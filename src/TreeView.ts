import { BasesEntry, BasesPropertyId, BasesView, QueryController, ViewOption } from 'obsidian';
import { GraphRenderer, type GraphColorOptions, type GraphLayoutOptions, type GraphNodeStyle } from './graph/GraphRenderer';
import { buildGraphModel, normalizePropertyId } from './logic/graphModel';
import { iconViewOptions, readAppearanceConfig, resolveEntryIcons } from './collection/appearance';
import { isPropertyColorEnabled } from './settings/settings';
import { resolveColorPalette } from './table-colors/palettes';
import { DEFAULT_FADE_THRESHOLD, FADE_THRESHOLD_MAX, FADE_THRESHOLD_MIN } from './graph/levelOfDetail';
import { linkPropertySlotKeys, resolveLinkProperties } from './graph/linkProperties';
import type ViewsPlugin from './main';

// The wire value written into every .base file that uses this view. It can
// never change once a vault has one on disk, the same permanent-id rule
// `SearchViewType` documents in `SearchView.ts`.
export const TreeViewType = 'views-tree';

/** Matches `GraphView`'s own default so a base switched between the two
 * reads the same cap back rather than silently regaining dropped nodes. */
const DEFAULT_NODE_CAP = 600;

/**
 * The tree is its own view rather than a mode inside the graph, because that
 * is what every other view in this plugin is and because the two answer
 * different questions: the graph asks what a base is shaped like, the tree
 * asks what hangs off what. The settings pane follows from that. There are no
 * force sliders here, no layout shape and no depth cap, because nothing is
 * simulated: `tidyTree.ts` decides every position outright, so a repel slider
 * would be a control that visibly does nothing.
 *
 * `GraphRenderer` is shared, and stays shared. It is the canvas engine (pan,
 * zoom, hit testing, icon rasters, the colour system, the level of detail
 * ladder), none of which is specific to either picture, and it already draws
 * the orthogonal elbow path this view wants. What differs between the two
 * views is which options are offered and what gets passed down, which is
 * exactly what a `BasesView` is for.
 */
export class TreeView extends BasesView {
	type = TreeViewType;
	private readonly renderer: GraphRenderer;
	private readonly unsubscribeColors: () => void;

	constructor(
		private readonly plugin: ViewsPlugin,
		controller: QueryController,
		containerEl: HTMLElement,
	) {
		super(controller);
		this.renderer = new GraphRenderer(containerEl, this.app, {
			// The tree draws every generation it finds, so nothing here
			// proposes a depth. The callback is still required by the
			// renderer's options, and writing the key keeps a base that gets
			// switched over to the graph view from reading back a stale one.
			onDepthChange: (depth) => this.config.set('depth', depth),
		});
		// A colour pack, an override, or the enabled-properties list can change
		// without the query itself changing, so the render needs its own nudge.
		this.unsubscribeColors = this.plugin.onPropertyColorSettingsChanged(() => this.onDataUpdated());
		// The root follows the active note the same way the graph's focus mode
		// does (see `rootSelection.ts`): with no hierarchy property named, the
		// tree is a spanning tree, and which note it is rooted at is the one
		// thing that decides its shape. A double-click re-root still wins,
		// because `selectRoot` checks the explicit override first.
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.onDataUpdated()));
	}

	onunload(): void {
		this.unsubscribeColors();
		this.renderer.destroy();
	}

	onResize(): void {
		this.renderer.resize();
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: 'Tree',
				type: 'group',
				items: [
					{
						// The property that decides parenthood. Empty is a real
						// answer rather than an unset one: with nothing named,
						// the tree is a spanning tree built from link distance,
						// which every base has. Naming one switches to the
						// hierarchy the vault itself records.
						//
						// It only means something for a property that is
						// already drawing edges (a Connect by slot below, or a
						// frontmatter link property), because parenthood is
						// read off the edges. See `treeSource.ts` for why
						// resolving the values a second time here would be a
						// second implementation free to disagree with the
						// first.
						displayName: 'Hierarchy property',
						type: 'property',
						key: 'hierarchyProperty',
						filter: () => true,
						placeholder: 'Parent of each note',
					},
					{
						// Left to right is the default because a vault's
						// hierarchies are usually deep and narrow, and that is
						// the orientation a pane can scroll comfortably.
						displayName: 'Tree direction',
						type: 'dropdown',
						key: 'treeOrientation',
						default: 'leftToRight',
						options: { leftToRight: 'Left to right', topDown: 'Top down' },
					},
					{
						displayName: 'Type property',
						type: 'property',
						key: 'typeProperty',
						filter: () => true,
						placeholder: 'What colors a node',
					},
					// One slot per connectable property, the same four the
					// graph offers and reading the same stored keys, so a base
					// that already has its Connect by set up keeps it when its
					// view is switched to this one.
					...linkPropertySlotKeys().map((key, index) => ({
						displayName: `Connect by ${index + 1}`,
						type: 'property' as const,
						key,
						filter: () => true,
						placeholder: index === 0 ? 'Connect notes sharing a value' : 'Optional',
					})),
					{
						displayName: 'Value node icon',
						type: 'text',
						key: 'valueNodeIcon',
						default: 'lucide-tag',
					},
					{
						displayName: 'Show body links',
						type: 'toggle',
						key: 'showBodyLinks',
						default: false,
					},
				],
			},
			// The same Icons group every other view declares, so a node takes
			// the icon its card already has, Notebook Navigator included.
			iconViewOptions([], 'Show node icons'),
			{
				displayName: 'Appearance',
				type: 'group',
				items: [
					{
						displayName: 'Node style',
						type: 'dropdown',
						key: 'nodeStyle',
						default: 'tiles',
						options: { tiles: 'Tiles', dots: 'Dots' },
					},
					{
						// Spacing between a parent and its children, and the
						// only spread control this view has. It reads the same
						// stored key the graph's own spacing slider does, so
						// the two stay in step for a base that switches views.
						displayName: 'Level spacing',
						type: 'slider',
						key: 'linkDistance',
						default: 120,
						min: 40,
						max: 400,
						step: 10,
						instant: true,
					},
					{
						displayName: 'Arrows',
						type: 'toggle',
						key: 'showArrows',
						default: true,
					},
					{
						displayName: 'Text fade threshold',
						type: 'slider',
						key: 'fadeThreshold',
						default: DEFAULT_FADE_THRESHOLD,
						min: FADE_THRESHOLD_MIN,
						max: FADE_THRESHOLD_MAX,
						step: 5,
						instant: true,
					},
					{
						displayName: 'Node cap',
						type: 'slider',
						key: 'nodeCap',
						default: DEFAULT_NODE_CAP,
						min: 50,
						max: 1000,
						step: 25,
						instant: true,
					},
				],
			},
		];
	}

	onDataUpdated(): void {
		const typeProperty = this.config.getAsPropertyId('typeProperty');
		// Bound once per update rather than per node: reading the config and
		// looking up the Notebook Navigator plugin are the expensive parts, and
		// a tree asks for every node's icon at once.
		const appearance = readAppearanceConfig(this.config);
		const colorOptions: GraphColorOptions = {
			typeProperty,
			palette: resolveColorPalette(this.plugin.settings.colorPack, this.plugin.settings.customPalette),
			overrides: this.plugin.settings.propertyValueColorOverrides,
			colorsEnabled: typeProperty !== null && isPropertyColorEnabled(this.plugin.settings, typeProperty),
		};
		const layoutOptions: GraphLayoutOptions = {
			// Spacing between generations, the one layout number the tree uses.
			linkDistance: this.numberOption('linkDistance', 120),
			// The simulation never runs under `tree` (see `GraphRenderer`'s
			// physics gate), so these four are inert. They are still passed at
			// their documented defaults rather than at zero, so that a base
			// switched over to the graph view does not open on a dead layout.
			repulsion: 50,
			gravity: 0.02,
			linkStrength: 0.35,
			showEdgeLabels: false,
			showArrows: this.config.get('showArrows') !== false,
			// An orphan has no parent and no children, so it is not part of any
			// tree; showing it would put a node on the canvas with nothing
			// connecting it to the picture.
			showOrphans: false,
			maxLinks: 0,
			mode: 'tree',
			// Ignored under `tree`, which draws every generation it finds.
			depth: 1,
			fadeThreshold: this.numberOption('fadeThreshold', DEFAULT_FADE_THRESHOLD),
			nodeStyle: this.config.get('nodeStyle') === 'dots' ? 'dots' : ('tiles' as GraphNodeStyle),
			// Ignored under `tree`: a shape bounds an emergent layout, and
			// nothing here is emergent.
			shape: 'free',
			treeOrientation: this.config.get('treeOrientation') === 'topDown' ? 'topDown' : 'leftToRight',
			// Null, not undefined, when nothing is picked: `GraphRenderer`
			// branches on it to choose the tree source, and "no property" is
			// the spanning-tree default rather than a missing value.
			hierarchyProperty: this.config.getAsPropertyId('hierarchyProperty'),
			// Read here rather than in `GraphRenderer`, which has no business
			// depending on `obsidian`'s workspace for one path string; root
			// selection (`./graph/rootSelection.ts`) only needs the path.
			activeNotePath: this.app.workspace.getActiveFile()?.path ?? null,
		};

		this.renderer.update(buildGraphModel(this.data?.data ?? [], this.app.metadataCache, {
			connectByProperties: resolveLinkProperties(
				linkPropertySlotKeys().map((key) => this.config.get(key)),
				this.config.get('linkProperties'),
			),
			connectByIcon: this.stringOption('valueNodeIcon'),
			includeBodyLinks: this.config.get('showBodyLinks') === true,
			// Group nodes are a graph-view affordance for colouring a cloud by
			// its Group by. A tree takes its structure from parenthood, so a
			// node per group value would be a second, unrelated hierarchy laid
			// over the one the user asked for.
			valueGroups: [],
			valueNodeProperties: this.propertyList('valueNodeProperties'),
			typeProperty,
			// `GraphEntryLike` is the structural subset of `BasesEntry` that
			// graph extraction needs, and every entry here is a real one.
			resolveIcons: (entry) => resolveEntryIcons(this.app, entry as BasesEntry, appearance),
			includeAttachments: this.config.get('includeAttachments') === true,
			includeExternalLinks: this.config.get('includeExternalLinks') === true,
			nodeCap: this.numberOption('nodeCap', DEFAULT_NODE_CAP),
		}), colorOptions, layoutOptions);
	}

	/** A text option arrives as whatever the config store holds. Blank reads as
	 * "not set" rather than as an empty icon spec, so an emptied box falls back
	 * to the node kind's own default glyph instead of drawing nothing. */
	private stringOption(key: string): string | null {
		const raw = this.config.get(key);
		if (typeof raw !== 'string') return null;
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	/** A slider option arrives as whatever the config store holds; guard
	 * against a missing or non-numeric value falling through to `NaN`, which
	 * would otherwise silently break the layout's spacing math. */
	private numberOption(key: string, fallback: number): number {
		const raw = this.config.get(key);
		const value = typeof raw === 'number' ? raw : Number(raw);
		return Number.isFinite(value) ? value : fallback;
	}

	/** Legacy reader for the retired multitext option, kept so a base saved
	 * with `valueNodeProperties` keeps its value nodes. Blank entries are
	 * dropped, and every entry is normalized to a full property id: users typed
	 * bare frontmatter names such as `class` while extraction matches on
	 * `note.class`. */
	private propertyList(key: string): BasesPropertyId[] {
		const raw = this.config.get(key);
		if (!Array.isArray(raw)) return [];
		return raw
			.map((value) => String(value).trim())
			.filter((value) => value.length > 0)
			.map((value) => normalizePropertyId(value));
	}
}
