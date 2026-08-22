/**
 * Reingold-Tilford tidy tree layout, in the linear-time form Buchheim, Junger
 * and Leipert give ("Improving Walker's Algorithm to Run in Linear Time",
 * 2002). Pure and DOM-free like `radialLayout.ts` and `graphDepth.ts`: it is
 * handed a tree (from `treeSource.ts`, though it asks only for the two fields
 * it reads, so anything tree-shaped satisfies it) plus the node extents the
 * renderer draws at, and returns points. Nothing in here knows about canvases,
 * tiles or Obsidian.
 *
 * The whole reason to run a real tidy tree rather than the obvious thing is
 * what the obvious thing gets wrong. Summing subtree widths (give each subtree
 * a slot as wide as its widest level, lay the slots side by side) is easy,
 * correct in the sense of never overlapping, and produces the loose, airy
 * layout that makes a rigid tree look like an org chart drawn by someone with
 * infinite paper: a deep narrow subtree reserves the full width of its widest
 * level at every level, so a bushy sibling standing next to it is pushed away
 * by space that is empty at the levels where the two actually meet.
 *
 * Reingold-Tilford instead compares the two subtrees' actual **contours**, the
 * left and right silhouettes level by level, and slides the right subtree in
 * until they just touch. Where a subtree is narrow, its neighbour moves into
 * the gap. Doing that naively costs quadratic time, because walking a contour
 * means walking a level of a subtree that may be much taller than the part of
 * it being compared. The threads are the fix: when a contour walk runs off the
 * bottom of the shorter subtree, that subtree's deepest node is given a
 * `thread` pointer to where the walk should continue, so the next comparison
 * resumes from there instead of re-descending. `mod`, `shift` and `change`
 * exist for the matching reason on the other axis: a subtree is moved by
 * writing one offset at its root and letting `secondWalk` accumulate it on the
 * way down, so shifting a thousand-node subtree is one addition rather than a
 * thousand.
 *
 * Deviations from the textbook algorithm, all three deliberate:
 *
 * 1. **Forests.** The paper lays out one tree. `treeSource.ts` returns several
 *    (see its `roots` doc for why there is no virtual root), so each root is
 *    laid out independently and the results are packed along the cross axis by
 *    their real extents, with `forestGap` between neighbours. Packing by
 *    measured extent rather than by contour is the one place the loose
 *    approach is kept, because two roots have no common ancestor and no reason
 *    to interlock: an org chart and an unrelated planning map should not be
 *    read as one picture.
 * 2. **Iteration, not recursion.** Both walks use explicit stacks. A tree
 *    source over a real base can hand this a chain hundreds of nodes deep (a
 *    BFS spanning tree of a long link chain is exactly that), and a layout is
 *    not a good place to discover the engine's stack limit.
 * 3. **Uniform node extents.** `distance` between adjacent siblings is one
 *    constant rather than a per-node measurement, because the renderer draws
 *    every tile at the same size in this mode. Where it does not (degree
 *    scaling), the caller passes the largest extent, which costs a little air
 *    between small siblings and never lets two tiles touch.
 */

/** Root on the left, generations marching right, siblings stacked down the
 * page: the planning-map reference, and the one that reads best for the deep
 * narrow trees a vault actually produces, since a page scrolls down more
 * comfortably than it scrolls across. `topDown` is the org-chart reference:
 * root at the top, generations descending, siblings side by side. */
export type TreeOrientation = 'leftToRight' | 'topDown';

export interface TidyTreeInput {
	/** Each node's children, in the order they should be stacked. Sorted by
	 * the tree sources so the same base always draws the same tree. */
	children: ReadonlyMap<string, string[]>;
	/** Every parentless node, in the order their subtrees are packed. */
	roots: readonly string[];
}

export interface TidyTreeOptions {
	orientation: TreeOrientation;
	/** Extent of a node along x, in world units. The renderer passes its tile
	 * size (widened by the degree scale ceiling, per deviation 3 above). */
	nodeWidth: number;
	/** Extent of a node along y, in world units. */
	nodeHeight: number;
	/** Clear space between two adjacent siblings, along the cross axis. */
	siblingGap: number;
	/** Clear space between one generation and the next, along the main axis.
	 * This is the length the elbow connectors run through, so it wants to be
	 * generous enough that the shared channel between two levels has room to
	 * be seen. */
	levelGap: number;
	/** Clear space between two neighbouring root subtrees in a forest.
	 * Defaults to four sibling gaps: wide enough that two unrelated trees do
	 * not read as one tree with a wide root. */
	forestGap?: number;
}

export interface TidyTreePosition {
	x: number;
	y: number;
	/** Generations below this node's own root. 0 for a root. */
	depth: number;
}

/** Internal per-node layout state, one entry per node, indexed by the id's
 * position in `order`. All the Buchheim bookkeeping lives here rather than on
 * the caller's tree, which stays untouched. */
interface WalkNode {
	id: string;
	parent: number;
	children: number[];
	/** 1-based position among its siblings, which is what `moveSubtree` needs
	 * to divide a shift among the subtrees between two siblings. */
	number: number;
	depth: number;
	prelim: number;
	mod: number;
	shift: number;
	change: number;
	/** Contour continuation pointer, or -1. See the file header. */
	thread: number;
	ancestor: number;
}

/**
 * Lays the tree out and returns one point per node, in world units, centred
 * on the origin (the renderer's own coordinate space has the origin in the
 * middle of the viewport, and its auto-fit reads a bounding box, so a layout
 * that starts centred needs no second pass to be framed).
 *
 * A node that appears in `children` but is reachable from no root is not laid
 * out and is simply absent from the result, the same contract
 * `computeDepthsFromRoot` follows for a node it never reached: the caller
 * filters its model to the ids that came back rather than this file inventing
 * a position for something with no place in the tree.
 */
export function computeTidyTree(tree: TidyTreeInput, options: TidyTreeOptions): Map<string, TidyTreePosition> {
	const positions = new Map<string, TidyTreePosition>();
	if (tree.roots.length === 0) return positions;

	const topDown = options.orientation === 'topDown';
	// The cross axis is the one siblings spread along; the main axis is the
	// one generations march along. Naming them by role rather than by x and y
	// is what lets one implementation serve both orientations, with the only
	// orientation-dependent line being where the two coordinates are finally
	// written out below.
	const crossExtent = topDown ? options.nodeWidth : options.nodeHeight;
	const mainExtent = topDown ? options.nodeHeight : options.nodeWidth;
	const siblingDistance = crossExtent + options.siblingGap;
	const mainStep = mainExtent + options.levelGap;
	const forestGap = options.forestGap ?? options.siblingGap * 4;

	/** Cross-axis coordinates, one entry per laid-out node, filled per root
	 * subtree and then offset as a block so the subtrees pack without
	 * overlapping. */
	const cross = new Map<string, number>();
	const depthOf = new Map<string, number>();
	let packOffset = 0;

	for (const root of tree.roots) {
		const nodes = buildWalkNodes(root, tree.children);
		if (nodes.length === 0) continue;
		firstWalk(nodes, siblingDistance);
		secondWalk(nodes);

		let min = Infinity;
		let max = -Infinity;
		for (const node of nodes) {
			if (node.prelim < min) min = node.prelim;
			if (node.prelim > max) max = node.prelim;
		}
		// Packed by measured extent, deviation 1 in the file header: shift this
		// whole subtree so its leftmost node lands at the running offset, then
		// advance past its full width plus the forest gap.
		const shift = packOffset - min;
		for (const node of nodes) {
			cross.set(node.id, node.prelim + shift);
			depthOf.set(node.id, node.depth);
		}
		packOffset = max + shift + crossExtent + forestGap;
	}

	if (cross.size === 0) return positions;

	let crossMin = Infinity;
	let crossMax = -Infinity;
	let depthMax = 0;
	for (const [id, value] of cross) {
		if (value < crossMin) crossMin = value;
		if (value > crossMax) crossMax = value;
		const depth = depthOf.get(id) as number;
		if (depth > depthMax) depthMax = depth;
	}
	const crossCenter = (crossMin + crossMax) / 2;
	const mainCenter = (depthMax * mainStep) / 2;

	for (const [id, value] of cross) {
		const depth = depthOf.get(id) as number;
		const along = depth * mainStep - mainCenter;
		const across = value - crossCenter;
		positions.set(id, topDown ? { x: across, y: along, depth } : { x: along, y: across, depth });
	}
	return positions;
}

/**
 * Flattens one root's subtree into the array both walks operate on, in
 * pre-order, with parents always at a lower index than their children.
 *
 * The `seen` guard is not defensive padding: a tree source is allowed to hand
 * back a `children` map whose entries disagree with its `parent` map (a
 * property source that broke a cycle removes a parent link, and nothing forces
 * the caller to have rebuilt `children` from it), and a node reached twice
 * would otherwise be laid out twice and the second placement would win. Taking
 * the first reach makes the result a tree regardless of what came in.
 */
function buildWalkNodes(root: string, children: ReadonlyMap<string, string[]>): WalkNode[] {
	const nodes: WalkNode[] = [];
	const indexById = new Map<string, number>();
	const push = (id: string, parent: number, number: number, depth: number): number => {
		const index = nodes.length;
		nodes.push({ id, parent, children: [], number, depth, prelim: 0, mod: 0, shift: 0, change: 0, thread: -1, ancestor: index });
		indexById.set(id, index);
		return index;
	};

	push(root, -1, 1, 0);
	const stack: number[] = [0];
	while (stack.length > 0) {
		const index = stack.pop() as number;
		const node = nodes[index];
		const kids = children.get(node.id) ?? [];
		for (const childId of kids) {
			if (indexById.has(childId)) continue;
			const childIndex = push(childId, index, node.children.length + 1, node.depth + 1);
			node.children.push(childIndex);
		}
		// Pushed in reverse so the stack pops them left to right, which keeps
		// `nodes` in the same pre-order the sibling order describes. Ordering
		// only matters for readability here (both walks index explicitly), but
		// a layout that is easier to reason about while debugging is worth the
		// one reversed loop.
		for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
	}
	return nodes;
}

/**
 * Buchheim's `firstWalk`, iterative. Assigns every node a preliminary
 * cross-axis coordinate relative to its parent, packing each subtree against
 * its left siblings' contours through `apportion`.
 *
 * The frame stack replaces the recursion: a frame holds which child it is up
 * to and the `defaultAncestor` that threads through the sibling loop.
 * `apportion` for a child runs when that child's own frame completes, which is
 * exactly where the recursive form calls it (immediately after the recursive
 * `firstWalk` returns).
 */
function firstWalk(nodes: WalkNode[], distance: number): void {
	interface Frame {
		index: number;
		childCursor: number;
		defaultAncestor: number;
	}

	const stack: Frame[] = [{ index: 0, childCursor: 0, defaultAncestor: nodes[0].children[0] ?? -1 }];
	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		const node = nodes[frame.index];
		if (frame.childCursor < node.children.length) {
			const childIndex = node.children[frame.childCursor];
			frame.childCursor += 1;
			stack.push({ index: childIndex, childCursor: 0, defaultAncestor: nodes[childIndex].children[0] ?? -1 });
			continue;
		}

		if (node.children.length === 0) {
			const left = leftSibling(nodes, frame.index);
			node.prelim = left === -1 ? 0 : nodes[left].prelim + distance;
		} else {
			executeShifts(nodes, frame.index);
			const first = nodes[node.children[0]];
			const last = nodes[node.children[node.children.length - 1]];
			const midpoint = (first.prelim + last.prelim) / 2;
			const left = leftSibling(nodes, frame.index);
			if (left === -1) {
				node.prelim = midpoint;
			} else {
				node.prelim = nodes[left].prelim + distance;
				// The subtree sits where its siblings' contours allow, but the
				// parent still wants to be centred over its children, so the
				// difference between the two is carried as a modifier applied
				// to the whole subtree on the way down in `secondWalk`.
				node.mod = node.prelim - midpoint;
			}
		}

		stack.pop();
		const parentFrame = stack[stack.length - 1];
		if (parentFrame) parentFrame.defaultAncestor = apportion(nodes, frame.index, parentFrame.defaultAncestor, distance);
	}
}

/**
 * Buchheim's `apportion`: walks the right contour of everything to this
 * subtree's left against this subtree's own left contour, level by level, and
 * moves this subtree right by however much the worst conflict demands. The
 * two extra walkers (`insideLeft`/`outsideLeft`, tracking the same levels from
 * the far side) are what let the threads be laid down for the next sibling to
 * reuse, which is the difference between linear and quadratic time.
 */
function apportion(nodes: WalkNode[], index: number, defaultAncestor: number, distance: number): number {
	const left = leftSibling(nodes, index);
	if (left === -1) return defaultAncestor;

	let insideRight = index;
	let outsideRight = index;
	let insideLeft = left;
	let outsideLeft = leftmostSibling(nodes, index);
	let insideRightMod = nodes[insideRight].mod;
	let outsideRightMod = nodes[outsideRight].mod;
	let insideLeftMod = nodes[insideLeft].mod;
	let outsideLeftMod = nodes[outsideLeft].mod;

	while (nextRight(nodes, insideLeft) !== -1 && nextLeft(nodes, insideRight) !== -1) {
		insideLeft = nextRight(nodes, insideLeft);
		insideRight = nextLeft(nodes, insideRight);
		outsideLeft = nextLeft(nodes, outsideLeft);
		outsideRight = nextRight(nodes, outsideRight);
		nodes[outsideRight].ancestor = index;

		const shift = nodes[insideLeft].prelim + insideLeftMod - (nodes[insideRight].prelim + insideRightMod) + distance;
		if (shift > 0) {
			moveSubtree(nodes, ancestorOf(nodes, insideLeft, index, defaultAncestor), index, shift);
			insideRightMod += shift;
			outsideRightMod += shift;
		}
		insideLeftMod += nodes[insideLeft].mod;
		insideRightMod += nodes[insideRight].mod;
		outsideLeftMod += nodes[outsideLeft].mod;
		outsideRightMod += nodes[outsideRight].mod;
	}

	// One contour ran out before the other. The deeper one's continuation is
	// threaded onto the shallower one's last node, so the next sibling's walk
	// picks up where this one stopped instead of descending again.
	if (nextRight(nodes, insideLeft) !== -1 && nextRight(nodes, outsideRight) === -1) {
		nodes[outsideRight].thread = nextRight(nodes, insideLeft);
		nodes[outsideRight].mod += insideLeftMod - outsideRightMod;
	}
	let nextDefaultAncestor = defaultAncestor;
	if (nextLeft(nodes, insideRight) !== -1 && nextLeft(nodes, outsideLeft) === -1) {
		nodes[outsideLeft].thread = nextLeft(nodes, insideRight);
		nodes[outsideLeft].mod += insideRightMod - outsideLeftMod;
		nextDefaultAncestor = index;
	}
	return nextDefaultAncestor;
}

/** Moves `right`'s subtree by `shift`, and distributes the same movement
 * smoothly across the subtrees standing between `left` and `right` so they end
 * up evenly spread rather than bunched against one side of the new gap. The
 * distribution is deferred into `change`/`shift` and applied by
 * `executeShifts`, which is what keeps this O(1). */
function moveSubtree(nodes: WalkNode[], left: number, right: number, shift: number): void {
	const subtrees = nodes[right].number - nodes[left].number;
	if (subtrees === 0) return;
	nodes[right].change -= shift / subtrees;
	nodes[right].shift += shift;
	nodes[left].change += shift / subtrees;
	nodes[right].prelim += shift;
	nodes[right].mod += shift;
}

/** Applies the deferred `shift`/`change` amounts `moveSubtree` left on a
 * node's children, right to left, so each middle subtree takes its share. */
function executeShifts(nodes: WalkNode[], index: number): void {
	const children = nodes[index].children;
	let shift = 0;
	let change = 0;
	for (let i = children.length - 1; i >= 0; i -= 1) {
		const child = nodes[children[i]];
		child.prelim += shift;
		child.mod += shift;
		change += child.change;
		shift += child.shift + change;
	}
}

/** The conflicting node's ancestor if it is a sibling of `index` (so a shift
 * applied to it moves a subtree in the same sibling run), otherwise the
 * default ancestor. */
function ancestorOf(nodes: WalkNode[], insideLeft: number, index: number, defaultAncestor: number): number {
	const candidate = nodes[insideLeft].ancestor;
	return nodes[candidate].parent === nodes[index].parent ? candidate : defaultAncestor;
}

/** Contour steps: down the left side, and down the right side, falling back to
 * the thread once a node has no children of its own. */
function nextLeft(nodes: WalkNode[], index: number): number {
	const node = nodes[index];
	return node.children.length > 0 ? node.children[0] : node.thread;
}

function nextRight(nodes: WalkNode[], index: number): number {
	const node = nodes[index];
	return node.children.length > 0 ? node.children[node.children.length - 1] : node.thread;
}

function leftSibling(nodes: WalkNode[], index: number): number {
	const parent = nodes[index].parent;
	if (parent === -1) return -1;
	const siblings = nodes[parent].children;
	const position = nodes[index].number - 1;
	return position > 0 ? siblings[position - 1] : -1;
}

function leftmostSibling(nodes: WalkNode[], index: number): number {
	const parent = nodes[index].parent;
	if (parent === -1) return index;
	return nodes[parent].children[0];
}

/** Buchheim's `secondWalk`, iterative: turns the relative `prelim` plus the
 * accumulated `mod` chain into a final cross-axis coordinate, written back
 * over `prelim` so the caller reads one field. */
function secondWalk(nodes: WalkNode[]): void {
	const stack: { index: number; modSum: number }[] = [{ index: 0, modSum: 0 }];
	while (stack.length > 0) {
		const { index, modSum } = stack.pop() as { index: number; modSum: number };
		const node = nodes[index];
		const nextModSum = modSum + node.mod;
		node.prelim += modSum;
		for (const child of node.children) stack.push({ index: child, modSum: nextModSum });
	}
}
