import assert from 'node:assert/strict';
import test from 'node:test';
import { computeTidyTree, type TidyTreeInput, type TidyTreeOptions, type TreeOrientation } from '../../src/graph/tidyTree';
import { bfsTreeSource, propertyTreeSource } from '../../src/graph/treeSource';
import type { GraphModel } from '../../src/graph/types';

const NODE_WIDTH = 40;
const NODE_HEIGHT = 20;
const SIBLING_GAP = 10;
const LEVEL_GAP = 30;

function options(orientation: TreeOrientation, overrides: Partial<TidyTreeOptions> = {}): TidyTreeOptions {
	return {
		orientation,
		nodeWidth: NODE_WIDTH,
		nodeHeight: NODE_HEIGHT,
		siblingGap: SIBLING_GAP,
		levelGap: LEVEL_GAP,
		...overrides,
	};
}

/** Centre-to-centre spacing two adjacent siblings should end up at when
 * nothing pushes them further apart: one node extent along the cross axis
 * plus the gap. */
function siblingDistance(orientation: TreeOrientation): number {
	return (orientation === 'topDown' ? NODE_WIDTH : NODE_HEIGHT) + SIBLING_GAP;
}

function tree(roots: string[], children: Record<string, string[]>): TidyTreeInput {
	return { roots, children: new Map(Object.entries(children)) };
}

/** Every node's drawn box, so overlap can be asserted the way the eye judges
 * it (two tiles sharing screen space) rather than by comparing coordinates on
 * one axis at a time. */
function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
	return Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT;
}

function assertNoOverlap(positions: Map<string, { x: number; y: number }>): void {
	const entries = [...positions];
	for (let i = 0; i < entries.length; i += 1) {
		for (let j = i + 1; j < entries.length; j += 1) {
			assert.ok(
				!overlaps(entries[i][1], entries[j][1]),
				`${entries[i][0]} and ${entries[j][0]} overlap at ${JSON.stringify(entries[i][1])} / ${JSON.stringify(entries[j][1])}`,
			);
		}
	}
}

const ORIENTATIONS: TreeOrientation[] = ['leftToRight', 'topDown'];

test('an empty forest lays out nothing rather than throwing', () => {
	assert.equal(computeTidyTree(tree([], {}), options('leftToRight')).size, 0);
});

test('depth runs along x under left to right and along y under top down', () => {
	const input = tree(['root'], { root: ['a', 'b'], a: ['a1'] });

	const horizontal = computeTidyTree(input, options('leftToRight'));
	const root = horizontal.get('root');
	const a = horizontal.get('a');
	const a1 = horizontal.get('a1');
	assert.ok(root && a && a1);
	assert.ok(a.x > root.x, 'a generation must sit further right than its parent');
	assert.ok(a1.x > a.x);
	assert.equal(a.x - root.x, NODE_WIDTH + LEVEL_GAP);
	assert.equal(a.depth, 1);
	assert.equal(a1.depth, 2);

	const vertical = computeTidyTree(input, options('topDown'));
	const vRoot = vertical.get('root');
	const vA = vertical.get('a');
	assert.ok(vRoot && vA);
	assert.equal(vA.x, vRoot.x - siblingDistance('topDown') / 2, 'the root centres over its two children');
	assert.equal(vA.y - vRoot.y, NODE_HEIGHT + LEVEL_GAP);
});

test('siblings are spaced by exactly one node extent plus the gap, in both orientations', () => {
	for (const orientation of ORIENTATIONS) {
		const positions = computeTidyTree(tree(['root'], { root: ['a', 'b', 'c'] }), options(orientation));
		const across = (id: string): number => {
			const point = positions.get(id);
			assert.ok(point);
			return orientation === 'topDown' ? point.x : point.y;
		};
		assert.equal(across('b') - across('a'), siblingDistance(orientation), orientation);
		assert.equal(across('c') - across('b'), siblingDistance(orientation), orientation);
	}
});

test('a parent is centred over its children', () => {
	const positions = computeTidyTree(tree(['root'], { root: ['a', 'b'], a: ['a1', 'a2'] }), options('leftToRight'));
	const a = positions.get('a');
	const a1 = positions.get('a1');
	const a2 = positions.get('a2');
	assert.ok(a && a1 && a2);
	assert.equal(a.y, (a1.y + a2.y) / 2);
});

test('sibling subtrees never overlap, however uneven their shapes', () => {
	// Deliberately lopsided: one child is a deep chain, one is bushy, one is a
	// leaf, and one is bushy at a level the others have nothing at.
	const input = tree(['root'], {
		root: ['deep', 'bushy', 'leaf', 'late'],
		deep: ['deep1'],
		deep1: ['deep2'],
		deep2: ['deep3'],
		bushy: ['b1', 'b2', 'b3', 'b4'],
		late: ['l1'],
		l1: ['l1a', 'l1b', 'l1c'],
	});
	for (const orientation of ORIENTATIONS) {
		assertNoOverlap(computeTidyTree(input, options(orientation)));
	}
});

test('subtrees pack by contour, not by bounding width: a leaf sits one gap from its neighbour whatever hangs under it', () => {
	// `wide` is one node above a node that is itself two nodes wide, so its
	// subtree's bounding box is two slots across while the subtree's own left
	// contour is one node at depth 1 and one at depth 2. A layout that reserved
	// the bounding width would push `leaf` a slot and a half away; a real tidy
	// tree only has to clear the contour, so the two end up exactly one sibling
	// distance apart at the only depth where they meet.
	const positions = computeTidyTree(
		tree(['root'], { root: ['wide', 'leaf'], wide: ['mid'], mid: ['m1', 'm2'] }),
		options('leftToRight'),
	);
	const wide = positions.get('wide');
	const leaf = positions.get('leaf');
	assert.ok(wide && leaf);
	assert.equal(leaf.y - wide.y, siblingDistance('leftToRight'));
	assertNoOverlap(positions);
});

test('a forest stacks its roots without overlap and without interleaving their subtrees', () => {
	const input = tree(['first', 'second'], {
		first: ['f1', 'f2'],
		second: ['s1'],
		s1: ['s1a', 's1b'],
	});
	for (const orientation of ORIENTATIONS) {
		const positions = computeTidyTree(input, options(orientation));
		assert.equal(positions.size, 7);
		assertNoOverlap(positions);
		const across = (id: string): number => {
			const point = positions.get(id);
			assert.ok(point);
			return orientation === 'topDown' ? point.x : point.y;
		};
		// Every node of the first tree comes before every node of the second:
		// two trees that interleaved would read as one tree with a false shape.
		const firstTree = ['first', 'f1', 'f2'].map(across);
		const secondTree = ['second', 's1', 's1a', 's1b'].map(across);
		assert.ok(Math.max(...firstTree) < Math.min(...secondTree), orientation);
	}
});

test('a single chain hundreds deep lays out without exhausting the stack', () => {
	const children: Record<string, string[]> = {};
	for (let i = 0; i < 800; i += 1) children[`n${i}`] = [`n${i + 1}`];
	const positions = computeTidyTree(tree(['n0'], children), options('leftToRight'));
	assert.equal(positions.size, 801);
	assert.equal(positions.get('n800')?.depth, 800);
});

test('the same tree lays out identically every time', () => {
	const input = tree(['root'], { root: ['a', 'b'], a: ['a1', 'a2'], b: ['b1'] });
	for (const orientation of ORIENTATIONS) {
		const first = JSON.stringify([...computeTidyTree(input, options(orientation))].sort());
		const second = JSON.stringify([...computeTidyTree(input, options(orientation))].sort());
		assert.equal(first, second);
	}
});

test('the layout is centred on the origin, which is what the renderer frames against', () => {
	const positions = computeTidyTree(tree(['root'], { root: ['a', 'b', 'c'] }), options('topDown'));
	const xs = [...positions.values()].map((point) => point.x);
	assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, 0);
});

test('a node named in children but hanging off no root is left unplaced rather than given a position', () => {
	const positions = computeTidyTree(tree(['root'], { root: ['a'], orphaned: ['x'] }), options('leftToRight'));
	assert.equal(positions.has('orphaned'), false);
	assert.equal(positions.has('x'), false);
});

// ---- End to end with the tree sources ------------------------------------

function graph(nodeIds: string[], edges: { from: string; to: string; property?: string | null }[]): GraphModel {
	const degrees = new Map(nodeIds.map((id) => [id, 0]));
	for (const edge of edges) {
		degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
		degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
	}
	return {
		nodes: nodeIds.map((id) => ({ id, kind: 'note', label: id, icons: [], typeValue: null, degree: degrees.get(id) ?? 0 })),
		edges: edges.map((edge) => ({
			from: edge.from,
			to: edge.to,
			label: null,
			property: (edge.property ?? null) as GraphModel['edges'][number]['property'],
			reciprocal: false,
		})),
		truncated: null,
	};
}

test('a BFS tree over a multi-component base lays every node out without overlap', () => {
	const source = graph(
		['a', 'b', 'c', 'x', 'y', 'lonely'],
		[{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'x', to: 'y' }],
	);
	for (const orientation of ORIENTATIONS) {
		const positions = computeTidyTree(bfsTreeSource(source, 'a'), options(orientation));
		assert.equal(positions.size, 6, 'a disconnected node is still a tree of one');
		assertNoOverlap(positions);
	}
});

test('a property tree with a cycle in it still lays out, every node placed once', () => {
	const source = graph(
		['a', 'b', 'c', 'd'],
		[
			{ from: 'a', to: 'b', property: 'note.class' },
			{ from: 'b', to: 'c', property: 'note.class' },
			{ from: 'c', to: 'a', property: 'note.class' },
			{ from: 'd', to: 'c', property: 'note.class' },
		],
	);
	const positions = computeTidyTree(propertyTreeSource(source, 'note.class'), options('leftToRight'));
	assert.equal(positions.size, 4);
	assertNoOverlap(positions);
});
