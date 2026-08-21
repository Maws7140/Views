import assert from 'node:assert/strict';
import test from 'node:test';
import { highestDegreeNodeId, selectRoot } from '../../src/graph/rootSelection';
import type { GraphModel, GraphNode } from '../../src/graph/types';

function node(id: string, degree: number, path?: string): GraphNode {
	return { id, kind: 'note', label: id, icons: [], typeValue: null, degree, path };
}

function model(nodes: GraphNode[]): GraphModel {
	return { nodes, edges: [], truncated: null };
}

test('an explicit root wins over everything else when it is still present', () => {
	const source = model([node('a', 5), node('b', 1)]);
	const result = selectRoot({ model: source, explicitRootId: 'b', activeNotePath: 'a.md' });
	assert.equal(result, 'b');
});

test('an explicit root that has fallen out of the model is ignored, not returned anyway', () => {
	const source = model([node('a', 5, 'a.md'), node('b', 1, 'b.md')]);
	const result = selectRoot({ model: source, explicitRootId: 'gone', activeNotePath: 'a.md' });
	assert.equal(result, 'a');
});

test('the active note wins when it is in the base and there is no explicit root', () => {
	const source = model([node('a', 1, 'a.md'), node('b', 9, 'b.md')]);
	const result = selectRoot({ model: source, explicitRootId: null, activeNotePath: 'a.md' });
	assert.equal(result, 'a');
});

test('with no active note and no explicit root, the highest-degree node is chosen', () => {
	const source = model([node('a', 1), node('b', 9), node('c', 4)]);
	const result = selectRoot({ model: source, explicitRootId: null, activeNotePath: null });
	assert.equal(result, 'b');
});

test('an active note not among this base\'s results falls back to highest degree', () => {
	const source = model([node('a', 1, 'a.md'), node('b', 9, 'b.md')]);
	const result = selectRoot({ model: source, explicitRootId: null, activeNotePath: 'elsewhere.md' });
	assert.equal(result, 'b');
});

test('a degree tie breaks on id, deterministically', () => {
	const source = model([node('z', 3), node('a', 3)]);
	const result = selectRoot({ model: source, explicitRootId: null, activeNotePath: null });
	assert.equal(result, 'a');
});

test('an empty model has no root at all', () => {
	const result = selectRoot({ model: model([]), explicitRootId: null, activeNotePath: null });
	assert.equal(result, null);
});

test('highestDegreeNodeId on its own picks the same winner', () => {
	assert.equal(highestDegreeNodeId([node('a', 2), node('b', 7), node('c', 7)]), 'b');
	assert.equal(highestDegreeNodeId([]), null);
});
