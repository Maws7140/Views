import type { GraphModel, GraphNode } from './types';

/**
 * Focus mode's root, chosen the way the plan states it: an explicit
 * double-click override if the node it named is still on the canvas,
 * otherwise the active note if the base includes it, otherwise whatever the
 * best-connected node is (so the graph never opens on an arbitrary node from
 * a base full of strangers). Pure and DOM-free so it is testable the same
 * way `graphDepth.ts` and `forceLayout.ts` are; `GraphRenderer` supplies the
 * active note's path itself, since reading it is the one piece of this that
 * actually needs `obsidian`.
 */
export interface RootSelectionInput {
	model: GraphModel;
	/** The node id a double-click most recently re-rooted onto, or null if
	 * the user has not re-rooted since the last time the root fell back to a
	 * default. Ignored once the node it names is no longer in the model. */
	explicitRootId: string | null;
	/** `TFile.path` of the active note, or null with nothing active (or a
	 * note not among this base's results). */
	activeNotePath: string | null;
}

export function selectRoot(input: RootSelectionInput): string | null {
	const { model, explicitRootId, activeNotePath } = input;
	if (model.nodes.length === 0) return null;

	if (explicitRootId !== null && model.nodes.some((node) => node.id === explicitRootId)) {
		return explicitRootId;
	}

	if (activeNotePath !== null) {
		const active = model.nodes.find((node) => node.path === activeNotePath);
		if (active) return active.id;
	}

	return highestDegreeNodeId(model.nodes);
}

/** Highest `degree` wins; a tie breaks on id so the same graph always picks
 * the same node rather than depending on array order. */
export function highestDegreeNodeId(nodes: GraphNode[]): string | null {
	if (nodes.length === 0) return null;
	let best = nodes[0];
	for (const node of nodes) {
		if (node.degree > best.degree || (node.degree === best.degree && node.id < best.id)) best = node;
	}
	return best.id;
}
