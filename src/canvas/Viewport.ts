import {
	boundsOf,
	clampScale,
	fitTransform,
	padBounds,
	screenToWorld,
	worldToScreen,
	type Point,
	type ScaleLimits,
	type ViewTransform,
	type WorldBounds,
} from './viewportMath';

/**
 * A canvas that can be panned and zoomed, and nothing else.
 *
 * It owns a `<canvas>`, a transform, the device-pixel-ratio dance and a redraw
 * schedule. It has no idea what is drawn on it: no nodes, no model, no theme.
 * The owner supplies a `draw` callback that is handed a context already scaled
 * and translated into world units, and a `hitTest` that answers what sits at a
 * world point.
 *
 * Written for the tree rather than extracted from `GraphRenderer`, which keeps
 * its own copy. Extracting would have meant refactoring a shipping view inside
 * the tree's phase for no benefit to the tree. If the graph is ever worth
 * moving onto this, that is its own change judged on its own merits.
 *
 * The pointer contract is the part worth reading. A press records where it
 * landed and what it hit; movement past `CLICK_DRAG_THRESHOLD` promotes it to
 * a drag, which pans; a release that never became a drag is a click, reported
 * with whatever the press hit rather than with what sits under the release.
 * That threshold is why a slightly shaky click on a tile still opens it
 * instead of nudging the view a pixel.
 */

export interface ViewportCallbacks<T> {
	/** Draws one frame. The context arrives with the world transform already
	 * applied, so the callback works in world units throughout. Stroke widths
	 * that should stay a constant screen thickness are the exception, and
	 * `scale` is passed for exactly that. */
	draw: (ctx: CanvasRenderingContext2D, scale: number) => void;
	/** What sits at a world point, or null for empty space. Empty space is
	 * what a pan drag starts on. */
	hitTest: (world: Point) => T | null;
	/** A press and release on the same target, with no drag in between. */
	onClick?: (target: T, event: PointerEvent) => void;
	/** Middle-click or ctrl/cmd-click, which every other view in this plugin
	 * treats as "open in a new leaf". */
	onAlternateClick?: (target: T, event: MouseEvent) => void;
	onDoubleClick?: (target: T, event: MouseEvent) => void;
	onContextMenu?: (target: T, event: MouseEvent) => void;
	/** Null when the pointer leaves everything. Called only on a change, so
	 * the owner can redraw on it without filtering out repeats. */
	onHover?: (target: T | null, screen: Point) => void;
}

export interface ViewportOptions {
	scaleLimits?: ScaleLimits;
	/** World units of air left around the content when fitting. */
	fitMargin?: number;
}

const DEFAULT_SCALE_LIMITS: ScaleLimits = { min: 0.05, max: 6 };
const DEFAULT_FIT_MARGIN = 60;
/** Screen pixels of movement that turn a press into a drag. Matches the
 * graph's own threshold, because someone who learns the feel of one canvas in
 * this plugin should not have to relearn it in the other. */
const CLICK_DRAG_THRESHOLD = 4;

interface PointerState {
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	dragging: boolean;
	hit: unknown;
}

export class Viewport<T> {
	readonly canvas: HTMLCanvasElement;
	private readonly ctx: CanvasRenderingContext2D;
	private readonly scaleLimits: ScaleLimits;
	private readonly fitMargin: number;

	private transform: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
	private width = 1;
	private height = 1;
	private dpr = 1;

	private redrawScheduled = false;
	private pointer: PointerState | null = null;
	private hovered: T | null = null;
	/** Once the user has panned or zoomed, an automatic fit would yank the view
	 * out from under them. Every later fit is skipped until `resetView` says
	 * the content changed enough to start over. */
	private userAdjustedView = false;

	private readonly resizeObserver: ResizeObserver;
	private dprCleanup: (() => void) | null = null;

	constructor(
		private readonly host: HTMLElement,
		private readonly callbacks: ViewportCallbacks<T>,
		options: ViewportOptions = {},
	) {
		this.scaleLimits = options.scaleLimits ?? DEFAULT_SCALE_LIMITS;
		this.fitMargin = options.fitMargin ?? DEFAULT_FIT_MARGIN;

		this.canvas = this.host.createEl('canvas', { cls: 'views-canvas' });
		const context = this.canvas.getContext('2d');
		if (context === null) throw new Error('Canvas 2D context unavailable');
		this.ctx = context;

		this.attachEvents();
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.host);
		this.watchDevicePixelRatio();
		this.handleResize();
	}

	destroy(): void {
		this.resizeObserver.disconnect();
		this.dprCleanup?.();
		this.dprCleanup = null;
		this.canvas.remove();
	}

	get scale(): number {
		return this.transform.scale;
	}

	/** Forgets that the user moved the view, so the next `fit` runs. Called
	 * when the content changes enough that the old framing is meaningless: a
	 * different base, a different hierarchy. Not called for an ordinary
	 * redraw, which must leave the view exactly where it was. */
	resetView(): void {
		this.userAdjustedView = false;
	}

	requestDraw(): void {
		if (this.redrawScheduled) return;
		this.redrawScheduled = true;
		requestAnimationFrame(() => {
			this.redrawScheduled = false;
			this.render();
		});
	}

	/**
	 * Frames the given world points, unless the user has already moved the
	 * view by hand.
	 *
	 * `halfWidth` and `halfHeight` grow the box by the extent of whatever is
	 * drawn at each point, so the outermost tiles are framed whole rather than
	 * clipped down the middle.
	 */
	fit(points: Iterable<Point>, halfWidth = 0, halfHeight = 0): void {
		if (this.userAdjustedView) return;
		this.fitNow(points, halfWidth, halfHeight);
	}

	/** Fits regardless of what the user has done to the view. This is the
	 * "fit to screen" button: a request rather than an automatic adjustment,
	 * so it is allowed to override them. */
	fitNow(points: Iterable<Point>, halfWidth = 0, halfHeight = 0): void {
		this.fitBounds(padBounds(boundsOf(points), halfWidth, halfHeight));
	}

	fitBounds(bounds: WorldBounds): void {
		const next = fitTransform(bounds, this.width, this.height, this.fitMargin, this.scaleLimits);
		if (next === null) return;
		this.transform = next;
		this.requestDraw();
	}

	zoomBy(factor: number): void {
		this.userAdjustedView = true;
		this.transform = {
			...this.transform,
			scale: clampScale(this.transform.scale * factor, this.scaleLimits),
		};
		this.requestDraw();
	}

	toWorld(screen: Point): Point {
		return screenToWorld(screen, this.transform, this.width, this.height);
	}

	toScreen(world: Point): Point {
		return worldToScreen(world, this.transform, this.width, this.height);
	}

	// ---- Frame --------------------------------------------------------------

	private render(): void {
		const { ctx } = this;
		ctx.save();
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.clearRect(0, 0, this.width, this.height);
		// The world transform, applied once here so the draw callback never
		// deals in screen coordinates. Matches the origin-at-centre convention
		// `viewportMath.ts` documents.
		ctx.translate(this.width / 2 + this.transform.offsetX, this.height / 2 + this.transform.offsetY);
		ctx.scale(this.transform.scale, this.transform.scale);
		this.callbacks.draw(ctx, this.transform.scale);
		ctx.restore();
	}

	private handleResize(): void {
		const rect = this.host.getBoundingClientRect();
		this.width = Math.max(1, Math.round(rect.width));
		this.height = Math.max(1, Math.round(rect.height));
		this.dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.max(1, Math.round(this.width * this.dpr));
		this.canvas.height = Math.max(1, Math.round(this.height * this.dpr));
		this.canvas.style.width = `${this.width}px`;
		this.canvas.style.height = `${this.height}px`;
		this.requestDraw();
	}

	/** `ResizeObserver` does not fire on a device-pixel-ratio change alone,
	 * which is what dragging the window to a monitor with a different scale
	 * factor does. A media query tuned to the current ratio catches it. It
	 * fires once and is re-armed at the new ratio, since `matchMedia` cannot
	 * track a moving target. */
	private watchDevicePixelRatio(): void {
		const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		const listener = () => {
			this.handleResize();
			this.watchDevicePixelRatio();
		};
		query.addEventListener('change', listener, { once: true });
		this.dprCleanup = () => query.removeEventListener('change', listener);
	}

	// ---- Input --------------------------------------------------------------

	private attachEvents(): void {
		this.canvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
		this.canvas.addEventListener('pointerdown', (event) => this.onPointerDown(event));
		this.canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
		this.canvas.addEventListener('pointerup', (event) => this.onPointerUp(event));
		this.canvas.addEventListener('pointercancel', () => this.onPointerCancel());
		this.canvas.addEventListener('pointerleave', () => this.setHovered(null, { x: 0, y: 0 }));
		this.canvas.addEventListener('auxclick', (event) => this.onAuxClick(event));
		this.canvas.addEventListener('dblclick', (event) => this.onDoubleClick(event));
		this.canvas.addEventListener('contextmenu', (event) => this.onContextMenu(event));
	}

	private localPoint(event: MouseEvent): Point {
		const rect = this.canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	private targetAt(event: MouseEvent): T | null {
		return this.callbacks.hitTest(this.toWorld(this.localPoint(event)));
	}

	private onWheel(event: WheelEvent): void {
		event.preventDefault();
		// A wheel zoom is unambiguously the user taking the view over, so any
		// fit still pending for the current content is cancelled rather than
		// jumping the zoom level they just set by hand.
		this.userAdjustedView = true;
		const anchor = this.localPoint(event);
		// The world point under the cursor before the scale change must stay
		// under it after, which is what makes a wheel zoom feel like scaling
		// the canvas rather than teleporting it.
		const worldBefore = screenToWorld(anchor, this.transform, this.width, this.height);
		const scale = clampScale(this.transform.scale * Math.exp(-event.deltaY * 0.0015), this.scaleLimits);
		const zoomed: ViewTransform = { ...this.transform, scale };
		const screenAfter = worldToScreen(worldBefore, zoomed, this.width, this.height);
		this.transform = {
			scale,
			offsetX: zoomed.offsetX + (anchor.x - screenAfter.x),
			offsetY: zoomed.offsetY + (anchor.y - screenAfter.y),
		};
		this.requestDraw();
	}

	private onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		const local = this.localPoint(event);
		this.pointer = {
			startX: local.x,
			startY: local.y,
			lastX: local.x,
			lastY: local.y,
			dragging: false,
			hit: this.targetAt(event),
		};
		this.canvas.setPointerCapture(event.pointerId);
	}

	private onPointerMove(event: PointerEvent): void {
		const local = this.localPoint(event);

		if (this.pointer !== null) {
			if (!this.pointer.dragging) {
				const moved = Math.hypot(local.x - this.pointer.startX, local.y - this.pointer.startY);
				if (moved > CLICK_DRAG_THRESHOLD) this.pointer.dragging = true;
			}
			if (this.pointer.dragging) {
				this.userAdjustedView = true;
				this.transform = {
					...this.transform,
					offsetX: this.transform.offsetX + (local.x - this.pointer.lastX),
					offsetY: this.transform.offsetY + (local.y - this.pointer.lastY),
				};
				this.requestDraw();
			}
			this.pointer.lastX = local.x;
			this.pointer.lastY = local.y;
			return;
		}

		this.setHovered(this.targetAt(event), local);
	}

	private onPointerUp(event: PointerEvent): void {
		const state = this.pointer;
		this.pointer = null;
		if (this.canvas.hasPointerCapture(event.pointerId)) {
			this.canvas.releasePointerCapture(event.pointerId);
		}
		if (state === null || state.dragging || state.hit === null) return;

		const target = state.hit as T;
		// Ctrl, or cmd on macOS, turns a plain click into the alternate one,
		// matching how a link opens in a new leaf everywhere else in Obsidian.
		if (event.ctrlKey || event.metaKey) {
			this.callbacks.onAlternateClick?.(target, event);
			return;
		}
		this.callbacks.onClick?.(target, event);
	}

	private onPointerCancel(): void {
		this.pointer = null;
	}

	private onAuxClick(event: MouseEvent): void {
		if (event.button !== 1) return;
		const target = this.targetAt(event);
		if (target === null) return;
		event.preventDefault();
		this.callbacks.onAlternateClick?.(target, event);
	}

	private onDoubleClick(event: MouseEvent): void {
		const target = this.targetAt(event);
		if (target === null) return;
		event.preventDefault();
		this.callbacks.onDoubleClick?.(target, event);
	}

	private onContextMenu(event: MouseEvent): void {
		const target = this.targetAt(event);
		if (target === null) return;
		event.preventDefault();
		this.callbacks.onContextMenu?.(target, event);
	}

	private setHovered(target: T | null, screen: Point): void {
		if (target === this.hovered) return;
		this.hovered = target;
		this.canvas.style.cursor = target === null ? 'default' : 'pointer';
		this.callbacks.onHover?.(target, screen);
	}
}
