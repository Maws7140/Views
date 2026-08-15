import { App, Component, Menu, Notice, setIcon, TFile } from 'obsidian';
import { isPropertyColorEnabled, normalizeColorPropertyId, type ViewsPluginSettings } from '../settings/settings';
import { RenderScheduler } from '../performance/RenderScheduler';
import { reportPerformance } from '../performance/metrics';
import { applyPropertyValuePill, propertyValueColorSeed } from '../ui/PropertyValueRenderer';
import { ColorAssigner, resolveColorPalette } from './palettes';

const BASE_ROOT = '.bases-view, .bases-embed';
// Cards carry the property id on their wrapper the same way table rows do.
// The list view builds bare spans with no property identity at all, so it is
// handled separately by LIST_ITEM below.
const CELL = '.bases-td[data-property], .bases-table-cell[data-property], .bases-cards-property[data-property]';
const LIST_ITEM = '.bases-list-item';
const TAG_PROPERTIES = ['file.tags', 'note.tags'];
const HEADER = '.bases-thead .bases-td';
const NOTE_PROPERTY = '.metadata-property[data-property-key]';
const NOTE_VALUE = '.metadata-property-value';
const VALUE_PILL = '.multi-select-pill, a.tag';
// The value itself rather than a wrapper around it, so the chip goes outside it.
const CHIP_LEAF = 'input, textarea, select, a, img, svg';
// A value holding one of these keeps Obsidian's DOM, and gets no chip at all.
const CHIP_BLOCKER = 'input, textarea, select, img, svg, div, ul, ol, table';

export class TableColorEnhancer extends Component {
	private observer: MutationObserver | null = null;
	private readonly pendingCells = new Set<HTMLElement>();
	private readonly pendingRoots = new Set<HTMLElement>();
	private readonly pendingNoteProperties = new Set<HTMLElement>();
	private readonly pendingListItems = new Set<HTMLElement>();
	private readonly scheduler = new RenderScheduler(() => this.flushPending());
	private colors: ColorAssigner | null = null;
	private colorsKey = '';
	private readonly decoratedState = new WeakMap<HTMLElement, string>();
	private basePathCache = new WeakMap<HTMLElement, string | null>();
	private readonly toggleButtons = new Map<HTMLElement, HTMLButtonElement>();
	private readonly menuHeaders = new WeakSet<HTMLElement>();

	constructor(
		private readonly app: App,
		private readonly getSettings: () => ViewsPluginSettings,
		private readonly saveSettings: () => Promise<void>,
	) {
		super();
	}

	onload(): void {
		this.observer = new MutationObserver((records) => this.queueMutations(records));
		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ['data-property', 'data-property-key', 'href', 'src', 'checked', 'aria-checked'],
		});
		this.registerDomEvent(document, 'input', (event) => this.queueNotePropertyEvent(event), true);
		this.registerDomEvent(document, 'change', (event) => this.queueNotePropertyEvent(event), true);
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (!(file instanceof TFile) || file.extension !== 'base') return;
			const settings = this.getSettings();
			if (!settings.tableColorDisabledBases.includes(oldPath)) return;
			settings.tableColorDisabledBases = settings.tableColorDisabledBases
				.map((path) => path === oldPath ? file.path : path);
			void this.saveSettings();
		}));
		this.refresh();
	}

	onunload(): void {
		this.observer?.disconnect();
		this.scheduler.cancel();
		this.pendingCells.clear();
		this.pendingRoots.clear();
		this.pendingNoteProperties.clear();
		this.pendingListItems.clear();
		for (const button of this.toggleButtons.values()) button.remove();
		this.toggleButtons.clear();
		this.clear();
	}

	refresh(): void {
		this.scheduler.cancel();
		this.pendingCells.clear();
		this.pendingRoots.clear();
		this.pendingNoteProperties.clear();
		this.pendingListItems.clear();
		this.basePathCache = new WeakMap();
		this.clear();
		const settings = this.getSettings();
		if (!settings.tableColorsEnabled) return;
		const palette = this.palette(settings);
		document.querySelectorAll<HTMLElement>(BASE_ROOT).forEach((root) => this.decorateRoot(root, settings, palette));
		document.querySelectorAll<HTMLElement>(NOTE_PROPERTY)
			.forEach((property) => this.decorateNoteProperty(property, settings, palette));
	}

	private queueMutations(records: MutationRecord[]): void {
		for (const record of records) {
			const target = record.target instanceof Element ? record.target : record.target.parentElement;
			// Views renders its own colors and repaints on every scroll frame.
			// Treating that churn as work for this enhancer meant rescanning the
			// whole Base sixty times a second while a timeline scrolled.
			if (target && this.isOwnView(target)) continue;
			if (target) this.queueElement(target);
			for (const node of Array.from(record.addedNodes)) {
				if (node instanceof Element && !this.isOwnView(node)) this.queueElement(node);
			}
		}
		if (
			this.pendingCells.size
			|| this.pendingRoots.size
			|| this.pendingNoteProperties.size
			// Queued list items used to be collected and then never scheduled, so a
			// list view repainted only when something else happened to ask for a pass.
			|| this.pendingListItems.size
		) this.scheduler.schedule();
	}

	/** Views' own view roots paint themselves and never need decorating here. */
	private isOwnView(element: Element): boolean {
		return element.closest('.tl-root, .mbv-collection-shell, .mbv-kanban, .mbv-heatmap') !== null;
	}

	private queueElement(element: Element): void {
		const noteProperty = element.matches(NOTE_PROPERTY) ? element : element.closest(NOTE_PROPERTY);
		if (noteProperty instanceof HTMLElement) this.pendingNoteProperties.add(noteProperty);
		element.querySelectorAll<HTMLElement>(NOTE_PROPERTY)
			.forEach((property) => this.pendingNoteProperties.add(property));
		const root = element.matches(BASE_ROOT)
			? element
			: element.closest(BASE_ROOT);
		if (root instanceof HTMLElement) this.bindColumnMenus(root);
		element.querySelectorAll<HTMLElement>(BASE_ROOT).forEach((baseRoot) => this.bindColumnMenus(baseRoot));
		const cell = element.matches(CELL) ? element : element.closest(CELL);
		if (cell instanceof HTMLElement && cell.closest(BASE_ROOT)) {
			this.pendingCells.add(cell);
			return;
		}
		// A scrolling table swaps whole rows in and out, so what arrives here is a
		// row, or the body that holds one, with the cells *inside* it. Looking only
		// upwards for a cell finds nothing in that case and the new rows are never
		// decorated, which is why colors dropped out of a table as it scrolled.
		//
		// Guarded by the enclosing Base so the scan cannot cost anything outside
		// one: every keystroke in the editor reaches this method too, and a
		// `querySelectorAll` per mutation there would be pure waste.
		if (element.closest(BASE_ROOT)) {
			element.querySelectorAll<HTMLElement>(CELL).forEach((descendant) => this.pendingCells.add(descendant));
		}
		const listItem = element.matches(LIST_ITEM) ? element : element.closest(LIST_ITEM);
		if (listItem instanceof HTMLElement && listItem.closest(BASE_ROOT)) {
			this.pendingListItems.add(listItem);
			return;
		}
		element.querySelectorAll<HTMLElement>(LIST_ITEM).forEach((item) => this.pendingListItems.add(item));
		if (element.matches(BASE_ROOT) && element instanceof HTMLElement) this.pendingRoots.add(element);
		element.querySelectorAll<HTMLElement>(BASE_ROOT).forEach((root) => this.pendingRoots.add(root));
	}

	private queueNotePropertyEvent(event: Event): void {
		if (!(event.target instanceof Element)) return;
		const property = event.target.closest<HTMLElement>(NOTE_PROPERTY);
		if (!property) return;
		this.pendingNoteProperties.add(property);
		this.scheduler.schedule();
	}

	private flushPending(): void {
		const startedAt = performance.now();
		const settings = this.getSettings();
		const roots = Array.from(this.pendingRoots);
		const cells = Array.from(this.pendingCells);
		const noteProperties = Array.from(this.pendingNoteProperties);
		const listItems = Array.from(this.pendingListItems);
		this.pendingRoots.clear();
		this.pendingCells.clear();
		this.pendingNoteProperties.clear();
		this.pendingListItems.clear();
		let scannedCells = 0;
		let changedValues = 0;
		if (!settings.tableColorsEnabled) {
			for (const root of roots) this.clearWithin(root);
			for (const cell of cells) this.clearWithin(cell);
			for (const property of noteProperties) this.clearWithin(property);
			for (const item of listItems) this.clearWithin(item);
		} else {
			const palette = this.palette(settings);
			for (const root of roots) {
				if (!root.isConnected) continue;
				const result = this.decorateRoot(root, settings, palette);
				scannedCells += result.scannedCells;
				changedValues += result.changedValues;
			}
			for (const cell of cells) {
				if (!cell.isConnected || roots.some((root) => root.contains(cell))) continue;
				scannedCells += 1;
				changedValues += this.decorateCellValues(cell, settings, palette);
			}
			for (const property of noteProperties) {
				if (!property.isConnected) continue;
				changedValues += this.decorateNoteProperty(property, settings, palette);
			}
			for (const item of listItems) {
				if (!item.isConnected || roots.some((root) => root.contains(item))) continue;
				changedValues += this.decorateListItem(item, settings, palette);
			}
		}
		reportPerformance('table mutation batch', startedAt, {
			roots: roots.length,
			cells: scannedCells,
			changedValues,
			noteProperties: noteProperties.length,
		});
	}

	private decorateRoot(
		root: HTMLElement,
		settings: ViewsPluginSettings,
		palette: string[],
	): { scannedCells: number; changedValues: number } {
		this.bindColumnMenus(root);
		const ownerRoot = this.ownerRoot(root);
		const basePath = this.basePathForRoot(ownerRoot);
		this.ensureBaseToggle(ownerRoot, basePath, settings);
		if (basePath && this.isBaseDisabled(basePath, settings)) {
			this.clearWithin(ownerRoot);
			return { scannedCells: 0, changedValues: 0 };
		}
		let scannedCells = 0;
		let changedValues = 0;
		root.querySelectorAll<HTMLElement>(CELL).forEach((cell) => {
			scannedCells += 1;
			changedValues += this.decorateCellValues(cell, settings, palette);
		});
		root.querySelectorAll<HTMLElement>(LIST_ITEM).forEach((item) => {
			scannedCells += 1;
			changedValues += this.decorateListItem(item, settings, palette);
		});
		return { scannedCells, changedValues };
	}

	private decorateCellValues(cell: HTMLElement, settings: ViewsPluginSettings, palette: string[]): number {
		const propertyId = cell.dataset.property?.trim() ?? '';
		const ownerRoot = this.ownerRoot(cell.closest<HTMLElement>(BASE_ROOT));
		const basePath = ownerRoot ? this.basePathForRoot(ownerRoot) : null;
		if (
			!propertyId
			|| (basePath !== null && this.isBaseDisabled(basePath, settings))
			|| !this.isColumnEnabled(propertyId, settings)
		) {
			this.clearWithin(cell);
			return 0;
		}
		// A scrolling table asks for this cell on every frame, and the work below
		// rewraps the value in a fresh chip, which is itself a mutation, which asks
		// for the cell again. Left unguarded that is a repaint loop, and it shows as
		// the whole column flickering while the table scrolls.
		//
		// The signature is the cell's own, not the chip's: a chip is replaced on
		// every rebuild, so a state keyed on it can never recognise a cell it has
		// already done. Whether the decoration is *currently present* is part of the
		// signature, so a rebuild that discards it reads as a change and is redone,
		// while a frame where nothing moved costs one string compare and no DOM.
		const signature = this.cellSignature(cell, propertyId, palette);
		if (this.decoratedState.get(cell) === signature) return 0;

		// Editable note tag/list properties use multi-select pills, while the
		// read-only core `file.tags` property renders literal anchor.tag elements.
		const pills = cell.querySelectorAll<HTMLElement>(VALUE_PILL);
		const valueEl = this.valueElement(cell);
		let changed = 0;
		if (pills.length && valueEl?.hasClass('views-colored-pill')) this.clearElement(valueEl);
		pills.forEach((pill) => {
			const value = pill.querySelector<HTMLElement>('.multi-select-pill-content')?.textContent?.trim()
				?? pill.textContent?.trim()
				?? '';
			if (this.applyPillColor(pill, propertyId, value, palette)) changed += 1;
		});
		if (!pills.length) {
			const value = valueEl ? this.renderedValueSeed(valueEl) : '';
			const chipEl = valueEl ? this.valueChipTarget(valueEl) : null;
			// A previous pass may have put the chip on the cell itself.
			if (chipEl && chipEl !== valueEl && valueEl?.hasClass('views-colored-pill')) this.clearElement(valueEl);
			const target = chipEl ?? valueEl;
			if (target && value && this.applyCellColor(target, propertyId, value, palette)) changed += 1;
			else if (target?.hasClass('views-colored-pill')) this.clearElement(target);
		}
		// Recomputed rather than reused: the pass above is what put the decoration
		// there, so the signature taken before it describes the cell as it was.
		this.decoratedState.set(cell, this.cellSignature(cell, propertyId, palette));
		return changed;
	}

	/**
	 * What a cell would have to change for its decoration to need redoing: the
	 * property it belongs to, the palette in force, the text it renders, and
	 * whether it is still wearing the decoration a previous pass gave it.
	 */
	private cellSignature(cell: HTMLElement, propertyId: string, palette: string[]): string {
		const text = (cell.textContent ?? '').trim();
		const decorated = cell.querySelector('.views-colored-pill') ? '1' : '0';
		return `${propertyId} ${text} ${decorated} ${palette.join(',')}`;
	}

	/**
	 * Finds the element the pill should be painted on, which is always an element
	 * that hugs the value's own text.
	 *
	 * A `.multi-select-pill` and an `a.tag` already are that element, and never
	 * reach here. Everything else arrives as text sitting loose in a table cell,
	 * so a span is put around it. The one thing this must never do is hand back a
	 * container: a cell is as wide as its column, so a pill painted on one comes
	 * out as a full-width slab with the text centred in it.
	 *
	 * Obsidian wraps a rendered value in one or more single-child elements, so
	 * the wrappers are walked through first to reach the text.
	 */
	private valueChipTarget(valueEl: HTMLElement): HTMLElement | null {
		let current = valueEl;
		while (true) {
			const children = Array.from(current.children) as HTMLElement[];
			if (children.length !== 1) break;
			const child = children[0];
			// Only descend through a wrapper that adds nothing but nesting.
			if ((current.textContent ?? '').trim() !== (child.textContent ?? '').trim()) break;
			// A link is the value, not a wrapper around it. Descending into one
			// would put the chip inside the link instead of around it.
			//
			// A chip this method placed on an earlier pass stops the walk for the
			// same reason: descending through it would wrap its contents in a
			// second chip, and again on every pass after that.
			if (child.matches(CHIP_LEAF) || child.hasClass('views-value-chip')) break;
			current = child;
		}
		return this.ensureValueChip(current);
	}

	/**
	 * Wraps whatever the element holds in one span, and returns it.
	 *
	 * The nodes are **moved** into the span rather than the text being copied out
	 * of them. That is what lets a linked value get a chip: `Phase` renders as an
	 * anchor, and the previous version refused to wrap anything that was not a
	 * bare text node, so the pill fell back to the cell and became a slab. Moving
	 * the nodes keeps the anchor live, click and all.
	 */
	private ensureValueChip(valueEl: HTMLElement): HTMLElement | null {
		const existing = valueEl.querySelector<HTMLElement>(':scope > .views-value-chip');
		if (existing) {
			// Obsidian re-renders a cell by replacing its children, so a stale chip
			// left beside fresh content has to give way to a new one.
			if (valueEl.childNodes.length === 1) return existing;
			while (existing.firstChild) valueEl.insertBefore(existing.firstChild, existing);
			existing.remove();
		}
		if (!valueEl.childNodes.length) return null;
		if (!(valueEl.textContent ?? '').trim()) return null;
		// Anything interactive or block-level keeps Obsidian's own DOM untouched.
		if (valueEl.querySelector(CHIP_BLOCKER)) return null;
		const chipEl = createSpan({ cls: 'views-value-chip' });
		while (valueEl.firstChild) chipEl.appendChild(valueEl.firstChild);
		valueEl.appendChild(chipEl);
		return chipEl;
	}

	/**
	 * `.bases-rendered-value` is the one element every Bases view type puts its
	 * value into: the table cell itself, the card line, the list span.
	 */
	private valueElement(cell: HTMLElement): HTMLElement | null {
		if (cell.hasClass('bases-rendered-value')) return cell;
		return cell.querySelector<HTMLElement>('.bases-rendered-value')
			?? (cell.matches('.bases-table-cell') ? cell : cell.querySelector<HTMLElement>('.bases-table-cell'));
	}

	/**
	 * List rows render each value into an anonymous span with no property id, so
	 * a value cannot be attributed to the property that produced it. Tags are
	 * the exception: an `a.tag` is a tag whichever property emitted it, so those
	 * are colored from the tags property, and nothing else is guessed at.
	 */
	private decorateListItem(item: HTMLElement, settings: ViewsPluginSettings, palette: string[]): number {
		const ownerRoot = this.ownerRoot(item.closest<HTMLElement>(BASE_ROOT));
		const basePath = ownerRoot ? this.basePathForRoot(ownerRoot) : null;
		const tagProperty = TAG_PROPERTIES.find((property) => this.isColumnEnabled(property, settings));
		if (!tagProperty || (basePath !== null && this.isBaseDisabled(basePath, settings))) {
			this.clearWithin(item);
			return 0;
		}
		let changed = 0;
		item.querySelectorAll<HTMLElement>(VALUE_PILL).forEach((pill) => {
			const value = pill.querySelector<HTMLElement>('.multi-select-pill-content')?.textContent?.trim()
				?? pill.textContent?.trim()
				?? '';
			if (value && this.applyPillColor(pill, tagProperty, value, palette)) changed += 1;
		});
		return changed;
	}

	private decorateNoteProperty(property: HTMLElement, settings: ViewsPluginSettings, palette: string[]): number {
		const propertyKey = property.dataset.propertyKey?.trim();
		const valueEl = property.querySelector<HTMLElement>(NOTE_VALUE);
		if (!propertyKey || !valueEl) return 0;
		const propertyId = this.normalizePropertyId(`note.${propertyKey}`);
		if (!this.isColumnEnabled(propertyId, settings)) {
			this.clearWithin(valueEl);
			return 0;
		}
		const sourceValue = this.notePropertySourceValue(property, propertyKey);
		const sourceItems = Array.isArray(sourceValue) ? sourceValue : null;
		const pills = valueEl.querySelectorAll<HTMLElement>(VALUE_PILL);
		let changed = 0;
		if (pills.length && valueEl.hasClass('views-colored-pill')) this.clearElement(valueEl);
		pills.forEach((pill, index) => {
			const value = sourceItems?.[index]
				?? pill.querySelector<HTMLElement>('.multi-select-pill-content')?.textContent?.trim()
				?? this.renderedValueSeed(pill);
			if (value && this.applyPillColor(pill, propertyId, value, palette)) changed += 1;
		});
		if (!pills.length) {
			const value = sourceValue ?? this.renderedValueSeed(valueEl);
			if (value && this.applyCellColor(valueEl, propertyId, value, palette)) changed += 1;
			else if (valueEl.hasClass('views-colored-pill')) this.clearElement(valueEl);
		}
		return changed;
	}

	private notePropertySourceValue(property: HTMLElement, propertyKey: string): unknown {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (!leaf.view.containerEl.contains(property)) continue;
			const filePath = leaf.getViewState().state?.file;
			const file = typeof filePath === 'string' ? this.app.vault.getAbstractFileByPath(filePath) : null;
			if (!(file instanceof TFile)) return null;
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter) return null;
			const key = Object.keys(frontmatter)
				.find((candidate) => candidate.toLocaleLowerCase() === propertyKey.toLocaleLowerCase());
			return key ? frontmatter[key] : null;
		}
		return null;
	}

	/** Native Bases does not expose cell Values publicly; keep this as the only DOM adapter. */
	private renderedValueSeed(element: HTMLElement): unknown {
		const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (checkbox) return checkbox.checked;
		const control = element.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
		if (control?.value.trim()) return control.value;
		const text = element.textContent?.trim();
		if (text) return text;
		const image = element.querySelector<HTMLImageElement>('img');
		if (image) return image.alt.trim() || image.currentSrc || image.src;
		const link = element.querySelector<HTMLAnchorElement>('a[href]');
		return link?.getAttribute('href')?.trim() ?? '';
	}

	private applyPillColor(pill: HTMLElement, propertyId: string, value: unknown, palette: string[]): boolean {
		const seed = propertyValueColorSeed(value);
		const state = `${propertyId}\u0000${seed}\u0000${palette.join(',')}`;
		if (this.decoratedState.get(pill) === state) return false;
		const wasColored = pill.hasClass('has-value-color');
		this.clearElement(pill);
		// The pill surface only ever carries a color, so an uncolored value keeps
		// its native presentation instead of gaining an empty chip.
		// One pill function for the whole plugin. `applyPropertyValuePill` is what
		// tags, list items, Collection chips, and timeline chips already use.
		const colored = applyPropertyValuePill(pill, value, palette, this.assigner(palette), propertyId);
		if (colored) pill.addClass('views-colored-pill');
		this.decoratedState.set(pill, state);
		return colored || wasColored;
	}

	private applyCellColor(valueEl: HTMLElement, propertyId: string, value: unknown, palette: string[]): boolean {
		const seed = propertyValueColorSeed(value);
		const state = `${propertyId}\u0000${seed}\u0000${palette.join(',')}`;
		if (this.decoratedState.get(valueEl) === state) return false;
		const wasColored = valueEl.hasClass('has-value-color');
		this.clearElement(valueEl);
		const colored = applyPropertyValuePill(valueEl, value, palette, this.assigner(palette), propertyId);
		if (colored) valueEl.addClass('views-colored-pill');
		this.decoratedState.set(valueEl, state);
		return colored || wasColored;
	}

	private isColumnEnabled(propertyId: string, settings = this.getSettings()): boolean {
		return isPropertyColorEnabled(settings, propertyId);
	}

	private normalizePropertyId(propertyId: string): string {
		return normalizeColorPropertyId(propertyId);
	}

	private isBaseDisabled(basePath: string, settings = this.getSettings()): boolean {
		return Array.isArray(settings.tableColorDisabledBases)
			&& settings.tableColorDisabledBases.includes(basePath);
	}

	private ensureBaseToggle(
		root: HTMLElement,
		basePath: string | null,
		settings: ViewsPluginSettings,
	): void {
		if (!basePath) return;
		const toolbar = root.querySelector<HTMLElement>('.bases-header .bases-toolbar');
		if (!toolbar) return;
		let button = this.toggleButtons.get(root);
		if (!button || !button.isConnected) {
			button = toolbar.createEl('button', {
				cls: 'clickable-icon views-table-color-toggle',
				attr: { type: 'button' },
			});
			button.addEventListener('click', () => {
				const path = button?.dataset.basePath;
				if (path) void this.toggleBase(path);
			});
			this.toggleButtons.set(root, button);
		}
		button.dataset.basePath = basePath;
		const enabled = !this.isBaseDisabled(basePath, settings);
		button.toggleClass('is-disabled', !enabled);
		button.setAttr('aria-pressed', enabled ? 'true' : 'false');
		button.setAttr('aria-label', enabled
			? 'Disable automatic property colors for this Base'
			: 'Enable automatic property colors for this Base');
		button.setAttr('title', enabled
			? 'Automatic property colors: on'
			: 'Automatic property colors: off');
		button.empty();
		setIcon(button, enabled ? 'palette' : 'palette-off');
	}

	private async toggleBase(basePath: string): Promise<void> {
		const settings = this.getSettings();
		const disabled = new Set(settings.tableColorDisabledBases);
		if (disabled.has(basePath)) disabled.delete(basePath);
		else disabled.add(basePath);
		settings.tableColorDisabledBases = [...disabled].sort();
		await this.saveSettings();
	}

	private async toggleColumn(propertyId: string): Promise<void> {
		const settings = this.getSettings();
		const normalized = this.normalizePropertyId(propertyId);
		const enabled = new Set((Array.isArray(settings.tableColorEnabledProperties)
			? settings.tableColorEnabledProperties
			: []).map((value) => this.normalizePropertyId(value)));
		if (enabled.has(normalized)) enabled.delete(normalized);
		else enabled.add(normalized);
		settings.tableColorEnabledProperties = [...enabled].sort();
		// Apply synchronously so the visible table responds as soon as the menu
		// closes; saveSettings persists it and performs the normal full refresh.
		this.refresh();
		await this.saveSettings();
		new Notice(`${enabled.has(normalized) ? 'Enabled' : 'Disabled'} automatic colors for ${propertyId.replace(/^note\./, '')}.`);
	}

	private ownerRoot(root: HTMLElement | null): HTMLElement {
		return root?.closest<HTMLElement>('.bases-embed') ?? root ?? document.body;
	}

	private basePathForRoot(root: HTMLElement): string | null {
		if (this.basePathCache.has(root)) return this.basePathCache.get(root) ?? null;
		let path: string | null = null;
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
			if (!leaf.view.containerEl.contains(root)) continue;
			const filePath = leaf.getViewState().state?.file;
			if (typeof filePath === 'string') path = filePath;
			break;
		}
		if (!path && root.hasClass('bases-embed')) path = this.embeddedBasePath(root);
		this.basePathCache.set(root, path);
		return path;
	}

	private embeddedBasePath(root: HTMLElement): string | null {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const stack: unknown[] = [leaf.view];
			const visited = new Set<unknown>();
			while (stack.length) {
				const current = stack.pop();
				if (!current || typeof current !== 'object' || visited.has(current)) continue;
				visited.add(current);
				const component = current as { containerEl?: unknown; file?: unknown; _children?: unknown };
				if (component.containerEl === root && component.file instanceof TFile && component.file.extension === 'base') {
					return component.file.path;
				}
				if (Array.isArray(component._children)) stack.push(...component._children);
			}
		}
		return null;
	}

	private bindColumnMenus(root: HTMLElement): void {
		root.querySelectorAll<HTMLElement>(HEADER).forEach((header) => {
			if (this.menuHeaders.has(header)) return;
			this.menuHeaders.add(header);
			// The native header registered its own target listener before the node
			// entered the document. Registering on that same node now guarantees
			// Bases creates the event menu first and this item is appended second.
			this.registerDomEvent(header, 'contextmenu', (event) => this.handleColumnContextMenu(event, header));
		});
	}

	private handleColumnContextMenu(event: MouseEvent, header: HTMLElement): void {
		if (!(event.target instanceof Element)) return;
		if (event.target.closest('.bases-table-header-resizer')) return;
		const root = header.closest<HTMLElement>(BASE_ROOT);
		if (!root) return;
		const propertyId = this.propertyIdForHeader(root, header);
		if (!propertyId) return;

		const settings = this.getSettings();
		const enabled = this.isColumnEnabled(propertyId, settings);
		const displayName = header.querySelector<HTMLElement>('.bases-table-header-name')?.textContent?.trim()
			|| header.textContent?.trim()
			|| propertyId.replace(/^note\./, '');
		Menu.forEvent(event)
			.addItem((item) => item
				.setTitle(`Automatic colors for ${displayName}`)
				.setIcon('palette')
				.setChecked(enabled)
				.setSection('action')
				.onClick(() => void this.toggleColumn(propertyId)));
	}

	private propertyIdForHeader(root: HTMLElement, header: HTMLElement): string {
		const direct = header.dataset.property?.trim();
		if (direct) return direct;
		const headerCells = Array.from(root.querySelectorAll<HTMLElement>(HEADER));
		const columnIndex = headerCells.indexOf(header);
		if (columnIndex < 0) return '';
		for (const row of Array.from(root.querySelectorAll<HTMLElement>('.bases-tr'))) {
			const cells = Array.from(row.children)
				.filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches(CELL));
			const propertyId = cells[columnIndex]?.dataset.property?.trim();
			if (propertyId) return propertyId;
		}
		return '';
	}

	/**
	 * Kept across passes rather than rebuilt per pass. A table decorates cells
	 * incrementally as they scroll into view, so a fresh assigner each time
	 * could give a value one color now and another later, in the same table.
	 * Rebuilt only when the palette itself changes.
	 */
	private assigner(palette: string[]): ColorAssigner {
		const key = palette.join(',');
		if (!this.colors || this.colorsKey !== key) {
			this.colors = new ColorAssigner(palette);
			this.colorsKey = key;
		}
		return this.colors;
	}

	private palette(settings: ViewsPluginSettings): string[] {
		return resolveColorPalette(settings.colorPack, settings.customPalette);
	}

	private clear(): void {
		document.querySelectorAll<HTMLElement>('.views-colored-row, .views-colored-pill').forEach((element) => {
			this.clearElement(element);
		});
	}

	private clearWithin(container: Element): void {
		if (container instanceof HTMLElement && container.matches('.views-colored-row, .views-colored-pill')) {
			this.clearElement(container);
		}
		container.querySelectorAll<HTMLElement>('.views-colored-row, .views-colored-pill')
			.forEach((element) => this.clearElement(element));
	}

	private clearElement(element: HTMLElement): void {
		element.removeClass('views-colored-row', 'views-colored-pill', 'views-property-pill', 'has-value-color');
		element.style.removeProperty('--views-row-color');
		element.style.removeProperty('--views-pill-color');
		element.style.removeProperty('--views-cell-color');
		element.style.removeProperty('--views-property-color');
		this.decoratedState.delete(element);
	}
}
