import {
	BasesEntry,
	BasesPropertyId,
	BasesView,
	BooleanValue,
	ListValue,
	Notice,
	QueryController,
	SliderOption,
	TFile,
	Value,
	ViewOption,
} from 'obsidian';
import {
	SearchRenderer,
	type SearchGroup,
	type SearchModel,
	type SearchRow,
} from './search/SearchRenderer';
import { ContentIndex, matchesHasFacet, type ContentFacts } from './logic/contentIndex';
import { isPropertyColorEnabled, overrideColorsForProperty } from './settings/settings';
import { ColorAssigner, parseCustomPalette, resolveColorPalette } from './table-colors/palettes';
import { renderPropertyValue } from './ui/PropertyValueRenderer';
import { showFileMenu } from './ui/EntryInteractions';
import { writeBooleanProperty } from './ui/writeBooleanProperty';
import { RenderScheduler } from './performance/RenderScheduler';
import { reportPerformance } from './performance/metrics';
import type ViewsPlugin from './main';

// This view was called Raycast before it was renamed to Search. The wire
// value has to stay 'more-bases-raycast' forever: it is written into every
// .base file that already uses this view, and changing it would orphan them.
export const SearchViewType = 'more-bases-raycast';

/** Above this many rows, pagination turns itself on unless the user has
 * explicitly set it either way. See `buildModel`. */
const LARGE_RESULT_THRESHOLD = 200;

/**
 * Revealing a file is the file explorer's own job and is not in the public API,
 * so the one method needed is declared here rather than casting the app to any.
 */
interface RevealCapableExplorer {
	revealInFolder(file: TFile): void;
}

interface AppWithInternalPlugins {
	internalPlugins?: { getEnabledPluginById(id: string): unknown };
}

interface SearchTextCacheEntry {
	mtime: number;
	text: string;
}

/**
 * Everything a single render's `renderProperties` calls need that does not
 * change per row: the property list, the palette, and whether colors are on
 * for each property. Built once per render instead of recomputed per row,
 * which is what made a large base's render cost scale with
 * rows x properties x enabled-property checks.
 */
interface SearchRenderContext {
	properties: BasesPropertyId[];
	palette: string[] | undefined;
	colorEnabled: Map<BasesPropertyId, boolean>;
	displayNames: Map<BasesPropertyId, string>;
}

export class SearchView extends BasesView {
	type = SearchViewType;
	private readonly containerEl: HTMLElement;
	private readonly renderer: SearchRenderer;
	private readonly entriesByPath = new Map<string, BasesEntry>();
	/** Rebuilt per render, so two values of a property never share a color. */
	private colors: ColorAssigner | null = null;
	private context: SearchRenderContext | null = null;
	/** Values already resolved while building a row's search text, keyed by
	 * path, reused by `renderProperties` instead of calling `entry.getValue`
	 * again for the same property in the same render. Cleared and rebuilt on
	 * every `buildModel`; a cache miss (a row whose search text came from the
	 * per-file cache below) simply falls back to `entry.getValue`. */
	private valuesByPath = new Map<string, (Value | null)[]>();
	/** Per-file, survives across renders. A row's search text only depends on
	 * the file's content and the current title/search-scope/property-order
	 * configuration, so an unrelated vault edit no longer costs every other
	 * row a rebuild, just the one file that actually changed. */
	private readonly searchTextCache = new Map<string, SearchTextCacheEntry>();
	private searchTextSignature = '';
	private readonly scheduler = new RenderScheduler(() => this.flushDataUpdate());
	/** Body-content facts, lazy and bounded: built only for the files a render
	 * is about to show, never swept across the vault. */
	private readonly contentIndex: ContentIndex;
	/** Bumped on every `flushDataUpdate`, so a content-index resolution that is
	 * still in flight when a newer update starts recognises itself as stale
	 * and skips its re-render instead of clobbering the newer one. This is the
	 * same problem `SearchRenderer`'s own `renderGeneration` solves for its
	 * progressive row queue, one level up: here the async step is the whole
	 * content-filtered model, not a batch of rows. */
	private contentGeneration = 0;

	constructor(
		private readonly plugin: ViewsPlugin,
		controller: QueryController,
		scrollEl: HTMLElement,
	) {
		super(controller);
		this.containerEl = scrollEl.createDiv({ cls: 'mbv-raycast-host' });
		this.renderer = new SearchRenderer(this.containerEl, {
			open: (path, newLeaf) => this.openPath(path, newLeaf),
			create: (name) => void this.createNote(name),
			copyLink: (path) => void this.copyLink(path),
			reveal: (path) => this.reveal(path),
			menu: (path, anchor) => this.openMenu(path, anchor),
			renderProperties: (containerEl, path) => this.renderProperties(containerEl, path),
		});
		this.register(this.plugin.onPropertyColorSettingsChanged(() => this.onDataUpdated()));
		this.contentIndex = new ContentIndex(this.app);
		this.registerEvent(this.app.metadataCache.on('changed', (file) => this.contentIndex.invalidate(file.path)));
	}

	onunload(): void {
		this.scheduler.cancel();
		this.renderer.destroy();
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: 'Search',
				type: 'group',
				items: [
					{
						displayName: 'Title',
						type: 'property',
						key: 'titleProperty',
						default: 'file.name',
					},
					{
						displayName: 'Subtitle',
						type: 'dropdown',
						key: 'subtitle',
						default: 'folder',
						options: { folder: 'Folder', path: 'Full path', none: 'None' },
					},
					{
						displayName: 'Search matches',
						type: 'dropdown',
						key: 'searchScope',
						default: 'all',
						options: { all: 'Everything', title: 'Name and title only' },
					},
					{
						// The spec's "search bar only": the field and nothing under it
						// until something is typed.
						displayName: 'Launcher mode',
						type: 'toggle',
						key: 'launcher',
						default: false,
					},
				],
			},
			{
				displayName: 'Content',
				type: 'group',
				items: [
					{
						displayName: 'Content contains',
						type: 'text',
						key: 'contentQuery',
						default: '',
					},
					{
						displayName: 'Has',
						type: 'dropdown',
						key: 'contentHas',
						default: 'any',
						options: {
							any: 'Anything',
							code: 'Code block',
							callout: 'Callout',
							tasks: 'Tasks',
							'open-tasks': 'Open tasks',
						},
					},
				],
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [
					{
						displayName: 'Show properties',
						type: 'toggle',
						key: 'showProperties',
						default: true,
					},
					{
						displayName: 'Row density',
						type: 'dropdown',
						key: 'density',
						default: 'comfortable',
						options: { comfortable: 'Comfortable', compact: 'Compact' },
					},
					{
						displayName: 'Color property values',
						type: 'toggle',
						key: 'propertyValueColors',
						default: true,
					},
					{
						displayName: 'Paginate',
						type: 'toggle',
						key: 'paginate',
						default: false,
					},
					{
						displayName: 'Rows per page',
						type: 'slider',
						key: 'pageSize',
						default: 50,
						min: 10,
						max: 500,
						step: 1,
						// A visual dimension like card width wants live feedback while
						// dragging. This is not that: every tick re-queries and rebuilds
						// the whole list (see `SearchRenderer.renderResults`), so `instant`
						// here turned a drag on a large base into a freeze.
						instant: false,
						shouldHide: (config: { get(key: string): unknown }) => config.get('paginate') !== true,
					} as SliderOption & { shouldHide(config: { get(key: string): unknown }): boolean },
				],
			},
		];
	}

	onDataUpdated(): void {
		// A burst of vault events (any modify, anywhere in the vault, since this
		// re-queries on every one of them) collapses into a single rebuild on the
		// next frame instead of one rebuild per event.
		this.scheduler.schedule();
	}

	private flushDataUpdate(): void {
		const modelStartedAt = performance.now();
		const palette = this.valuePalette();
		this.colors = palette ? new ColorAssigner(palette) : null;
		const properties = this.displayProperties();
		this.context = this.createRenderContext(properties, palette);
		// Reserved before anything else resolves, so the automatic picker never
		// lands a different value on a color the user already chose for it.
		if (this.colors) {
			for (const property of properties) {
				if (!this.context.colorEnabled.get(property)) continue;
				for (const hex of overrideColorsForProperty(this.plugin.settings.propertyValueColorOverrides, property)) {
					this.colors.reserve(property, hex);
				}
			}
		}

		const contentQuery = this.stringConfig('contentQuery', '').trim().toLowerCase();
		const contentHas = this.stringConfig('contentHas', 'any');
		const contentActive = Boolean(contentQuery) || contentHas !== 'any';

		if (!contentActive) {
			const model = this.buildModel(properties, null, false);
			reportPerformance('search model', modelStartedAt, { rows: model.groups.reduce((sum, g) => sum + g.rows.length, 0), properties: properties.length });
			this.renderer.update(model);
			return;
		}

		// Content facts need `vault.cachedRead`, which is async, so this cannot
		// be resolved on the Bases render path (which is sync) without a second
		// pass. Render everything unfiltered first, with a pending indicator, so
		// the view never flashes to an empty list while the read is in flight.
		this.contentGeneration += 1;
		const generation = this.contentGeneration;
		const pendingModel = this.buildModel(properties, null, true);
		reportPerformance('search model', modelStartedAt, { rows: pendingModel.groups.reduce((sum, g) => sum + g.rows.length, 0), properties: properties.length });
		this.renderer.update(pendingModel);

		const files: TFile[] = [];
		for (const path of this.entriesByPath.keys()) {
			const file = this.fileForPath(path);
			if (file) files.push(file);
		}
		void this.contentIndex.resolve(files).then((facts) => {
			// A newer `flushDataUpdate` ran while this resolve was in flight (a
			// vault edit, a config change): its own pass owns the render now, and
			// rebuilding the model here against `this.data` as it stands today
			// would either duplicate that render or race it.
			if (generation !== this.contentGeneration) return;
			const filteredModel = this.buildModel(properties, facts, false);
			this.renderer.update(filteredModel);
		});
	}

	private createRenderContext(properties: BasesPropertyId[], palette: string[] | undefined): SearchRenderContext {
		const colorEnabled = new Map<BasesPropertyId, boolean>();
		const displayNames = new Map<BasesPropertyId, string>();
		for (const property of properties) {
			colorEnabled.set(property, isPropertyColorEnabled(this.plugin.settings, property));
			displayNames.set(property, this.config.getDisplayName(property));
		}
		return { properties, palette, colorEnabled, displayNames };
	}

	/**
	 * `contentFacts` is `null` while no content filter is set at all, or while
	 * one is set but its facts have not resolved yet (the pending first pass).
	 * `contentPending` distinguishes those two: only when it is false and
	 * `contentFacts` is non-null does a row actually get held to the content
	 * filter, so the pending pass renders everything the base returned rather
	 * than an empty list.
	 */
	private buildModel(
		properties: BasesPropertyId[],
		contentFacts: Map<string, ContentFacts> | null,
		contentPending: boolean,
	): SearchModel {
		this.entriesByPath.clear();
		this.valuesByPath = new Map();
		const titleProp = this.config.getAsPropertyId('titleProperty');
		const subtitle = this.stringConfig('subtitle', 'folder');
		const searchProperties = this.stringConfig('searchScope', 'all') !== 'title';
		const contentQuery = this.stringConfig('contentQuery', '').trim().toLowerCase();
		const contentHas = this.stringConfig('contentHas', 'any');
		const filterByContent = contentFacts !== null && !contentPending;

		const signature = JSON.stringify([this.config.getOrder(), titleProp, searchProperties]);
		if (signature !== this.searchTextSignature) {
			this.searchTextCache.clear();
			this.searchTextSignature = signature;
		}

		const groups: SearchGroup[] = [];
		for (const group of this.data?.groupedData ?? []) {
			const rows: SearchRow[] = [];
			let rowIndex = 0;
			for (const entry of group.entries) {
				this.entriesByPath.set(entry.file.path, entry);
				if (filterByContent) {
					const facts = contentFacts?.get(entry.file.path);
					if (contentQuery && !(facts?.text.includes(contentQuery) ?? false)) continue;
					if (!matchesHasFacet(facts, contentHas)) continue;
				}
				const row = this.buildRow(entry, titleProp, subtitle, searchProperties, properties);
				row.key = `${groups.length}:${rowIndex}:${row.path}`;
				rows.push(row);
				rowIndex += 1;
			}
			if (rows.length) groups.push({ key: group.key?.toString() ?? '', rows });
		}

		const rowCount = groups.reduce((sum, group) => sum + group.rows.length, 0);
		const paginateOption = this.config.get('paginate');
		// Bases does not auto-apply declared view-option defaults in this plugin's
		// experience, so `undefined` reliably means "the user never touched this",
		// which is the only signal safe to override. Only `false` is treated as an
		// explicit opt-out.
		const auto = paginateOption === undefined && rowCount > LARGE_RESULT_THRESHOLD;
		const paginate = paginateOption === true || auto;
		const density = this.stringConfig('density', 'comfortable') === 'compact' ? 'compact' : 'comfortable';
		const showProperties = this.config.get('showProperties') !== false;
		const columnSignature = JSON.stringify([
			properties,
			density,
			showProperties,
			Boolean(this.context?.palette),
			this.plugin.settings.tableColorsEnabled,
		]);

		return {
			groups,
			showGroupHeadings: groups.length > 1 || Boolean(groups[0]?.key),
			launcher: this.config.get('launcher') === true,
			showProperties,
			propertyCount: properties.length,
			density,
			placeholder: 'Search',
			emptyNotice: 'This base returned no notes.',
			pageSize: paginate ? this.numberOption('pageSize', 50, 10, 500) : 0,
			autoPaginated: auto,
			columnSignature,
			contentPending,
		};
	}

	private buildRow(
		entry: BasesEntry,
		titleProp: BasesPropertyId | null,
		subtitle: string,
		searchProperties: boolean,
		properties: BasesPropertyId[],
	): SearchRow {
		const title = (titleProp ? entry.getValue(titleProp)?.toString().trim() : '')
			|| entry.file.basename;
		const folder = entry.file.parent?.path ?? '';
		const path = entry.file.path;
		const mtime = entry.file.stat.mtime;
		const cached = this.searchTextCache.get(path);

		let searchText: string;
		if (cached && cached.mtime === mtime) {
			// The file has not changed since this was last computed, so neither has
			// anything the search text or the display values are derived from.
			searchText = cached.text;
		} else {
			// Identity fields are not a display concern, so they are matched
			// unconditionally: file name and path stay searchable even when Title
			// points at a different property or file.name is off the property list.
			const terms = [...new Set([title, entry.file.basename, entry.file.name, entry.file.path])];
			// Matched against what the row actually shows, plus the identity fields
			// above, so a search answers what is on screen and what the file is.
			if (searchProperties) {
				const values: (Value | null)[] = [];
				for (const property of properties) {
					const value = entry.getValue(property);
					values.push(value);
					const text = value?.toString();
					if (text) terms.push(text);
				}
				// Kept for `renderProperties` to reuse in this same render, so the
				// most expensive primitive in the view (`entry.getValue`, which
				// evaluates a formula property) is not paid twice per row.
				this.valuesByPath.set(path, values);
			}
			searchText = terms.join(' ').toLowerCase();
			this.searchTextCache.set(path, { mtime, text: searchText });
		}

		return {
			path,
			key: '', // assigned by the caller once the row's position in the model is known
			title,
			subtitle: subtitle === 'none' ? '' : subtitle === 'path' ? entry.file.path : folder === '' ? '' : folder,
			searchText,
		};
	}

	/**
	 * The properties the user put in the view's own property list, which is the
	 * same list every other view here reads, minus the one already used as the
	 * title so it does not appear twice in one row.
	 */
	private displayProperties(): BasesPropertyId[] {
		const titleProp = this.config.getAsPropertyId('titleProperty');
		return this.config.getOrder().filter((property) => property !== titleProp);
	}

	/**
	 * One cell per property, always, and in the same order. A row that skipped a
	 * value it does not have would shift every later value into the wrong column.
	 * Returns whether any cell in the row holds a list value, so the caller can
	 * mark the row directly instead of leaning on a `:has()` selector.
	 */
	private renderProperties(rowEl: HTMLElement, path: string): boolean {
		const entry = this.entriesByPath.get(path);
		if (!entry || !this.context) return false;
		const cached = this.valuesByPath.get(path);
		let hasList = false;
		this.context.properties.forEach((property, index) => {
			const valueEl = rowEl.createDiv({ cls: 'mbv-ray-prop' });
			const value = cached ? cached[index] : entry.getValue(property);
			if (value === null || value === undefined) return;
			const isBoolean = value instanceof BooleanValue;
			// An unset boolean is still a real checkbox to click, not a value to
			// skip the way a blank text or date property is.
			if (!isBoolean && !value.toString().trim()) return;
			if (value instanceof ListValue) hasList = true;
			const colorsEnabled = this.context?.colorEnabled.get(property) ?? false;
			renderPropertyValue(valueEl, value, {
				app: this.app,
				property,
				displayName: this.context?.displayNames.get(property),
				valueColorPalette: this.context?.palette && colorsEnabled ? this.context.palette : undefined,
				valueColors: colorsEnabled ? this.colors ?? undefined : undefined,
				valueColorOverrides: colorsEnabled ? this.plugin.settings.propertyValueColorOverrides : undefined,
				onBooleanChange: property.startsWith('note.')
					? (checked) => writeBooleanProperty(this.app, entry, property, checked)
					: undefined,
			});
		});
		return hasList;
	}

	private valuePalette(): string[] | undefined {
		if (this.config.get('propertyValueColors') === false) return undefined;
		if (!this.plugin.settings.tableColorsEnabled) return undefined;
		return resolveColorPalette(
			this.plugin.settings.colorPack,
			parseCustomPalette(this.plugin.settings.customPalette),
		);
	}

	private fileForPath(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private openPath(path: string, newLeaf: boolean): void {
		const file = this.fileForPath(path);
		if (!file) return;
		void this.app.workspace.getLeaf(newLeaf).openFile(file);
	}

	/**
	 * Alt+Enter creates what was typed. The folder is Obsidian's own answer for
	 * where a new note belongs, so the view does not invent a location of its own.
	 */
	private async createNote(name: string): Promise<void> {
		const parent = this.app.fileManager.getNewFileParent('');
		const folder = parent.path === '/' ? '' : `${parent.path}/`;
		const base = name.replace(/[\\/:*?"<>|]/g, '-').trim();
		if (!base) return;
		let path = `${folder}${base}.md`;
		// A name that is already taken gets a suffix rather than an error, since
		// the point of the action is that typing a name is enough.
		for (let suffix = 1; this.app.vault.getAbstractFileByPath(path); suffix += 1) {
			path = `${folder}${base} ${suffix}.md`;
		}
		try {
			const file = await this.app.vault.create(path, '');
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			new Notice(`Could not create "${base}": ${error instanceof Error ? error.message : error}`);
		}
	}

	private async copyLink(path: string): Promise<void> {
		const file = this.fileForPath(path);
		if (!file) return;
		const link = this.app.fileManager.generateMarkdownLink(file, '');
		await navigator.clipboard.writeText(link);
		new Notice('Link copied');
	}

	/** The file explorer's own reveal, so the note lands selected in the tree. */
	private reveal(path: string): void {
		const file = this.fileForPath(path);
		if (!file) return;
		const internal = (this.app as unknown as AppWithInternalPlugins).internalPlugins;
		const explorer = internal?.getEnabledPluginById('file-explorer') as RevealCapableExplorer | null;
		if (!explorer?.revealInFolder) {
			new Notice('The file explorer is not enabled.');
			return;
		}
		explorer.revealInFolder(file);
	}

	private openMenu(path: string, anchor: HTMLElement): void {
		const file = this.fileForPath(path);
		if (!file) return;
		const rect = anchor.getBoundingClientRect();
		const event = new MouseEvent('contextmenu', {
			clientX: rect.left + 24,
			clientY: rect.bottom,
		});
		showFileMenu(this.app, file, event);
	}

	private stringConfig(key: string, fallback: string): string {
		const value = this.config.get(key);
		return typeof value === 'string' && value ? value : fallback;
	}

	private numberOption(key: string, fallback: number, min: number, max: number): number {
		const value = this.config.get(key);
		if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
		return Math.min(max, Math.max(min, value));
	}

}
