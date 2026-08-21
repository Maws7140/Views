import { seedPosition } from './forceLayout';
import { shapeFillOrder, type ShapeGeometry } from './layoutShapes';
import type { GraphEdge, GraphNode } from './types';

/**
 * Connected components, and a centre for each one.
 *
 * A force layout with a single centring point drags every disconnected island
 * into the middle, where they interleave with the main cluster and with each
 * other. On a vault-wide graph that barely shows, because a vault is mostly one
 * giant component. On a filtered base, which is what this view is for, it is
 * the mess: a base of tasks or people is very often a handful of small clusters
 * and a scatter of unconnected notes.
 *
 * Giving each component its own centre turns that into one main cluster with
 * its islands arranged around it. A graph that really is one component gets one
 * centre at the origin, which is exactly the behaviour this replaces.
 *
 * Everything here is deterministic: the same model always produces the same
 * centres, so a base does not rearrange itself between opens.
 */

export interface ComponentLayout {
	/** Centre point per node id. */
	centers: Map<string, { x: number; y: number }>;
	/** Where each node should start, near its own component's centre. */
	seeds: Map<string, { x: number; y: number }>;
	/** Number of distinct components found. */
	count: number;
}

/** World-unit gap left between two components' discs, so islands read as
 * separate rather than as one texture. */
const COMPONENT_GAP = 90;

/** Matches `seedPosition`'s spacing, so a component's estimated disc is the
 * size its seeded nodes actually occupy. */
const SEED_SPACING = 44;

/** Angle between successive placement attempts on the search spiral. The
 * golden angle again, for the same reason it seeds a sunflower: successive
 * attempts never line up radially, so the search covers the plane evenly
 * instead of probing along a few spokes. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** How far along the search spiral each attempt steps. Small enough to find a
 * snug placement, large enough that a graph of many small components does not
 * spend thousands of attempts per component. */
const PLACEMENT_STEP = 24;

/** Bound on placement attempts per component. Reaching it means the spiral
 * could not find a clear spot, which only happens for pathological inputs; the
 * component is then placed at the last position tried rather than looping. */
const MAX_PLACEMENT_ATTEMPTS = 2000;

/**
 * Groups nodes into connected components (edges are treated as undirected,
 * because a component is about reachability, not direction), then packs the
 * components: largest at the origin, the rest placed on a spiral search that
 * skips positions where they would overlap something already placed.
 */
export function buildComponentLayout(nodes: GraphNode[], edges: GraphEdge[]): ComponentLayout {
	const ordered = connectedComponents(nodes, edges);

	const centers = new Map<string, { x: number; y: number }>();
	const seeds = new Map<string, { x: number; y: number }>();
	const placed: { x: number; y: number; radius: number }[] = [];

	for (const group of ordered) {
		const radius = componentRadius(group.length);
		const center = placed.length === 0
			? { x: 0, y: 0 }
			: findClearPlacement(placed, radius);
		placed.push({ ...center, radius });
		group.forEach((id, index) => {
			centers.set(id, center);
			const offset = seedPosition(index);
			seeds.set(id, { x: center.x + offset.x, y: center.y + offset.y });
		});
	}

	return { centers, seeds, count: ordered.length };
}

export interface ShapedLayout {
	/** Where each node starts, spread across the shape's area. */
	seeds: Map<string, { x: number; y: number }>;
	/** Number of distinct components found. */
	count: number;
}

/**
 * The same components, laid out inside a shape instead of packed as free
 * discs.
 *
 * Every node takes a point from one fill of the whole shape, largest component
 * first, so a component occupies a contiguous wedge of that fill rather than a
 * disc placed wherever the packing spiral had room. That is what makes the
 * silhouette the shape: the nodes are distributed across its area from the
 * first frame, not settled into a blob that a boundary then has to squeeze.
 * The fill is taken in `shapeFillOrder`'s order rather than raw index order,
 * without which a component's members land a golden angle apart and every
 * island starts scattered across the whole shape.
 *
 * No centres, unlike `buildComponentLayout`: a shaped layout runs with centring
 * off entirely (see `ForceSimulation.tick`), because a boundary and a centring
 * spring are two ways of bounding the same layout and the spring wins. What
 * holds a component together here is its own links, and what holds the graph in
 * is the boundary.
 */
export function buildShapedLayout(
	nodes: GraphNode[],
	edges: GraphEdge[],
	geometry: ShapeGeometry,
): ShapedLayout {
	const ordered = connectedComponents(nodes, edges);
	const points = shapeFillOrder(geometry, nodes.length);
	const seeds = new Map<string, { x: number; y: number }>();
	let index = 0;

	for (const group of ordered) {
		for (const id of group) {
			seeds.set(id, points[index] ?? { x: 0, y: 0 });
			index += 1;
		}
	}

	return { seeds, count: ordered.length };
}

/**
 * Groups nodes into connected components, largest first.
 *
 * Edges are treated as undirected, because a component is about reachability,
 * not direction. Ties in size are broken by the first member's id so the order
 * does not depend on Map iteration happening to match across runs, which is
 * what keeps both layouts above deterministic.
 */
export function connectedComponents(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
	const parent = new Map<string, string>();
	for (const node of nodes) parent.set(node.id, node.id);

	function find(id: string): string {
		let root = id;
		while (parent.get(root) !== root) root = parent.get(root) as string;
		// Path compression, so a long chain of merges does not make later
		// lookups walk it again.
		let cursor = id;
		while (parent.get(cursor) !== root) {
			const next = parent.get(cursor) as string;
			parent.set(cursor, root);
			cursor = next;
		}
		return root;
	}

	for (const edge of edges) {
		if (!parent.has(edge.from) || !parent.has(edge.to)) continue;
		const a = find(edge.from);
		const b = find(edge.to);
		if (a !== b) parent.set(a, b);
	}

	const groups = new Map<string, string[]>();
	for (const node of nodes) {
		const root = find(node.id);
		const group = groups.get(root);
		if (group) group.push(node.id);
		else groups.set(root, [node.id]);
	}

	return Array.from(groups.values()).sort((a, b) => (
		b.length - a.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
	));
}

/** The disc a component of this many nodes occupies once seeded, which is the
 * phyllotaxis spiral's outer radius for its last index. A single node still
 * gets a real radius, so lone notes do not pack shoulder to shoulder. */
function componentRadius(size: number): number {
	return SEED_SPACING * Math.sqrt(Math.max(1, size));
}

function findClearPlacement(
	placed: { x: number; y: number; radius: number }[],
	radius: number,
): { x: number; y: number } {
	let candidate = { x: 0, y: 0 };
	for (let attempt = 1; attempt <= MAX_PLACEMENT_ATTEMPTS; attempt += 1) {
		const angle = attempt * GOLDEN_ANGLE;
		const distance = PLACEMENT_STEP * Math.sqrt(attempt);
		candidate = { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
		if (placed.every((other) => (
			Math.hypot(other.x - candidate.x, other.y - candidate.y) >= other.radius + radius + COMPONENT_GAP
		))) {
			return candidate;
		}
	}
	return candidate;
}
