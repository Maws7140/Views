import { BasesEntry, BasesPropertyId, BasesView, QueryController, ViewOption } from 'obsidian';
import { buildTreeModel, type TreeNode, type TreeSortOrder } from './tree/treeModel';
import { TreeOutline } from './tree/TreeOutline';
import { iconViewOptions, readAppearanceConfig, resolveEntryIcons } from './collection/appearance';
import { isPropertyColorEnabled } from './settings/settings';
import { resolveColorPalette, stableColor } from './table-colors/palettes';
import type ViewsPlugin from './main';

// The wire value written into every .base file that uses this view. It can
// never change once a vault has one on disk, the same permanent-id rule
// `SearchViewType` documents in `SearchView.ts`.
export const TreeViewType = 'views-tree';

/** How many `Nest by` slots the settings pane offers. Four, matching the
 * graph's Connect by slots (`./graph/linkProperties.ts`), because the same
 * argument applies: past three or four levels an outline is deeper than
 * anything a vault actually records, and a fifth empty picker costs every
 * user pane space to serve almost nobody. */
const NEST_SLOTS = 4;

const DEFAULT_EXPAND_DEPTH = 2;

export function nestBySlotKeys(): string[] {
	return Array.from({ length: NEST_SLOTS }, (_, index) => `nestBy${index + 1}`);
}

/**
 * The tree, built on its own model rather than on the graph's.
 *
 * The first cut of this view wrapped `GraphRenderer` and derived parenthood
 * from the graph's edge list, which is why `file.folder` drew nothing: a
 * folder is not an edge. It also inherited the whole graph vocabulary, so the
 * pane offered Orphans (meaningless in a tree) while quietly dropping every
 * unlinked note. Both are gone. See `./tree/treeModel.ts` for how hierarchy is
 * derived now, and why it composes out of slots rather than picking one source
 * on the user's behalf.
 */
export class TreeView extends BasesView {
	type = TreeViewType;
	private readonly outline: TreeOutline;
	private readonly unsubscribeColors: () => void;

	constructor(
		private readonly plugin: ViewsPlugin,
		controller: QueryController,
		containerEl: HTMLElement,
	) {
		super(controller);
		this.outline = new TreeOutline(containerEl, this.app, (id, expanded) => this.persistToggle(id, expanded));
		// A colour pack, an override, or the enabled-properties list can change
		// without the query itself changing, so the render needs its own nudge.
		this.unsubscribeColors = this.plugin.onPropertyColorSettingsChanged(() => this.onDataUpdated());
	}

	onunload(): void {
		this.unsubscribeColors();
		this.outline.destroy();
	}

	onResize(): void {
		// The outline is ordinary flow layout and reflows itself. Nothing to do
		// here, unlike the canvas views which have to resize a backing store.
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: 'Hierarchy',
				type: 'group',
				items: [
					// Ordered slots rather than a fixed list of hierarchy kinds.
					// Which hierarchy a vault has is the vault's business: this
					// one is mostly folders, another is `parent` chains, a third
					// is status over class. Each slot adds one level of
					// containers and notes sit at the innermost, so `status`
					// then `class` is as legal as `file.folder` alone.
					...nestBySlotKeys().map((key, index) => ({
						displayName: `Nest by ${index + 1}`,
						type: 'property' as const,
						key,
						filter: () => true,
						placeholder: index === 0 ? 'file.folder for the vault\'s folders' : 'Optional',
					})),
					{
						// Split is what turns a path into levels. Without it
						// `file.folder` gives one flat row per distinct full
						// path, which is the shape of a table, not a tree.
						// Covers nested tags by the same rule.
						displayName: 'Split nested values',
						type: 'toggle',
						key: 'splitNestedValues',
						default: true,
					},
					{
						// Separate from the slots because it is a different
						// question. A slot groups notes under a value; this
						// puts a note under another note, recursively, which is
						// the only way to express a chain more than one level
						// deep from a single property.
						displayName: 'Parent property',
						type: 'property',
						key: 'parentProperty',
						filter: () => true,
						placeholder: 'A note that names its own parent',
					},
					{
						// Most vaults that keep folder notes keep one for
						// nearly every folder. Without this each of them shows
						// as a same-named child inside its own folder.
						displayName: 'Merge folder notes',
						type: 'toggle',
						key: 'mergeFolderNotes',
						default: true,
					},
				],
			},
			// The same Icons group every other view declares, so a row takes the
			// icon its card already has, Notebook Navigator included.
			iconViewOptions([], 'Show row icons'),
			{
				displayName: 'Appearance',
				type: 'group',
				items: [
					{
						displayName: 'Type property',
						type: 'property',
						key: 'typeProperty',
						filter: () => true,
						placeholder: 'What colors a row',
					},
					{
						displayName: 'Show counts',
						type: 'toggle',
						key: 'showCounts',
						default: true,
					},
					{
						displayName: 'Expand to depth',
						type: 'slider',
						key: 'expandToDepth',
						default: DEFAULT_EXPAND_DEPTH,
						min: 0,
						max: 6,
						step: 1,
						instant: true,
					},
					{
						displayName: 'Sort within level',
						type: 'dropdown',
						key: 'sortOrder',
						default: 'name',
						options: { name: 'Name', count: 'Note count', modified: 'Last modified' },
					},
				],
			},
		];
	}

	onDataUpdated(): void {
		const entries = this.data?.data ?? [];
		const typeProperty = this.config.getAsPropertyId('typeProperty');
		const appearance = readAppearanceConfig(this.config);

		const model = buildTreeModel(entries, {
			nestBy: this.nestByProperties(),
			parentProperty: this.config.getAsPropertyId('parentProperty'),
			splitNestedValues: this.config.get('splitNestedValues') !== false,
			mergeFolderNotes: this.config.get('mergeFolderNotes') !== false,
			sortOrder: this.sortOrder(),
			modifiedTimes: this.modifiedTimes(entries),
			// The one piece that genuinely needs `obsidian`, which is why
			// `treeModel.ts` takes it as a parameter and stays pure.
			resolveNotePath: (linkpath, sourcePath) => (
				this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null
			),
		});

		const colorFor = this.colorResolver(entries, typeProperty);
		const iconsFor = this.iconResolver(entries, appearance);

		this.outline.update(model, {
			showCounts: this.config.get('showCounts') !== false,
			expandToDepth: this.numberOption('expandToDepth', DEFAULT_EXPAND_DEPTH),
			colorOf: colorFor,
			iconsOf: iconsFor,
		}, this.restoredExpansion());
	}

	/** The slot values, in order, blanks dropped so an empty slot 2 does not
	 * stop slot 3 from contributing a level. Falls back to the legacy
	 * `hierarchyProperty` key when no slot is set, so a base saved by the
	 * previous build keeps the property it already names. */
	private nestByProperties(): BasesPropertyId[] {
		const slots = nestBySlotKeys()
			.map((key) => this.config.getAsPropertyId(key))
			.filter((value): value is BasesPropertyId => value !== null && String(value).length > 0);
		if (slots.length > 0) return slots;

		const legacy = this.config.getAsPropertyId('hierarchyProperty');
		return legacy !== null && String(legacy).length > 0 ? [legacy] : [];
	}

	private sortOrder(): TreeSortOrder {
		const raw = this.config.get('sortOrder');
		return raw === 'count' || raw === 'modified' ? raw : 'name';
	}

	/** Only built when it is going to be read, because `sortOrder: 'modified'`
	 * is the one order that needs it and reading `stat` per entry is not free
	 * on a base of a couple of thousand notes. */
	private modifiedTimes(entries: BasesEntry[]): Map<string, number> | undefined {
		if (this.sortOrder() !== 'modified') return undefined;
		const times = new Map<string, number>();
		for (const entry of entries) {
			const file = this.app.vault.getFileByPath(entry.file.path);
			if (file) times.set(entry.file.path, file.stat.mtime);
		}
		return times;
	}

	/** Rows are coloured through the same assigner a table or a Kanban board
	 * uses, so a value keeps its colour across views. A container carries the
	 * value it was built from; a note is looked up by path. */
	private colorResolver(entries: BasesEntry[], typeProperty: BasesPropertyId | null): (node: TreeNode) => string | null {
		if (typeProperty === null || !isPropertyColorEnabled(this.plugin.settings, typeProperty)) {
			return () => null;
		}
		const palette = resolveColorPalette(this.plugin.settings.colorPack, this.plugin.settings.customPalette);
		const overrides = this.plugin.settings.propertyValueColorOverrides[String(typeProperty)] ?? {};
		const valueByPath = new Map<string, string>();
		for (const entry of entries) {
			const raw = entry.getValue(typeProperty);
			if (raw !== null && raw !== undefined) valueByPath.set(entry.file.path, String(raw).trim());
		}

		return (node) => {
			const value = node.kind === 'container'
				? node.value
				: valueByPath.get(node.path ?? '') ?? null;
			if (value === null || value.length === 0) return null;
			return overrides[value] ?? stableColor(value, palette);
		};
	}

	private iconResolver(entries: BasesEntry[], appearance: ReturnType<typeof readAppearanceConfig>): (node: TreeNode) => string[] {
		const entryByPath = new Map<string, BasesEntry>();
		for (const entry of entries) entryByPath.set(entry.file.path, entry);

		return (node) => {
			if (node.path !== undefined) {
				const entry = entryByPath.get(node.path);
				if (entry) return resolveEntryIcons(this.app, entry, appearance);
			}
			// A container standing for a value, not a file, has no note to take
			// an icon from. The folder glyph is the honest default: every
			// container is something notes sit inside.
			return node.kind === 'container' ? ['lucide-folder'] : [];
		};
	}

	/** Expansion is persisted per view so a tree does not spring back open
	 * every time the query re-runs. Stored as a flat map of node id to state,
	 * only for rows the user actually toggled. */
	private restoredExpansion(): Map<string, boolean> {
		const raw = this.config.get('expanded');
		const restored = new Map<string, boolean>();
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return restored;
		for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof value === 'boolean') restored.set(id, value);
		}
		return restored;
	}

	private persistToggle(id: string, expanded: boolean): void {
		const raw = this.config.get('expanded');
		const current = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
			? { ...(raw as Record<string, boolean>) }
			: {};
		current[id] = expanded;
		this.config.set('expanded', current);
	}

	/** A slider option arrives as whatever the config store holds; guard
	 * against a missing or non-numeric value falling through to `NaN`. */
	private numberOption(key: string, fallback: number): number {
		const raw = this.config.get(key);
		const value = typeof raw === 'number' ? raw : Number(raw);
		return Number.isFinite(value) ? value : fallback;
	}
}
