/**
 * Layout shapes: the silhouette the whole-base graph is laid out inside.
 *
 * The force model settles a graph sensibly, but the outline it settles into is
 * accidental, whatever the component packing spiral happened to produce. A
 * shape makes that outline a choice.
 *
 * A shape is a convex region centred on the origin, and there are only two
 * kinds: a circle, or a regular polygon held as its half-planes. Everything
 * else here (does a point sit inside, how far is the boundary along an angle,
 * how big must the region be to hold N nodes) is written once against those
 * two kinds, so adding a pentagon is a table entry rather than new geometry.
 *
 * Nothing in this file touches the DOM, canvas, or Obsidian's API: the
 * simulation and the renderer drive it, and it is asserted headless in Node.
 */

/** The stored wire values for the `shape` view option. `free` is the layout
 * this view had before shapes existed and keeps that path exactly. */
export type LayoutShape = 'free' | 'circle' | 'square' | 'diamond' | 'triangle' | 'hexagon';

/** Display names for the option dropdown, in the order they should appear.
 * Held here rather than in `GraphView` so a new shape is added in one place. */
export const LAYOUT_SHAPE_LABELS: Record<LayoutShape, string> = {
	free: 'Free',
	circle: 'Circle',
	square: 'Square',
	diamond: 'Diamond',
	triangle: 'Triangle',
	hexagon: 'Hexagon',
};

export function isLayoutShape(value: unknown): value is LayoutShape {
	return typeof value === 'string' && value in LAYOUT_SHAPE_LABELS;
}

/** A half-plane of a convex polygon: the interior is where
 * `x * nx + y * ny <= distance`, with `(nx, ny)` a unit outward normal. */
interface ShapeEdge {
	nx: number;
	ny: number;
	distance: number;
}

/**
 * A sized region centred on the origin.
 *
 * `edges` is null for a circle, which is not a polygon and would need an
 * unbounded number of half-planes to be one. `size` is the inradius in both
 * cases (the circle's radius; a polygon's apothem, the centre-to-edge
 * distance), which is what makes the two comparable: two shapes with the same
 * `size` contain the same inscribed circle.
 */
export interface ShapeGeometry {
	shape: LayoutShape;
	size: number;
	edges: readonly ShapeEdge[] | null;
}

/** Sides per polygonal shape. `diamond` is a square stood on a corner, which
 * is a rotation rather than a different polygon, so the rotation table below
 * is what separates the two. */
const SHAPE_SIDES: Record<Exclude<LayoutShape, 'free' | 'circle'>, number> = {
	square: 4,
	diamond: 4,
	triangle: 3,
	hexagon: 6,
};

/**
 * Rotation applied to each polygon, in radians, chosen so each shape reads the
 * way its name does on screen rather than however the generic construction
 * happened to land: a square sits flat, a diamond is that same square turned
 * an eighth of a turn onto its corner, a triangle points up, a hexagon sits
 * flat. Canvas y grows downward, so a triangle whose single edge normal points
 * at +y has that edge along the bottom and its apex at the top.
 */
const SHAPE_ROTATION: Record<Exclude<LayoutShape, 'free' | 'circle'>, number> = {
	square: 0,
	diamond: Math.PI / 4,
	triangle: Math.PI / 2,
	hexagon: 0,
};

/**
 * Builds the geometry for a shape at a given inradius. Returns null for
 * `free`, which is the "no boundary at all" case rather than a boundary of
 * some size, so callers branch on null instead of on a sentinel size.
 */
export function shapeGeometry(shape: LayoutShape, size: number): ShapeGeometry | null {
	if (shape === 'free') return null;
	const safeSize = Math.max(1, size);
	if (shape === 'circle') return { shape, size: safeSize, edges: null };
	const sides = SHAPE_SIDES[shape];
	const rotation = SHAPE_ROTATION[shape];
	const edges: ShapeEdge[] = [];
	for (let i = 0; i < sides; i += 1) {
		const angle = rotation + (i * 2 * Math.PI) / sides;
		edges.push({ nx: Math.cos(angle), ny: Math.sin(angle), distance: safeSize });
	}
	return { shape, size: safeSize, edges };
}

/**
 * How much area a shape of this inradius covers. Used to invert a node count
 * into a size, so the same base is drawn at the same density whichever shape
 * is picked instead of a triangle coming out three times as cramped as a
 * square.
 */
export function shapeArea(shape: Exclude<LayoutShape, 'free'>, size: number): number {
	if (shape === 'circle') return Math.PI * size * size;
	const sides = SHAPE_SIDES[shape];
	return sides * size * size * Math.tan(Math.PI / sides);
}

/**
 * The fraction of the shape's area the node tiles themselves take up.
 *
 * Not a packing bound: circles pack at about 0.9, and a graph drawn that
 * tightly is the knot this whole effort is about. A fifth leaves room for
 * labels, for the edges between tiles to read as lines rather than as a
 * texture, and for the simulation to move a node without immediately
 * colliding. Sized against what the free layout's seeding spiral produces, so
 * switching a base from `Free` to `Circle` keeps it roughly the size it
 * already was.
 */
const NODE_PACKING_FRACTION = 0.2;

/**
 * The inradius a shape needs to hold this many nodes of this radius at the
 * density above. Growing with the square root of the count is what keeps that
 * density constant: area has to grow linearly with the node count, and area
 * goes as the square of the size.
 *
 * `spacingScale` is how airy the caller wants it, as a multiple of the default
 * density. `GraphRenderer` passes the Link distance slider over its default,
 * which makes that one slider the spread control for a shaped layout: it
 * already scales the repulsion cutoff and the speed cap for the same reason
 * (nothing in a force layout means anything except relative to the distance a
 * link rests at), and with centring off under a shape it is the only knob that
 * would otherwise have nothing to push against.
 */
export function shapeSizeForNodes(
	shape: Exclude<LayoutShape, 'free'>,
	nodeCount: number,
	nodeRadius: number,
	spacingScale = 1,
): number {
	const count = Math.max(1, nodeCount);
	const radius = Math.max(1, nodeRadius);
	const spacing = Math.max(0.1, spacingScale);
	const targetArea = (count * Math.PI * radius * radius * spacing * spacing) / NODE_PACKING_FRACTION;
	// Invert `shapeArea`: it is quadratic in `size` with a shape-dependent
	// coefficient, so one evaluation at size 1 gives that coefficient.
	return Math.sqrt(targetArea / shapeArea(shape, 1));
}

export interface ShapeDistance {
	/** Positive outside the shape, negative inside, in world units. */
	distance: number;
	/** Unit outward normal at the point: the direction a node outside the
	 * shape has to be pushed back along. */
	nx: number;
	ny: number;
}

/**
 * Signed distance from a point to the shape's boundary, with the outward
 * normal there.
 *
 * For a polygon this is the largest of the per-edge half-plane distances: the
 * sign is exact everywhere, and so is the magnitude out beyond an edge, but out
 * beyond a corner it is an underestimate, because the point is outside two
 * half-planes at once and only the worse of the two is reported. `projectInside`
 * is what turns that into a correct push; nothing else needs the magnitude.
 */
export function shapeSignedDistance(geometry: ShapeGeometry, x: number, y: number): ShapeDistance {
	if (!geometry.edges) {
		const length = Math.hypot(x, y);
		// Dead centre has no meaningful outward direction; any unit vector
		// will do, and the distance is the full radius inward either way.
		if (length < 1e-6) return { distance: -geometry.size, nx: 1, ny: 0 };
		return { distance: length - geometry.size, nx: x / length, ny: y / length };
	}
	let best = geometry.edges[0];
	let bestDistance = -Infinity;
	for (const edge of geometry.edges) {
		const distance = x * edge.nx + y * edge.ny - edge.distance;
		if (distance > bestDistance) {
			bestDistance = distance;
			best = edge;
		}
	}
	return { distance: bestDistance, nx: best.nx, ny: best.ny };
}

/**
 * Distance from the origin to the boundary along a ray at `angle`.
 *
 * This is what lets one fill routine cover every shape: a point is chosen in
 * polar form against the unit disc and then stretched out to the boundary
 * along its own direction, so a square's fill reaches into its corners instead
 * of being a disc with the corners left empty.
 */
export function boundaryDistanceAt(geometry: ShapeGeometry, angle: number): number {
	if (!geometry.edges) return geometry.size;
	const dx = Math.cos(angle);
	const dy = Math.sin(angle);
	let limit = Infinity;
	for (const edge of geometry.edges) {
		const along = dx * edge.nx + dy * edge.ny;
		// A ray running parallel to an edge or away from it never crosses it,
		// so that edge places no limit on how far the ray can travel.
		if (along <= 1e-9) continue;
		limit = Math.min(limit, edge.distance / along);
	}
	return Number.isFinite(limit) ? limit : geometry.size;
}

/** The angle between successive points of a phyllotaxis (sunflower) spiral,
 * the same golden angle the free layout seeds on: the one irrational rotation
 * that never lines two points up radially, so the fill never leaves a seam. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Keeps the outermost fill point just inside the boundary rather than exactly
 * on it, so containment is not already fighting the seeding on the first tick. */
const FILL_INSET = 0.94;

/**
 * The `index`-th of `count` points filling the shape.
 *
 * Radius grows as the square root of the index, which is what spreads points
 * evenly by area rather than crowding the middle; the angle advances by the
 * golden angle; and the result is scaled to the boundary along that angle so
 * the fill takes the shape's outline.
 *
 * Deterministic in both arguments, so the same base fills the same way on
 * every open, which is the rule the whole layout is held to.
 *
 * Note that consecutive indices are NOT neighbours: successive points of a
 * phyllotaxis are a golden angle (about 137 degrees) apart, which is exactly
 * what stops the spiral leaving seams. Use `shapeFillOrder` when the points
 * have to be handed out to groups that want to land together.
 */
export function shapeFillPosition(
	geometry: ShapeGeometry,
	index: number,
	count: number,
): { x: number; y: number } {
	const total = Math.max(1, count);
	const angle = index * GOLDEN_ANGLE;
	// The half-step offset keeps the very first point off the exact centre,
	// where the largest component would otherwise start stacked on the origin.
	const unitRadius = Math.sqrt(Math.min(1, (index + 0.5) / total));
	const reach = boundaryDistanceAt(geometry, angle) * FILL_INSET * unitRadius;
	return { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach };
}

/** How far in from the boundary a projection lands when the margin asked for
 * is larger than the shape itself, as a fraction of the shape's size. Only
 * reachable for a node drawn bigger than the whole layout, which means a base
 * of one or two nodes; the point of the floor is that the projection stays a
 * real point rather than collapsing to the origin or turning inside out. */
const MIN_PROJECTION_SCALE = 0.05;

/**
 * The nearest point along the ray from the centre that lies inside the shape
 * by at least `margin`, or the point itself if it is already there.
 *
 * Pulling straight back toward the centre, rather than perpendicular to the
 * nearest edge, is both what containment wants (a node that drifted out is put
 * back where it came from) and the only correction that is exact in one step
 * for every shape here: `boundaryDistanceAt` gives the exact boundary along
 * that ray, and a convex region centred on the origin is crossed by any such
 * ray exactly once. A perpendicular push has to be iterated, and converges
 * slowly out past a narrow corner.
 *
 * The margin is applied by shrinking the shape rather than by stepping in from
 * the boundary: reach scales linearly with size, so a node lands inside a
 * shape one radius smaller, which is exactly "inside by its own radius" and
 * stays correct at a corner, where stepping perpendicular would not.
 */
export function projectInside(
	geometry: ShapeGeometry,
	x: number,
	y: number,
	margin = 0,
): { x: number; y: number } {
	if (shapeSignedDistance(geometry, x, y).distance + margin <= 0) return { x, y };
	const scale = Math.max(MIN_PROJECTION_SCALE, (geometry.size - margin) / geometry.size);
	const angle = Math.atan2(y, x);
	const reach = boundaryDistanceAt(geometry, angle) * scale;
	return { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach };
}

/**
 * The same fill, ordered so that points handed out consecutively land near
 * each other.
 *
 * `shapeFillPosition` covers the shape evenly but visits it in golden-angle
 * jumps, so handing its points out in index order scatters each component
 * across the whole shape and leaves the link force to drag every island back
 * together from opposite sides. Sorting the fill by angle turns "the next N
 * points" into a wedge of the shape instead of a scatter across it: a
 * component gets a contiguous slice whose width is its share of the nodes.
 *
 * The radius is the tiebreak, so a component narrow enough to sit inside one
 * angular step still comes out contiguous from the centre outward rather than
 * split across the radius.
 */
export function shapeFillOrder(geometry: ShapeGeometry, count: number): { x: number; y: number }[] {
	const points = Array.from({ length: Math.max(0, count) }, (_, index) => {
		const point = shapeFillPosition(geometry, index, count);
		return { ...point, angle: Math.atan2(point.y, point.x), radius: Math.hypot(point.x, point.y) };
	});
	points.sort((a, b) => a.angle - b.angle || a.radius - b.radius);
	return points.map((point) => ({ x: point.x, y: point.y }));
}
