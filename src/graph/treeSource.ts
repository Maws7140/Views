import type { GraphModel } from './types';
import { computeDepthsFromRoot, type DepthResult } from './graphDepth';

/**
 * Where the rigid tree mode's parenthood comes from.
 *
 * A tree layout needs one answer to "who is this node's parent", and a graph
 * does not have one: it has edges, which are neither ordered nor acyclic.
 * There are two honest ways to invent that answer and they suit different
 * bases, so both ship behind one shape rather than the layout being written
 * against either of them:
 *
 * - `bfsTreeSource` derives parenthood from distance. Every base has this,
 *   because every base has edges, and it needs no configuration at all. What
 *   it costs is meaning: a BFS spanning tree flattens cycles and picks a
 *   parent by whichever neighbour the traversal reached first, so on a base
 *   wired together by Connect-by value hubs the resulting hierarchy is a true
 *   statement about hop counts and an arbitrary one about anything else.
 * - `propertyTreeSource` derives parenthood from a property the user already
 *   maintains (`class`, `parent`, `project`). The tree then means what the
 *   vault means. What it costs is applicability: a base whose notes carry no
 *   such property has no hierarchy to draw, which is why BFS is the default
 *   and this is opt-in.
 *
 * Both return the same `{ depths, parent, children }` `graphDepth.ts` already
 * defines, widened with the one thing a tree layout needs that a single-root
 * BFS never had to express: `roots`.
 *
 * **Forests, not a virtual root.** A graph rarely has exactly one node with
 * no parent, and both sources here can produce several. This module returns
 * every one of them in `roots` and leaves them as separate trees rather than
 * synthesising a virtual parent above them. A virtual root would have to be
 * an id with no `GraphNode` behind it, which every downstream consumer (the
 * renderer's node list, hit testing, the colour system, the label pass) would
 * then have to special-case, all to draw one tile that is not in the base and
 * one edge that is not a relationship. `tidyTree.ts` stacks root subtrees
 * along the cross axis instead, which is the same picture without the lie.
 *
 * Pure and DOM-free, like `graphDepth.ts` and `radialLayout.ts`: the layout
 * in `tidyTree.ts` and the renderer both build on this, and neither the
 * metadata cache nor the canvas has any business in here.
 */
export interface TreeSourceResult extends DepthResult {
	/** Every node with no parent, in the order the layout should stack their
	 * subtrees. Never empty for a non-empty result: a node set with no root
	 * at all would mean every node has a parent, which is a cycle, and both
	 * sources below break cycles rather than returning one. */
	roots: string[];
}

const EMPTY_RESULT: TreeSourceResult = { depths: new Map(), parent: new Map(), children: new Map(), roots: [] };

/**
 * Parenthood by hop count: `computeDepthsFromRoot` from `rootId`, then the
 * same again from the best node of whatever is left, until every node in the
 * model has been placed.
 *
 * The repeat is the whole difference from focus mode. There, a node the root
 * cannot reach is deliberately excluded, because focus mode is a claim about
 * one note's neighbourhood. Here the mode is a claim about the base's shape,
 * and a base connected through Connect-by hubs is normally several islands
 * (one per hub, plus whatever the hubs share), so stopping at the first
 * component would silently draw a fraction of the base and look like a bug in
 * the layout rather than a property of the data.
 *
 * Each additional component is seeded at its highest-degree node, tie broken
 * on id, so a hub anchors its own island rather than the island hanging off
 * whichever leaf happened to sort first. Sorted seeding plus the sorted
 * sibling order `computeDepthsFromRoot` already guarantees makes the whole
 * result a function of the model alone, not of edge order.
 */
export function bfsTreeSource(model: GraphModel, rootId: string): TreeSourceResult {
	if (model.nodes.length === 0) return EMPTY_RESULT;

	const depths = new Map<string, number>();
	const parent = new Map<string, string>();
	const children = new Map<string, string[]>();
	const roots: string[] = [];

	const remaining = new Map(model.nodes.map((node) => [node.id, node.degree]));
	// The caller's root only leads if it is actually in the model; otherwise
	// this falls straight through to the same highest-degree choice every
	// later component gets, rather than returning nothing the way
	// `computeDepthsFromRoot` does for a root it cannot find. An unknown root
	// is a stale double-click or an active note the base no longer returns,
	// not a reason to draw an empty canvas.
	let seed: string | null = remaining.has(rootId) ? rootId : bestRemaining(remaining);

	while (seed !== null) {
		const component = computeDepthsFromRoot(model, seed);
		roots.push(seed);
		for (const [id, depth] of component.depths) {
			depths.set(id, depth);
			remaining.delete(id);
		}
		for (const [id, parentId] of component.parent) parent.set(id, parentId);
		for (const [id, kids] of component.children) children.set(id, kids);
		seed = bestRemaining(remaining);
	}

	return { depths, parent, children, roots };
}

/** Highest degree wins, id breaks the tie, exactly as `rootSelection.ts`
 * chooses focus mode's root. Kept local rather than shared with that file
 * because this one is picking from a shrinking id/degree map rather than from
 * a `GraphNode[]`, and copying eight lines is cheaper than making that
 * function generic over both. */
function bestRemaining(remaining: Map<string, number>): string | null {
	let bestId: string | null = null;
	let bestDegree = -Infinity;
	for (const [id, degree] of remaining) {
		if (degree > bestDegree || (degree === bestDegree && bestId !== null && id < bestId)) {
			bestId = id;
			bestDegree = degree;
		}
	}
	return bestId;
}

/**
 * Parenthood by an explicit property: the tree the user already wrote into
 * their frontmatter.
 *
 * The property is read off the **edges**, not off the notes, and that is the
 * load-bearing decision in this function. `graphModel.ts` has already done
 * the hard half of the job: for every Connect-by property it resolved each
 * value to a real note where one exists (wikilink or plain text naming a note
 * the base returned) and to a shared value node where one does not, then
 * recorded the property id on the resulting edge. Re-reading raw frontmatter
 * here would mean reimplementing that resolution against the metadata cache,
 * which would drag `obsidian` into a pure module and, worse, would be a
 * second implementation free to disagree with the first about what a value
 * points at.
 *
 * So: an edge carrying `parentProperty` means "`from` declares `to` as its
 * parent", because that is the direction `graphModel.ts` writes a Connect-by
 * or frontmatter-link edge in. A reciprocal edge (the pair fold collapsed two
 * opposing edges into one) offers parenthood in both directions and is left
 * to the cycle breaker below to resolve, since two notes naming each other as
 * parent is exactly a two-node cycle and there is no third answer to give.
 *
 * `rootId`, when supplied and when it turns out to have no parent of its own,
 * is stacked first. It is not forced to be a root: a node the user is looking
 * at is not thereby the top of the hierarchy, and cutting its real parent off
 * to pretend otherwise would draw a different tree than the vault describes.
 */
export function propertyTreeSource(model: GraphModel, parentProperty: string, rootId?: string): TreeSourceResult {
	if (model.nodes.length === 0) return EMPTY_RESULT;

	const known = new Set(model.nodes.map((node) => node.id));
	// Candidates rather than a single parent, collected then reduced: a note
	// with `class: [[CS 221]], [[CS 229]]` genuinely declares two parents, and
	// a tree can only draw one. Lowest id wins, which is arbitrary but stable,
	// and stability is what stops the same base drawing a different tree on
	// every refresh.
	const candidates = new Map<string, string[]>();
	const offer = (child: string, parentId: string): void => {
		if (child === parentId || !known.has(child) || !known.has(parentId)) return;
		const existing = candidates.get(child);
		if (existing) existing.push(parentId);
		else candidates.set(child, [parentId]);
	};
	for (const edge of model.edges) {
		if (edge.property !== parentProperty) continue;
		offer(edge.from, edge.to);
		if (edge.reciprocal) offer(edge.to, edge.from);
	}

	const parent = new Map<string, string>();
	for (const [child, parents] of candidates) {
		parent.set(child, [...parents].sort()[0]);
	}

	breakCycles(model, parent);

	// Everything left without a parent tops its own tree. Sorted for the same
	// determinism reason the candidate reduction above is, with `rootId`
	// lifted to the front when it is genuinely parentless so the node the user
	// arrived on is the one at the top of the canvas rather than buried
	// halfway down a forest ordered alphabetically.
	const roots = model.nodes
		.map((node) => node.id)
		.filter((id) => !parent.has(id))
		.sort();
	if (rootId !== undefined) {
		const index = roots.indexOf(rootId);
		if (index > 0) {
			roots.splice(index, 1);
			roots.unshift(rootId);
		}
	}

	const children = new Map<string, string[]>();
	for (const [child, parentId] of parent) {
		const siblings = children.get(parentId);
		if (siblings) siblings.push(child);
		else children.set(parentId, [child]);
	}
	for (const siblings of children.values()) siblings.sort();

	// Depth is measured down from the roots rather than carried out of the
	// candidate pass, so it describes the tree that survived cycle breaking
	// rather than the relation that went into it.
	const depths = new Map<string, number>();
	const queue = [...roots];
	for (const root of roots) depths.set(root, 0);
	let head = 0;
	while (head < queue.length) {
		const current = queue[head];
		head += 1;
		const depth = depths.get(current) as number;
		for (const child of children.get(current) ?? []) {
			if (depths.has(child)) continue;
			depths.set(child, depth + 1);
			queue.push(child);
		}
	}

	return { depths, parent, children, roots };
}

/**
 * Removes the minimum number of parent links needed to make `parent` acyclic,
 * by walking each node's ancestor chain and cutting the link that closes a
 * cycle. The node whose link is cut becomes a root.
 *
 * A cycle is not a malformed vault, it is an ordinary one: two notes that name
 * each other, or a `parent` chain that loops back through a shared hub. What
 * must not happen is the layout walking that loop forever, so this runs before
 * anything reads `parent` as a tree.
 *
 * Three-colour marking rather than a fresh visited set per node: with `seen`
 * remembering nodes already proven to lead to a root, a chain of a thousand
 * notes is walked once in total instead of once per node.
 */
function breakCycles(model: GraphModel, parent: Map<string, string>): void {
	const SETTLED = 1;
	const ON_PATH = 2;
	const state = new Map<string, number>();
	// Sorted so which link of a cycle gets cut is a function of the ids alone.
	// Without it the cut would follow model node order, and the same base could
	// root a cycle at a different member from one refresh to the next.
	const ids = model.nodes.map((node) => node.id).sort();

	for (const id of ids) {
		if (state.has(id)) continue;
		const path: string[] = [];
		let current: string | undefined = id;
		while (current !== undefined && !state.has(current)) {
			state.set(current, ON_PATH);
			path.push(current);
			current = parent.get(current);
		}
		// Landed back on the path being walked: `current` is the node the cycle
		// closes onto, so the link out of the node just before it (the last one
		// pushed) is the one that closes the cycle, and cutting it promotes that
		// node to a root.
		if (current !== undefined && state.get(current) === ON_PATH) {
			parent.delete(path[path.length - 1]);
		}
		for (const visited of path) state.set(visited, SETTLED);
	}
}
