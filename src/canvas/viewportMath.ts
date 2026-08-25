/**
 * The transform behind a pan-and-zoom canvas, as pure functions.
 *
 * Split from `Viewport.ts` for the same reason `forceLayout.ts` is split from
 * `GraphRenderer.ts`: the arithmetic is where the bugs are, and arithmetic is
 * testable headless while a wheel listener is not. `Viewport.ts` owns a canvas,
 * a DOM and a redraw schedule; this file owns none of those and imports
 * nothing.
 *
 * The convention throughout: **the world origin sits at the centre of the
 * viewport when the offset is zero.** Layouts in this codebase come back
 * centred on the origin (`computeTidyTree` says so explicitly), so a freshly
 * laid-out tree is already roughly in frame before anything fits it.
 */

export interface Point {
	x: number;
	y: number;
}

/** Pan and zoom, with no reference to what is being viewed. */
export interface ViewTransform {
	scale: number;
	offsetX: number;
	offsetY: number;
}

/** The rectangle a fit is asked to frame, in world units. */
export interface WorldBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface ScaleLimits {
	min: number;
	max: number;
}

export function clampScale(scale: number, limits: ScaleLimits): number {
	if (!Number.isFinite(scale)) return limits.min;
	return Math.min(Math.max(scale, limits.min), limits.max);
}

export function worldToScreen(
	world: Point,
	transform: ViewTransform,
	width: number,
	height: number,
): Point {
	return {
		x: width / 2 + transform.offsetX + world.x * transform.scale,
		y: height / 2 + transform.offsetY + world.y * transform.scale,
	};
}

export function screenToWorld(
	screen: Point,
	transform: ViewTransform,
	width: number,
	height: number,
): Point {
	return {
		x: (screen.x - width / 2 - transform.offsetX) / transform.scale,
		y: (screen.y - height / 2 - transform.offsetY) / transform.scale,
	};
}

/**
 * Zooms about a fixed screen point, which is what makes a wheel zoom feel like
 * the canvas is being scaled under the cursor rather than jumping.
 *
 * The rule is one line: whatever world point sat under the cursor before the
 * scale change must sit under it after. Everything else follows from solving
 * for the offset that makes that true.
 */
export function zoomAbout(
	transform: ViewTransform,
	anchor: Point,
	factor: number,
	limits: ScaleLimits,
	width: number,
	height: number,
): ViewTransform {
	const worldBefore = screenToWorld(anchor, transform, width, height);
	const scale = clampScale(transform.scale * factor, limits);
	const zoomed: ViewTransform = { ...transform, scale };
	const screenAfter = worldToScreen(worldBefore, zoomed, width, height);
	return {
		scale,
		offsetX: zoomed.offsetX + (anchor.x - screenAfter.x),
		offsetY: zoomed.offsetY + (anchor.y - screenAfter.y),
	};
}

/**
 * The transform that puts `bounds` in frame with `margin` world units of air
 * around it.
 *
 * Returns null for bounds that are not finite, which is the shape an empty
 * model produces and is a legitimate answer rather than an error: a caller
 * with nothing to draw should leave the view where the user put it instead of
 * being handed a transform derived from infinities.
 */
export function fitTransform(
	bounds: WorldBounds,
	width: number,
	height: number,
	margin: number,
	limits: ScaleLimits,
): ViewTransform | null {
	if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return null;

	// A single node, or a perfectly flat row, has zero extent on one axis and
	// would divide the viewport by zero. Flooring at one world unit costs
	// nothing for real content and leaves the degenerate case scaled to the
	// clamp ceiling rather than to infinity.
	const contentWidth = Math.max(bounds.maxX - bounds.minX, 1) + margin * 2;
	const contentHeight = Math.max(bounds.maxY - bounds.minY, 1) + margin * 2;
	const scale = clampScale(Math.min(width / contentWidth, height / contentHeight), limits);

	const centerX = (bounds.minX + bounds.maxX) / 2;
	const centerY = (bounds.minY + bounds.maxY) / 2;
	return { scale, offsetX: -centerX * scale, offsetY: -centerY * scale };
}

/** The bounding box of a set of points, or an empty box (all infinities) when
 * handed none. `fitTransform` reads that box as "nothing to frame". */
export function boundsOf(points: Iterable<Point>): WorldBounds {
	const bounds: WorldBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const point of points) {
		if (point.x < bounds.minX) bounds.minX = point.x;
		if (point.x > bounds.maxX) bounds.maxX = point.x;
		if (point.y < bounds.minY) bounds.minY = point.y;
		if (point.y > bounds.maxY) bounds.maxY = point.y;
	}
	return bounds;
}

/** Grows a box by half a node's extent on each side, so a fit frames the
 * tiles drawn at those points rather than their centres. Without this the
 * outermost tiles are half cut off at every zoom level. */
export function padBounds(bounds: WorldBounds, halfWidth: number, halfHeight: number): WorldBounds {
	if (!Number.isFinite(bounds.minX)) return bounds;
	return {
		minX: bounds.minX - halfWidth,
		minY: bounds.minY - halfHeight,
		maxX: bounds.maxX + halfWidth,
		maxY: bounds.maxY + halfHeight,
	};
}
