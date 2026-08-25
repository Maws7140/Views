import { App } from 'obsidian';
import { Viewport } from '../canvas/Viewport';
import type { Point } from '../canvas/viewportMath';
import { IconRaster, type IconGlyph } from '../graph/iconRaster';
import type { TreeOrientation } from '../graph/tidyTree';
import { computeTreeLayout, type LayoutEdge, type PlacedNode, type TreeLayout } from './treeLayout';
import type { TreeModel, TreeNode } from './treeModel';

/**
 * The tree as a diagram: rounded tiles connected by elbows, laid out by
 * `tidyTree.ts` and drawn on a `Viewport`.
 *
 * The reference is the planning map (`Tree view-1787354984181.png`): root on
 * the left, generations marching right, one shared trunk leaving each parent
 * that the children branch off, rather than a separate line drawn from the
 * parent to each child. The shared trunk is the whole visual difference
 * between a diagram that reads as a structure and one that reads as a spray of
 * lines, and it is why the connectors are drawn per parent below rather than
 * per edge.
 *
 * Same `TreeModel`, same `Then nest by` slots and same persisted collapse
 * state as `TreeOutline.ts`. Nothing here knows what a property is.
 */

export interface TreeCanvasOptions {
	orientation: TreeOrientation;
	showCounts: boolean;
	expandToDepth: number;
	/** Rows the user toggled, keyed by `TreeNode.chain`, as the outline
	 * reports and the view persists them. */
	toggled: ReadonlyMap<string, boolean>;
	colorOf?: (node: TreeNode) => string | null;
	iconsOf?: (node: TreeNode) => string[];
}

/** Tile geometry, in world units. Uniform rather than measured per label,
 * which is what `tidyTree.ts` assumes (its deviation 3) and what keeps a
 * generation reading as a column rather than a ragged edge. A label wider than
 * the tile is truncated; the outline is where the full text lives. */
const TILE_WIDTH = 168;
const TILE_HEIGHT = 34;
const TILE_RADIUS = 6;
const SIBLING_GAP = 10;
const LEVEL_GAP = 58;
const LABEL_FONT_SIZE = 12;
const COUNT_FONT_SIZE = 10;
const ICON_SIZE = 14;
const TILE_PADDING_X = 10;
/** Half-extent of the square a click on the twisty must land in. Generous
 * against the drawn chevron, because at a zoomed-out scale the glyph is a few
 * screen pixels and an exact hit box would be unusable. */
const TWISTY_HIT = 9;
const DIMMED_ALPHA = 0.25;

interface ThemeColors {
	text: string;
	muted: string;
	edge: string;
	tileFill: string;
	tileBorder: string;
	accent: string;
	fontFamily: string;
}

/** What a pointer can land on. The twisty is a separate target from the tile
 * so that collapsing a subtree and opening its note are different gestures on
 * the same row, exactly as they are in the outline. */
export interface TreeHit {
	placed: PlacedNode;
	part: 'tile' | 'twisty';
}

export class TreeCanvas {
	private readonly viewport: Viewport<TreeHit>;
	private readonly iconRaster: IconRaster;
	private model: TreeModel = { roots: [], byId: new Map(), total: 0 };
	private options: TreeCanvasOptions = {
		orientation: 'leftToRight',
		showCounts: true,
		expandToDepth: 2,
		toggled: new Map(),
	};
	private layout: TreeLayout = { placed: [], byId: new Map(), edges: [] };
	/** Children grouped by parent, which is what lets the connectors draw one
	 * shared trunk per parent instead of one line per edge. Rebuilt with the
	 * layout rather than derived per frame. */
	private childrenByParent = new Map<string, PlacedNode[]>();
	private theme: ThemeColors = fallbackTheme();
	private hovered: PlacedNode | null = null;

	constructor(
		private readonly containerEl: HTMLElement,
		private readonly app: App,
		private readonly onToggle: (chain: string, expanded: boolean) => void,
	) {
		this.containerEl.addClass('views-tree-canvas');
		this.iconRaster = new IconRaster(this.app);
		this.viewport = new Viewport<TreeHit>(this.containerEl, {
			draw: (ctx, scale) => this.draw(ctx, scale),
			hitTest: (world) => this.hitTest(world),
			onClick: (hit) => this.onHitClicked(hit, false),
			onAlternateClick: (hit) => this.onHitClicked(hit, true),
			onHover: (hit) => this.setHovered(hit?.placed ?? null),
		});
	}

	destroy(): void {
		this.viewport.destroy();
		this.containerEl.empty();
		this.containerEl.removeClass('views-tree-canvas');
	}

	/** Re-fits on the next update. The view calls this when the base's data or
	 * hierarchy changed, as opposed to when only a colour or a toggle did. */
	resetView(): void {
		this.viewport.resetView();
	}

	update(model: TreeModel, options: TreeCanvasOptions): void {
		this.model = model;
		this.options = options;
		this.theme = readThemeColors(this.containerEl);
		this.rebuildLayout();
		this.viewport.fit(this.layout.placed, TILE_WIDTH / 2, TILE_HEIGHT / 2);
		this.viewport.requestDraw();
	}

	private rebuildLayout(): void {
		this.layout = computeTreeLayout(this.model, {
			orientation: this.options.orientation,
			nodeWidth: TILE_WIDTH,
			nodeHeight: TILE_HEIGHT,
			siblingGap: SIBLING_GAP,
			levelGap: LEVEL_GAP,
			toggled: this.options.toggled,
			expandToDepth: this.options.expandToDepth,
		});

		this.childrenByParent = new Map();
		for (const edge of this.layout.edges) {
			const siblings = this.childrenByParent.get(edge.parent.node.id);
			if (siblings === undefined) this.childrenByParent.set(edge.parent.node.id, [edge.child]);
			else siblings.push(edge.child);
		}
	}

	// ---- Drawing ------------------------------------------------------------

	private draw(ctx: CanvasRenderingContext2D, scale: number): void {
		if (this.layout.placed.length === 0) return;
		this.drawConnectors(ctx, scale);
		for (const placed of this.layout.placed) this.drawTile(ctx, placed);
	}

	/**
	 * One trunk per parent, with a branch to each child.
	 *
	 * The trunk leaves the parent along the main axis, turns at a channel
	 * halfway to the next generation, and runs across the full span of its
	 * children; each child then takes one straight segment from the channel to
	 * its own edge. Drawing it per parent rather than per edge is what puts
	 * every branch on the same channel line, which is the planning map's
	 * defining shape. Per-edge drawing computes the same channel for each
	 * child and would overdraw the trunk once per child, which at any
	 * transparency reads as a thicker line under bushy parents.
	 */
	private drawConnectors(ctx: CanvasRenderingContext2D, scale: number): void {
		const horizontal = this.options.orientation === 'leftToRight';
		// Divided by scale so the stroke stays one screen pixel at any zoom
		// rather than thickening as the view zooms in.
		ctx.lineWidth = 1 / scale;
		ctx.lineCap = 'butt';
		// Mitred: the corner of an elbow is a point, and a rounded join at this
		// width reads as a wobble in the line.
		ctx.lineJoin = 'miter';
		ctx.strokeStyle = this.theme.edge;

		const mainHalf = (horizontal ? TILE_WIDTH : TILE_HEIGHT) / 2;

		for (const [parentId, children] of this.childrenByParent) {
			const parent = this.layout.byId.get(parentId);
			if (parent === undefined || children.length === 0) continue;

			ctx.globalAlpha = this.connectorAlpha(parent, children);

			const alongParent = horizontal ? parent.x : parent.y;
			const alongChild = horizontal ? children[0].x : children[0].y;
			const exit = alongParent + mainHalf;
			const entry = alongChild - mainHalf;
			const channel = (exit + entry) / 2;

			let acrossMin = Infinity;
			let acrossMax = -Infinity;
			for (const child of children) {
				const across = horizontal ? child.y : child.x;
				if (across < acrossMin) acrossMin = across;
				if (across > acrossMax) acrossMax = across;
			}
			const acrossParent = horizontal ? parent.y : parent.x;

			ctx.beginPath();
			if (horizontal) {
				ctx.moveTo(exit, acrossParent);
				ctx.lineTo(channel, acrossParent);
				ctx.moveTo(channel, acrossMin);
				ctx.lineTo(channel, acrossMax);
				for (const child of children) {
					ctx.moveTo(channel, child.y);
					ctx.lineTo(entry, child.y);
				}
			} else {
				ctx.moveTo(acrossParent, exit);
				ctx.lineTo(acrossParent, channel);
				ctx.moveTo(acrossMin, channel);
				ctx.lineTo(acrossMax, channel);
				for (const child of children) {
					ctx.moveTo(child.x, channel);
					ctx.lineTo(child.x, entry);
				}
			}
			ctx.stroke();
		}

		ctx.globalAlpha = 1;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
	}

	/** A trunk stays lit while the pointer is on the parent or on any of its
	 * children, so hovering a tile shows the whole joint it belongs to rather
	 * than half of it. */
	private connectorAlpha(parent: PlacedNode, children: PlacedNode[]): number {
		if (this.hovered === null) return 1;
		if (this.hovered === parent) return 1;
		return children.includes(this.hovered) ? 1 : DIMMED_ALPHA;
	}

	private drawTile(ctx: CanvasRenderingContext2D, placed: PlacedNode): void {
		const { node } = placed;
		const hovered = this.hovered === placed;
		ctx.globalAlpha = this.hovered === null || hovered || this.touchesHovered(placed) ? 1 : DIMMED_ALPHA;

		const color = this.options.colorOf?.(node) ?? null;
		const left = placed.x - TILE_WIDTH / 2;
		const top = placed.y - TILE_HEIGHT / 2;

		ctx.beginPath();
		roundedRect(ctx, left, top, TILE_WIDTH, TILE_HEIGHT, TILE_RADIUS);
		ctx.fillStyle = color ?? this.theme.tileFill;
		ctx.fill();
		ctx.lineWidth = hovered ? 2 : 1;
		ctx.strokeStyle = hovered ? this.theme.accent : (color ?? this.theme.tileBorder);
		ctx.stroke();

		let textLeft = left + TILE_PADDING_X;
		const icons = this.options.iconsOf?.(node) ?? [];
		if (icons.length > 0) {
			const glyph = this.iconRaster.request(
				icons,
				node.kind === 'note' ? 'note' : 'value',
				ICON_SIZE,
				this.theme.text,
				() => this.viewport.requestDraw(),
			);
			if (glyph !== null) {
				drawGlyph(ctx, glyph, textLeft + ICON_SIZE / 2, placed.y, this.theme.text, ICON_SIZE, this.theme.fontFamily);
			}
			// The gap is reserved whether or not the glyph resolved this frame,
			// so a label does not jump sideways when an icon finishes loading.
			textLeft += ICON_SIZE + 6;
		}

		let textRight = left + TILE_WIDTH - TILE_PADDING_X;
		if (this.options.showCounts && node.kind === 'container') {
			ctx.font = `${COUNT_FONT_SIZE}px ${this.theme.fontFamily}`;
			ctx.fillStyle = this.theme.muted;
			ctx.textAlign = 'right';
			ctx.textBaseline = 'middle';
			const count = String(node.noteCount);
			ctx.fillText(count, textRight, placed.y + 1);
			textRight -= ctx.measureText(count).width + 8;
		}

		ctx.font = `${LABEL_FONT_SIZE}px ${this.theme.fontFamily}`;
		ctx.fillStyle = this.theme.text;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';
		ctx.fillText(ellipsize(ctx, node.label, Math.max(textRight - textLeft, 0)), textLeft, placed.y + 1);

		if (node.children.length > 0) this.drawTwisty(ctx, placed);
		ctx.globalAlpha = 1;
	}

	/** A chevron on the leading edge of the tile, pointing along the main axis
	 * when the subtree is open and back at the tile when it is shut. Drawn as
	 * two strokes rather than a rasterized icon because it changes with state
	 * every frame and is two lines. */
	private drawTwisty(ctx: CanvasRenderingContext2D, placed: PlacedNode): void {
		const center = this.twistyCenter(placed);
		const arm = 3.5;
		const open = !placed.collapsed;
		ctx.beginPath();
		if (this.options.orientation === 'leftToRight') {
			const direction = open ? 1 : -1;
			ctx.moveTo(center.x - arm * direction, center.y - arm);
			ctx.lineTo(center.x + arm * direction, center.y);
			ctx.lineTo(center.x - arm * direction, center.y + arm);
		} else {
			const direction = open ? 1 : -1;
			ctx.moveTo(center.x - arm, center.y - arm * direction);
			ctx.lineTo(center.x, center.y + arm * direction);
			ctx.lineTo(center.x + arm, center.y - arm * direction);
		}
		ctx.lineWidth = 1.5;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.strokeStyle = this.theme.muted;
		ctx.stroke();
	}

	/** Sits just outside the tile on the side the children are on, so it never
	 * covers the label and always reads as belonging to the branch it opens. */
	private twistyCenter(placed: PlacedNode): Point {
		if (this.options.orientation === 'leftToRight') {
			return { x: placed.x + TILE_WIDTH / 2 + 8, y: placed.y };
		}
		return { x: placed.x, y: placed.y + TILE_HEIGHT / 2 + 8 };
	}

	private touchesHovered(placed: PlacedNode): boolean {
		if (this.hovered === null) return false;
		if (this.hovered.node.children.some((child) => child.id === placed.node.id)) return true;
		return placed.node.children.some((child) => child.id === this.hovered?.node.id);
	}

	// ---- Input --------------------------------------------------------------

	/**
	 * Linear over the placed nodes, deliberately.
	 *
	 * The graph builds a quadtree because its simulation needs one anyway; a
	 * tree has no simulation, and a base that returns a few thousand rows costs
	 * a few thousand comparisons on a pointer move, which is nothing next to
	 * the frame that follows it. Reversed so the topmost generation drawn wins
	 * a tie, matching what the user sees.
	 */
	private hitTest(world: Point): TreeHit | null {
		for (let index = this.layout.placed.length - 1; index >= 0; index -= 1) {
			const placed = this.layout.placed[index];
			if (placed.node.children.length > 0) {
				const twisty = this.twistyCenter(placed);
				if (Math.abs(world.x - twisty.x) <= TWISTY_HIT && Math.abs(world.y - twisty.y) <= TWISTY_HIT) {
					return { placed, part: 'twisty' };
				}
			}
			if (
				Math.abs(world.x - placed.x) <= TILE_WIDTH / 2
				&& Math.abs(world.y - placed.y) <= TILE_HEIGHT / 2
			) {
				return { placed, part: 'tile' };
			}
		}
		return null;
	}

	private onHitClicked(hit: TreeHit, newLeaf: boolean): void {
		if (hit.part === 'twisty') {
			this.toggle(hit.placed);
			return;
		}
		const { path } = hit.placed.node;
		if (path === undefined) {
			// A container with no note behind it has nothing to open, so a click
			// on it does the next most useful thing rather than nothing.
			if (hit.placed.node.children.length > 0) this.toggle(hit.placed);
			return;
		}
		const file = this.app.vault.getFileByPath(path);
		if (file !== null) void this.app.workspace.getLeaf(newLeaf).openFile(file);
	}

	private toggle(placed: PlacedNode): void {
		const expanded = placed.collapsed;
		// The map the view owns is what the next update reads, so it is updated
		// here as well rather than waiting for the round trip through config.
		(this.options.toggled as Map<string, boolean>).set(placed.node.chain, expanded);
		this.onToggle(placed.node.chain, expanded);
		this.rebuildLayout();
		this.viewport.requestDraw();
	}

	private setHovered(placed: PlacedNode | null): void {
		if (placed === this.hovered) return;
		this.hovered = placed;
		this.viewport.requestDraw();
	}
}

function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): void {
	const r = Math.min(radius, width / 2, height / 2);
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + width, y, x + width, y + height, r);
	ctx.arcTo(x + width, y + height, x, y + height, r);
	ctx.arcTo(x, y + height, x, y, r);
	ctx.arcTo(x, y, x + width, y, r);
	ctx.closePath();
}

/** Trims a label to fit, with a trailing ellipsis. Binary search rather than
 * a character walk: `measureText` is the expensive call here and a tile can
 * hold a path segment of any length. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
	if (maxWidth <= 0) return '';
	if (ctx.measureText(text).width <= maxWidth) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
		else high = mid - 1;
	}
	return low === 0 ? '' : `${text.slice(0, low)}…`;
}

function drawGlyph(
	ctx: CanvasRenderingContext2D,
	glyph: IconGlyph,
	cx: number,
	cy: number,
	color: string,
	size: number,
	fontFamily: string,
): void {
	if (glyph.kind === 'bitmap') {
		ctx.drawImage(glyph.bitmap, cx - size / 2, cy - size / 2, size, size);
		return;
	}
	ctx.fillStyle = color;
	// An icon-font glyph is a codepoint that means something only in its own
	// face, so it names the family; an emoji takes the interface font.
	ctx.font = `${size * 0.85}px ${glyph.fontFamily ?? fontFamily}`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(glyph.text, cx, cy + 1);
}

function readThemeColors(el: HTMLElement): ThemeColors {
	const style = getComputedStyle(el);
	const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	return {
		text: read('--text-normal', '#dcddde'),
		muted: read('--text-muted', '#999999'),
		edge: read('--background-modifier-border', '#484f58'),
		tileFill: read('--background-secondary', '#252525'),
		tileBorder: read('--background-modifier-border', '#484f58'),
		accent: read('--interactive-accent', '#7c3aed'),
		fontFamily: read('--font-interface', 'sans-serif'),
	};
}

function fallbackTheme(): ThemeColors {
	return {
		text: '#dcddde',
		muted: '#999999',
		edge: '#484f58',
		tileFill: '#252525',
		tileBorder: '#484f58',
		accent: '#7c3aed',
		fontFamily: 'sans-serif',
	};
}
