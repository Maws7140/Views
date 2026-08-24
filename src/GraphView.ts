import { BasesEntry, BasesPropertyId, BasesView, DropdownOption, PropertyOption, QueryController, SliderOption, ViewOption } from 'obsidian';
import { GraphRenderer, type GraphColorOptions, type GraphLayoutOptions, type GraphMode, type GraphNodeStyle } from './graph/GraphRenderer';
import type { LayoutShape } from './graph/layoutShapes';
import { buildGraphModel, normalizePropertyId } from './logic/graphModel';
import { iconViewOptions, readAppearanceConfig, resolveEntryIcons } from './collection/appearance';
import { isPropertyColorEnabled } from './settings/settings';
import { resolveColorPalette } from './table-colors/palettes';
import { centerForceSliderToGravity, linkForceSliderToStrength } from './graph/forceLayout';
import { DEFAULT_FADE_THRESHOLD, FADE_THRESHOLD_MAX, FADE_THRESHOLD_MIN } from './graph/levelOfDetail';
import { resolveShowOrphans } from './graph/orphanVisibility';
import { linkPropertySlotKeys, resolveLinkProperties } from './graph/linkProperties';
import { LAYOUT_SHAPE_LABELS, isLayoutShape } from './graph/layoutShapes';
import type ViewsPlugin from './main';

// The wire value written into every .base file that uses this view. It can
// never change once a vault has one on disk: 'views-graph' is the permanent
// id, the same rule `SearchViewType` documents in `SearchView.ts`.
export const GraphViewType = 'views-graph';

/** Default for the "Node cap" option below. Above this the picture stops
 * being readable well before it stops being drawable, so the cap is about
 * legibility rather than the renderer's limit. `buildGraphModel` keeps the
 * highest-degree nodes and reports what it dropped, and the renderer shows
 * that count rather than truncating silently. */
const DEFAULT_NODE_CAP = 600;

/** Default for the "Depth" slider below: the root and its immediate
 * neighbours, which is the picture in the plan's Capacities reference
 * images and the smallest useful focus-mode graph. */
const DEFAULT_DEPTH = 1;

/** Default for "Center force": `centerForceSliderToGravity(40) ===
 * DEFAULT_FORCE_OPTIONS.gravity`, so adding the slider changes nothing about
 * how an existing base already renders until someone actually moves it. */
const DEFAULT_CENTER_FORCE = 40;

/** Default for "Link force": `linkForceSliderToStrength(50) ===
 * DEFAULT_FORCE_OPTIONS.linkStrength`, for the same reason. */
const DEFAULT_LINK_FORCE = 50;

/** The stored `mode` value, defaulted to focus. `tree` is deliberately not
 * accepted here: the tree is its own view (`TreeView.ts`), not a mode of this
 * one, and a base saved during the brief window when it was a mode reads back
 * as focus rather than as a graph that silently refuses to run its physics. */
function resolveGraphMode(raw: unknown): GraphMode {
	if (raw === 'wholeBase' || raw === 'focus') return raw;
	return 'focus';
}

export class GraphView extends BasesView {
	type = GraphViewType;
	private readonly renderer: GraphRenderer;
	private readonly unsubscribeColors: () => void;

	constructor(
		private readonly plugin: ViewsPlugin,
		controller: QueryController,
		containerEl: HTMLElement,
	) {
		super(controller);
		this.renderer = new GraphRenderer(containerEl, this.app, {
			// "Show more"/"Show less" propose a depth; this is the one place
			// that actually knows how to persist it, same as
			// `HeatmapView.stepYear` and `CalendarView.stepMonth`.
			onDepthChange: (depth) => this.config.set('depth', depth),
		});
		// A color pack, an override, or the enabled-properties list can change
		// without the query itself changing, so the render needs its own nudge.
		this.unsubscribeColors = this.plugin.onPropertyColorSettingsChanged(() => this.onDataUpdated());
		// Focus mode's root follows the active note (root selection's whole
		// point, per `rootSelection.ts`), so switching notes has to re-run
		// `onDataUpdated` the same way a query change does. A double-click
		// override still wins regardless: `selectRoot` checks it first, so this
		// never fights a re-root the user just made by hand.
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
				displayName: 'Graph',
				type: 'group',
				items: [
					{
						displayName: 'Type property',
						type: 'property',
						key: 'typeProperty',
						filter: () => true,
						placeholder: 'What colors and groups a node',
					},
					// One native property dropdown per slot rather than the free-text
					// boxes this used to be, so a link property is picked from the
					// vault's own properties the way every other property input in
					// Bases works. See `linkProperties.ts` for why there are four of
					// them and how the legacy `linkProperties` array still counts.
					...linkPropertySlotKeys().map((key, index) => ({
						displayName: `Connect by ${index + 1}`,
						type: 'property' as const,
						key,
						filter: () => true,
						placeholder: index === 0 ? 'Connect notes sharing a value' : 'Optional',
					})),
					{
						// Every Connect-by value node takes this icon, so a
						// category never wears the same glyph as a note. One
						// icon rather than one per slot: four more pickers to
						// serve a distinction that only has to read at a
						// glance is not a trade worth making.
						displayName: 'Value node icon',
						type: 'text',
						key: 'valueNodeIcon',
						default: 'lucide-tag',
					},
					{
						// Off by default, and that default is the point.
						//
						// Value nodes used to be a property picker of this
						// plugin's own, which a base opted into by naming a
						// property. Moving them onto the base's Group by made
						// them appear on any view that happened to carry a
						// groupBy, which is most of them, since a view copied
						// from a table or a board brings its grouping along.
						// A graph then sprouted a node per group value that
						// nobody asked for, and where the grouped values are
						// themselves links to real notes, that node is a second
						// copy of a note already on the canvas: the real one,
						// which was the biggest node and the hub of its own
						// cluster, now has a synthetic twin next to it.
						displayName: 'Group nodes',
						type: 'toggle',
						key: 'showGroupNodes',
						default: false,
					},
					{
						displayName: 'Show body links',
						type: 'toggle',
						key: 'showBodyLinks',
						default: false,
					},
					{
						displayName: 'Include attachments',
						type: 'toggle',
						key: 'includeAttachments',
						default: false,
					},
					{
						// Off by default: the entries a base hands this view
						// are already filtered, but a link out of one of them
						// resolves against the vault, so drawing every target
						// put filtered-out notes straight back on the canvas.
						displayName: 'Include linked notes outside the base',
						type: 'toggle',
						key: 'includeExternalLinks',
						default: false,
					},
					{
						displayName: 'Edge labels',
						type: 'toggle',
						key: 'showEdgeLabels',
						default: true,
					},
				],
			},
			// The same Icons group every other view declares, so a node takes
			// the icon its card already has, Notebook Navigator included.
			iconViewOptions([], 'Show node icons'),
			{
				displayName: 'Layout',
				type: 'group',
				items: [
					{
						displayName: 'Mode',
						type: 'dropdown',
						key: 'mode',
						default: 'focus',
						options: { focus: 'Focus on a note', wholeBase: 'Whole base' },
					},
					{
						displayName: 'Depth',
						type: 'slider',
						key: 'depth',
						default: DEFAULT_DEPTH,
						min: 1,
						max: 3,
						step: 1,
						instant: true,
						// Obsidian supports this runtime ViewOption predicate even though
						// it is not yet declared in the public type definitions (see the
						// identical cast in CollectionView.ts and SearchView.ts).
						// Focus mode only: whole base has no root to measure
						// hops from.
						shouldHide: (config: { get(key: string): unknown }) => config.get('mode') !== 'focus',
					} as SliderOption & { shouldHide(config: { get(key: string): unknown }): boolean },
					{
						// Whole-base only: focus mode arranges into rings
						// around a root, which is a shape of its own, so a
						// second one on top of it would have nothing to do.
						displayName: 'Shape',
						type: 'dropdown',
						key: 'shape',
						default: 'circle',
						options: LAYOUT_SHAPE_LABELS,
						shouldHide: (config: { get(key: string): unknown }) => config.get('mode') !== 'wholeBase',
					} as DropdownOption & { shouldHide(config: { get(key: string): unknown }): boolean },
					{
						displayName: 'Link distance',
						type: 'slider',
						key: 'linkDistance',
						default: 120,
						min: 40,
						max: 400,
						step: 10,
						instant: true,
					},
					// Obsidian's own vocabulary from here down (Repel force, Center
					// force, Link force, Orphans, Arrows, Text fade threshold, Node
					// style): display names only change from what this view had
					// before. Every stored key below that already existed
					// (`repulsion`, `linkDistance` above, `nodeCap`, `maxLinks`) keeps
					// its exact wire name, so a base saved before this rename still
					// reads back with the same behaviour it had.
					{
						displayName: 'Repel force',
						type: 'slider',
						key: 'repulsion',
						default: 50,
						min: 0,
						max: 100,
						step: 5,
						instant: true,
					},
					{
						// Hidden under a layout shape, where it does nothing:
						// the boundary bounds the graph there, and centring is
						// off so that it can (see `ForceSimulation.tick`). Link
						// distance is the spread control in that mode.
						displayName: 'Center force',
						type: 'slider',
						key: 'centerForce',
						default: DEFAULT_CENTER_FORCE,
						min: 0,
						max: 100,
						step: 5,
						instant: true,
						shouldHide: (config: { get(key: string): unknown }) => (
							config.get('mode') === 'wholeBase' && (config.get('shape') ?? 'circle') !== 'free'
						),
					} as SliderOption & { shouldHide(config: { get(key: string): unknown }): boolean },
					{
						displayName: 'Link force',
						type: 'slider',
						key: 'linkForce',
						default: DEFAULT_LINK_FORCE,
						min: 0,
						max: 100,
						step: 5,
						instant: true,
					},
					{
						displayName: 'Orphans',
						type: 'toggle',
						key: 'showOrphans',
						default: false,
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
						displayName: 'Node style',
						type: 'dropdown',
						key: 'nodeStyle',
						default: 'tiles',
						options: { tiles: 'Tiles', dots: 'Dots' },
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
					{
						displayName: 'Hide nodes with more than N links',
						type: 'slider',
						key: 'maxLinks',
						default: 0,
						min: 0,
						max: 100,
						step: 1,
						instant: true,
					},
				],
			},
		];
	}

	onDataUpdated(): void {
		const typeProperty = this.config.getAsPropertyId('typeProperty');
		// The one icon resolver, bound to this view's config. Bound once per
		// update rather than per node: reading the config and looking up the
		// Notebook Navigator plugin are the expensive parts, and a graph asks
		// for every node's icon at once.
		const appearance = readAppearanceConfig(this.config);
		const colorOptions: GraphColorOptions = {
			typeProperty,
			palette: resolveColorPalette(this.plugin.settings.colorPack, this.plugin.settings.customPalette),
			overrides: this.plugin.settings.propertyValueColorOverrides,
			colorsEnabled: typeProperty !== null && isPropertyColorEnabled(this.plugin.settings, typeProperty),
		};
		const layoutOptions: GraphLayoutOptions = {
			linkDistance: this.numberOption('linkDistance', 120),
			repulsion: this.numberOption('repulsion', 50),
			gravity: centerForceSliderToGravity(this.numberOption('centerForce', DEFAULT_CENTER_FORCE)),
			linkStrength: linkForceSliderToStrength(this.numberOption('linkForce', DEFAULT_LINK_FORCE)),
			showEdgeLabels: this.config.get('showEdgeLabels') !== false,
			showArrows: this.config.get('showArrows') !== false,
			// `showOrphans` is the new key; `hideUnlinked` is what a base saved
			// before this rename still carries. `resolveShowOrphans` prefers the
			// new key and otherwise inverts the legacy one, per
			// `orphanVisibility.ts`'s doc comment on why a straight rename would
			// have silently flipped an explicit "don't hide" into "hide."
			showOrphans: resolveShowOrphans(this.config.get('showOrphans'), this.config.get('hideUnlinked')),
			// 0 is the option's default and means "off": every note in a base
			// has at least a few links once value nodes are in the mix, so a
			// nonzero floor here would silently hide nodes nobody asked to hide.
			maxLinks: this.numberOption('maxLinks', 0),
			mode: resolveGraphMode(this.config.get('mode')),
			depth: this.numberOption('depth', DEFAULT_DEPTH),
			fadeThreshold: this.numberOption('fadeThreshold', DEFAULT_FADE_THRESHOLD),
			nodeStyle: this.config.get('nodeStyle') === 'dots' ? 'dots' : ('tiles' as GraphNodeStyle),
			// A base saved before this option existed carries no `shape` at
			// all, and reads back as the circle every new base gets.
			shape: isLayoutShape(this.config.get('shape')) ? this.config.get('shape') as LayoutShape : 'circle',
			// Required by the shared options type and inert here: this view has
			// no tree mode to reach them from. They belong to `TreeView`.
			treeOrientation: 'leftToRight',
			hierarchyProperty: null,
			// Read here rather than in `GraphRenderer`, which has no business
			// depending on `obsidian`'s workspace for something as small as one
			// path string; root selection (`./graph/rootSelection.ts`) only
			// needs the path itself, not the live `TFile`.
			activeNotePath: this.app.workspace.getActiveFile()?.path ?? null,
		};

		// Value nodes come from the base's own Group by, and only when `Group
		// nodes` asks for them. `groupedData` returns a single keyless group
		// when nothing is grouped, which is the "off" case rather than one node
		// everything hangs off.
		const groups = this.config.get('showGroupNodes') === true ? (this.data?.groupedData ?? []) : [];
		const valueGroups = groups
			.filter((group) => group.key?.isTruthy())
			.map((group) => ({
				label: group.key?.toString() ?? '',
				paths: group.entries.map((entry) => entry.file.path),
			}))
			.filter((group) => group.label.length > 0);

		this.renderer.update(buildGraphModel(this.data?.data ?? [], this.app.metadataCache, {
			// The slots (and the legacy array) now say what to connect notes
			// through rather than which links to filter down to. The filtering
			// role is gone: it was subtractive, so on a vault with one link
			// property it could only ever do nothing or empty the graph.
			connectByProperties: resolveLinkProperties(
				linkPropertySlotKeys().map((key) => this.config.get(key)),
				this.config.get('linkProperties'),
			),
			connectByIcon: this.stringOption('valueNodeIcon'),
			includeBodyLinks: this.config.get('showBodyLinks') === true,
			valueGroups,
			// Only when the base has no grouping of its own: the option that
			// wrote this key is gone, but a base saved with it keeps working
			// until its owner sets a Group by instead.
			valueNodeProperties: valueGroups.length > 0 ? [] : this.propertyList('valueNodeProperties'),
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
	 * would otherwise silently break the simulation's spring and repulsion
	 * math. */
	private numberOption(key: string, fallback: number): number {
		const raw = this.config.get(key);
		const value = typeof raw === 'number' ? raw : Number(raw);
		return Number.isFinite(value) ? value : fallback;
	}

	/** Reads a stored array of property names, the shape the retired multitext
	 * options wrote. `valueNodeProperties` has no option left in the settings
	 * pane but is still read so a base saved with it keeps its value nodes, so
	 * this is now purely a legacy reader. Blank entries are dropped, because a
	 * trailing empty row read as a real property would filter every edge out and
	 * empty the canvas, and every entry is normalized to a full property id:
	 * users typed bare frontmatter names such as `class` while extraction
	 * matches on `note.class`, and until that was reconciled the two never met. */
	private propertyList(key: string): BasesPropertyId[] {
		const raw = this.config.get(key);
		if (!Array.isArray(raw)) return [];
		return raw
			.map((value) => String(value).trim())
			.filter((value) => value.length > 0)
			.map((value) => normalizePropertyId(value));
	}
}
