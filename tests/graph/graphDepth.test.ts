import assert from 'node:assert/strict';
import test from 'node:test';
import { computeDepthsFromRoot } from '../../src/graph/graphDepth';
import type { GraphModel } from '../../src/graph/types';

function model(nodeIds: string[], edges: { from: string; to: string }[]): GraphModel {
	return {
		nodes: nodeIds.map((id) => ({ id, kind: 'note', label: id, icons: [], typeValue: null, degree: 0 })),
		edges: edges.map((edge) => ({ from: edge.from, to: edge.to, label: null, property: null, reciprocal: false })),
		truncated: null,
	};
}

test('root is depth 0 and direct neighbours are depth 1', () => {
	const source = model(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]);
	const { depths } = computeDepthsFromRoot(source, 'a');
	assert.equal(depths.get('a'), 0);
	assert.equal(depths.get('b'), 1);
	assert.equal(depths.get('c'), 1);
});

test('a chain grows depth one hop at a time', () => {
	const source = model(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }]);
	const { depths } = computeDepthsFromRoot(source, 'a');
	assert.equal(depths.get('d'), 3);
});

test('edges are undirected: a node only reachable against the edge direction still gets a depth', () => {
	const source = model(['a', 'b'], [{ from: 'b', to: 'a' }]);
	const { depths } = computeDepthsFromRoot(source, 'a');
	assert.equal(depths.get('b'), 1);
});

test('a cycle does not loop the traversal or revisit a node at a shorter depth wrong', () => {
	const source = model(
		['a', 'b', 'c'],
		[{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
	);
	const { depths } = computeDepthsFromRoot(source, 'a');
	assert.equal(depths.size, 3);
	assert.equal(depths.get('a'), 0);
	assert.equal(depths.get('b'), 1);
	assert.equal(depths.get('c'), 1);
});

test('a node unreachable from the root has no depth entry at all', () => {
	const source = model(['a', 'b', 'isolated'], [{ from: 'a', to: 'b' }]);
	const { depths } = computeDepthsFromRoot(source, 'a');
	assert.equal(depths.size, 2);
	assert.equal(depths.has('isolated'), false);
});

test('a root not present in the model produces an empty result rather than throwing', () => {
	const source = model(['a', 'b'], [{ from: 'a', to: 'b' }]);
	const { depths, parent, children } = computeDepthsFromRoot(source, 'missing');
	assert.equal(depths.size, 0);
	assert.equal(parent.size, 0);
	assert.equal(children.size, 0);
});

test('the BFS tree records a parent for every reached non-root node, sorted children', () => {
	const source = model(
		['a', 'c', 'b'],
		[{ from: 'a', to: 'c' }, { from: 'a', to: 'b' }],
	);
	const { parent, children } = computeDepthsFromRoot(source, 'a');
	assert.equal(parent.get('b'), 'a');
	assert.equal(parent.get('c'), 'a');
	assert.deepEqual(children.get('a'), ['b', 'c']);
});
