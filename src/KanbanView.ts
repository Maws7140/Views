import {
	BasesEntry,
	BasesEntryGroup,
	BasesPropertyId,
	BasesView,
	Notice,
	QueryController,
	TFile,
	ViewOption,
	parseYaml,
} from 'obsidian';
import {
	KanbanRenderer,
	type KanbanCard,
	type KanbanCardProperty,
	type KanbanColumn,
	type KanbanDropTarget,
	type KanbanLane,
	type KanbanModel,
} from './kanban/KanbanRenderer';
import {
	automaticColorPalette,
	colorViewOptions,
	getNotebookNavigatorApi,
	iconViewOptions,
	readAppearanceConfig,
	resolveCardColor,
	resolveCardIcons,
	type CollectionAppearanceConfig,
} from './collection/appearance';
import { applyManualOrder, NO_LANE_KEY, partitionGroupsIntoLanes } from './logic/lanes';
import { EntryInteractions, type EntryTarget } from './ui/EntryInteractions';
import { isPropertyColorEnabled } from './settings/settings';
import { parseCustomPalette } from './table-colors/palettes';
import { resolvePropertyValueColor } from './ui/PropertyValueRenderer';
import type ViewsPlugin from './main';

export const KanbanViewType = 'more-bases-kanban';

/** The card already shows the note's name, so these never render as a chip. */
const TITLE_PROPERTIES = new Set(['file.name', 'file.basename', 'file.file', 'file.fullname']);

/** A bare order entry means a note property. */
function normalizePropertyId(property: string): string {
	const trimmed = property.trim();
	return /^(?:note|file|formula)\./.test(trimmed) ? trimmed : `note.${trimmed}`;
}

interface GroupPropertyInfo {
	property: string | null;
	reason: string;
}

export class KanbanView extends BasesView {
	type = KanbanViewType;
	private readonly containerEl: HTMLElement;
	private readonly renderer: KanbanRenderer;
	private readonly entriesById = new Map<string, BasesEntry>();
	private readonly cardLocations = new Map<string, { columnKey: string; laneKey: string }>();
	private readonly cardCache = new Map<string, KanbanCard>();
	private appearanceCache: CollectionAppearanceConfig | null = null;
	private readonly columnIcons = new Map<string, string>();
	private lastModel: KanbanModel | null = null;
	private groupProperty: GroupPropertyInfo = { property: null, reason: 'Resolving the Group by property.' };
	private groupPropertyToken = 0;
	private laneProp: BasesPropertyId | null = null;
	private orderProp: BasesPropertyId | null = null;
	private mediaProp: BasesPropertyId | null = null;
	private titleProp: BasesPropertyId | null = null;
	private detachInteractions: (() => void) | null = null;
	private unsubscribeColors: (() => void) | null = null;
	/** Column keys stay visible after their last card leaves. */
	private knownColumns: string[] = [];

	constructor(
		private readonly plugin: ViewsPlugin,
		controller: QueryController,
		scrollEl: HTMLElement,
	) {
		super(controller);
		this.containerEl = scrollEl.createDiv({ cls: 'mbv-kanban-host' });
		this.renderer = new KanbanRenderer(this.containerEl, this.app, {
			resolveCard: (cardId, laneKey) => this.resolveCard(cardId, laneKey),
			onDrop: (target) => this.handleDrop(target),
			onColumnReorder: (order) => this.persistColumnOrder(order),
			onLaneToggle: (laneKey, collapsed) => this.persistLaneCollapse(laneKey, collapsed),
		});
		// Registered here rather than in onload, the same way the Collection view
		// binds its handlers, so the listeners exist as soon as the view does.
		this.detachInteractions = new EntryInteractions(this.app, {
			resolve: (event) => this.resolveTarget(event),
			isSuppressed: () => this.renderer.isDragging(),
		}).attach(this.containerEl);
		this.unsubscribeColors = this.plugin.onPropertyColorSettingsChanged(() => this.onDataUpdated());
	}

	private resolveTarget(event: Event): EntryTarget | null {
		const target = event.target instanceof Element
			? event.target.closest<HTMLElement>('.mbv-kanban-card')
			: null;
		const path = target?.dataset.id;
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		return target && file instanceof TFile ? { el: target, file } : null;
	}

	onunload(): void {
		this.detachInteractions?.();
		this.unsubscribeColors?.();
		this.renderer.destroy();
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: 'Kanban',
				type: 'group',
				items: [
					{
						displayName: 'Swimlane property',
						type: 'property',
						key: 'swimlaneProperty',
						filter: () => true,
						placeholder: 'Split columns into rows',
					},
					{
						displayName: 'Swimlane order',
						type: 'dropdown',
						key: 'swimlaneSort',
						default: 'sort',
						options: {
							sort: 'Follow Sort by',
							name: 'Name, A to Z',
							'name-desc': 'Name, Z to A',
							count: 'Most cards first',
						},
					},
					{
						displayName: 'Empty swimlane last',
						type: 'toggle',
						key: 'emptyLaneLast',
						default: true,
					},
					{
						displayName: 'Manual order property',
						type: 'property',
						key: 'orderProperty',
						filter: () => true,
						placeholder: 'Number property, enables reordering',
					},
					{
						displayName: 'Title property',
						type: 'property',
						key: 'titleProperty',
						default: 'file.name',
					},
					{
						displayName: 'Cover property',
						type: 'property',
						key: 'mediaProperty',
						filter: () => true,
						placeholder: 'Image shown on the card',
					},
				],
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [
					{
						displayName: 'Compact cards',
						type: 'toggle',
						key: 'compactCards',
						default: false,
					},
					{
						displayName: 'Show counts',
						type: 'toggle',
						key: 'showCounts',
						default: true,
					},
					{
						displayName: 'Hide empty columns',
						type: 'toggle',
						key: 'hideEmptyColumns',
						default: false,
					},
					{
						displayName: 'Hide empty swimlanes',
						type: 'toggle',
						key: 'hideEmptySwimlanes',
						default: true,
					},
					{
						displayName: 'Column width',
						type: 'slider',
						key: 'columnWidth',
						default: 300,
						min: 100,
						max: 900,
						step: 1,
						instant: true,
					},
					{
						displayName: 'Board height',
						type: 'slider',
						key: 'viewportHeight',
						default: 0,
						min: 0,
						max: 1200,
						step: 1,
						instant: true,
					},
					{
						displayName: 'Cover height',
						type: 'slider',
						key: 'coverHeight',
						default: 96,
						min: 0,
						max: 320,
						step: 1,
						instant: true,
					},
				],
			},
			colorViewOptions('Card colors'),
			iconViewOptions(),
		];
	}

	onDataUpdated(): void {
		this.appearanceCache = null;
		this.columnIcons.clear();
		this.laneProp = this.config.getAsPropertyId('swimlaneProperty');
		this.orderProp = this.config.getAsPropertyId('orderProperty');
		this.mediaProp = this.config.getAsPropertyId('mediaProperty');
		this.titleProp = this.config.getAsPropertyId('titleProperty') ?? ('file.name' as BasesPropertyId);
		void this.resolveGroupProperty();
		this.renderer.update(this.buildModel());
	}

	private buildModel(): KanbanModel {
		this.entriesById.clear();
		this.cardLocations.clear();
		// Entries are recreated on every result set, so cached cards go with them.
		this.cardCache.clear();
		const groups = (this.data?.groupedData ?? []).filter((group) => group.entries.length > 0);
		const palette = this.headerPalette();
		const laneName = this.laneProp ? this.config.getDisplayName(this.laneProp) : 'lane';
		const partition = partitionGroupsIntoLanes(groups, this.laneProp, laneName, (group) => this.columnKey(group));

		const columnsByKey = new Map<string, KanbanColumn>();
		for (const group of groups) {
			const key = this.columnKey(group);
			const cells = partition.cells.get(key) ?? new Map<string, BasesEntry[]>();
			const cards = new Map<string, string[]>();
			let count = 0;
			for (const lane of partition.lanes) {
				const entries = cells.get(lane.key) ?? [];
				const ids: string[] = [];
				for (const entry of entries) {
					this.entriesById.set(entry.file.path, entry);
					this.cardLocations.set(entry.file.path, { columnKey: key, laneKey: lane.key });
					ids.push(entry.file.path);
				}
				cards.set(lane.key, ids);
				count += ids.length;
			}
			columnsByKey.set(key, {
				key,
				label: key,
				color: this.plugin.settings.tableColorsEnabled
					? resolvePropertyValueColor(key, palette) ?? undefined
					: undefined,
				icon: this.columnIcon(key),
				count,
				cards,
			});
		}

		// A column whose last card was dragged away would otherwise vanish under
		// the cursor, so previously seen columns are kept as empty destinations.
		for (const key of this.knownColumns) {
			if (columnsByKey.has(key)) continue;
			const cards = new Map<string, string[]>();
			for (const lane of partition.lanes) cards.set(lane.key, []);
			columnsByKey.set(key, {
				key,
				label: key,
				color: this.plugin.settings.tableColorsEnabled
					? resolvePropertyValueColor(key, palette) ?? undefined
					: undefined,
				icon: this.columnIcon(key),
				count: 0,
				cards,
			});
		}

		let columns = applyManualOrder([...columnsByKey.values()], this.storedColumnOrder());
		this.knownColumns = columns.map((column) => column.key);
		if (this.config.get('hideEmptyColumns') === true) {
			columns = columns.filter((column) => column.count > 0);
		}

		let lanes: KanbanLane[] = partition.lanes.map((lane) => ({
			key: lane.key,
			label: lane.label,
			color: this.laneProp && lane.key !== NO_LANE_KEY && this.plugin.settings.tableColorsEnabled
				? resolvePropertyValueColor(lane.key, palette) ?? undefined
				: undefined,
			count: columns.reduce((total, column) => total + (column.cards.get(lane.key)?.length ?? 0), 0),
		}));
		if (this.laneProp && this.config.get('hideEmptySwimlanes') !== false) {
			lanes = lanes.filter((lane) => lane.count > 0);
		}
		lanes = this.orderLanes(lanes);

		this.lastModel = {
			columns,
			lanes,
			hasLanes: this.laneProp !== null,
			columnWidth: this.numberOption('columnWidth', 300),
			coverHeight: this.numberOption('coverHeight', 96),
			viewportHeight: this.numberOption('viewportHeight', 0),
			showCounts: this.config.get('showCounts') !== false,
			compact: this.config.get('compactCards') === true,
			canDrag: this.groupProperty.property !== null,
			dragDisabledReason: this.groupProperty.property ? '' : this.groupProperty.reason,
			canReorder: this.orderProp !== null,
			collapsedLanes: this.storedList('collapsedSwimlanes'),
		};
		return this.lastModel;
	}

	/**
	 * Built on demand for cards the renderer is actually showing. Resolving
	 * icons and every property for thousands of off-screen notes was what froze
	 * a Base with no Group by, where every note lands in one column.
	 */
	/**
	 * The view's own colour pack when one is chosen, otherwise the pack from the
	 * plugin's Colors settings, so a board follows the palette the user picked
	 * rather than silently defaulting to Notion.
	 */
	private appearance(): CollectionAppearanceConfig {
		if (this.appearanceCache) return this.appearanceCache;
		const appearance = readAppearanceConfig(this.config);
		if (this.config.get('colorPack') === undefined) {
			appearance.colorPack = this.plugin.settings.colorPack;
			appearance.customColors = parseCustomPalette(this.plugin.settings.customPalette);
		}
		this.appearanceCache = appearance;
		return appearance;
	}

	/**
	 * Lane order defaults to first appearance in the native sort, which is the
	 * rule the rest of the plugin follows, and can be overridden per view. The
	 * unassigned lane is kept out of the sort so it does not land in the middle
	 * of real values.
	 */
	private orderLanes(lanes: KanbanLane[]): KanbanLane[] {
		const mode = this.config.get('swimlaneSort');
		const emptyLast = this.config.get('emptyLaneLast') !== false;
		const named = lanes.filter((lane) => lane.key !== NO_LANE_KEY);
		const unassigned = lanes.filter((lane) => lane.key === NO_LANE_KEY);

		if (mode === 'name' || mode === 'name-desc') {
			const direction = mode === 'name-desc' ? -1 : 1;
			named.sort((a, b) => direction * a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
		} else if (mode === 'count') {
			named.sort((a, b) => b.count - a.count);
		}

		const ordered = emptyLast ? [...named, ...unassigned] : [...unassigned, ...named];
		return applyManualOrder(ordered, this.storedList('swimlaneOrder'));
	}

	/** Columns, swimlanes, and cards all tint from this one palette. */
	private headerPalette(): string[] {
		return automaticColorPalette(this.appearance());
	}

	private resolveCard(cardId: string, laneKey: string): KanbanCard | null {
		const cached = this.cardCache.get(cardId);
		if (cached) return cached;
		const entry = this.entriesById.get(cardId);
		if (!entry) return null;
		const card = this.toCard(entry, laneKey, this.headerPalette());
		this.cardCache.set(cardId, card);
		return card;
	}

	private toCard(entry: BasesEntry, laneKey: string, palette: string[]): KanbanCard {
		const skip = new Set([this.laneProp, this.orderProp, this.mediaProp, this.titleProp]
			.filter(Boolean)
			.map((property) => normalizePropertyId(property as string)));
		const properties: KanbanCardProperty[] = [];
		for (const ordered of this.config.getOrder()) {
			// Bases stores an order entry as written, so a note property can
			// arrive bare. `getValue` needs the qualified id.
			const property = normalizePropertyId(ordered) as BasesPropertyId;
			if (skip.has(property) || TITLE_PROPERTIES.has(property)) continue;
			const value = this.safeValue(entry, property);
			if (value === null || value === undefined) continue;
			properties.push({
				property,
				displayName: this.config.getDisplayName(property),
				value,
				palette: isPropertyColorEnabled(this.plugin.settings, property) ? palette : undefined,
			});
		}
		const appearance = this.appearance();
		const title = this.cardTitle(entry);
		return {
			id: entry.file.path,
			title,
			laneKey,
			icons: resolveCardIcons(entry, appearance, getNotebookNavigatorApi(this.app)),
			properties,
			// The same colour vocabulary as a Collection card: frontmatter,
			// automatic, or off, with the view's own palette.
			color: resolveCardColor(entry, appearance, title, this.app, automaticColorPalette(appearance)) ?? undefined,
			cover: this.coverFor(entry),
		};
	}


	/** Same rule as a Collection card: the chosen property, else the file name. */
	private cardTitle(entry: BasesEntry): string {
		if (this.titleProp) {
			const value = this.safeValue(entry, this.titleProp);
			const title = value === null || value === undefined ? '' : String(value).trim();
			if (title) return title;
		}
		return entry.file.basename;
	}

	/** A stale or renamed property in the order must not take the board down. */
	private safeValue(entry: BasesEntry, property: BasesPropertyId): unknown {
		try {
			return entry.getValue(property);
		} catch {
			return null;
		}
	}

	private coverFor(entry: BasesEntry): string | null {
		if (!this.mediaProp) return null;
		const raw = entry.getValue(this.mediaProp)?.toString().trim();
		if (!raw) return null;
		const link = raw.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
		if (/^https?:\/\//.test(link)) return link;
		const file = this.app.metadataCache.getFirstLinkpathDest(link, entry.file.path);
		return file ? this.app.vault.getResourcePath(file) : null;
	}

	/**
	 * A grouping value is often a link to a note, such as a status or a person.
	 * When it resolves to one, that note's frontmatter icon heads the column
	 * instead of the generic dot, using the view's configured icon property.
	 */
	private columnIcon(columnKey: string): string | undefined {
		const appearance = this.appearance();
		if (!appearance.showIcons || !columnKey) return undefined;
		const cached = this.columnIcons.get(columnKey);
		if (cached !== undefined) return cached || undefined;
		const link = columnKey.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].trim();
		const file = link ? this.app.metadataCache.getFirstLinkpathDest(link, '') : null;
		const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
		const key = (appearance.iconProperty ?? 'note.icon').replace(/^note\./, '');
		const match = frontmatter
			? Object.keys(frontmatter).find((candidate) => candidate.toLocaleLowerCase() === key.toLocaleLowerCase())
			: undefined;
		const icon = match && typeof frontmatter?.[match] === 'string' ? String(frontmatter[match]).trim() : '';
		this.columnIcons.set(columnKey, icon);
		return icon || undefined;
	}

	private columnKey(group: BasesEntryGroup): string {
		if (!group.key?.isTruthy()) return 'No value';
		return group.key.toString().trim() || 'No value';
	}

	private storedColumnOrder(): string[] {
		return this.storedList('columnOrder');
	}

	private storedList(key: string): string[] {
		const raw = this.config.get(key);
		if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string');
		return [];
	}

	/** Collapsed lanes live in the view config, so the state survives a reload. */
	private persistLaneCollapse(laneKey: string, collapsed: boolean): void {
		const current = new Set(this.storedList('collapsedSwimlanes'));
		if (collapsed) current.add(laneKey);
		else current.delete(laneKey);
		this.config.set('collapsedSwimlanes', [...current]);
	}

	private persistColumnOrder(order: string[]): void {
		this.config.set('columnOrder', order);
	}

	private numberOption(key: string, fallback: number): number {
		const value = this.config.get(key);
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		const parsed = typeof value === 'string' ? Number(value) : NaN;
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	/**
	 * The Bases API exposes a group's value but never the property it grouped
	 * by, so the property is read out of the `.base` file, which stores it per
	 * view. Without it a card cannot know what to write, and drag stays off.
	 */
	private async resolveGroupProperty(): Promise<void> {
		const token = ++this.groupPropertyToken;
		const basePath = this.basePath();
		if (!basePath) {
			this.setGroupProperty(token, null, 'Drag is unavailable: the Base file for this view could not be located.');
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(basePath);
		if (!(file instanceof TFile)) {
			this.setGroupProperty(token, null, 'Drag is unavailable: the Base file could not be read.');
			return;
		}
		try {
			const parsed = parseYaml(await this.app.vault.cachedRead(file)) as Record<string, unknown> | null;
			const views = Array.isArray(parsed?.views) ? parsed?.views as Record<string, unknown>[] : [];
			const view = views.find((candidate) => candidate?.name === this.config.name);
			const groupBy = view?.groupBy as { property?: unknown } | undefined;
			const property = typeof groupBy?.property === 'string' ? groupBy.property.trim() : '';
			if (!property) {
				this.setGroupProperty(token, null, 'Set Group by on this view to enable drag between columns.');
				return;
			}
			const normalized = /^(?:note|file|formula)\./.test(property) ? property : `note.${property}`;
			if (!normalized.startsWith('note.')) {
				this.setGroupProperty(token, null, `Drag is unavailable: ${property} is not a writable property.`);
				return;
			}
			this.setGroupProperty(token, normalized, '');
		} catch {
			this.setGroupProperty(token, null, 'Drag is unavailable: the Base file could not be parsed.');
		}
	}

	private setGroupProperty(token: number, property: string | null, reason: string): void {
		if (token !== this.groupPropertyToken) return;
		if (this.groupProperty.property === property && this.groupProperty.reason === reason) return;
		this.groupProperty = { property, reason };
		this.renderer.update(this.buildModel());
	}

	private basePath(): string | null {
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
			if (!leaf.view.containerEl.contains(this.containerEl)) continue;
			const filePath = leaf.getViewState().state?.file;
			if (typeof filePath === 'string') return filePath;
		}
		return this.embeddedBasePath();
	}

	/**
	 * An embedded Base has no `bases` leaf of its own, so the file is found by
	 * walking the component tree of whatever view hosts it, the same way
	 * `TableColorEnhancer` resolves embeds. Embedded boards drag like any other.
	 */
	private embeddedBasePath(): string | null {
		let found: string | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found || !leaf.view.containerEl.contains(this.containerEl)) return;
			const stack: unknown[] = [leaf.view];
			const visited = new Set<unknown>();
			while (stack.length) {
				const current = stack.pop();
				if (!current || typeof current !== 'object' || visited.has(current)) continue;
				visited.add(current);
				const component = current as { containerEl?: unknown; file?: unknown; _children?: unknown };
				if (component.file instanceof TFile
					&& component.file.extension === 'base'
					&& component.containerEl instanceof HTMLElement
					&& component.containerEl.contains(this.containerEl)) {
					found = component.file.path;
					return;
				}
				if (Array.isArray(component._children)) stack.push(...component._children);
			}
		});
		return found;
	}

	private async handleDrop(target: KanbanDropTarget): Promise<void> {
		const groupProperty = this.groupProperty.property;
		if (!groupProperty) return;
		const entry = this.entriesById.get(target.cardId);
		if (!entry) return;

		const card = this.findCard(target.cardId);
		const columnChanged = card?.columnKey !== target.columnKey;
		const laneChanged = this.laneProp !== null && card?.laneKey !== target.laneKey;

		try {
			if (columnChanged) {
				await this.writeProperty(entry.file, groupProperty, this.columnValue(target.columnKey));
			}
			if (laneChanged && this.laneProp) {
				await this.writeProperty(entry.file, this.laneProp, this.laneValue(target.laneKey));
			}
			if (this.orderProp) await this.writeOrder(target);
		} catch (error) {
			console.error('[Views] Kanban drop failed', error);
			new Notice(`Unable to move ${entry.file.basename}.`);
		}
	}

	private findCard(cardId: string): { columnKey: string; laneKey: string } | null {
		return this.cardLocations.get(cardId) ?? null;
	}

	/**
	 * Copies the raw frontmatter value from a note already in the destination
	 * column, so a number, boolean, or date column keeps its type instead of
	 * being flattened to the displayed string.
	 */
	private columnValue(columnKey: string): unknown {
		const groupProperty = this.groupProperty.property;
		if (!groupProperty) return columnKey;
		for (const group of this.data?.groupedData ?? []) {
			if (this.columnKey(group) !== columnKey) continue;
			const sample = group.entries[0];
			if (!sample) break;
			const raw = this.rawFrontmatter(sample.file, groupProperty);
			if (raw !== undefined && raw !== null) return raw;
		}
		return columnKey;
	}

	private laneValue(laneKey: string): unknown {
		if (laneKey === NO_LANE_KEY) return null;
		if (!this.laneProp) return laneKey;
		for (const entry of this.data?.data ?? []) {
			const value = entry.getValue(this.laneProp)?.toString().split(',')[0]?.trim();
			if (value !== laneKey) continue;
			const raw = this.rawFrontmatter(entry.file, this.laneProp);
			if (raw !== undefined && raw !== null) return raw;
		}
		return laneKey;
	}

	private rawFrontmatter(file: TFile, property: string): unknown {
		if (!property.startsWith('note.')) return null;
		const key = property.slice('note.'.length);
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) return null;
		const match = Object.keys(frontmatter).find((candidate) => candidate.toLocaleLowerCase() === key.toLocaleLowerCase());
		return match ? frontmatter[match] : null;
	}

	private async writeProperty(file: TFile, property: string, value: unknown): Promise<void> {
		if (!property.startsWith('note.')) throw new Error(`${property} is not writable`);
		const key = property.slice('note.'.length);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const existing = Object.keys(frontmatter)
				.find((candidate) => candidate.toLocaleLowerCase() === key.toLocaleLowerCase());
			frontmatter[existing ?? key] = value;
		});
	}

	/** Renumbers the destination cell so a manual order survives the drop. */
	private async writeOrder(target: KanbanDropTarget): Promise<void> {
		const orderProperty = this.orderProp;
		if (!orderProperty || !this.lastModel) return;
		const column = this.lastModel.columns.find((candidate) => candidate.key === target.columnKey);
		const ids = (column?.cards.get(target.laneKey) ?? []).filter((id) => id !== target.cardId);
		if (!this.entriesById.has(target.cardId)) return;
		const ordered = [...ids.slice(0, target.index), target.cardId, ...ids.slice(target.index)];
		for (let index = 0; index < ordered.length; index += 1) {
			const entry = this.entriesById.get(ordered[index]);
			if (!entry) continue;
			await this.writeProperty(entry.file, orderProperty, (index + 1) * 10);
		}
	}

}
