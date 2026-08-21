/**
 * Force-directed layout, written here rather than pulled in as a dependency
 * (see the plan's "Deliberately not doing" section: d3-force is tens of
 * kilobytes for something a quadtree gives us, and this plugin ships no
 * runtime dependencies).
 *
 * Nothing in this file touches the DOM, canvas, or Obsidian's API, on
 * purpose: `GraphRenderer` drives it from a `requestAnimationFrame` loop, but
 * the physics and the tree it runs on are asserted headless in Node.
 */

import type { ShapeGeometry } from './layoutShapes';
import { boundaryDistanceAt, projectInside, shapeSignedDistance } from './layoutShapes';

// ---- Deterministic seeding -------------------------------------------------

/** FNV-1a over the node id, so the same base lays out the same way on every
 * open instead of reshuffling from `Math.random()`. */
function hashString(id: string): number {
	let hash = 2166136261;
	for (let i = 0; i < id.length; i += 1) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/** Splitmix-style bit mixer, used twice per id (with a different salt) to get
 * two independent-looking values out of one hash without a second string
 * pass. */
function mixBits(x: number): number {
	let value = x;
	value = Math.imul(value ^ (value >>> 16), 2246822507);
	value = Math.imul(value ^ (value >>> 13), 3266489909);
	value ^= value >>> 16;
	return value >>> 0;
}

/** The angle between successive points on a phyllotaxis (sunflower) spiral:
 * the golden angle, the one irrational rotation that never lines up two
 * points radially and so never leaves a gap or a seam in the spiral. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** World-unit spacing between successive rings of the seeding spiral. Chosen
 * to match `DEFAULT_FORCE_OPTIONS.collisionRadius * 2` (twice the tile-sized
 * collision radius the simulation resolves overlap against), so consecutive
 * seed points land close to already touching rather than either stacked or
 * scattered needlessly far apart. Kept as a literal rather than a reference
 * to `DEFAULT_FORCE_OPTIONS` (declared later in this file) so this stays
 * ordering-independent; the two are asserted to agree in forceLayout.test.ts. */
const SEED_SPACING = 44;

/** Initial position for a node before the simulation has run a single tick,
 * placed by its index in the current node order on a phyllotaxis spiral:
 * radius grows with the square root of the index (the classic sunflower
 * seed-head packing, which keeps points evenly dense as the spiral grows
 * rather than thinning out or crowding), angle advances by the golden angle
 * each step. Seeding by index rather than by hashing the id is what makes
 * the initial spread already close to a settled layout instead of a pile the
 * simulation has to untangle from a standing start: every seed point starts
 * roughly `SEED_SPACING` from its neighbours in seed order, at every graph
 * size, rather than every node starting in roughly the same small region.
 *
 * Deterministic and stable: the same index always produces the same point,
 * so a node keeps the same seed position on every open of the same graph
 * (`ForceSimulation.setGraph` calls this with a node's position in the
 * incoming id array, which is fixed for a given model). */
export function seedPosition(index: number): { x: number; y: number } {
	const angle = index * GOLDEN_ANGLE;
	const radius = SEED_SPACING * Math.sqrt(index);
	return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

// ---- Barnes-Hut quadtree ---------------------------------------------------

export interface QuadBody {
	id: string;
	x: number;
	y: number;
}

interface QuadRegion {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Guards against unbounded recursion when bodies coincide exactly (two
 * nodes seeded or dragged onto the same point). Past this depth, further
 * bodies are folded into the leaf's aggregate mass rather than split again;
 * it is an approximation only for that degenerate case. */
const MAX_DEPTH = 24;

/** Below this squared distance, force magnitude is capped by treating the
 * distance as if it were this large, so two nearly coincident bodies do not
 * produce a force spike that throws the simulation apart. */
const MIN_DIST_SQ = 4;

class QuadNode {
	region: QuadRegion;
	mass = 0;
	cx = 0;
	cy = 0;
	/** Non-null only for a leaf holding exactly one body. A leaf past
	 * `MAX_DEPTH` with more than one body has `body === null` and `mass > 1`:
	 * an aggregate with no children, the depth-limit fallback above. */
	body: QuadBody | null = null;
	nw: QuadNode | null = null;
	ne: QuadNode | null = null;
	sw: QuadNode | null = null;
	se: QuadNode | null = null;

	constructor(region: QuadRegion) {
		this.region = region;
	}

	get isLeaf(): boolean {
		return this.nw === null;
	}
}

function subdivide(node: QuadNode): void {
	const { x0, y0, x1, y1 } = node.region;
	const midX = (x0 + x1) / 2;
	const midY = (y0 + y1) / 2;
	node.nw = new QuadNode({ x0, y0, x1: midX, y1: midY });
	node.ne = new QuadNode({ x0: midX, y0, x1, y1: midY });
	node.sw = new QuadNode({ x0, y0: midY, x1: midX, y1 });
	node.se = new QuadNode({ x0: midX, y0: midY, x1, y1 });
}

function childFor(node: QuadNode, body: QuadBody): QuadNode {
	const { x0, y0, x1, y1 } = node.region;
	const midX = (x0 + x1) / 2;
	const midY = (y0 + y1) / 2;
	const east = body.x >= midX;
	const south = body.y >= midY;
	if (east && south) return node.se as QuadNode;
	if (east) return node.ne as QuadNode;
	if (south) return node.sw as QuadNode;
	return node.nw as QuadNode;
}

function insert(node: QuadNode, body: QuadBody, depth: number): void {
	if (node.mass === 0) {
		node.body = body;
		node.mass = 1;
		node.cx = body.x;
		node.cy = body.y;
		return;
	}

	if (node.isLeaf && node.body !== null) {
		const existing = node.body;
		const coincident = existing.x === body.x && existing.y === body.y;
		if (depth >= MAX_DEPTH || coincident) {
			node.body = null;
			node.cx = (node.cx * node.mass + body.x) / (node.mass + 1);
			node.cy = (node.cy * node.mass + body.y) / (node.mass + 1);
			node.mass += 1;
			return;
		}
		subdivide(node);
		node.body = null;
		insert(childFor(node, existing), existing, depth + 1);
		node.cx = (node.cx * node.mass + body.x) / (node.mass + 1);
		node.cy = (node.cy * node.mass + body.y) / (node.mass + 1);
		node.mass += 1;
		insert(childFor(node, body), body, depth + 1);
		return;
	}

	node.cx = (node.cx * node.mass + body.x) / (node.mass + 1);
	node.cy = (node.cy * node.mass + body.y) / (node.mass + 1);
	node.mass += 1;

	if (node.isLeaf) {
		// Saturated leaf past MAX_DEPTH: fold into the aggregate, no children.
		return;
	}
	insert(childFor(node, body), body, depth + 1);
}

function applyPoint(
	px: number,
	py: number,
	mass: number,
	x: number,
	y: number,
	strength: number,
	out: { fx: number; fy: number },
): void {
	const dx = x - px;
	const dy = y - py;
	const distSq = Math.max(dx * dx + dy * dy, MIN_DIST_SQ);
	const dist = Math.sqrt(distSq);
	const force = (strength * mass) / distSq;
	out.fx += (dx / dist) * force;
	out.fy += (dy / dist) * force;
}

/** Squared minimum distance from `(x, y)` to the closest point of `region`,
 * zero when `(x, y)` is inside it. Used to prune a whole subtree once every
 * point it could possibly contain is already beyond the repulsion cutoff,
 * which is both a correctness bound (nothing closer than this is skipped)
 * and the speedup Barnes-Hut is supposed to give a cutoff for. */
function regionMinDistSq(region: QuadRegion, x: number, y: number): number {
	const dx = Math.max(region.x0 - x, 0, x - region.x1);
	const dy = Math.max(region.y0 - y, 0, y - region.y1);
	return dx * dx + dy * dy;
}

function accumulate(
	node: QuadNode | null,
	x: number,
	y: number,
	excludeId: string | null,
	theta: number,
	strength: number,
	distanceMaxSq: number,
	out: { fx: number; fy: number },
): void {
	if (!node || node.mass === 0) return;

	// A cutoff of Infinity (the "no limit" case the correctness assertions
	// use) always fails this check and falls through unchanged.
	if (regionMinDistSq(node.region, x, y) > distanceMaxSq) return;

	if (node.isLeaf && node.body) {
		if (node.body.id === excludeId) return;
		applyPoint(node.cx, node.cy, 1, x, y, strength, out);
		return;
	}

	if (node.isLeaf) {
		// Saturated aggregate leaf: no children to recurse into, so it is
		// always treated as one combined mass point.
		applyPoint(node.cx, node.cy, node.mass, x, y, strength, out);
		return;
	}

	const dx = x - node.cx;
	const dy = y - node.cy;
	const distSq = Math.max(dx * dx + dy * dy, MIN_DIST_SQ);
	const side = node.region.x1 - node.region.x0;
	if ((side * side) / distSq < theta * theta) {
		applyPoint(node.cx, node.cy, node.mass, x, y, strength, out);
		return;
	}

	accumulate(node.nw, x, y, excludeId, theta, strength, distanceMaxSq, out);
	accumulate(node.ne, x, y, excludeId, theta, strength, distanceMaxSq, out);
	accumulate(node.sw, x, y, excludeId, theta, strength, distanceMaxSq, out);
	accumulate(node.se, x, y, excludeId, theta, strength, distanceMaxSq, out);
}

function visitBox(node: QuadNode | null, x0: number, y0: number, x1: number, y1: number, results: string[]): void {
	if (!node || node.mass === 0) return;
	const r = node.region;
	if (r.x1 < x0 || r.x0 > x1 || r.y1 < y0 || r.y0 > y1) return;

	if (node.isLeaf) {
		if (node.body && node.body.x >= x0 && node.body.x <= x1 && node.body.y >= y0 && node.body.y <= y1) {
			results.push(node.body.id);
		}
		return;
	}
	visitBox(node.nw, x0, y0, x1, y1, results);
	visitBox(node.ne, x0, y0, x1, y1, results);
	visitBox(node.sw, x0, y0, x1, y1, results);
	visitBox(node.se, x0, y0, x1, y1, results);
}

export class Quadtree {
	private constructor(private readonly root: QuadNode) {}

	static build(bodies: QuadBody[]): Quadtree {
		if (bodies.length === 0) {
			return new Quadtree(new QuadNode({ x0: -1, y0: -1, x1: 1, y1: 1 }));
		}
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const body of bodies) {
			if (body.x < minX) minX = body.x;
			if (body.x > maxX) maxX = body.x;
			if (body.y < minY) minY = body.y;
			if (body.y > maxY) maxY = body.y;
		}
		const size = Math.max(maxX - minX, maxY - minY, 1) + 2;
		const midX = (minX + maxX) / 2;
		const midY = (minY + maxY) / 2;
		const half = size / 2;
		const root = new QuadNode({ x0: midX - half, y0: midY - half, x1: midX + half, y1: midY + half });
		for (const body of bodies) insert(root, body, 0);
		return new Quadtree(root);
	}

	/** Net repulsive force on a point at `(x, y)` from every body in the tree
	 * except `excludeId`, approximated per node with the Barnes-Hut `theta`
	 * criterion (a cluster whose bounding side is small relative to its
	 * distance is treated as one mass point rather than expanded). `theta = 0`
	 * always expands to individual bodies, which is what the correctness
	 * assertions use to compare against a brute-force sum.
	 *
	 * `distanceMax` (world units, `Infinity` for no cutoff) prunes any
	 * subtree that cannot contain a body within range, per
	 * `regionMinDistSq`. This is the fix for repulsion's force on a node
	 * otherwise scaling with total node count `N`: without it, a node at the
	 * centre of a large disconnected cloud is pushed by every other node in
	 * the graph regardless of how far away it already is, so the more nodes
	 * a base has the harder the opening tick shoves everything outward. */
	forceOn(x: number, y: number, excludeId: string | null, theta: number, strength: number, distanceMax: number): { fx: number; fy: number } {
		const out = { fx: 0, fy: 0 };
		const distanceMaxSq = distanceMax * distanceMax;
		accumulate(this.root, x, y, excludeId, theta, strength, distanceMaxSq, out);
		return out;
	}

	/** Ids of bodies whose exact position falls within the axis-aligned box.
	 * This is the hit-test path: `GraphRenderer` reuses the same tree built
	 * for this tick's force accumulation instead of a separate uniform grid. */
	queryBox(x0: number, y0: number, x1: number, y1: number): string[] {
		const results: string[] = [];
		visitBox(this.root, x0, y0, x1, y1, results);
		return results;
	}
}

/** O(n^2) reference used only by assertions, to check the quadtree traversal
 * against a direct sum rather than trusting the tree's own bookkeeping.
 * `distanceMax` defaults to no cutoff so existing exact-match assertions
 * (built against `theta = 0`, which never approximates) are unaffected. */
export function bruteForceRepulsion(
	bodies: QuadBody[],
	strength: number,
	distanceMax = Infinity,
): Map<string, { fx: number; fy: number }> {
	const result = new Map<string, { fx: number; fy: number }>();
	for (const body of bodies) {
		const out = { fx: 0, fy: 0 };
		for (const other of bodies) {
			if (other.id === body.id) continue;
			const dx = other.x - body.x;
			const dy = other.y - body.y;
			if (dx * dx + dy * dy > distanceMax * distanceMax) continue;
			applyPoint(other.x, other.y, 1, body.x, body.y, strength, out);
		}
		result.set(body.id, out);
	}
	return result;
}

// ---- Force simulation -------------------------------------------------------

export interface SimNode {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	pinned: boolean;
	/** World-unit radius this node occupies, from `setNodeRadii`. Falls back
	 * to `ForceOptions.collisionRadius` when the caller described no radius
	 * for it, so a caller that never calls `setNodeRadii` behaves exactly as
	 * it did when every node was the same size. */
	radius: number;
	/** The point this node is centred toward, which is its own component's
	 * centre rather than the world origin. Zero for a caller that never set
	 * component centres, which is the single-component case anyway. */
	centerX: number;
	centerY: number;
}

export interface SimLink {
	source: string;
	target: string;
}

/** A link with the two numbers d3-force derives once from endpoint degree and
 * then reuses every tick. Kept beside the links rather than recomputed per
 * tick: degree cannot change without `setGraph` being called again. */
interface PreparedLink extends SimLink {
	/** `linkStrength` divided by the smaller endpoint degree. A leaf hanging
	 * off a hub pulls with its full share; the hub, which is being pulled by
	 * every one of its neighbours at once, is not dragged around by any one
	 * of them. */
	strengthScale: number;
	/** The source's share of the pair's degree. The correction is split by
	 * this, so the heavier endpoint absorbs less of it and the lighter one
	 * moves to meet it. Without this a hub is whipped about by its own
	 * neighbourhood, which is what a hairball is. */
	bias: number;
}

export interface ForceOptions {
	linkDistance: number;
	linkStrength: number;
	repulsion: number;
	/** Per-node centring coefficient. `tick()` multiplies this by the live
	 * node count before applying it (see the comment there), so this value
	 * is the *per-node* contribution, not the effective pull on any one
	 * graph. */
	gravity: number;
	theta: number;
	/** World units beyond which two bodies no longer repel each other.
	 * `Infinity` restores the old unbounded behaviour, which the exact-match
	 * correctness assertions rely on. */
	distanceMax: number;
	/** Per-tick displacement cap, applied to the resolved velocity right
	 * before it is added to position. Bounds how far any node can jump in a
	 * single frame, which matters most on the first few ticks at `alpha = 1`
	 * before the cutoff and centring above have had a chance to act. */
	maxSpeed: number;
	velocityDecay: number;
	alphaMin: number;
	alphaDecay: number;
	alphaTarget: number;
	/** World-unit radius a node's tile occupies for collision purposes. Two
	 * unpinned nodes are pushed apart whenever the distance between their
	 * centres drops below twice this, which is what keeps tiles from settling
	 * on top of each other (`GraphRenderer` sets this from half its own
	 * `TILE_SIZE`; `forceLayout.ts` otherwise has no notion of a tile). Zero
	 * or less disables collision entirely. */
	collisionRadius: number;
}

/** `alphaDecay` chosen the way d3-force does: reach `alphaMin` in roughly 300
 * ticks from `alpha = 1` with `alphaTarget = 0`, which is the bound the
 * cooling assertion checks against.
 *
 * `distanceMax` and `maxSpeed` are both expressed as multiples of
 * `linkDistance` rather than fixed numbers, and `GraphRenderer` recomputes
 * them from the live `linkDistance` slider for the same reason: a cutoff
 * only makes sense relative to the scale the rest of the layout is drawn
 * at. 5x `linkDistance` (600 here) is far enough that connected clusters
 * several link-lengths apart still repel each other and keep their
 * separation, but a node stops being pushed by the rest of a large,
 * disconnected graph once it is well clear of it, which is what keeps the
 * per-node force from scaling with total node count. 1.5x `linkDistance`
 * (180 here) as the per-tick speed cap is generous enough not to visibly
 * slow normal settling once alpha has decayed, while still preventing the
 * opening `alpha = 1` ticks from throwing a node clear off screen in one
 * frame. */
export const DEFAULT_FORCE_OPTIONS: ForceOptions = {
	linkDistance: 120,
	linkStrength: 0.35,
	repulsion: 260,
	gravity: 0.02,
	theta: 0.85,
	distanceMax: 120 * 5,
	maxSpeed: 120 * 1.5,
	velocityDecay: 0.4,
	alphaMin: 0.001,
	alphaDecay: 1 - Math.pow(0.001, 1 / 300),
	alphaTarget: 0,
	collisionRadius: 22,
};

/** Relaxation passes run per tick to resolve tile overlap. One pass only
 * pushes directly-overlapping pairs apart, which can open a new overlap with
 * a third node that was already close; a couple more passes settle those
 * knock-on cases without the cost of iterating to full convergence every
 * frame, which is unnecessary when the simulation is already ticking at
 * 60fps and will settle further next frame regardless. */
const COLLISION_ITERATIONS = 3;

/** How much of the way toward an even fill each tick moves a node, when a
 * layout shape is active.
 *
 * Small on purpose. This is a bias applied every tick, not a correction: at
 * this rate the forces still decide where a node goes relative to its
 * neighbours, and the fill only decides how the graph's nodes are spread from
 * the centre outward. Large enough and clusters get visibly smeared into
 * arcs; too small and the layout cools before the rim fills.
 */
const CONFORM_RATE = 0.06;

/** Multiplies `ForceOptions.distanceMax`/`maxSpeed` derivation from
 * `linkDistance`, exported so `GraphRenderer` recomputes both from the live
 * `Link distance` slider instead of the two staying pinned to the default. */
export const DISTANCE_MAX_LINK_FACTOR = 5;
export const MAX_SPEED_LINK_FACTOR = 1.5;

/** Maps the 0-100 "Repel force" slider (`GraphView.getViewOptions`, stored
 * key `repulsion`) onto a charge magnitude. The slider is a coarse knob, not
 * a physical unit, so the mapping only needs to feel monotonic and
 * reasonable across its range. */
export function repulsionSliderToStrength(sliderValue: number): number {
	return 80 + sliderValue * 24;
}

/** Maps the 0-100 "Center force" slider (stored key `centerForce`) onto
 * `ForceOptions.gravity`. The slider's default of 40 (`GraphView`'s
 * `DEFAULT_CENTER_FORCE`) reproduces `DEFAULT_FORCE_OPTIONS.gravity` (0.02)
 * exactly, so adding this slider does not itself change how any existing
 * base already renders. */
export function centerForceSliderToGravity(sliderValue: number): number {
	return (sliderValue / 100) * 0.05;
}

/** Maps the 0-100 "Link force" slider (stored key `linkForce`) onto
 * `ForceOptions.linkStrength`. The slider's default of 50 (`GraphView`'s
 * `DEFAULT_LINK_FORCE`) reproduces `DEFAULT_FORCE_OPTIONS.linkStrength`
 * (0.35) exactly, for the same reason. */
export function linkForceSliderToStrength(sliderValue: number): number {
	return (sliderValue / 100) * 0.7;
}

/**
 * Degree-normalized link weights, computed once per graph the way d3-force
 * does. Degree is counted over the links actually being simulated, not taken
 * from `GraphNode.degree`, so a filtered or trimmed edge set weights itself
 * correctly rather than by edges that are not on the canvas.
 */
function prepareLinks(links: SimLink[], nodes: ReadonlyMap<string, SimNode>): PreparedLink[] {
	const degree = new Map<string, number>();
	for (const link of links) {
		if (!nodes.has(link.source) || !nodes.has(link.target)) continue;
		degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
		degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
	}
	return links.map((link) => {
		const sourceDegree = degree.get(link.source) ?? 1;
		const targetDegree = degree.get(link.target) ?? 1;
		return {
			...link,
			strengthScale: 1 / Math.max(1, Math.min(sourceDegree, targetDegree)),
			bias: sourceDegree / Math.max(1, sourceDegree + targetDegree),
		};
	});
}

export class ForceSimulation {
	private nodes = new Map<string, SimNode>();
	private links: PreparedLink[] = [];
	/** Radii by node id, from `setNodeRadii`. Held separately from the nodes
	 * so a radius survives `setGraph` re-seeding a node, and so a caller can
	 * set radii before or after the graph without ordering mattering. */
	private nodeRadii: ReadonlyMap<string, number> | null = null;
	/** Component centres by node id, from `setComponentCenters`. Same
	 * reasoning as the radii above. */
	private nodeCenters: ReadonlyMap<string, { x: number; y: number }> | null = null;
	private alpha = 0;
	private options: ForceOptions = { ...DEFAULT_FORCE_OPTIONS };
	private quadtree: Quadtree | null = null;
	/** Focus mode's radial layout: a node with an entry here is held at that
	 * exact distance from the origin every tick (radius fixed by depth, per
	 * the plan), while everything that moves it there during the tick
	 * (repulsion, links, collision) is left free to keep acting on it. Null
	 * in whole-base mode, where no node is ring-constrained and the existing
	 * force layout is unchanged. */
	private ringRadii: ReadonlyMap<string, number> | null = null;
	/** The region the layout is confined to, from `setShape`. Null is the
	 * unbounded `Free` layout, which is what this view did before shapes
	 * existed. */
	private shape: ShapeGeometry | null = null;

	setOptions(partial: Partial<ForceOptions>): void {
		this.options = { ...this.options, ...partial };
		// A changed default radius has to reach nodes the caller never
		// described, or a `collisionRadius` change would only take effect for
		// nodes added afterwards.
		this.applyNodeRadii();
	}

	/** Per-node collision radii, keyed by node id. `GraphRenderer` passes what
	 * it actually draws, so a hub scaled up by degree separates by the size on
	 * screen rather than by a shared constant that is smaller than the tile.
	 * A node with no entry keeps `ForceOptions.collisionRadius`. */
	setNodeRadii(radii: ReadonlyMap<string, number> | null): void {
		this.nodeRadii = radii;
		this.applyNodeRadii();
	}

	/** The point each node is centred toward, so every connected component
	 * settles around its own centre instead of all of them competing for the
	 * origin. Null clears them back to the origin. */
	setComponentCenters(centers: ReadonlyMap<string, { x: number; y: number }> | null): void {
		this.nodeCenters = centers;
		for (const node of this.nodes.values()) {
			const center = centers?.get(node.id);
			node.centerX = center?.x ?? 0;
			node.centerY = center?.y ?? 0;
		}
	}

	private applyNodeRadii(): void {
		for (const node of this.nodes.values()) {
			node.radius = this.nodeRadii?.get(node.id) ?? this.options.collisionRadius;
		}
	}

	/** Installs (or clears, with `null`) the focus-mode ring-radius
	 * constraint. Keyed by node id; a node with no entry is unconstrained.
	 * `GraphRenderer` calls this once per `update()`, matching how
	 * `setGraph`/`setOptions` are driven. */
	setRingRadii(radii: ReadonlyMap<string, number> | null): void {
		this.ringRadii = radii;
	}

	/** Confines the layout to a region (or releases it, with `null`).
	 * `GraphRenderer` sets this once per `update()` alongside the ring radii,
	 * from the `Shape` option. */
	setShape(shape: ShapeGeometry | null): void {
		this.shape = shape;
	}

	/** Moves every node named here to that exact point, at rest.
	 *
	 * `setGraph` deliberately keeps the position of any node whose id survives,
	 * so a data refresh does not throw away a settled layout. That is wrong for
	 * a change of shape: the node set is identical, so nothing would be
	 * re-seeded and the new boundary would only ever push in whatever stragglers
	 * ended up outside it, rather than the graph taking the new shape. A pinned
	 * node keeps its pin, since the user put it there.
	 */
	reseedAll(positions: ReadonlyMap<string, { x: number; y: number }>): void {
		for (const node of this.nodes.values()) {
			if (node.pinned) continue;
			const seed = positions.get(node.id);
			if (!seed) continue;
			node.x = seed.x;
			node.y = seed.y;
			node.vx = 0;
			node.vy = 0;
		}
		this.quadtree = null;
	}

	getOptions(): ForceOptions {
		return this.options;
	}

	/** Replaces the node/edge set. Nodes whose id persists keep their position,
	 * velocity and pin; new ids are seeded deterministically (by their
	 * position in `nodeIds`, per `seedPosition`, unless `seedOverrides`
	 * supplies an exact point for that id (the radial layout uses this to
	 * drop a focus-mode node straight onto its ring rather than the spiral);
	 * dropped ids are discarded. Returns whether the id set actually changed,
	 * which is what `GraphRenderer` uses to decide whether this was a real
	 * model change worth re-warming the simulation for. */
	setGraph(nodeIds: string[], links: SimLink[], seedOverrides?: ReadonlyMap<string, { x: number; y: number }>): boolean {
		const next = new Map<string, SimNode>();
		let changed = nodeIds.length !== this.nodes.size;
		nodeIds.forEach((id, index) => {
			const existing = this.nodes.get(id);
			if (existing) {
				next.set(id, existing);
				return;
			}
			changed = true;
			const seed = seedOverrides?.get(id) ?? seedPosition(index);
			const center = this.nodeCenters?.get(id);
			next.set(id, {
				id,
				x: seed.x,
				y: seed.y,
				vx: 0,
				vy: 0,
				pinned: false,
				radius: this.nodeRadii?.get(id) ?? this.options.collisionRadius,
				centerX: center?.x ?? 0,
				centerY: center?.y ?? 0,
			});
		});
		if (!changed && next.size === this.nodes.size) {
			for (const id of next.keys()) {
				if (!this.nodes.has(id)) {
					changed = true;
					break;
				}
			}
		}
		this.nodes = next;
		this.links = prepareLinks(links, next);
		this.quadtree = null;
		return changed;
	}

	reheat(alpha = 1): void {
		this.alpha = Math.max(this.alpha, Math.min(1, alpha));
	}

	isRunning(): boolean {
		return this.alpha > this.options.alphaMin;
	}

	getAlpha(): number {
		return this.alpha;
	}

	pin(id: string, x: number, y: number): void {
		const node = this.nodes.get(id);
		if (!node) return;
		node.pinned = true;
		node.x = x;
		node.y = y;
		node.vx = 0;
		node.vy = 0;
	}

	unpin(id: string): void {
		const node = this.nodes.get(id);
		if (node) node.pinned = false;
	}

	getPosition(id: string): { x: number; y: number } | undefined {
		const node = this.nodes.get(id);
		return node ? { x: node.x, y: node.y } : undefined;
	}

	positions(): Map<string, { x: number; y: number }> {
		const result = new Map<string, { x: number; y: number }>();
		for (const node of this.nodes.values()) result.set(node.id, { x: node.x, y: node.y });
		return result;
	}

	/** Builds (or returns the tick-cached) quadtree over current positions.
	 * Never null, so `GraphRenderer` can hit-test even before the first tick
	 * has run (right after `setGraph`, before any `requestAnimationFrame`
	 * fires). */
	getQuadtree(): Quadtree {
		if (!this.quadtree) {
			this.quadtree = Quadtree.build(Array.from(this.nodes.values(), (n) => ({ id: n.id, x: n.x, y: n.y })));
		}
		return this.quadtree;
	}

	/** Advances the simulation one step. Returns whether it is still running
	 * after the step, which is what the caller uses to decide whether to keep
	 * scheduling animation frames. A caller that keeps calling `tick()` after
	 * this returns false just keeps re-doing nothing at negligible cost, but
	 * `GraphRenderer` stops scheduling frames entirely instead, per the
	 * "an always-warm simulation is a permanent frame cost" rule. */
	tick(): boolean {
		if (!this.isRunning()) return false;
		const opts = this.options;
		this.alpha += (opts.alphaTarget - this.alpha) * opts.alphaDecay;

		const bodies = Array.from(this.nodes.values(), (n) => ({ id: n.id, x: n.x, y: n.y }));
		const quad = Quadtree.build(bodies);
		this.quadtree = quad;

		for (const node of this.nodes.values()) {
			if (node.pinned) continue;
			const force = quad.forceOn(node.x, node.y, node.id, opts.theta, opts.repulsion, opts.distanceMax);
			node.vx += force.fx * this.alpha;
			node.vy += force.fy * this.alpha;
		}

		for (const link of this.links) {
			const source = this.nodes.get(link.source);
			const target = this.nodes.get(link.target);
			if (!source || !target) continue;
			const dx = target.x - source.x;
			const dy = target.y - source.y;
			const dist = Math.max(Math.hypot(dx, dy), 0.001);
			// The rest length is measured between edges, not centres, so the
			// visible gap between two tiles is the same whatever their sizes.
			// Without this a hub scaled up by degree swallows its neighbours.
			const rest = opts.linkDistance + source.radius + target.radius;
			const diff = ((dist - rest) / dist) * opts.linkStrength * link.strengthScale * this.alpha;
			const fx = dx * diff;
			const fy = dy * diff;
			// `bias` is the source's share of the pair's degree, and each end
			// takes the *other* end's share of the correction: the heavier
			// node moves less, which is what stops a hub being dragged around
			// by every leaf hanging off it.
			if (!source.pinned) {
				source.vx += fx * (1 - link.bias);
				source.vy += fy * (1 - link.bias);
			}
			if (!target.pinned) {
				target.vx -= fx * link.bias;
				target.vy -= fy * link.bias;
			}
		}

		// Centring is a spring to the origin (`-x * coefficient`, growing
		// linearly with distance), while the repulsion above is a sum over
		// every other node within `distanceMax`. For a disconnected cloud
		// packed into a roughly circular area, that sum is driven by local
		// density (bodies per unit area within the cutoff): as `N` grows
		// with the cloud's own footprint growing to match it, each node's
		// net outward push settles toward a value that grows with `N`, not a
		// constant, so a fixed centring coefficient lets the equilibrium
		// radius (where the spring finally balances the outward push) drift
		// outward as the graph gets bigger. That is the "worse on a real
		// base than in a small test" complaint: a small test graph never
		// has enough nodes to notice.
		//
		// A coefficient that scaled linearly with `N` would fully cancel
		// that growth, but overcorrects in practice: it collapses a large
		// cloud into an unrealistically tight knot (verified empirically
		// against the assertions below) because the outward push does not
		// actually grow linearly once `distanceMax` is capping how many
		// neighbours any node contends with. Scaling by `sqrt(N)` instead
		// tracks the outward push closely enough to keep the equilibrium
		// radius bounded across widely different graph sizes, while still
		// letting a large cloud spread out over a visibly larger area than
		// a small one, which is what "settles within a bounded radius for
		// N=50 and N=500 alike" (not "settles at the same radius") checks.
		// Centring is off entirely when a shape is active, and that is the
		// whole reason a shape reads as one.
		//
		// The two are alternative ways of bounding a layout and they cannot
		// both be in charge. Centring bounds it by pulling inward until the
		// spring balances repulsion, which lands wherever the force numbers
		// happen to land; a shape bounds it at a boundary chosen to hold this
		// many nodes at a sensible density. Run together, centring wins long
		// before the boundary is reached: measured on a 162-node graph, the
		// layout settled at 41% of the way to the wall, so the shape was
		// seeded and then quietly abandoned, and what was left was the same
		// blob as before with a different starting arrangement. With centring
		// off, the same graph settles at 95% of the boundary and the outline
		// is the shape.
		//
		// Nothing is lost by dropping it: a component is held together by its
		// own links, the graph is held in by the boundary, and an orphan with
		// neither ends up out against the wall, which is where an unconnected
		// note belongs.
		const centeringStrength = this.shape
			? 0
			: opts.gravity * Math.sqrt(Math.max(1, this.nodes.size));

		for (const node of this.nodes.values()) {
			if (node.pinned) {
				node.vx = 0;
				node.vy = 0;
				continue;
			}
			// Toward this node's own component centre, not the world origin:
			// otherwise every disconnected island is dragged into the middle
			// and interleaves with the main cluster. One component means one
			// centre at the origin, which is the behaviour this replaces.
			node.vx += (node.centerX - node.x) * centeringStrength * this.alpha;
			node.vy += (node.centerY - node.y) * centeringStrength * this.alpha;
			node.vx *= 1 - opts.velocityDecay;
			node.vy *= 1 - opts.velocityDecay;

			const speed = Math.hypot(node.vx, node.vy);
			if (speed > opts.maxSpeed) {
				const scale = opts.maxSpeed / speed;
				node.vx *= scale;
				node.vy *= scale;
			}

			node.x += node.vx;
			node.y += node.vy;
		}

		this.resolveCollisions();
		this.applyShapeFill();
		this.applyContainment();
		this.applyRingConstraints();
		// Collision (and the ring constraint right after it) move positions
		// directly rather than through velocity, so the quadtree built at the
		// top of this tick (used for repulsion and exposed to `GraphRenderer`
		// for hit testing) is stale until the next tick rebuilds it. Cheap to
		// rebuild once more here since hit testing between now and the next
		// `tick()` call should agree with what is on screen, not with where
		// nodes were before collision (and the ring snap) ran.
		this.quadtree = Quadtree.build(Array.from(this.nodes.values(), (n) => ({ id: n.id, x: n.x, y: n.y })));

		return this.isRunning();
	}

	/** One-time O(n) pass that nudges any node sharing another's exact
	 * position by a fraction of a world unit, in a deterministic direction
	 * derived from its id so the same base nudges the same way on every run.
	 * See the call site in `resolveCollisions` for why this has to run before
	 * the quadtree is built at all, not just before the first pass. */
	private separateExactDuplicates(): void {
		const seen = new Map<string, SimNode[]>();
		for (const node of this.nodes.values()) {
			const key = `${node.x.toFixed(6)}|${node.y.toFixed(6)}`;
			const group = seen.get(key);
			if (group) group.push(node);
			else seen.set(key, [node]);
		}
		for (const group of seen.values()) {
			if (group.length < 2) continue;
			for (let i = 1; i < group.length; i += 1) {
				const member = group[i];
				if (member.pinned) continue;
				const angle = (mixBits(hashString(member.id) ^ i) / 0xffffffff) * Math.PI * 2;
				member.x += Math.cos(angle) * 0.05;
				member.y += Math.sin(angle) * 0.05;
			}
		}
	}

	/** Direct positional correction, not a velocity-based force: a node
	 * overlapping another is pushed out along the line between their centres
	 * by half the overlap each (a pinned node absorbs none of it, the other
	 * side absorbs all of it), run for a few passes per tick per
	 * `COLLISION_ITERATIONS`. This is the standard way to resolve rigid-body
	 * overlap in a force simulation: doing it as a spring force instead would
	 * fight the repulsion and link forces every frame rather than settling. */
	private resolveCollisions(): void {
		if (this.nodes.size < 2) return;
		let maxRadius = 0;
		for (const node of this.nodes.values()) {
			if (node.radius > maxRadius) maxRadius = node.radius;
		}
		if (!(maxRadius > 0)) return;
		// The query box has to reach the largest radius in the graph, not this
		// node's own: a small node standing next to a hub is inside the hub's
		// reach long before the hub is inside its own.
		const queryReach = maxRadius * 2;

		// `insert()` folds two bodies at the exact same coordinates into one
		// bodyless aggregate leaf rather than subdividing (see its comment):
		// correct for Barnes-Hut repulsion, where identical points would exert
		// identical force anyway, but it means `queryBox` cannot report either
		// original id back out again, since neither is stored once folded. A
		// node dropped onto another, or two seeded at the same point, would
		// otherwise never appear as a collision candidate to each other and
		// stay stuck at zero distance forever. Nudging exact duplicates apart
		// by a sub-pixel amount first keeps them distinguishable to the tree
		// so the ordinary per-pass separation below can take over.
		this.separateExactDuplicates();

		for (let pass = 0; pass < COLLISION_ITERATIONS; pass += 1) {
			const bodies = Array.from(this.nodes.values(), (n) => ({ id: n.id, x: n.x, y: n.y }));
			const quad = Quadtree.build(bodies);
			for (const node of this.nodes.values()) {
				const nearby = quad.queryBox(node.x - queryReach, node.y - queryReach, node.x + queryReach, node.y + queryReach);
				for (const otherId of nearby) {
					if (otherId === node.id) continue;
					const other = this.nodes.get(otherId);
					if (!other) continue;
					if (node.pinned && other.pinned) continue;

					const minDist = node.radius + other.radius;
					if (!(minDist > 0)) continue;
					let dx = other.x - node.x;
					let dy = other.y - node.y;
					let dist = Math.hypot(dx, dy);
					if (dist >= minDist) continue;
					if (dist < 0.001) {
						// Exactly coincident: no direction to separate along, so one
						// is manufactured from the id pair rather than leaving the
						// pair stuck together forever.
						const angle = mixBits(hashString(node.id) ^ hashString(other.id)) / 0xffffffff * Math.PI * 2;
						dx = Math.cos(angle);
						dy = Math.sin(angle);
						dist = 1;
					}

					const overlap = minDist - dist;
					const ux = dx / dist;
					const uy = dy / dist;

					if (node.pinned) {
						other.x += ux * overlap;
						other.y += uy * overlap;
					} else if (other.pinned) {
						node.x -= ux * overlap;
						node.y -= uy * overlap;
					} else {
						const half = overlap / 2;
						node.x -= ux * half;
						node.y -= uy * half;
						other.x += ux * half;
						other.y += uy * half;
					}
				}
			}
		}
	}

	/**
	 * Spreads the graph evenly across the layout shape, from the centre
	 * outward.
	 *
	 * Seeding the fill is not enough on its own, which is what measurement
	 * showed: a settled graph puts 40% of its nodes in the innermost quarter of
	 * the shape's area and 4% in the outermost. Relaxation only ever pulls
	 * inward. Every link contracts, gathering a hub's neighbours into a rosette
	 * around it, and the only outward force is repulsion, which is short range
	 * and weak once alpha has decayed. So the graph drifts off the rim and
	 * leaves a ring of empty space, and the silhouette reads as a few clumps
	 * rather than as the shape.
	 *
	 * Obsidian's own graph gets away without this because a vault graph is one
	 * component of several thousand nodes, where the outline emerges from sheer
	 * numbers. A base is a few hundred nodes in a handful of rosettes, and at
	 * that size an outline has to be maintained rather than hoped for.
	 *
	 * The pass is histogram equalisation on radius. Nodes are ranked by how far
	 * out they currently sit as a fraction of the boundary along their own ray,
	 * and node `i` of `n` is nudged toward the fraction `sqrt((i + 0.5) / n)`,
	 * which is the radius at which rank `i` would sit if the nodes were spread
	 * evenly by area. Angles are untouched and the radial ordering is preserved
	 * (a node never overtakes the one outside it), so a cluster stays a cluster
	 * and stays where the forces put it; only the spacing from the centre
	 * outward is corrected.
	 *
	 * Positional and alpha-independent, like collision and containment, and for
	 * the same reason: a force scaled by alpha stops meaning anything exactly
	 * when the graph has settled and is being looked at.
	 */
	private applyShapeFill(): void {
		const shape = this.shape;
		if (!shape) return;
		const movable: { node: SimNode; angle: number; reach: number; fill: number }[] = [];
		for (const node of this.nodes.values()) {
			if (node.pinned) continue;
			const angle = Math.atan2(node.y, node.x);
			const reach = boundaryDistanceAt(shape, angle);
			if (reach <= 0) continue;
			movable.push({ node, angle, reach, fill: Math.hypot(node.x, node.y) / reach });
		}
		if (movable.length < 2) return;
		movable.sort((a, b) => a.fill - b.fill);
		const total = movable.length;
		for (let i = 0; i < total; i += 1) {
			const entry = movable[i];
			// Even by area, not by radius: the area between two radii grows with
			// the radius, so an even spread puts rank i at the square root of
			// its share rather than at its share.
			const target = Math.sqrt((i + 0.5) / total);
			const fill = entry.fill + (target - entry.fill) * CONFORM_RATE;
			const radius = fill * entry.reach;
			entry.node.x = Math.cos(entry.angle) * radius;
			entry.node.y = Math.sin(entry.angle) * radius;
		}
	}

	/**
	 * Holds every node inside the layout shape.
	 *
	 * A positional correction rather than a force, for the same reason
	 * collision is one: a force is scaled by `alpha`, so it fades to nothing as
	 * the simulation cools and the boundary would stop meaning anything by the
	 * time the graph is settled, which is exactly when it is being looked at. A
	 * node outside is pulled straight back toward the centre until it is inside
	 * by its own radius, and the part of its velocity that carried it out is
	 * dropped so it does not spend the next tick pushing against the same wall.
	 *
	 * Pinned nodes are left alone: the user dragged them there.
	 */
	private applyContainment(): void {
		const shape = this.shape;
		if (!shape) return;
		for (const node of this.nodes.values()) {
			if (node.pinned) continue;
			// Measured against the node's own edge, not its centre, so a hub
			// scaled up by degree sits inside the boundary rather than half
			// across it.
			if (shapeSignedDistance(shape, node.x, node.y).distance + node.radius <= 0) continue;
			const inside = projectInside(shape, node.x, node.y, node.radius);
			const dx = inside.x - node.x;
			const dy = inside.y - node.y;
			node.x = inside.x;
			node.y = inside.y;
			// Drop whatever part of the velocity was carrying the node out, so
			// it does not spend the next tick pushing against the same wall.
			const length = Math.hypot(dx, dy);
			if (length < 1e-9) continue;
			const outward = -(node.vx * dx + node.vy * dy) / length;
			if (outward > 0) {
				node.vx += (dx / length) * outward;
				node.vy += (dy / length) * outward;
			}
		}
	}

	/** Focus mode's radial layout, applied after everything else has had its
	 * say for the tick: every node with an entry in `ringRadii` is projected
	 * back onto the circle of that exact radius, keeping the angle its own
	 * position already implies. Radius is fixed by depth this way; angle is
	 * whatever repulsion, links and collision just moved it to, which is the
	 * "only the angular position relaxes" half of the plan. A pinned node
	 * (the root, always pinned to the origin by `GraphRenderer`) is left
	 * alone: projecting a point already at the origin onto a nonzero-radius
	 * circle has no defined angle to preserve, and the root has no ring
	 * radius of its own regardless. */
	private applyRingConstraints(): void {
		if (!this.ringRadii) return;
		for (const node of this.nodes.values()) {
			if (node.pinned) continue;
			const targetRadius = this.ringRadii.get(node.id);
			if (targetRadius === undefined) continue;
			const dist = Math.hypot(node.x, node.y);
			if (dist < 0.001) {
				// Degenerate: no angle to preserve (a node landed exactly on the
				// origin), so one is manufactured from its id, the same way
				// `resolveCollisions` breaks an exact tie between two bodies.
				const angle = (mixBits(hashString(node.id)) / 0xffffffff) * Math.PI * 2;
				node.x = Math.cos(angle) * targetRadius;
				node.y = Math.sin(angle) * targetRadius;
				continue;
			}
			const scale = targetRadius / dist;
			node.x *= scale;
			node.y *= scale;
		}
	}
}
