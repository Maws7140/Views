import type { GraphModel } from './types';

/**
 * Breadth-first distance from a root, over the edge set treated as
 * undirected (a "how many hops away" question does not care which way a
 * property link points). Pure and DOM-free like `forceLayout.ts`, so
 * `GraphRenderer`'s focus-mode pipeline and the radial layout in
 * `radialLayout.ts` can both build on it, and it stays exercisable headless
 * in Node the same way.
 */

export interface DepthResult {
	/** Hop count from the root. A node absent from this map was never
	 * reached: unreachable from the root, and excluded from focus mode by
	 * that absence rather than by any separate filtering step. */
	depths: Map<string, number>;
	/** The BFS tree's parent pointer for every non-root node that was
	 * reached. Absent for the root and for any unreached node. */
	parent: Map<string, string>;
	/** The BFS tree's children, sorted by id so the radial layout's angular
	 * slicing is deterministic regardless of edge order in the model. Only
	 * present for nodes that have at least one BFS child. */
	children: Map<string, string[]>;
}

const EMPTY_RESULT: DepthResult = { depths: new Map(), parent: new Map(), children: new Map() };

/**
 * BFS from `rootId`. A cycle in the graph cannot loop the traversal: the
 * `depths.has(neighbor)` guard below means every node is enqueued at most
 * once, whether it has one path back to the root or several. A node with no
 * path to the root at all (a disconnected part of the base) simply never
 * gets a `depths` entry, which is the "excluded in focus mode" behaviour the
 * plan calls for, with no separate reachability pass needed.
 */
export function computeDepthsFromRoot(model: GraphModel, rootId: string): DepthResult {
	const adjacency = buildUndirectedAdjacency(model);
	if (!adjacency.has(rootId)) return EMPTY_RESULT;

	const depths = new Map<string, number>([[rootId, 0]]);
	const parent = new Map<string, string>();
	const children = new Map<string, string[]>();

	const queue: string[] = [rootId];
	let head = 0;
	while (head < queue.length) {
		const current = queue[head];
		head += 1;
		const currentDepth = depths.get(current) as number;
		// Sorted so the same graph and the same root always visit siblings in
		// the same order, which is what makes the radial layout's angular
		// slice assignment deterministic rather than dependent on Set
		// insertion order (itself dependent on edge order in the model).
		const neighbors = [...(adjacency.get(current) ?? [])].sort();
		for (const neighbor of neighbors) {
			if (depths.has(neighbor)) continue;
			depths.set(neighbor, currentDepth + 1);
			parent.set(neighbor, current);
			const siblings = children.get(current);
			if (siblings) siblings.push(neighbor);
			else children.set(current, [neighbor]);
			queue.push(neighbor);
		}
	}

	return { depths, parent, children };
}

function buildUndirectedAdjacency(model: GraphModel): Map<string, Set<string>> {
	const adjacency = new Map<string, Set<string>>();
	const ensure = (id: string): Set<string> => {
		let set = adjacency.get(id);
		if (!set) {
			set = new Set();
			adjacency.set(id, set);
		}
		return set;
	};
	for (const node of model.nodes) ensure(node.id);
	for (const edge of model.edges) {
		ensure(edge.from).add(edge.to);
		ensure(edge.to).add(edge.from);
	}
	return adjacency;
}
