import { BasesEntry, BasesPropertyId, BasesView, QueryController, ViewOption } from 'obsidian';
import { buildTreeModel, type TreeGroup, type TreeModel, type TreeNode } from './tree/treeModel';
import { resolveNestLevels } from './tree/treeLevels';
import { TreeOutline } from './tree/TreeOutline';
import { iconViewOptions, readAppearanceConfig, resolveEntryIcons } from './collection/appearance';
import { isPropertyColorEnabled } from './settings/settings';
import { resolveColorPalette, stableColor } from './table-colors/palettes';
import type ViewsPlugin from './main';

// The wire value written into every .base file that uses this view. It can
// never change once a vault has one on disk, the same permanent-id rule
// `SearchViewType` documents in `SearchView.ts`.
export const TreeViewType = 'views-tree';

/** How many `Then nest by` slots the settings pane offers. Four, matching the
 * graph's Connect by slots (`./graph/linkProperties.ts`), because the same
 * argument applies: past three or four levels an outline is deeper than
 * anything a vault actually records, and a fifth empty picker costs every
 * user pane space to serve almost nobody. */
const NEST_SLOTS = 4;

const DEFAULT_EXPAND_DEPTH = 2;

/**
 * The deepest generation `Expand to depth` can be asked to open.
 *
 * The first cut capped this at 6, which was a guess and a wrong one. Nesting
 * is not bounded by the four `Then nest by` slots: `Split nested values` turns
 * one `file.folder` into a row per path segment, so a five-deep folder is
 * already five levels before a single slot is spent, and `Parent property`
 * recurses without any bound at all. A vault here reaches depth 5 on folders
 * alone, which put the note rows at 6 and left the slider unable to open the
 * generation it was sitting on.
 *
 * Twenty is not a claim about how deep a tree can go, only about how deep one
 * can be worth opening on arrival: past this the rows a slider would reveal are
 * far more than a screen holds, and reaching them by clicking is the better
 * interaction anyway. Asking for more than the tree has is harmless, since the
 * outline compares against each row's own depth.
 */
const MAX_EXPAND_DEPTH = 20;

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
	/** The tree as last built, kept only so `persistToggle` can prune saved
	 * rows against what still exists. */
	private lastModel: TreeModel | null = null;

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
					// The base's own Group by supplies the outermost level, so
					// these start at the second: "then nest by". Ordered slots
					// rather than a fixed list of hierarchy kinds, because which
					// hierarchy a vault has is the vault's business, and one vault
					// is folders where another is status over class.
					...nestBySlotKeys().map((key, index) => ({
						displayName: `Then nest by ${index + 1}`,
						type: 'property' as const,
						key,
						filter: () => true,
						placeholder: 'Nests inside the base\'s Group by',
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
						max: MAX_EXPAND_DEPTH,
						step: 1,
						instant: true,
					},
				],
			},
		];
	}

	onDataUpdated(): void {
		const entries = this.data?.data ?? [];
		const typeProperty = this.config.getAsPropertyId('typeProperty');
		const appearance = readAppearanceConfig(this.config);

		const model = this.lastModel = buildTreeModel(this.groups(), {
			nestBy: this.nestByProperties(),
			parentProperty: this.config.getAsPropertyId('parentProperty'),
			splitNestedValues: this.config.get('splitNestedValues') !== false,
			mergeFolderNotes: this.config.get('mergeFolderNotes') !== false,
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

	/**
	 * The base's own groups, which is where the tree's outermost level comes
	 * from.
	 *
	 * `groupedData` is the Bases API's authoritative render projection: Group
	 * by, Sort by, the filters and the results limit are all already applied to
	 * it, and it returns one keyless group when the base has no grouping.
	 * Reading it here rather than rebuilding any of those four as options of
	 * our own is what makes the tree answer to the same menus every other Bases
	 * view answers to. `CollectionView.getVisibleGroups` carries the same note,
	 * having shipped the other way once and flattened every grid into a single
	 * group.
	 */
	private groups(): TreeGroup[] {
		return (this.data?.groupedData ?? [])
			.filter((group) => group.entries.length > 0)
			.map((group) => ({
				key: group.key?.isTruthy() ? group.key.toString() : null,
				entries: group.entries,
			}));
	}

	/**
	 * The nesting properties beneath the group level. The rule itself lives in
	 * `./tree/treeLevels.ts`, pure and tested, because it is a rule about how
	 * three config keys interact and that is exactly the thing that broke.
	 */
	private nestByProperties(): BasesPropertyId[] {
		return resolveNestLevels({
			groupProperty: this.groupProperty(),
			slots: nestBySlotKeys().map((key) => this.config.getAsPropertyId(key)),
			legacyProperty: this.config.getAsPropertyId('hierarchyProperty'),
		});
	}

	/**
	 * The property the base's own Group by names, or null.
	 *
	 * Read off the view config rather than inferred from `groupedData`, because
	 * a group key tells you a value and not which property produced it, and the
	 * dedupe in `resolveNestLevels` needs the property. Bases writes `groupBy`
	 * as `{ property, direction }` and spells the property bare (`file.folder`,
	 * `class`) where a view's own slots spell it `note.class`;
	 * `resolveNestLevels` reconciles the two.
	 */
	private groupProperty(): BasesPropertyId | null {
		const raw = this.config.get('groupBy');
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
		const property = (raw as { property?: unknown }).property;
		return typeof property === 'string' && property.length > 0 ? (property as BasesPropertyId) : null;
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

	/**
	 * Expansion is persisted per view so a tree does not spring back open every
	 * time the query re-runs, and it is stored the way `KanbanView` stores
	 * collapsed swimlanes (`KanbanView.persistLaneCollapse`): plain string
	 * arrays holding only what deviates from the default.
	 *
	 * Two arrays rather than one, because `Expand to depth` gives a row a
	 * default in either direction: a shallow row can be explicitly closed and a
	 * deep one explicitly opened, and a single "collapsed" list cannot say both.
	 *
	 * The previous shape was an object keyed by `TreeNode.id`, which encodes
	 * level indices. Changing the hierarchy renumbered every level, so every
	 * saved key went stale at once, nothing ever pruned them, and a later row
	 * that happened to land on a matching id silently inherited a stranger's
	 * collapse state. One view had accumulated 13 such keys.
	 */
	private restoredExpansion(): Map<string, boolean> {
		const restored = new Map<string, boolean>();
		for (const chain of this.storedList('collapsedRows')) restored.set(chain, false);
		for (const chain of this.storedList('expandedRows')) restored.set(chain, true);
		return restored;
	}

	private storedList(key: string): string[] {
		const raw = this.config.get(key);
		if (!Array.isArray(raw)) return [];
		return raw.filter((value): value is string => typeof value === 'string');
	}

	/**
	 * Records one toggle, then prunes both lists to rows the current model
	 * actually has.
	 *
	 * Pruning on write is what stops the file growing without bound as a user
	 * renames folders or reworks the hierarchy, and it is also what finally
	 * clears the legacy `expanded` object: the first toggle after this ships
	 * writes the new keys and blanks the old one.
	 */
	private persistToggle(chain: string, expanded: boolean): void {
		const live = this.liveChains();
		const collapsed = new Set(this.storedList('collapsedRows'));
		const opened = new Set(this.storedList('expandedRows'));

		collapsed.delete(chain);
		opened.delete(chain);
		if (expanded) opened.add(chain);
		else collapsed.add(chain);

		const keep = (chains: Set<string>): string[] => [...chains].filter((value) => live.has(value));
		this.config.set('collapsedRows', keep(collapsed));
		this.config.set('expandedRows', keep(opened));
		if (this.config.get('expanded') !== null && this.config.get('expanded') !== undefined) {
			this.config.set('expanded', null);
		}
	}

	/** Every chain in the tree as last built, so pruning can tell a row that
	 * still exists from one that does not. */
	private liveChains(): Set<string> {
		const chains = new Set<string>();
		const walk = (nodes: TreeNode[]): void => {
			for (const node of nodes) {
				chains.add(node.chain);
				walk(node.children);
			}
		};
		walk(this.lastModel?.roots ?? []);
		return chains;
	}

	/** A slider option arrives as whatever the config store holds; guard
	 * against a missing or non-numeric value falling through to `NaN`. */
	private numberOption(key: string, fallback: number): number {
		const raw = this.config.get(key);
		const value = typeof raw === 'number' ? raw : Number(raw);
		return Number.isFinite(value) ? value : fallback;
	}
}
