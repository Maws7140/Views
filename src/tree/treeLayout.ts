import { computeTidyTree, type TreeOrientation } from '../graph/tidyTree';
import type { TreeModel, TreeNode } from './treeModel';

/**
 * The bridge between the tree's model and the tidy-tree layout, plus the one
 * rule the diagram adds on top of the outline: **a collapsed node is a leaf.**
 *
 * Pure and DOM-free, like `treeModel.ts` and `treeLevels.ts`. It is a separate
 * file from either because it belongs to neither: the model does not know a
 * diagram exists, and `tidyTree.ts` asks only for `{children, roots}` and has
 * no opinion about what a node is. This is the twenty lines that turn one into
 * the other, and the place where collapse gets applied.
 *
 * Collapse matters more here than in the outline. An outline row that is shut
 * simply stops rendering its children, and the rows below it move up. A
 * diagram that hid a collapsed subtree's tiles but still fed them to the
 * layout would reserve empty space for things nobody can see, so a tree with
 * one open branch would draw that branch in a narrow strip beside a wide blank
 * area. Pruning before layout is what makes collapsing actually condense the
 * picture.
 *
 * Collapse state is the same `chain`-keyed map the outline persists, so a
 * subtree shut in the outline is shut in the diagram and the two modes always
 * agree on shape.
 */

export interface TreeLayoutOptions {
	orientation: TreeOrientation;
	nodeWidth: number;
	nodeHeight: number;
	siblingGap: number;
	levelGap: number;
	/**
	 * Rows the user has explicitly toggled, keyed by `TreeNode.chain`, exactly
	 * as `TreeOutline` reports them. A row absent from the map follows
	 * `expandToDepth`.
	 */
	toggled: ReadonlyMap<string, boolean>;
	/** Rows at or above this depth are open unless `toggled` says otherwise. */
	expandToDepth: number;
}

/** One node placed on the canvas. `node` is the model's own object rather than
 * a copy, so the renderer reads label, icon, count and colour straight off it
 * without this file having to mirror the model's fields. */
export interface PlacedNode {
	node: TreeNode;
	x: number;
	y: number;
	depth: number;
	/** Whether this node has children in the model that the layout pruned.
	 * The renderer draws a twisty on these, and only on these: a leaf with
	 * nothing hidden must not offer a control that would do nothing. */
	collapsed: boolean;
}

/** A connector to draw. Both ends are guaranteed present in `placed`. */
export interface LayoutEdge {
	parent: PlacedNode;
	child: PlacedNode;
}

export interface TreeLayout {
	placed: PlacedNode[];
	byId: Map<string, PlacedNode>;
	edges: LayoutEdge[];
}

const EMPTY_LAYOUT: TreeLayout = { placed: [], byId: new Map(), edges: [] };

/**
 * Whether a node's children are drawn.
 *
 * Deliberately the same rule as `TreeOutline.isExpanded`, minus the filter
 * case: the outline opens everything on the way to a filter match, which is a
 * property of a text box the diagram does not have. Keeping the rest identical
 * is what makes the two modes agree.
 */
export function isExpanded(node: TreeNode, options: Pick<TreeLayoutOptions, 'toggled' | 'expandToDepth'>): boolean {
	return options.toggled.get(node.chain) ?? node.depth < options.expandToDepth;
}

export function computeTreeLayout(model: TreeModel, options: TreeLayoutOptions): TreeLayout {
	if (model.roots.length === 0) return EMPTY_LAYOUT;

	const visible = new Map<string, TreeNode>();
	const children = new Map<string, string[]>();
	const collapsed = new Set<string>();
	const parentOf = new Map<string, string>();

	// Breadth-first rather than recursive: `treeModel.ts` places notes under
	// notes through `parentProperty` with no depth bound, and a layout is a bad
	// place to meet the engine's stack limit. `tidyTree.ts` makes the same
	// choice for the same reason (its deviation 2).
	const queue: TreeNode[] = [...model.roots];
	while (queue.length > 0) {
		const node = queue.shift() as TreeNode;
		visible.set(node.id, node);
		if (node.children.length === 0) continue;
		if (!isExpanded(node, options)) {
			collapsed.add(node.id);
			continue;
		}
		children.set(node.id, node.children.map((child) => child.id));
		for (const child of node.children) {
			parentOf.set(child.id, node.id);
			queue.push(child);
		}
	}

	const positions = computeTidyTree(
		{ children, roots: model.roots.map((root) => root.id) },
		{
			orientation: options.orientation,
			nodeWidth: options.nodeWidth,
			nodeHeight: options.nodeHeight,
			siblingGap: options.siblingGap,
			levelGap: options.levelGap,
		},
	);

	const byId = new Map<string, PlacedNode>();
	const placed: PlacedNode[] = [];
	for (const [id, position] of positions) {
		const node = visible.get(id);
		if (node === undefined) continue;
		const entry: PlacedNode = {
			node,
			x: position.x,
			y: position.y,
			depth: position.depth,
			collapsed: collapsed.has(id),
		};
		byId.set(id, entry);
		placed.push(entry);
	}

	// Sorted by depth so the renderer draws generations in order. Without it
	// the order is whatever the position map iterates in, which makes any
	// overlap between a tile and a connector look arbitrary between renders.
	placed.sort((a, b) => a.depth - b.depth);

	const edges: LayoutEdge[] = [];
	for (const [childId, parentId] of parentOf) {
		const child = byId.get(childId);
		const parent = byId.get(parentId);
		// A node that `computeTidyTree` could not reach is absent from the
		// result by contract, so both ends are checked rather than assumed.
		if (child === undefined || parent === undefined) continue;
		edges.push({ parent, child });
	}

	return { placed, byId, edges };
}
