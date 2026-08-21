import type { GraphModel } from './types';

/**
 * The view-only clutter controls `GraphRenderer.update` applies on top of
 * whatever `buildGraphModel` already extracted and capped. Split out from
 * `GraphRenderer.ts` because this file, unlike that one, touches nothing from
 * `obsidian` or the DOM, so it can be exercised headless in Node the same way
 * `forceLayout.ts` and `graphModel.ts` are.
 */

/** Applies "Hide unlinked nodes" (degree 0) and "Hide nodes with more than N
 * links" (degree > `maxLinks`, `maxLinks <= 0` meaning off). Both read
 * `GraphNode.degree` rather than re-walking `edges`, and both drop from
 * `edges` any edge that touched a node either one removed: a high-degree
 * node's edges very much do reference other nodes, so leaving `edges`
 * untouched would draw a line to a tile that is no longer being drawn. */
export function filterModelForView(model: GraphModel, hideUnlinked: boolean, maxLinks: number): GraphModel {
	if (!hideUnlinked && !(maxLinks > 0)) return model;
	const kept = model.nodes.filter((node) => {
		if (hideUnlinked && node.degree === 0) return false;
		if (maxLinks > 0 && node.degree > maxLinks) return false;
		return true;
	});
	if (kept.length === model.nodes.length) return model;
	const keptIds = new Set(kept.map((node) => node.id));
	const edges = model.edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));
	return { nodes: kept, edges, truncated: model.truncated };
}

/** Focus mode's subset: every node `depths` reached within `maxDepth` hops of
 * the root, and only the edges between two such nodes. `depths` comes from
 * `computeDepthsFromRoot` (`./graphDepth.ts`), so a node it never reached
 * (unreachable from the root, per that function's own contract) is absent
 * from `depths` and therefore dropped here the same way an over-depth node
 * is: by simply not being kept, never by a separate reachability check. */
export function filterModelToDepth(model: GraphModel, depths: ReadonlyMap<string, number>, maxDepth: number): GraphModel {
	const kept = model.nodes.filter((node) => {
		const depth = depths.get(node.id);
		return depth !== undefined && depth <= maxDepth;
	});
	if (kept.length === model.nodes.length) return model;
	const keptIds = new Set(kept.map((node) => node.id));
	const edges = model.edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));
	return { nodes: kept, edges, truncated: model.truncated };
}

export interface GraphNoticeInput {
	/** Nodes the base produced, before the view-only filters below ran. */
	totalNodes: number;
	/** Nodes actually being drawn, after orphan hiding, the link limit and
	 * (in focus mode) the depth subset. */
	drawnNodes: number;
	truncated: GraphModel['truncated'];
	showOrphans: boolean;
	maxLinks: number;
}

/**
 * The line shown above the canvas, or null for the ordinary case of a graph
 * that is drawing everything it was given.
 *
 * The empty case earns a sentence of its own because the canvas has no other
 * way to explain itself: a base whose notes do not link to each other draws
 * nothing at all once orphans are hidden, and a blank canvas reads as a broken
 * view rather than as a filter doing its job. This matters more now that a
 * link pointing outside the base no longer counts toward a note's degree, so a
 * base can go from a full canvas to an empty one on a filter alone.
 */
export function describeGraphNotice(input: GraphNoticeInput): string | null {
	if (input.totalNodes > 0 && input.drawnNodes === 0) {
		if (!input.showOrphans) {
			return 'Nothing to draw: none of the notes this base returned link to each other. Turn on Orphans to show them anyway.';
		}
		if (input.maxLinks > 0) return 'Nothing to draw: every node has more links than the limit allows.';
		return 'Nothing to draw.';
	}
	if (input.truncated) return `Showing ${input.truncated.shown} of ${input.truncated.total} nodes.`;
	return null;
}
