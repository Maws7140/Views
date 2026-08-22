import assert from 'node:assert/strict';
import test from 'node:test';
import { bfsTreeSource, propertyTreeSource } from '../../src/graph/treeSource';
import type { GraphModel } from '../../src/graph/types';

interface EdgeSpec {
	from: string;
	to: string;
	property?: string | null;
	reciprocal?: boolean;
}

/** Degree is counted from the edge list rather than passed in, because
 * `bfsTreeSource` seeds each additional component at its highest-degree node
 * and a hand-written degree of 0 everywhere would make that choice untestable. */
function model(nodeIds: string[], edges: EdgeSpec[]): GraphModel {
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
			reciprocal: edge.reciprocal ?? false,
		})),
		truncated: null,
	};
}

function serialize(result: { parent: Map<string, string>; children: Map<string, string[]>; roots: string[] }): string {
	return JSON.stringify({
		parent: [...result.parent].sort(),
		children: [...result.children].sort(),
		roots: result.roots,
	});
}

// ---- BFS source ----------------------------------------------------------

test('the BFS source roots at the node it was given and hangs its neighbours off it', () => {
	const source = model(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]);
	const tree = bfsTreeSource(source, 'a');
	assert.deepEqual(tree.roots, ['a']);
	assert.equal(tree.parent.get('b'), 'a');
	assert.equal(tree.parent.get('c'), 'a');
	assert.deepEqual(tree.children.get('a'), ['b', 'c']);
	assert.equal(tree.depths.get('c'), 1);
});

test('the BFS source covers every component, not just the root\'s, one root each', () => {
	const source = model(
		['a', 'b', 'x', 'y', 'z'],
		[{ from: 'a', to: 'b' }, { from: 'x', to: 'y' }, { from: 'x', to: 'z' }],
	);
	const tree = bfsTreeSource(source, 'a');
	// Focus mode would have stopped at `a` and `b`. A tree of the whole base
	// that silently drew two of five nodes would read as a broken layout.
	assert.equal(tree.depths.size, 5);
	// `x` has two edges to `y`'s and `z`'s one, so the second component is
	// seeded at its hub rather than at whichever id sorts first.
	assert.deepEqual(tree.roots, ['a', 'x']);
});

test('the BFS source falls back to the best-connected node when the root is not in the model', () => {
	const source = model(['a', 'b', 'c'], [{ from: 'b', to: 'a' }, { from: 'b', to: 'c' }]);
	const tree = bfsTreeSource(source, 'gone.md');
	assert.deepEqual(tree.roots, ['b']);
	assert.equal(tree.depths.get('b'), 0);
});

test('the BFS source is deterministic under a reordered edge list', () => {
	const nodes = ['a', 'b', 'c', 'd', 'e'];
	const edges = [
		{ from: 'a', to: 'b' },
		{ from: 'a', to: 'c' },
		{ from: 'b', to: 'd' },
		{ from: 'c', to: 'd' },
		{ from: 'd', to: 'e' },
	];
	const first = bfsTreeSource(model(nodes, edges), 'a');
	const second = bfsTreeSource(model(nodes, [...edges].reverse()), 'a');
	assert.equal(serialize(first), serialize(second));
});

test('an empty model produces an empty result rather than throwing', () => {
	const tree = bfsTreeSource(model([], []), 'a');
	assert.deepEqual(tree.roots, []);
	assert.equal(tree.depths.size, 0);
});

// ---- Property source -----------------------------------------------------

test('the property source takes the parent from an edge carrying that property', () => {
	const source = model(
		['essay.md', 'notes.md', 'CS 221.md'],
		[
			{ from: 'essay.md', to: 'CS 221.md', property: 'note.class' },
			{ from: 'notes.md', to: 'CS 221.md', property: 'note.class' },
		],
	);
	const tree = propertyTreeSource(source, 'note.class');
	assert.deepEqual(tree.roots, ['CS 221.md']);
	assert.equal(tree.parent.get('essay.md'), 'CS 221.md');
	assert.deepEqual(tree.children.get('CS 221.md'), ['essay.md', 'notes.md']);
	assert.equal(tree.depths.get('notes.md'), 1);
});

test('the property source ignores edges from any other property', () => {
	const source = model(
		['a', 'b', 'c'],
		[
			{ from: 'a', to: 'b', property: 'note.class' },
			{ from: 'c', to: 'b', property: 'note.related' },
		],
	);
	const tree = propertyTreeSource(source, 'note.class');
	assert.equal(tree.parent.get('a'), 'b');
	assert.equal(tree.parent.has('c'), false);
	assert.deepEqual(tree.roots, ['b', 'c']);
});

test('several declared parents reduce to the lowest id, not to whichever edge came first', () => {
	const nodes = ['leaf', 'alpha', 'omega'];
	const edges = [
		{ from: 'leaf', to: 'omega', property: 'note.class' },
		{ from: 'leaf', to: 'alpha', property: 'note.class' },
	];
	const first = propertyTreeSource(model(nodes, edges), 'note.class');
	const second = propertyTreeSource(model(nodes, [...edges].reverse()), 'note.class');
	assert.equal(first.parent.get('leaf'), 'alpha');
	assert.equal(serialize(first), serialize(second));
});

test('a cycle is broken rather than walked forever, and every node still lands in the forest', () => {
	const source = model(
		['a', 'b', 'c'],
		[
			{ from: 'a', to: 'b', property: 'note.class' },
			{ from: 'b', to: 'c', property: 'note.class' },
			{ from: 'c', to: 'a', property: 'note.class' },
		],
	);
	const tree = propertyTreeSource(source, 'note.class');
	assert.equal(tree.roots.length, 1);
	assert.equal(tree.depths.size, 3, 'every node in the cycle must still be placed');
	// Exactly one link cut: a three-node cycle becomes a three-node chain.
	assert.equal(tree.parent.size, 2);
	assert.equal(tree.depths.get(tree.roots[0]), 0);
});

test('two notes naming each other are a cycle too, and one of them becomes the root', () => {
	const source = model(['a', 'b'], [{ from: 'a', to: 'b', property: 'note.class', reciprocal: true }]);
	const tree = propertyTreeSource(source, 'note.class');
	assert.equal(tree.roots.length, 1);
	assert.equal(tree.parent.size, 1);
	assert.equal(tree.depths.size, 2);
});

test('cycle breaking is deterministic across runs and across edge order', () => {
	const nodes = ['a', 'b', 'c', 'd'];
	const edges = [
		{ from: 'a', to: 'b', property: 'note.class' },
		{ from: 'b', to: 'c', property: 'note.class' },
		{ from: 'c', to: 'a', property: 'note.class' },
		{ from: 'd', to: 'a', property: 'note.class' },
	];
	const first = propertyTreeSource(model(nodes, edges), 'note.class');
	const second = propertyTreeSource(model(nodes, [...edges].reverse()), 'note.class');
	const third = propertyTreeSource(model([...nodes].reverse(), edges), 'note.class');
	assert.equal(serialize(first), serialize(second));
	assert.equal(serialize(first), serialize(third));
});

test('a base with no hierarchy property at all is a forest of single nodes, not an empty canvas', () => {
	const source = model(['a', 'b', 'c'], [{ from: 'a', to: 'b', property: 'note.related' }]);
	const tree = propertyTreeSource(source, 'note.class');
	assert.deepEqual(tree.roots, ['a', 'b', 'c']);
	assert.equal(tree.parent.size, 0);
	for (const id of ['a', 'b', 'c']) assert.equal(tree.depths.get(id), 0);
});

test('a parentless root the caller named is stacked first, and one with a parent is left where it belongs', () => {
	const source = model(
		['a', 'b', 'c'],
		[{ from: 'c', to: 'a', property: 'note.class' }],
	);
	assert.deepEqual(propertyTreeSource(source, 'note.class', 'b').roots, ['b', 'a']);
	// `c` declares `a` as its parent, so asking for it as the root does not
	// cut that link: the tree still says what the vault says.
	const rootedAtChild = propertyTreeSource(source, 'note.class', 'c');
	assert.deepEqual(rootedAtChild.roots, ['a', 'b']);
	assert.equal(rootedAtChild.parent.get('c'), 'a');
});

test('an edge to a node outside the model is not a parent link', () => {
	const source = model(['a'], [{ from: 'a', to: 'missing.md', property: 'note.class' }]);
	const tree = propertyTreeSource(source, 'note.class');
	assert.deepEqual(tree.roots, ['a']);
	assert.equal(tree.parent.size, 0);
});
