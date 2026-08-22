import { App, BasesPropertyId, Keymap, TFile } from 'obsidian';
import { DOUBLE_CLICK_DELAY_MS, showFileMenu } from '../ui/EntryInteractions';
import { ColorAssigner } from '../table-colors/palettes';
import { getPropertyValueColorOverride, overrideColorsForProperty } from '../settings/settings';
import { IconRaster, type IconGlyph } from './iconRaster';
import { EMPTY_GRAPH_MODEL, type GraphModel, type GraphNode } from './types';
import { describeGraphNotice, filterModelForView, filterModelToDepth } from './graphFilters';
import { computeDepthsFromRoot } from './graphDepth';
import { computeRadialLayout } from './radialLayout';
import { selectRoot } from './rootSelection';
import { bfsTreeSource, propertyTreeSource, type TreeSourceResult } from './treeSource';
import { computeTidyTree, type TreeOrientation } from './tidyTree';
import {
	DISTANCE_MAX_LINK_FACTOR,
	MAX_SPEED_LINK_FACTOR,
	ForceSimulation,
	repulsionSliderToStrength,
	type Quadtree,
} from './forceLayout';
import { degreeScale, DEGREE_SCALE_CEILING } from './nodeSizing';
import { buildComponentLayout, buildShapedLayout } from './graphComponents';
import { shapeGeometry, shapeSizeForNodes, type LayoutShape } from './layoutShapes';
import { fadeThresholdToLevelOfDetail, DEFAULT_FADE_THRESHOLD } from './levelOfDetail';

/**
 * Canvas drawing, hit testing, pan and zoom for the graph view.
 *
 * Node positions come from `ForceSimulation` (`./forceLayout.ts`), which is
 * plain physics with no DOM or canvas dependency of its own. This file drives
 * it from a `requestAnimationFrame` loop, reads its positions into `layout`
 * for drawing, and reuses its Barnes-Hut quadtree for hit testing rather than
 * keeping a separate uniform grid.
 */

/** Tile side, in world units. World units equal CSS pixels at scale 1. */
const TILE_SIZE = 44;
const TILE_RADIUS = 10;
const ICON_SIZE = 22;
const LABEL_GAP = 6;
const LABEL_MAX_WIDTH = 96;
const LABEL_FONT_SIZE = 11;

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
/** Base dot radius before `degreeScale` is applied (plan item 2, "applies to
 * both node styles"). The level of detail ladder itself (edge labels drop
 * first, then node labels, then tiles collapse to dots) now lives in
 * `levelOfDetail.ts`, scaled by the "Text fade threshold" slider rather than
 * hardcoded here. */
const DOT_RADIUS = 5;

/** Edge label typography and the backing gap that keeps it readable over the
 * line it sits on. */
const EDGE_LABEL_FONT_SIZE = 10;
const EDGE_LABEL_MAX_WIDTH = 90;
const EDGE_LABEL_PADDING_X = 4;
const EDGE_LABEL_PADDING_Y = 2;
/** Perpendicular offset from the line for each of a reciprocal edge's two
 * labels, so `label` (outbound) and `reciprocalLabel` (inbound) sit on
 * opposite sides of the line instead of stacking on top of each other. */
const RECIPROCAL_LABEL_OFFSET = 7;

/** Screen pixels of pointer movement before a mousedown counts as a drag
 * rather than a click, so a slightly shaky click still opens a note. */
const CLICK_DRAG_THRESHOLD = 4;

const DIMMED_ALPHA = 0.25;

/** Alpha the simulation is warmed to while a node is being dragged. A full
 * reheat here is what made the whole graph churn around the cursor: at alpha 1
 * every node in the layout is free to move as far per tick as it did on the
 * first frame after opening. Dragging one node is not a reason to re-run the
 * layout, only a reason to let the neighbourhood respond. */
const DRAG_REHEAT_ALPHA = 0.3;

/** Alpha the simulation is warmed to when a node is dropped. Low on purpose:
 * this is for the neighbours, so collision can push a crowd aside around a node
 * dropped into it, and not for the layout, which has no business rearranging
 * itself because one node was moved by hand. */
const DROP_REHEAT_ALPHA = 0.15;

/** Scope name for the ColorAssigner: one scope per renderer instance is
 * correct because a graph view only ever colors one type property at a time. */
const COLOR_SCOPE = 'graph-type';

export interface GraphColorOptions {
	typeProperty: BasesPropertyId | null;
	palette: string[];
	overrides: Record<string, Record<string, string>>;
	colorsEnabled: boolean;
}

/** 'focus' shows one root's neighbourhood out to `depth` hops, radially laid
 * out; 'wholeBase' is the previous, only behaviour: every node the base and
 * the clutter controls below leave standing, laid out by force alone. Focus
 * is the default because it is the case research (and the Capacities
 * reference) says actually stays legible as a base grows; whole base remains
 * available for the small, already-scoped sets where it still reads well.
 *
 * 'tree' is the rigid tree: parenthood from `treeSource.ts`, positions from
 * the tidy tree in `tidyTree.ts`, and orthogonal elbow connectors instead of
 * straight lines. It is the one mode whose positions are not physics at all,
 * which is why the simulation is held off entirely under it (see `update`):
 * a layout that has already decided where every node belongs has nothing to
 * gain from forces and everything to lose, since the first thing repulsion
 * does to a set of neatly aligned columns is stop them being columns. */
export type GraphMode = 'focus' | 'wholeBase' | 'tree';

/** 'tiles' is the reference design (icon on a tint of the type colour,
 * saturated border) and stays the default; 'dots' is Obsidian's plain-circle
 * style, still drawn in the node's property colour so the colour system
 * survives the switch. Reuses the exact draw branch `render()` already took
 * at low zoom (`dotMode`), rather than a second drawing path: this option
 * just forces that branch on regardless of scale. */
export type GraphNodeStyle = 'tiles' | 'dots';

/** The layout view options declared in `GraphView.getViewOptions` (`Link
 * distance`, `Repel force`, `Center force`, `Link force`, `Edge labels`,
 * `Mode`, `Depth`, `Orphans`, `Arrows`, `Text fade threshold`, `Node style`),
 * wired through to the simulation and the edge label LOD/toggle here. */
export interface GraphLayoutOptions {
	linkDistance: number;
	/** "Repel force" in the settings panel; stored key stays `repulsion`. */
	repulsion: number;
	/** "Center force"; maps onto `ForceOptions.gravity` via
	 * `centerForceSliderToGravity`. */
	gravity: number;
	/** "Link force"; maps onto `ForceOptions.linkStrength` via
	 * `linkForceSliderToStrength`. */
	linkStrength: number;
	showEdgeLabels: boolean;
	/** "Arrows". Defaults on (unlike Obsidian's default off): our edges are
	 * directed property edges where direction carries meaning, unlike an
	 * undirected wikilink. */
	showArrows: boolean;
	/** "Orphans": a show toggle, default off, for degree-0 nodes. The
	 * inverse of the old "Hide unlinked nodes" checkbox; see
	 * `orphanVisibility.ts` for why that flip needed a new stored key rather
	 * than reusing the old one. Most notes in a typical base carry no
	 * frontmatter links at all, and a cloud of isolated tiles under pure
	 * repulsion is the single biggest source of visual noise on first open,
	 * which is why this still defaults to hiding them. */
	showOrphans: boolean;
	/** Drops any node whose degree exceeds this before layout and drawing.
	 * Zero or less means no cap. A base's hub notes (the ones with a couple
	 * dozen `related` links) are the ones that turn the rest of the graph
	 * into a single unreadable knot around them, which "Orphans" does
	 * nothing for since a hub is the opposite of an orphan; this is the
	 * clutter control for that case, matching Capacities' own graph. */
	maxLinks: number;
	mode: GraphMode;
	/** How many hops out from the root focus mode shows, 1 to 3. Ignored in
	 * whole-base mode. */
	depth: number;
	/** "Text fade threshold", 0-100. Scales the level of detail ladder
	 * (`levelOfDetail.ts`) rather than replacing it. */
	fadeThreshold: number;
	/** "Node style": tiles (default) or dots. */
	nodeStyle: GraphNodeStyle;
	/** "Shape": the silhouette the whole-base layout is laid out inside, per
	 * `layoutShapes.ts`. `free` is the unbounded layout this view had before
	 * shapes existed. Ignored in focus mode, which arranges into rings around
	 * a root and so already has a shape of its own. */
	shape: LayoutShape;
	/** "Tree direction": which way the generations march in tree mode. Left
	 * to right is the default because a vault's trees are usually deep and
	 * narrow rather than wide and shallow, and a pane scrolls down more
	 * comfortably than it scrolls across. Ignored outside tree mode. */
	treeOrientation: TreeOrientation;
	/** "Hierarchy property": the property whose value names a node's parent,
	 * or null for the default hop-distance tree. Matched against
	 * `GraphEdge.property`, so it only means something for a property that is
	 * already producing edges (a Connect-by slot, or a frontmatter link
	 * property); see `treeSource.ts` for why parenthood is read off the edges
	 * rather than re-resolved from frontmatter here. Ignored outside tree
	 * mode. */
	hierarchyProperty: BasesPropertyId | null;
	/** `TFile.path` of the active note, or null. `GraphView` reads this from
	 * `app.workspace.getActiveFile()`, since that call needs `obsidian` and
	 * has no business inside this DOM/canvas-only file's root-selection use. */
	activeNotePath: string | null;
}

const DEFAULT_LAYOUT_OPTIONS: GraphLayoutOptions = {
	linkDistance: 120,
	repulsion: 50,
	gravity: 0.02,
	linkStrength: 0.35,
	showEdgeLabels: true,
	showArrows: true,
	showOrphans: false,
	maxLinks: 0,
	mode: 'focus',
	depth: 1,
	fadeThreshold: DEFAULT_FADE_THRESHOLD,
	nodeStyle: 'tiles',
	shape: 'circle',
	treeOrientation: 'leftToRight',
	hierarchyProperty: null,
	activeNotePath: null,
};

/** Clear space between one generation and the next in tree mode, as a
 * multiple of the live "Link distance" slider. Wider than one link distance
 * on purpose: the whole gap between two levels is where the elbow connectors
 * run, and a channel the reader cannot see the shape of is just a thick
 * line. Reusing the existing slider rather than adding a tree-only spacing
 * control follows what `radialLayout.ts` already does with ring spacing. */
const TREE_LEVEL_GAP_FACTOR = 1.2;

/** Clear space between two adjacent siblings in tree mode, in world units.
 * Fixed rather than slider-driven because it is a legibility floor (two
 * tiles and their labels not touching), not a spread control: "Link
 * distance" already moves the levels apart, which is the axis a tree
 * actually needs loosening on. */
const TREE_SIBLING_GAP = 14;

/** Clamps to the depth slider's own range (`GraphView.getViewOptions`, 1 to
 * 3) so a stray config value never asks the radial layout for a ring that
 * does not exist. */
function clampDepth(depth: number): number {
	return Math.min(3, Math.max(1, Math.round(depth)));
}

/** Bounded number of physics ticks to wait for the simulation to settle
 * before fitting the view to content regardless of whether alpha has
 * reached its floor yet. Well short of the ~300-tick full cooling schedule:
 * a graph that is still going to keep drifting slightly at tick 150 is
 * already framed close enough that the remaining settling reads as motion
 * within view rather than as the graph missing the viewport, which is the
 * actual bug being fixed. */
const AUTO_FIT_TICK_BOUND = 150;

/** World-unit padding around the content bounding box when fitting to view,
 * so tiles at the edge are not flush against the pane border. */
const FIT_MARGIN = TILE_SIZE * 2;

interface ThemeColors {
	text: string;
	muted: string;
	edge: string;
	neutralFill: string;
	neutralBorder: string;
	hoverRing: string;
	fontFamily: string;
	canvasBg: string;
}

interface Point {
	x: number;
	y: number;
}

interface ValueColorTriple {
	fill: string;
	border: string;
	glyph: string;
}

interface PointerState {
	down: boolean;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	dragging: boolean;
	hitId: string | null;
}

/** Constructor-time callbacks `GraphView` supplies so this file, which knows
 * nothing of `BasesViewConfig`, can still ask for a config write. Mirrors
 * `HeatmapRenderer`'s `onPeriodChange`/`onStepYear` and `CalendarRenderer`'s
 * `onStepMonth`: the renderer proposes a new value, the view is the one that
 * actually calls `config.set`, and the value round-trips back in on the next
 * `update()` once Bases re-renders. */
export interface GraphRendererOptions {
	/** Called with the next depth (already clamped to 1-3) when "Show more"
	 * or "Show less" is clicked. */
	onDepthChange?: (depth: number) => void;
}

export class GraphRenderer {
	private readonly host: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	private readonly hoverCardEl: HTMLElement;
	private readonly noticeEl: HTMLElement;
	private readonly depthControlsEl: HTMLElement;
	private readonly depthLessBtn: HTMLButtonElement;
	private readonly depthMoreBtn: HTMLButtonElement;
	private readonly depthLabelEl: HTMLElement;
	private readonly pinResetBtn: HTMLButtonElement;
	private readonly icons: IconRaster;
	private readonly resizeObserver: ResizeObserver;
	private readonly onDepthChange?: (depth: number) => void;

	private model: GraphModel = EMPTY_GRAPH_MODEL;
	private nodesById = new Map<string, GraphNode>();
	private layout = new Map<string, Point>();
	private adjacency = new Map<string, Set<string>>();
	/** Nodes in the fixed order labels compete for space in: highest degree
	 * first, id as a tiebreak. Recomputed only on a model change, not every
	 * frame, so the same labels win from frame to frame instead of flickering
	 * as `labelRects` fills up in a different order each time. */
	private labelPriorityOrder: GraphNode[] = [];
	/** World-space bounding boxes of every label already placed this frame
	 * (node labels, then edge labels). A candidate label is skipped rather
	 * than drawn once it would overlap one of these, which is the whole of
	 * the decluttering: nothing more than "does this collide with something
	 * that already won its spot." Rebuilt at the top of every `render()`. */
	private labelRects: { x0: number; y0: number; x1: number; y1: number }[] = [];
	private readonly simulation = new ForceSimulation();
	private simFrameHandle: number | null = null;
	private layoutOptions: GraphLayoutOptions = DEFAULT_LAYOUT_OPTIONS;
	/** The node a drag started on, pinned in the simulation for the duration
	 * of the drag. `GraphRenderer` already treated this as a reserved no-op in
	 * step 2; this is where it gets wired up. */
	private draggingNodeId: string | null = null;
	/** Nodes the user has placed by hand. Held so they can all be released the
	 * moment the layout is re-seeded: a pin only means something while the graph
	 * it was made in is still the graph on screen. */
	private userPinnedIds = new Set<string>();
	/** Every node id ever pinned by a user drag (not the focus-mode root pin,
	 * which `update()` manages on its own). Backs "Reset pinned positions"
	 * (plan item 7): a graph hand-arranged into a corner over several drags
	 * has more than one pin to clear, and this is the record of exactly
	 * which nodes those are, independent of whether any of them is currently
	 * mid-drag. */

	/** The mode the last `update()` ran under, cached so `onDoubleClick` and
	 * `refreshDepthControls` know how to behave without re-reading
	 * `layoutOptions.mode` (they're the same value; this is just the name
	 * the rest of the class reads it by). */
	private mode: GraphMode = DEFAULT_LAYOUT_OPTIONS.mode;
	/** Set by double-clicking a node in focus mode. Cleared implicitly the
	 * moment the node it names is no longer in the filtered model:
	 * `selectRoot` (`./rootSelection.ts`) ignores an explicit root that has
	 * fallen out, so the ordinary active-note/highest-degree fallback simply
	 * resumes rather than this needing to notice and reset itself. */
	private explicitRootId: string | null = null;
	/** The root the last `update()` actually resolved to (null outside focus
	 * mode, or with an empty graph). Tracked separately from
	 * `explicitRootId` so the simulation can pin/unpin exactly the node that
	 * is currently pinned, regardless of why it became root. */
	private currentRootId: string | null = null;
	private pinnedRootId: string | null = null;

	/** The parent/child pairs tree mode draws as elbows, in the order they
	 * should be stroked. Empty outside tree mode.
	 *
	 * Tree mode draws these and nothing else, which is a real decision rather
	 * than an oversight: a base's edge set is a graph, the tree is one
	 * spanning subset of it, and the edges left over are precisely the ones
	 * that do not fit the hierarchy on screen. Drawing them too would put
	 * diagonals across a picture whose entire claim is that every line is
	 * orthogonal and every generation is a column, which is the same mistake
	 * as running forces under a fixed layout: it fights the thing being
	 * built. The relationships are not lost, they are one mode switch away. */
	private treeEdges: { parent: string; child: string }[] = [];

	/** The exact arguments the last real `update()` call was given, replayed
	 * by `reroot()` so double-clicking a node reruns the whole pipeline
	 * (depth, subset, radial layout) as though a fresh `onDataUpdated()` had
	 * arrived with this node as the active one. */
	private lastRawModel: GraphModel = EMPTY_GRAPH_MODEL;
	private lastColorOptions: GraphColorOptions = { typeProperty: null, palette: [], overrides: {}, colorsEnabled: false };
	private lastLayoutOptions: GraphLayoutOptions = DEFAULT_LAYOUT_OPTIONS;

	/** True once the user has panned or zoomed by hand, since the last real
	 * model change. Auto-fit checks this and does nothing while it is true:
	 * the whole point is to frame the graph on open, never to fight a view
	 * the user has already set up themselves. */
	private userAdjustedView = false;
	/** True while waiting for the simulation to settle (or hit
	 * `AUTO_FIT_TICK_BOUND`) after a model change, so the next fit-worthy
	 * moment triggers exactly one auto-fit rather than one every frame. */
	private awaitingAutoFit = false;
	private autoFitTickCount = 0;

	private colorOptions: GraphColorOptions = { typeProperty: null, palette: [], overrides: {}, colorsEnabled: false };
	private colorAssigner: ColorAssigner | null = null;
	private valueColorCache = new Map<string, ValueColorTriple>();
	private theme: ThemeColors = fallbackTheme();

	private width = 1;
	private height = 1;
	private dpr = window.devicePixelRatio || 1;
	private scale = 1;
	private offsetX = 0;
	private offsetY = 0;

	private hoveredId: string | null = null;
	private pointer: PointerState | null = null;
	private pendingOpenTimer: number | null = null;
	private redrawScheduled = false;
	private dprCleanup: (() => void) | null = null;

	constructor(containerEl: HTMLElement, private readonly app: App, options: GraphRendererOptions = {}) {
		this.icons = new IconRaster(app);
		this.onDepthChange = options.onDepthChange;
		this.host = containerEl.createDiv({ cls: 'views-graph-host' });
		this.canvas = this.host.createEl('canvas', { cls: 'views-graph-canvas' });
		this.noticeEl = this.host.createDiv({ cls: 'views-graph-notice' });
		this.hoverCardEl = this.host.createDiv({ cls: 'views-graph-hovercard' });

		this.depthControlsEl = this.host.createDiv({ cls: 'views-graph-depth-controls' });
		this.depthLessBtn = this.depthControlsEl.createEl('button', {
			cls: 'views-graph-depth-btn',
			text: 'Show less',
			attr: { type: 'button' },
		});
		this.depthLabelEl = this.depthControlsEl.createSpan({ cls: 'views-graph-depth-label' });
		this.depthMoreBtn = this.depthControlsEl.createEl('button', {
			cls: 'views-graph-depth-btn',
			text: 'Show more',
			attr: { type: 'button' },
		});
		this.depthLessBtn.addEventListener('click', () => this.stepDepth(-1));
		this.depthMoreBtn.addEventListener('click', () => this.stepDepth(1));

		const ctx = this.canvas.getContext('2d');
		if (!ctx) throw new Error('Graph view: 2d canvas context unavailable.');
		this.ctx = ctx;

		this.attachEvents();
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.host);
		this.watchDevicePixelRatio();
		this.handleResize();
	}

	update(model: GraphModel, colorOptions: GraphColorOptions, layoutOptions: GraphLayoutOptions = DEFAULT_LAYOUT_OPTIONS): void {
		// Cached so `reroot()` can replay this exact call: a double-click needs
		// to redo everything from here down (depth, subset, radial layout) as
		// though a fresh `onDataUpdated()` had arrived with the clicked node as
		// the active one, and this file has no other way to ask for that.
		this.lastRawModel = model;
		this.lastColorOptions = colorOptions;
		this.lastLayoutOptions = layoutOptions;

		// Filtering happens here, not in `buildGraphModel`: that function owns
		// node selection under the node cap and knows nothing about this
		// view-only toggle. `GraphNode.degree` already counts edges touching
		// the node (computed from the same edge list this model carries), so
		// "unlinked" is just "degree zero" with no need to re-walk `edges`.
		// `filterModelForView` still takes a hide flag; `showOrphans` is its
		// negation, per the "Orphans" show toggle `GraphLayoutOptions` docs.
		const filtered = filterModelForView(model, !layoutOptions.showOrphans, layoutOptions.maxLinks);
		this.mode = layoutOptions.mode;

		let effectiveModel = filtered;
		let seedOverrides: ReadonlyMap<string, { x: number; y: number }> | undefined;
		let ringRadii: ReadonlyMap<string, number> | null = null;
		let rootId: string | null = null;
		/** Non-null only in tree mode, where it is the finished layout rather
		 * than a seed the simulation is free to move afterwards. */
		let treeLayout: ReadonlyMap<string, { x: number; y: number }> | null = null;

		if (this.mode === 'tree') {
			this.treeEdges = [];
			rootId = selectRoot({ model: filtered, explicitRootId: this.explicitRootId, activeNotePath: layoutOptions.activeNotePath });
			if (rootId) {
				// Both sources cover every node the filters left standing (see
				// `treeSource.ts`), so unlike focus mode there is no subset to
				// take here: `depths` is only used to drop anything a source
				// could not place, which is nothing today and stays correct if
				// that ever changes.
				const tree = this.buildTree(filtered, rootId, layoutOptions);
				effectiveModel = filterModelToDepth(filtered, tree.depths, Number.POSITIVE_INFINITY);
				treeLayout = computeTidyTree(tree, {
					orientation: layoutOptions.treeOrientation,
					// The extents the renderer actually draws at, widened to the
					// degree scale ceiling so a hub's larger tile does not
					// overhang the slot the layout reserved for it, and to the
					// label's own box on whichever axis the labels stack along:
					// a tree whose tiles clear each other but whose names
					// overlap is not a tidy tree.
					nodeWidth: Math.max(TILE_SIZE * DEGREE_SCALE_CEILING, LABEL_MAX_WIDTH),
					nodeHeight: TILE_SIZE * DEGREE_SCALE_CEILING + LABEL_GAP + LABEL_FONT_SIZE,
					siblingGap: TREE_SIBLING_GAP,
					levelGap: layoutOptions.linkDistance * TREE_LEVEL_GAP_FACTOR,
				});
				for (const [child, parent] of tree.parent) {
					if (treeLayout.has(child) && treeLayout.has(parent)) this.treeEdges.push({ parent, child });
				}
				seedOverrides = treeLayout;
			} else {
				effectiveModel = EMPTY_GRAPH_MODEL;
			}
		} else if (this.mode === 'focus') {
			rootId = selectRoot({ model: filtered, explicitRootId: this.explicitRootId, activeNotePath: layoutOptions.activeNotePath });
			if (rootId) {
				const { depths } = computeDepthsFromRoot(filtered, rootId);
				effectiveModel = filterModelToDepth(filtered, depths, clampDepth(layoutOptions.depth));
				// The radial layout only needs the subset it is about to draw, not
				// the whole filtered base: a node one hop beyond the shown depth
				// has no ring to sit on here regardless of how far the BFS in
				// `computeDepthsFromRoot` could otherwise reach.
				const radial = computeRadialLayout(effectiveModel, rootId, layoutOptions.linkDistance);
				const seeds = new Map<string, { x: number; y: number }>();
				const radii = new Map<string, number>();
				for (const [id, position] of radial) {
					seeds.set(id, { x: position.x, y: position.y });
					// The root has no ring of its own: it is pinned to the origin
					// below instead of radius-constrained, so a ring entry for it
					// would be dead weight `applyRingConstraints` skips anyway
					// (pinned nodes are exempt) but there is no reason to carry it.
					if (id !== rootId) radii.set(id, position.ring * layoutOptions.linkDistance);
				}
				seedOverrides = seeds;
				ringRadii = radii;
			} else {
				effectiveModel = EMPTY_GRAPH_MODEL;
			}
		}
		if (this.mode !== 'tree') this.treeEdges = [];
		this.currentRootId = rootId;

		this.model = effectiveModel;
		this.colorOptions = colorOptions;
		this.nodesById.clear();
		for (const node of effectiveModel.nodes) this.nodesById.set(node.id, node);
		// Computed once here rather than sorted every frame in `render()`: the
		// order only needs to change when the node set or its degrees do, and
		// resorting 600 nodes every frame at 60fps is wasted work `render()`
		// does not need to pay for.
		this.labelPriorityOrder = [...effectiveModel.nodes].sort(
			(a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);

		// A real change to the node/edge set re-warms the simulation, same as a
		// drag. A `linkDistance`/`repulsion` change also counts: those options
		// are inputs to the simulation itself, and leaving them inert once the
		// layout has settled would make the sliders they are wired to pointless
		// after the first few seconds. A mode or depth change counts for the
		// same reason (they change what `effectiveModel` even is), and so does
		// a root change even on the rare occasion it leaves the node set itself
		// unchanged: the whole radial layout is anchored to the root, so a new
		// root means every ring target just moved even if no id did. Anything
		// else that reaches `update` (color settings, a pan-triggered
		// re-render) does not reheat, per the plan's "on model change, on drag,
		// and on nothing else."
		const rootChanged = rootId !== this.pinnedRootId;
		const shapeChanged = layoutOptions.shape !== this.layoutOptions.shape;
		const layoutOptionsChanged =
			layoutOptions.linkDistance !== this.layoutOptions.linkDistance ||
			layoutOptions.repulsion !== this.layoutOptions.repulsion ||
			layoutOptions.gravity !== this.layoutOptions.gravity ||
			layoutOptions.linkStrength !== this.layoutOptions.linkStrength ||
			layoutOptions.mode !== this.layoutOptions.mode ||
			layoutOptions.shape !== this.layoutOptions.shape ||
			// Both tree inputs count for the same reason a shape change does:
			// they change where every node belongs without necessarily
			// changing which nodes there are.
			layoutOptions.treeOrientation !== this.layoutOptions.treeOrientation ||
			layoutOptions.hierarchyProperty !== this.layoutOptions.hierarchyProperty ||
			clampDepth(layoutOptions.depth) !== clampDepth(this.layoutOptions.depth);
		this.layoutOptions = layoutOptions;
		this.simulation.setOptions({
			linkDistance: layoutOptions.linkDistance,
			repulsion: repulsionSliderToStrength(layoutOptions.repulsion),
			gravity: layoutOptions.gravity,
			linkStrength: layoutOptions.linkStrength,
			// Both derived from the live `linkDistance` slider rather than
			// pinned to the default, per `DEFAULT_FORCE_OPTIONS`'s comment: a
			// cutoff or a per-tick speed cap only means something relative to
			// the scale the rest of the layout is drawn at.
			distanceMax: layoutOptions.linkDistance * DISTANCE_MAX_LINK_FACTOR,
			maxSpeed: layoutOptions.linkDistance * MAX_SPEED_LINK_FACTOR,
			// Half the tile side: two node centres closer than a full tile apart
			// means their tiles overlap, which is exactly the collision the
			// simulation resolves per tick.
			collisionRadius: TILE_SIZE / 2,
		});
		this.simulation.setRingRadii(ringRadii);

		// What the renderer actually draws, so collision separates tiles by
		// their real size and a link rests outside both of them. Without this
		// a hub scaled up by degree sits on top of its own neighbours.
		this.simulation.setNodeRadii(new Map(effectiveModel.nodes.map((node) => [
			node.id,
			this.nodeRadius(node.degree),
		])));

		// One centre per connected component in whole-base mode, so a base's
		// islands lay out around its main cluster instead of being dragged
		// through it. Focus mode has its own arrangement (rings around a root)
		// and everything on screen there is reachable from that root anyway,
		// so it keeps the single centre.
		// The layout shape, sized for what is actually on screen so density
		// stays the same as the base grows rather than the graph getting
		// denser inside a fixed outline. Whole-base mode only: focus mode
		// arranges into rings around a root, which is its own shape, and a
		// second boundary on top of that would just fight it.
		const geometry = layoutOptions.mode === 'wholeBase' && layoutOptions.shape !== 'free'
			? shapeGeometry(
				layoutOptions.shape,
				shapeSizeForNodes(
					layoutOptions.shape,
					effectiveModel.nodes.length,
					TILE_SIZE / 2,
					// The Link distance slider doubles as the spread control
					// for a shaped layout, per `shapeSizeForNodes`.
					layoutOptions.linkDistance / DEFAULT_LAYOUT_OPTIONS.linkDistance,
				),
			)
			: null;
		this.simulation.setShape(geometry);

		if (geometry) {
			// A shaped layout has no component centres: it runs with centring
			// off, since a boundary and a centring spring cannot both bound the
			// same layout and the spring wins.
			this.simulation.setComponentCenters(null);
			seedOverrides = buildShapedLayout(effectiveModel.nodes, effectiveModel.edges, geometry).seeds;
		} else if (layoutOptions.mode === 'wholeBase') {
			const components = buildComponentLayout(effectiveModel.nodes, effectiveModel.edges);
			this.simulation.setComponentCenters(components.centers);
			// Seeding a node inside its own component costs nothing and saves
			// the simulation from having to drag it across the graph first.
			seedOverrides = components.seeds;
		} else {
			this.simulation.setComponentCenters(null);
		}

		const graphChanged = this.simulation.setGraph(
			effectiveModel.nodes.map((node) => node.id),
			effectiveModel.edges.map((edge) => ({ source: edge.from, target: edge.to })),
			seedOverrides,
		);

		// A change of shape leaves the node set identical, so nothing above was
		// re-seeded and every node still sits where the old shape left it. Lay
		// them out again from the new fill, or the graph would only ever be
		// nudged in at the edges instead of taking the shape that was asked
		// for.
		if (shapeChanged && !graphChanged && seedOverrides) {
			this.simulation.reseedAll(seedOverrides);
		}

		// Root pinning: unpin whichever node was pinned before (a no-op if
		// nothing was, or if it is no longer in the simulation at all) and pin
		// the new one at the origin, matching "root pinned at the centre."
		// Whole-base mode's `rootId` is always null here, so this also
		// correctly unpins and pins nothing when switching out of focus mode.
		if (rootChanged) {
			if (this.pinnedRootId) this.simulation.unpin(this.pinnedRootId);
			if (rootId) this.simulation.pin(rootId, 0, 0);
			this.pinnedRootId = rootId;
		} else if (rootId) {
			// Re-affirms the pin every update even when the root itself has not
			// changed: cheap, and it is what keeps the root from ever being the
			// one node a stray force nudges before its pin takes effect.
			this.simulation.pin(rootId, 0, 0);
		}

		// Hand-placed nodes are released whenever the layout is re-seeded. The
		// positions they were placed at describe an arrangement that no longer
		// exists, and holding them would leave a node stranded in open space
		// while everything it related to moved.
		if (graphChanged || rootChanged || shapeChanged || treeLayout) {
			for (const id of this.userPinnedIds) this.simulation.unpin(id);
			this.userPinnedIds.clear();
		}

		// Tree mode reseeds unconditionally, and after the unpin above so a
		// hand-dragged node comes back into line with the rest. `setGraph`
		// keeps the position of any id that survived, which is right when
		// positions are physics the layout will settle again and wrong when
		// they are the answer: flipping the orientation, or switching the
		// hierarchy property, leaves the node set identical and every node in
		// the wrong place, and nothing else here would move them.
		if (treeLayout) this.simulation.reseedAll(treeLayout);

		const isRealChange = graphChanged || layoutOptionsChanged || rootChanged;
		// Under a tree layout the simulation is not warmed, prewarmed or
		// stepped at all: every position is already final, so a reheat could
		// only move nodes off the grid the layout just put them on. This is
		// the same reasoning that turns centring off under a layout shape,
		// carried to its end: there, forces and a boundary were two ways of
		// bounding one layout and only one could be in charge; here the layout
		// is fully determined, so the forces have nothing left to decide.
		// `ensureSimulationLoop` refuses to start under this mode as well, so
		// a drag cannot restart the physics behind this check's back.
		if (isRealChange) {
			if (!treeLayout) this.simulation.reheat(1);
			// Arrive arranged. Without this the first painted frame is the raw
			// seeding spiral and the user watches the graph untangle itself,
			// which reads as a mess that sorted itself out rather than as a
			// layout. The tick count is fixed per node count rather than
			// budgeted by wall-clock, so the same base opens the same way
			// every time instead of depending on how busy the machine was.
			//
			// Only when the graph itself changed, never on a slider: the force
			// sliders are `instant`, so prewarming on those would run a burst
			// of ticks on every pixel of a drag, and watching the layout
			// respond is the whole point of dragging one.
			if (!treeLayout && (graphChanged || rootChanged || shapeChanged)) this.prewarm(effectiveModel.nodes.length);
			// A real change is exactly the moment auto-fit should get another
			// turn: the graph just moved out from under any prior fit, and the
			// user has not yet had a chance to react to the new layout, so any
			// pan/zoom they did before this change no longer applies to it.
			this.userAdjustedView = false;
			this.awaitingAutoFit = true;
			this.autoFitTickCount = 0;
		}
		this.syncLayoutFromSimulation();
		this.buildAdjacency(effectiveModel);
		this.ensureSimulationLoop();
		// The simulation loop only runs while `isRunning()`; a change that
		// reheats always starts it, but a change that leaves the simulation
		// already cold (nothing to animate, e.g. re-showing a graph that was
		// already settled) would otherwise never reach the auto-fit check in
		// that loop, so it is resolved once immediately here too.
		// A tree layout never runs the loop that would otherwise resolve this,
		// so its fit is resolved here every time rather than only when the
		// simulation happens to be cold.
		if (isRealChange && (treeLayout !== null || !this.simulation.isRunning())) this.maybeAutoFit();

		// Colors are resolved from the model, not from a frame, so a fresh
		// assigner and an empty cache belong here rather than in render(): two
		// pan frames of the same model must never redistribute a color.
		this.valueColorCache.clear();
		this.colorAssigner = new ColorAssigner(colorOptions.palette);
		if (colorOptions.typeProperty && colorOptions.colorsEnabled) {
			for (const hex of overrideColorsForProperty(colorOptions.overrides, colorOptions.typeProperty)) {
				this.colorAssigner.reserve(COLOR_SCOPE, hex);
			}
		}

		if (this.hoveredId && !this.nodesById.has(this.hoveredId)) this.setHovered(null, 0, 0);
		// Unchanged by the orphan filter on purpose: the node cap and
		// "Orphans" are independent and compose without double accounting.
		// `buildGraphModel` applies the cap first (favouring the
		// highest-degree nodes, `GraphView`'s `NODE_CAP` doc comment), so a
		// disconnected note is already the least likely thing the cap kept in
		// the first place; hiding it afterwards here is a view-only step that
		// says nothing about whether the base's node count exceeded the cap.
		this.updateNotice(describeGraphNotice({
			totalNodes: model.nodes.length,
			drawnNodes: effectiveModel.nodes.length,
			truncated: model.truncated,
			showOrphans: layoutOptions.showOrphans,
			maxLinks: layoutOptions.maxLinks,
		}));
		this.refreshDepthControls();
		this.scheduleRedraw();
	}

	/** Picks the tree source tree mode lays out: the hierarchy property when
	 * one is set, hop distance otherwise. Split out of `update` so the choice
	 * reads as the one decision it is; both sources return the same shape, so
	 * nothing downstream of here knows which was taken. */
	private buildTree(model: GraphModel, rootId: string, layoutOptions: GraphLayoutOptions): TreeSourceResult {
		const property = layoutOptions.hierarchyProperty;
		return property ? propertyTreeSource(model, property, rootId) : bfsTreeSource(model, rootId);
	}

	/** Shows the "Show more" / "Show less" cluster only in focus mode with an
	 * actual root (nothing to step through on an empty graph), and disables
	 * whichever button is already at the depth slider's own range. */
	private refreshDepthControls(): void {
		const visible = this.mode === 'focus' && this.currentRootId !== null;
		this.depthControlsEl.toggleClass('is-visible', visible);
		if (!visible) return;
		const depth = clampDepth(this.layoutOptions.depth);
		this.depthLabelEl.setText(`Depth ${depth}`);
		this.depthLessBtn.disabled = depth <= 1;
		this.depthMoreBtn.disabled = depth >= 3;
	}

	/** "Show more"/"Show less": proposes the next depth through
	 * `onDepthChange`, which `GraphView` wires to `config.set('depth', …)`.
	 * This file never writes the new depth into `layoutOptions` itself; the
	 * value round-trips back in through the next `update()` once Bases
	 * re-renders from the config change, the same way every other stepper in
	 * this plugin (`HeatmapView.stepYear`, `CalendarView.stepMonth`) works. */
	private stepDepth(delta: number): void {
		const next = clampDepth(this.layoutOptions.depth + delta);
		if (next === clampDepth(this.layoutOptions.depth)) return;
		this.onDepthChange?.(next);
	}

	/** Re-roots focus mode on a double-clicked node by replaying the last real
	 * `update()` call with `explicitRootId` now pointing at it, so depth,
	 * subset and radial layout are all recomputed exactly as if this node had
	 * been the active note when a fresh `onDataUpdated()` arrived. */
	private reroot(nodeId: string): void {
		if (this.explicitRootId === nodeId) return;
		this.explicitRootId = nodeId;
		this.update(this.lastRawModel, this.lastColorOptions, this.lastLayoutOptions);
	}

	/** Called by the view's `onResize`, matching `TimelineView`'s convention. */
	resize(): void {
		this.handleResize();
	}

	destroy(): void {
		this.resizeObserver.disconnect();
		this.dprCleanup?.();
		this.cancelPendingOpen();
		this.stopSimulationLoop();
	}

	// ---- Layout and simulation ----------------------------------------------

	/** Copies the simulation's current positions into `layout`, which drawing
	 * and edge trimming read from. Cheap: a plain object copy per node, once
	 * per physics tick or per external position change (a drag). */
	private syncLayoutFromSimulation(): void {
		this.layout = this.simulation.positions();
	}

	/** Starts the physics `requestAnimationFrame` loop if the simulation has
	 * anything to do and nothing is already scheduled. Idempotent, so it is
	 * safe to call after every `update()` and every drag pin. */
	private ensureSimulationLoop(): void {
		if (this.simFrameHandle !== null) return;
		// Never under a tree layout: positions there are decided, not settled,
		// and the only thing a tick could do is undo them. This is the single
		// gate rather than one check per reheat call site, so a future caller
		// cannot restart the physics by adding a reheat somewhere new.
		if (this.mode === 'tree') return;
		if (!this.simulation.isRunning()) return;
		const step = () => {
			// A frame scheduled before the mode changed is still in flight when
			// tree mode arrives, and one tick is enough to shake a finished
			// layout apart. Checked here rather than only at scheduling time
			// because there is no way to un-schedule the frame that is already
			// on its way.
			if (this.mode === 'tree') {
				this.simFrameHandle = null;
				return;
			}
			const stillRunning = this.simulation.tick();
			this.syncLayoutFromSimulation();
			if (this.awaitingAutoFit) {
				this.autoFitTickCount += 1;
				if (!stillRunning || this.autoFitTickCount >= AUTO_FIT_TICK_BOUND) this.maybeAutoFit();
			}
			this.render();
			// The cooling schedule is the point: once alpha has decayed below
			// its floor, the frame is cancelled and nothing more is scheduled,
			// rather than a permanently warm loop costing a frame in a pane
			// nobody is looking at.
			this.simFrameHandle = stillRunning ? requestAnimationFrame(step) : null;
		};
		this.simFrameHandle = requestAnimationFrame(step);
	}

	/** Resolves the pending auto-fit armed by `update()`: fits the view to
	 * content unless the user has already panned or zoomed since, either way
	 * clearing the "waiting" flag so this only fires once per model change. */
	private maybeAutoFit(): void {
		this.awaitingAutoFit = false;
		if (this.userAdjustedView) return;
		this.fitToView();
	}

	/** Fits pan and zoom to the current node positions' bounding box, with a
	 * fixed world-unit margin. This is what puts the graph in frame on open
	 * instead of leaving it wherever the physics happened to settle: even a
	 * well-shaped layout is useless if it lands outside the viewport with no
	 * way to find it. */
	private fitToView(): void {
		if (this.model.nodes.length === 0) return;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const node of this.model.nodes) {
			const pos = this.layout.get(node.id);
			if (!pos) continue;
			if (pos.x < minX) minX = pos.x;
			if (pos.x > maxX) maxX = pos.x;
			if (pos.y < minY) minY = pos.y;
			if (pos.y > maxY) maxY = pos.y;
		}
		if (!Number.isFinite(minX)) return;

		const contentWidth = Math.max(maxX - minX, 1) + FIT_MARGIN * 2;
		const contentHeight = Math.max(maxY - minY, 1) + FIT_MARGIN * 2;
		const nextScale = clamp(Math.min(this.width / contentWidth, this.height / contentHeight), MIN_SCALE, MAX_SCALE);

		const centerX = (minX + maxX) / 2;
		const centerY = (minY + maxY) / 2;
		this.scale = nextScale;
		this.offsetX = -centerX * nextScale;
		this.offsetY = -centerY * nextScale;
		this.scheduleRedraw();
	}

	private stopSimulationLoop(): void {
		if (this.simFrameHandle !== null) {
			cancelAnimationFrame(this.simFrameHandle);
			this.simFrameHandle = null;
		}
	}

	/** Hit test through the same quadtree the simulation built for its last
	 * force accumulation, rather than a separate uniform grid: the plan calls
	 * for reusing it when that composes cleanly, and it does here because the
	 * quadtree already indexes every node's exact position by id. */
	private hitTest(worldX: number, worldY: number): GraphNode | null {
		// Widened by the degree scale ceiling so a hub's larger tile is still
		// hit-testable at its own edge, not just the box an unscaled tile
		// would have occupied; the nearest-candidate loop below still resolves
		// ties correctly for anything smaller that also falls in this box.
		const half = (TILE_SIZE * DEGREE_SCALE_CEILING) / 2;
		const quad: Quadtree = this.simulation.getQuadtree();
		const candidates = quad.queryBox(worldX - half, worldY - half, worldX + half, worldY + half);
		if (candidates.length === 0) return null;
		let bestId = candidates[0];
		let bestDist = Infinity;
		for (const id of candidates) {
			const pos = this.layout.get(id);
			if (!pos) continue;
			const dist = Math.hypot(pos.x - worldX, pos.y - worldY);
			if (dist < bestDist) {
				bestDist = dist;
				bestId = id;
			}
		}
		return this.nodesById.get(bestId) ?? null;
	}

	private buildAdjacency(model: GraphModel): void {
		this.adjacency.clear();
		for (const edge of model.edges) {
			this.linkAdjacent(edge.from, edge.to);
			this.linkAdjacent(edge.to, edge.from);
		}
	}

	private linkAdjacent(a: string, b: string): void {
		let set = this.adjacency.get(a);
		if (!set) {
			set = new Set();
			this.adjacency.set(a, set);
		}
		set.add(b);
	}

	// ---- Coordinate transforms --------------------------------------------

	private worldToScreen(x: number, y: number): Point {
		return {
			x: this.width / 2 + this.offsetX + x * this.scale,
			y: this.height / 2 + this.offsetY + y * this.scale,
		};
	}

	private screenToWorld(x: number, y: number): Point {
		return {
			x: (x - this.width / 2 - this.offsetX) / this.scale,
			y: (y - this.height / 2 - this.offsetY) / this.scale,
		};
	}

	// ---- Sizing and DPR -----------------------------------------------------

	private handleResize(): void {
		const rect = this.host.getBoundingClientRect();
		this.width = Math.max(1, Math.round(rect.width));
		this.height = Math.max(1, Math.round(rect.height));
		this.dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
		this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
		this.canvas.style.width = `${this.width}px`;
		this.canvas.style.height = `${this.height}px`;
		this.scheduleRedraw();
	}

	/** `ResizeObserver` does not fire on a DPR change alone (dragging the
	 * window to a monitor with a different scale factor), so a media query
	 * tuned to the current ratio is used instead. It fires once and is
	 * re-armed at the new ratio each time, since a `matchMedia` query does not
	 * track a moving target on its own. */
	private watchDevicePixelRatio(): void {
		const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		const listener = () => {
			this.handleResize();
			this.watchDevicePixelRatio();
		};
		query.addEventListener('change', listener, { once: true });
		this.dprCleanup = () => query.removeEventListener('change', listener);
	}

	private scheduleRedraw(): void {
		if (this.redrawScheduled) return;
		this.redrawScheduled = true;
		requestAnimationFrame(() => {
			this.redrawScheduled = false;
			this.render();
		});
	}

	// ---- Drawing ------------------------------------------------------------

	private render(): void {
		// Once per frame, not per node: exactly the cost the plan calls out.
		this.theme = readThemeColors(this.host);

		const ctx = this.ctx;
		ctx.save();
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.clearRect(0, 0, this.width, this.height);
		ctx.translate(this.width / 2 + this.offsetX, this.height / 2 + this.offsetY);
		ctx.scale(this.scale, this.scale);

		const lod = fadeThresholdToLevelOfDetail(this.layoutOptions.fadeThreshold);
		// "Dots" forces the same low-zoom draw branch on regardless of scale
		// (plan item 2, reusing rather than duplicating the draw path) but,
		// unlike the ladder's own low-zoom case, does not itself hide labels:
		// a deliberately chosen dot still gets a name at a zoom level that
		// would keep a tile's label too. Label visibility is driven by scale
		// against the ladder alone, which already implies `!dotMode` from the
		// zoom cutoff (`labelMinScale` is always >= `dotMinScale`, per
		// `levelOfDetail.ts`) whenever it is the zoom, not the node style
		// option, doing the collapsing.
		const dotMode = this.layoutOptions.nodeStyle === 'dots' || this.scale < lod.dotMinScale;
		const showLabels = this.scale >= lod.labelMinScale;
		// Top of the same ladder: edge labels need more room than a node label,
		// so they are the first thing dropped when zooming out.
		const showEdgeLabels = this.scale >= lod.edgeLabelMinScale;

		this.drawEdges(ctx, dotMode);
		let hoveredNode: GraphNode | null = null;
		for (const node of this.model.nodes) {
			if (node.id === this.hoveredId) {
				hoveredNode = node;
				continue;
			}
			this.drawNode(ctx, node, dotMode, false);
		}
		// The hovered tile draws last so a raised node is never covered by a
		// neighbor that happens to sit later in the node list.
		if (hoveredNode) this.drawNode(ctx, hoveredNode, dotMode, true);

		// Reset once per frame: a label that lost its spot on the last frame
		// gets a fresh chance on this one, since positions may have moved.
		this.labelRects = [];
		if (showLabels) this.drawNodeLabels(ctx);
		this.drawEdgeLabels(ctx, showEdgeLabels);

		ctx.restore();
	}

	/**
	 * Node labels, one pass over `labelPriorityOrder` (highest degree first,
	 * with the hovered node always drawn regardless of degree since that is
	 * the one label the user just asked to see). A label is skipped, not
	 * shrunk or repositioned, once it would overlap a label already placed
	 * this frame: simple, and it is what keeps the same labels winning frame
	 * to frame rather than flickering as positions drift by a pixel.
	 */
	private drawNodeLabels(ctx: CanvasRenderingContext2D): void {
		ctx.font = `${LABEL_FONT_SIZE}px ${this.theme.fontFamily}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';

		if (this.hoveredId) {
			const hovered = this.nodesById.get(this.hoveredId);
			if (hovered) this.placeNodeLabel(ctx, hovered, true);
		}
		for (const node of this.labelPriorityOrder) {
			if (node.id === this.hoveredId) continue;
			this.placeNodeLabel(ctx, node, false);
		}
	}

	/** Measures and, unless `force` is false and it would overlap a label
	 * already placed this frame, draws one node's label and reserves its box
	 * in `labelRects`. */
	private placeNodeLabel(ctx: CanvasRenderingContext2D, node: GraphNode, force: boolean): void {
		const pos = this.layout.get(node.id);
		if (!pos) return;
		const label = truncateToWidth(ctx, node.label, LABEL_MAX_WIDTH);
		const width = ctx.measureText(label).width;
		const top = pos.y + TILE_SIZE / 2 + LABEL_GAP;
		const rect = { x0: pos.x - width / 2, y0: top, x1: pos.x + width / 2, y1: top + LABEL_FONT_SIZE };
		if (!force && this.rectOverlapsPlaced(rect)) return;

		const dimmed = this.hoveredId !== null && node.id !== this.hoveredId && !this.adjacency.get(this.hoveredId ?? '')?.has(node.id);
		ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
		ctx.fillStyle = this.theme.text;
		ctx.fillText(label, pos.x, top);
		ctx.globalAlpha = 1;
		this.labelRects.push(rect);
	}

	private rectOverlapsPlaced(rect: { x0: number; y0: number; x1: number; y1: number }): boolean {
		for (const placed of this.labelRects) {
			if (rect.x0 < placed.x1 && rect.x1 > placed.x0 && rect.y0 < placed.y1 && rect.y1 > placed.y0) return true;
		}
		return false;
	}

	/**
	 * Tree mode's connectors: orthogonal elbows, one shared channel per
	 * parent.
	 *
	 * The channel is what makes the picture read as an org chart rather than
	 * as a fan. Each parent's children all leave through one stub on the
	 * parent's own edge, that stub runs half way to the next generation, and
	 * the turn happens on a single line shared by every sibling. Giving each
	 * child its own diagonal (or its own channel at its own offset) produces
	 * the same information and none of the structure: the shared trunk is the
	 * visual statement that these nodes are siblings, and it is drawn once
	 * per child only because a canvas path is cheaper to repeat than to
	 * deduplicate.
	 *
	 * The channel sits on the main axis (horizontal under `leftToRight`,
	 * vertical under `topDown`) at the midpoint of the gap between the two
	 * generations, which is why `TREE_LEVEL_GAP_FACTOR` opens that gap wider
	 * than one link distance: the channel needs room to be seen as a channel.
	 *
	 * Both ends are trimmed by the same `nodeInset` straight edges use, so
	 * "Node style: dots" still lands the line on the dot rather than under a
	 * tile that is not being drawn, and an arrowhead still marks the child
	 * end when "Arrows" is on. The arrow is oriented along the final segment
	 * alone, which is the segment that actually enters the node, so it points
	 * square into the child the way the reference images do rather than along
	 * the notional straight line between the two centres.
	 */
	private drawTreeEdges(ctx: CanvasRenderingContext2D, dotMode: boolean): void {
		if (this.treeEdges.length === 0) return;
		ctx.lineWidth = 1 / this.scale;
		// Mitred rather than rounded: the corner is the point of an elbow, and
		// a rounded join at this stroke width reads as a wobble in the line.
		ctx.lineCap = 'butt';
		ctx.lineJoin = 'miter';
		const horizontal = this.layoutOptions.treeOrientation === 'leftToRight';

		for (const { parent, child } of this.treeEdges) {
			const from = this.layout.get(parent);
			const to = this.layout.get(child);
			if (!from || !to) continue;

			const dimmed = this.hoveredId !== null && parent !== this.hoveredId && child !== this.hoveredId;
			ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
			ctx.strokeStyle = this.theme.edge;

			const fromInset = this.nodeInset(parent, dotMode);
			const toInset = this.nodeInset(child, dotMode);
			// `direction` is +1 when the child sits further along the main axis
			// than its parent and -1 otherwise. It is always +1 for the layout
			// as computed, but reading it off the positions rather than
			// assuming it keeps the elbow correct for a node the user has
			// dragged somewhere the layout did not put it.
			const alongFrom = horizontal ? from.x : from.y;
			const alongTo = horizontal ? to.x : to.y;
			const direction = alongTo >= alongFrom ? 1 : -1;
			const exit = alongFrom + fromInset * direction;
			const entry = alongTo - toInset * direction;
			const channel = (exit + entry) / 2;
			const acrossFrom = horizontal ? from.y : from.x;
			const acrossTo = horizontal ? to.y : to.x;

			ctx.beginPath();
			if (horizontal) {
				ctx.moveTo(exit, acrossFrom);
				ctx.lineTo(channel, acrossFrom);
				ctx.lineTo(channel, acrossTo);
				ctx.lineTo(entry, acrossTo);
			} else {
				ctx.moveTo(acrossFrom, exit);
				ctx.lineTo(acrossFrom, channel);
				ctx.lineTo(acrossTo, channel);
				ctx.lineTo(acrossTo, entry);
			}
			ctx.stroke();

			if (this.layoutOptions.showArrows) {
				const tip = horizontal ? { x: entry, y: acrossTo } : { x: acrossTo, y: entry };
				const tail = horizontal ? { x: channel, y: acrossTo } : { x: acrossTo, y: channel };
				// A child sitting on its parent's own channel line has a
				// zero-length final segment and no direction to point along, so
				// the arrow is placed along the main axis instead of being
				// derived from two identical points.
				const degenerate = Math.hypot(tip.x - tail.x, tip.y - tail.y) < 0.5;
				const fallback = horizontal
					? { x: entry - direction, y: acrossTo }
					: { x: acrossTo, y: entry - direction };
				drawArrowhead(ctx, degenerate ? fallback : tail, tip, this.theme.edge);
			}
		}
		ctx.globalAlpha = 1;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
	}

	private drawEdges(ctx: CanvasRenderingContext2D, dotMode: boolean): void {
		if (this.mode === 'tree') {
			this.drawTreeEdges(ctx, dotMode);
			return;
		}
		if (!this.model.edges.length) return;
		// Divided by scale so the stroke stays a constant 1 screen pixel wide
		// regardless of zoom, rather than thickening as the view zooms in.
		ctx.lineWidth = 1 / this.scale;
		ctx.lineCap = 'round';
		for (const edge of this.model.edges) {
			const from = this.layout.get(edge.from);
			const to = this.layout.get(edge.to);
			if (!from || !to) continue;

			const dimmed = this.hoveredId !== null && edge.from !== this.hoveredId && edge.to !== this.hoveredId;
			ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
			ctx.strokeStyle = this.theme.edge;

			// Each end trims by that node's own degree-scaled size (plan item 2
			// applies to the edges' endpoints too, not just the tile/dot itself),
			// so a line still stops flush against a hub's larger tile instead of
			// running under it.
			const fromInset = this.nodeInset(edge.from, dotMode);
			const toInset = this.nodeInset(edge.to, dotMode);
			const trimmed = trimLine(from, to, fromInset, toInset);
			ctx.beginPath();
			ctx.moveTo(trimmed.from.x, trimmed.from.y);
			ctx.lineTo(trimmed.to.x, trimmed.to.y);
			ctx.stroke();

			if (this.layoutOptions.showArrows) {
				drawArrowhead(ctx, trimmed.from, trimmed.to, this.theme.edge);
				if (edge.reciprocal) drawArrowhead(ctx, trimmed.to, trimmed.from, this.theme.edge);
			}
		}
		ctx.globalAlpha = 1;
	}

	/** Half the width of a node's drawn tile, which is what the simulation
	 * separates by and rests links outside of. Tiles rather than dots even
	 * when the Dots style is chosen: the style can be switched at any time
	 * without relaying out, and laying out for the smaller of the two would
	 * put tiles on top of each other the moment it was switched back. */
	private nodeRadius(degree: number): number {
		return (TILE_SIZE * degreeScale(degree)) / 2;
	}

	/**
	 * Runs the opening ticks before the first paint, so the graph appears
	 * arranged and then refines rather than appearing as a knot.
	 *
	 * The budget shrinks as the graph grows, because a tick costs roughly
	 * `n log n`: a small graph can afford to arrive almost settled, and a
	 * large one still gets enough ticks to be past the explosive opening
	 * without stalling the frame that opens the view.
	 */
	private prewarm(nodeCount: number): void {
		if (nodeCount === 0) return;
		const ticks = clamp(Math.round(4000 / Math.max(1, nodeCount)), 8, 120);
		for (let i = 0; i < ticks; i += 1) {
			if (!this.simulation.tick()) break;
		}
	}

	/** World-unit distance from a node's centre to the edge of its drawn
	 * shape, plus a small gap, for `trimLine`. Reads the node's degree
	 * straight from `nodesById` rather than threading it through the edge
	 * list, since `GraphEdge` only carries ids. */
	private nodeInset(nodeId: string, dotMode: boolean): number {
		const scale = degreeScale(this.nodesById.get(nodeId)?.degree ?? 0);
		return dotMode ? DOT_RADIUS * scale + 2 : (TILE_SIZE * scale) / 2 + 2;
	}

	/**
	 * Edge labels, drawn at each edge's midpoint, oriented with the line and
	 * flipped so the text is never upside down, with a filled backing in the
	 * canvas background color so it reads over the line underneath it.
	 *
	 * A reciprocal edge carries two labels (`label` outbound, `reciprocalLabel`
	 * inbound). Both are shown, on opposite sides of the line rather than
	 * stacked: `label` above, `reciprocalLabel` below. A non-reciprocal edge
	 * shows its single label centered directly on the line.
	 *
	 * Two things keep a dense knot of edges (`staus` on every one of them,
	 * the bug that motivated this) from turning into the same mush node
	 * labels used to be: a label is dropped, not shrunk, once it would
	 * overlap a label already placed this frame (node labels first, so an
	 * edge label never covers one) via the same `labelRects`/`rectOverlapsPlaced`
	 * node labels use; and a label is not drawn at all on an edge shorter
	 * than the label's own text width, since there is no room to sit it on
	 * the line without it spilling over both endpoints' tiles regardless of
	 * where it is placed along the line.
	 */
	private drawEdgeLabels(ctx: CanvasRenderingContext2D, visible: boolean): void {
		// Off in tree mode: these are drawn at an edge's midpoint along a
		// straight line between two centres, and in that mode no such line
		// exists to sit on. A label placed there would land in open space,
		// usually on top of the elbow channel it is not describing. The one
		// property a tree edge could be labelled with is the hierarchy
		// property, which is the same word on every edge in the graph.
		if (this.mode === 'tree') return;
		if (!visible || !this.layoutOptions.showEdgeLabels || !this.model.edges.length) return;
		ctx.font = `${EDGE_LABEL_FONT_SIZE}px ${this.theme.fontFamily}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		for (const edge of this.model.edges) {
			const hasReciprocalLabel = edge.reciprocal && Boolean(edge.reciprocalLabel);
			if (!edge.label && !hasReciprocalLabel) continue;
			const from = this.layout.get(edge.from);
			const to = this.layout.get(edge.to);
			if (!from || !to) continue;

			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const edgeLength = Math.hypot(dx, dy);

			const midX = (from.x + to.x) / 2;
			const midY = (from.y + to.y) / 2;
			let angle = Math.atan2(dy, dx);
			// Flip past vertical so the text always reads left to right rather
			// than upside down, regardless of which end `from`/`to` happen to be.
			if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;

			const dimmed = this.hoveredId !== null && edge.from !== this.hoveredId && edge.to !== this.hoveredId;

			if (hasReciprocalLabel) {
				if (edge.label) this.placeEdgeLabel(ctx, edge.label, midX, midY, angle, -RECIPROCAL_LABEL_OFFSET, edgeLength, dimmed);
				this.placeEdgeLabel(ctx, edge.reciprocalLabel as string, midX, midY, angle, RECIPROCAL_LABEL_OFFSET, edgeLength, dimmed);
			} else if (edge.label) {
				this.placeEdgeLabel(ctx, edge.label, midX, midY, angle, 0, edgeLength, dimmed);
			}
		}
		ctx.globalAlpha = 1;
	}

	/** Measures a label in the edge's rotated local space (`x` along the
	 * line, `y` perpendicular to it, `yOffset` a further perpendicular shift
	 * for a reciprocal edge's second label), works out its true world-space
	 * bounding box, and draws it unless the edge is too short for it or it
	 * would overlap a label already placed this frame. */
	private placeEdgeLabel(
		ctx: CanvasRenderingContext2D,
		text: string,
		midX: number,
		midY: number,
		angle: number,
		yOffset: number,
		edgeLength: number,
		dimmed: boolean,
	): void {
		const label = truncateToWidth(ctx, text, EDGE_LABEL_MAX_WIDTH);
		const width = ctx.measureText(label).width;
		if (edgeLength < width) return;

		const rect = rotatedRectBounds(midX, midY, width, EDGE_LABEL_FONT_SIZE, angle, yOffset);
		if (this.rectOverlapsPlaced(rect)) return;

		ctx.save();
		ctx.translate(midX, midY);
		ctx.rotate(angle);
		ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
		ctx.fillStyle = this.theme.canvasBg;
		ctx.fillRect(
			-width / 2 - EDGE_LABEL_PADDING_X,
			yOffset - EDGE_LABEL_FONT_SIZE / 2 - EDGE_LABEL_PADDING_Y,
			width + EDGE_LABEL_PADDING_X * 2,
			EDGE_LABEL_FONT_SIZE + EDGE_LABEL_PADDING_Y * 2,
		);
		ctx.fillStyle = this.theme.text;
		ctx.fillText(label, 0, yOffset);
		ctx.restore();

		this.labelRects.push(rect);
	}

	private drawNode(ctx: CanvasRenderingContext2D, node: GraphNode, dotMode: boolean, hovered: boolean): void {
		const pos = this.layout.get(node.id);
		if (!pos) return;

		const dimmed = this.hoveredId !== null && !hovered && !this.adjacency.get(this.hoveredId ?? '')?.has(node.id);
		ctx.globalAlpha = dimmed ? DIMMED_ALPHA : 1;
		const colors = this.valueColors(node.typeValue);
		// Plan item 2: node size by degree, applied identically to both node
		// styles so a hub still reads as a hub whether it is drawn as a tile
		// or as a dot.
		const scale = degreeScale(node.degree);

		if (dotMode) {
			ctx.beginPath();
			ctx.arc(pos.x, pos.y, DOT_RADIUS * scale, 0, Math.PI * 2);
			ctx.fillStyle = colors.border;
			ctx.fill();
			ctx.globalAlpha = 1;
			return;
		}

		const tileSize = TILE_SIZE * scale;
		const half = tileSize / 2;
		roundRectPath(ctx, pos.x - half, pos.y - half, tileSize, tileSize, TILE_RADIUS * scale);
		ctx.fillStyle = colors.fill;
		ctx.fill();
		ctx.lineWidth = hovered ? 2.5 : 1.5;
		ctx.strokeStyle = hovered ? this.theme.hoverRing : colors.border;
		ctx.stroke();

		const iconSize = ICON_SIZE * scale;
		const glyph = this.icons.request(node.icons, node.kind, iconSize, colors.glyph, () => this.scheduleRedraw());
		if (glyph) this.drawGlyph(ctx, glyph, pos.x, pos.y, colors.glyph, iconSize);

		ctx.globalAlpha = 1;
	}

	private drawGlyph(ctx: CanvasRenderingContext2D, glyph: IconGlyph, cx: number, cy: number, color: string, iconSize: number): void {
		if (glyph.kind === 'bitmap') {
			ctx.drawImage(glyph.bitmap, cx - iconSize / 2, cy - iconSize / 2, iconSize, iconSize);
			return;
		}
		ctx.fillStyle = color;
		// An icon-font glyph is a codepoint that only means something in its own
		// face, so it names the family; an emoji takes the interface font.
		ctx.font = `${iconSize * 0.85}px ${glyph.fontFamily ?? this.theme.fontFamily}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(glyph.text, cx, cy + 1);
	}

	/** Resolved once per distinct value per model update, not once per node:
	 * `color-mix` is unavailable on a canvas, so the fill/border/glyph triple
	 * is computed here and reused for every node sharing the value. */
	private valueColors(typeValue: string | null): ValueColorTriple {
		if (!typeValue) {
			return { fill: this.theme.neutralFill, border: this.theme.neutralBorder, glyph: this.theme.muted };
		}
		const cached = this.valueColorCache.get(typeValue);
		if (cached) return cached;

		let hex: string | null = null;
		if (this.colorOptions.typeProperty && this.colorOptions.colorsEnabled) {
			hex = getPropertyValueColorOverride(this.colorOptions.overrides, this.colorOptions.typeProperty, typeValue) ?? null;
		}
		if (!hex) hex = this.colorAssigner?.color(COLOR_SCOPE, typeValue) ?? null;

		const resolved: ValueColorTriple = hex
			? { fill: hexWithAlpha(hex, 0.16), border: hex, glyph: hex }
			: { fill: this.theme.neutralFill, border: this.theme.neutralBorder, glyph: this.theme.muted };
		this.valueColorCache.set(typeValue, resolved);
		return resolved;
	}

	private updateNotice(notice: string | null): void {
		if (!notice) {
			this.noticeEl.removeClass('is-visible');
			return;
		}
		this.noticeEl.setText(notice);
		this.noticeEl.addClass('is-visible');
	}

	// ---- Interaction --------------------------------------------------------

	private attachEvents(): void {
		this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
		this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
		this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
		this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
		this.canvas.addEventListener('pointerleave', () => this.setHovered(null, 0, 0));
		this.canvas.addEventListener('pointercancel', () => this.onPointerCancel());
		this.canvas.addEventListener('auxclick', (event) => this.onAuxClick(event));
		this.canvas.addEventListener('dblclick', (event) => this.onDoubleClick(event));
		this.canvas.addEventListener('contextmenu', (event) => this.onContextMenu(event));
	}

	private onWheel(event: WheelEvent): void {
		event.preventDefault();
		// A wheel zoom is unambiguously the user taking over the view, so any
		// auto-fit still pending for the current model is cancelled: nothing
		// here should later jump the zoom level they just set by hand.
		this.userAdjustedView = true;
		const rect = this.canvas.getBoundingClientRect();
		const sx = event.clientX - rect.left;
		const sy = event.clientY - rect.top;
		const worldBefore = this.screenToWorld(sx, sy);

		const factor = Math.exp(-event.deltaY * 0.0015);
		this.scale = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);

		const screenAfter = this.worldToScreen(worldBefore.x, worldBefore.y);
		this.offsetX += sx - screenAfter.x;
		this.offsetY += sy - screenAfter.y;
		this.scheduleRedraw();
	}

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		const rect = this.canvas.getBoundingClientRect();
		const sx = event.clientX - rect.left;
		const sy = event.clientY - rect.top;
		const world = this.screenToWorld(sx, sy);
		this.pointer = {
			down: true,
			startX: sx,
			startY: sy,
			lastX: sx,
			lastY: sy,
			dragging: false,
			hitId: this.hitTest(world.x, world.y)?.id ?? null,
		};
		this.canvas.setPointerCapture(event.pointerId);
	}

	private onPointerMove(event: PointerEvent): void {
		const rect = this.canvas.getBoundingClientRect();
		const sx = event.clientX - rect.left;
		const sy = event.clientY - rect.top;

		if (this.pointer?.down) {
			const dx = sx - this.pointer.lastX;
			const dy = sy - this.pointer.lastY;
			if (!this.pointer.dragging) {
				const totalDx = sx - this.pointer.startX;
				const totalDy = sy - this.pointer.startY;
				if (Math.hypot(totalDx, totalDy) > CLICK_DRAG_THRESHOLD) this.pointer.dragging = true;
			}
			// Only a drag that started on empty space pans; a drag started on a
			// node is reserved for pin-dragging once step 3 adds a simulation.
			if (this.pointer.dragging && this.pointer.hitId === null) {
				// Panning is the user taking over the view, same as a wheel
				// zoom; dragging a node is not (see the pin branch below,
				// which does not touch this flag), since the user is
				// repositioning content, not the camera.
				this.userAdjustedView = true;
				this.offsetX += dx;
				this.offsetY += dy;
				this.scheduleRedraw();
			} else if (this.pointer.dragging && this.pointer.hitId !== null) {
				if (this.draggingNodeId !== this.pointer.hitId) {
					// Drag just started on a node: pin it and re-warm, one of the
					// two allowed reheat triggers alongside a model change. The
					// pin outlives the drop, see `onPointerUp`.
					this.draggingNodeId = this.pointer.hitId;
					this.simulation.reheat(DRAG_REHEAT_ALPHA);
					this.ensureSimulationLoop();
				}
				const world = this.screenToWorld(sx, sy);
				this.simulation.pin(this.draggingNodeId, world.x, world.y);
				this.syncLayoutFromSimulation();
				this.scheduleRedraw();
			}
			this.pointer.lastX = sx;
			this.pointer.lastY = sy;
			return;
		}

		const world = this.screenToWorld(sx, sy);
		this.setHovered(this.hitTest(world.x, world.y), sx, sy);
	}

	private onPointerUp(event: PointerEvent): void {
		if (event.button !== 0 || !this.pointer?.down) return;
		const { dragging, hitId } = this.pointer;
		this.pointer.down = false;
		// A dropped node stays where it was dropped.
		//
		// Both obvious answers are wrong on their own. Releasing the pin on drop
		// hands the node straight back to the forces, which pull it home: the
		// node rubber-bands out of the user's hand, and arranging a graph by
		// hand is impossible. Pinning it forever is what this replaced, and
		// strands it: the model changes, everything else re-seeds around it, and
		// the pinned node is left behind in a place that no longer means
		// anything.
		//
		// So the pin persists, and `update()` clears every user pin whenever the
		// layout is genuinely re-seeded. A hand-placed node holds its place for
		// as long as the graph it was placed in still exists.
		//
		// The small reheat is for the neighbours, not the node: dropping a node
		// into a crowd has to let collision push the crowd aside, and at this
		// alpha that is a nudge rather than a re-layout.
		if (this.draggingNodeId) {
			this.userPinnedIds.add(this.draggingNodeId);
			this.simulation.reheat(DROP_REHEAT_ALPHA);
			this.ensureSimulationLoop();
		}
		this.draggingNodeId = null;
		if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
		if (dragging || !hitId) return;

		const node = this.nodesById.get(hitId);
		if (node) this.scheduleOpen(node, Boolean(Keymap.isModEvent(event)));
	}

	private onPointerCancel(): void {
		if (this.pointer) this.pointer.down = false;
		this.draggingNodeId = null;
	}

	private onAuxClick(event: MouseEvent): void {
		if (event.button !== 1) return;
		const rect = this.canvas.getBoundingClientRect();
		const world = this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
		const node = this.hitTest(world.x, world.y);
		if (!node) return;
		event.preventDefault();
		this.cancelPendingOpen();
		void this.openNode(node, true);
	}

	/** In focus mode, double-clicking a node re-roots on it, per the plan.
	 * Whole-base mode keeps double-click's previous job (the file context
	 * menu) exactly as it was, since re-rooting has no meaning there. Nothing
	 * is lost by the swap in focus mode either: `onContextMenu` right below
	 * already opens the identical menu on right-click, which is why
	 * double-click was free to take on a new job here in the first place. */
	private onDoubleClick(event: MouseEvent): void {
		const rect = this.canvas.getBoundingClientRect();
		const world = this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
		const node = this.hitTest(world.x, world.y);
		if (!node) return;
		event.preventDefault();
		this.cancelPendingOpen();
		// Tree mode re-roots on a double-click for the same reason focus mode
		// does: its root is chosen the same way, and with a hop-distance tree
		// the choice of root is the whole shape of the picture. Under a
		// hierarchy property it moves less (a node that declares a parent
		// keeps it, per `propertyTreeSource`) but still decides which of the
		// forest's trees is stacked first.
		if (this.mode === 'focus' || this.mode === 'tree') {
			this.reroot(node.id);
		} else {
			this.showMenuFor(node, event);
		}
	}

	private onContextMenu(event: MouseEvent): void {
		const rect = this.canvas.getBoundingClientRect();
		const world = this.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
		const node = this.hitTest(world.x, world.y);
		if (!node) return;
		event.preventDefault();
		this.cancelPendingOpen();
		this.showMenuFor(node, event);
	}

	/** A single click waits, so a double click reads as the menu rather than
	 * two opens in a row: same convention `EntryInteractions` uses elsewhere. */
	private scheduleOpen(node: GraphNode, newLeaf: boolean): void {
		this.cancelPendingOpen();
		this.pendingOpenTimer = window.setTimeout(() => {
			this.pendingOpenTimer = null;
			void this.openNode(node, newLeaf);
		}, DOUBLE_CLICK_DELAY_MS);
	}

	private cancelPendingOpen(): void {
		if (this.pendingOpenTimer === null) return;
		window.clearTimeout(this.pendingOpenTimer);
		this.pendingOpenTimer = null;
	}

	private async openNode(node: GraphNode, newLeaf: boolean): Promise<void> {
		if (!node.path) return;
		const file = this.app.vault.getAbstractFileByPath(node.path);
		if (!(file instanceof TFile)) return;
		await this.app.workspace.getLeaf(newLeaf).openFile(file);
	}

	private showMenuFor(node: GraphNode, event: MouseEvent): void {
		if (!node.path) return;
		const file = this.app.vault.getAbstractFileByPath(node.path);
		if (!(file instanceof TFile)) return;
		showFileMenu(this.app, file, event);
	}

	private setHovered(node: GraphNode | null, screenX: number, screenY: number): void {
		const nextId = node?.id ?? null;
		if (nextId !== this.hoveredId) {
			this.hoveredId = nextId;
			this.scheduleRedraw();
		}
		if (!node) {
			this.hoverCardEl.removeClass('is-visible');
			return;
		}
		this.hoverCardEl.empty();
		this.hoverCardEl.createDiv({ cls: 'views-graph-hovercard-title', text: node.label });
		if (node.typeValue) this.hoverCardEl.createDiv({ cls: 'views-graph-hovercard-meta', text: node.typeValue });
		this.hoverCardEl.addClass('is-visible');
		this.hoverCardEl.style.left = `${screenX + 14}px`;
		this.hoverCardEl.style.top = `${screenY + 14}px`;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

/** Shortens each end of a line by that end's own inset, so an edge stops at
 * the edge of a node's drawn shape rather than being drawn under it. The two
 * insets differ once degree scaling (plan item 2) is in play, since the two
 * endpoints are not necessarily the same size. */
function trimLine(from: Point, to: Point, fromInset: number, toInset: number): { from: Point; to: Point } {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length <= fromInset + toInset) return { from, to: from };
	const ux = dx / length;
	const uy = dy / length;
	return {
		from: { x: from.x + ux * fromInset, y: from.y + uy * fromInset },
		to: { x: to.x - ux * toInset, y: to.y - uy * toInset },
	};
}

function drawArrowhead(ctx: CanvasRenderingContext2D, from: Point, to: Point, color: string): void {
	const size = 5;
	const angle = Math.atan2(to.y - from.y, to.x - from.x);
	ctx.beginPath();
	ctx.moveTo(to.x, to.y);
	ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 7), to.y - size * Math.sin(angle - Math.PI / 7));
	ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 7), to.y - size * Math.sin(angle + Math.PI / 7));
	ctx.closePath();
	ctx.fillStyle = color;
	ctx.fill();
}

/** World-space axis-aligned bounding box of a `width` x `height` label drawn
 * centered at `(cx, cy)`, rotated by `angle` and then shifted `yOffset`
 * further along the rotated frame's own y axis, matching exactly how
 * `placeEdgeLabel` transforms the canvas before drawing. Used for label
 * overlap rejection, so it has to agree with the actual draw transform
 * rather than approximate it. */
function rotatedRectBounds(cx: number, cy: number, width: number, height: number, angle: number, yOffset: number): { x0: number; y0: number; x1: number; y1: number } {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const halfW = width / 2;
	const halfH = height / 2;
	const corners = [
		{ x: -halfW, y: yOffset - halfH },
		{ x: halfW, y: yOffset - halfH },
		{ x: halfW, y: yOffset + halfH },
		{ x: -halfW, y: yOffset + halfH },
	];
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const corner of corners) {
		const worldX = cx + corner.x * cos - corner.y * sin;
		const worldY = cy + corner.x * sin + corner.y * cos;
		if (worldX < x0) x0 = worldX;
		if (worldX > x1) x1 = worldX;
		if (worldY < y0) y0 = worldY;
		if (worldY > y1) y1 = worldY;
	}
	return { x0, y0, x1, y1 };
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = `${text.slice(0, mid)}…`;
		if (ctx.measureText(candidate).width <= maxWidth) low = mid;
		else high = mid - 1;
	}
	return low > 0 ? `${text.slice(0, low)}…` : '…';
}

function hexWithAlpha(hex: string, alpha: number): string {
	const match = hex.match(/^#([0-9a-f]{6})$/i);
	if (!match) return hex;
	const value = parseInt(match[1], 16);
	const r = (value >> 16) & 255;
	const g = (value >> 8) & 255;
	const b = value & 255;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function readThemeColors(el: HTMLElement): ThemeColors {
	const style = getComputedStyle(el);
	const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	return {
		text: read('--text-normal', '#dcddde'),
		muted: read('--text-muted', '#999999'),
		edge: read('--background-modifier-border', '#484f58'),
		neutralFill: read('--background-modifier-hover', 'rgba(255, 255, 255, 0.06)'),
		neutralBorder: read('--background-modifier-border', '#484f58'),
		hoverRing: read('--interactive-accent', '#7c3aed'),
		fontFamily: read('--font-interface', 'sans-serif'),
		canvasBg: read('--background-primary', '#1e1e1e'),
	};
}

function fallbackTheme(): ThemeColors {
	return {
		text: '#dcddde',
		muted: '#999999',
		edge: '#484f58',
		canvasBg: '#1e1e1e',
		neutralFill: 'rgba(255, 255, 255, 0.06)',
		neutralBorder: '#484f58',
		hoverRing: '#7c3aed',
		fontFamily: 'sans-serif',
	};
}
