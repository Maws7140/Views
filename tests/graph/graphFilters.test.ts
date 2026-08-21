import assert from 'node:assert/strict';
import test from 'node:test';
import { describeGraphNotice, filterModelForView, filterModelToDepth } from '../../src/graph/graphFilters';
import type { GraphModel } from '../../src/graph/types';

function model(nodes: { id: string; degree: number }[], edges: { from: string; to: string }[]): GraphModel {
	return {
		nodes: nodes.map((node) => ({
			id: node.id,
			kind: 'note',
			label: node.id,
			icons: [],
			typeValue: null,
			degree: node.degree,
		})),
		edges: edges.map((edge) => ({ from: edge.from, to: edge.to, label: null, property: null, reciprocal: false })),
		truncated: null,
	};
}

test('hideUnlinked removes only degree-0 nodes and the edges no longer have anywhere to point', () => {
	const source = model(
		[{ id: 'a', degree: 1 }, { id: 'b', degree: 1 }, { id: 'lonely', degree: 0 }],
		[{ from: 'a', to: 'b' }],
	);
	const filtered = filterModelForView(source, true, 0);
	assert.deepEqual(filtered.nodes.map((n) => n.id).sort(), ['a', 'b']);
	assert.equal(filtered.edges.length, 1);
});

test('the max-links filter removes exactly the nodes over the threshold and their edges', () => {
	const source = model(
		[{ id: 'hub', degree: 5 }, { id: 'quiet', degree: 1 }],
		[{ from: 'hub', to: 'quiet' }],
	);
	const filtered = filterModelForView(source, false, 3);
	assert.deepEqual(filtered.nodes.map((n) => n.id), ['quiet']);
	// hub is gone, so the edge that touched it cannot survive either, even
	// though the surviving endpoint (quiet) was itself under the threshold.
	assert.equal(filtered.edges.length, 0);
});

test('a node exactly at the max-links threshold is kept, not filtered', () => {
	const source = model([{ id: 'a', degree: 3 }], []);
	const filtered = filterModelForView(source, false, 3);
	assert.equal(filtered.nodes.length, 1);
});

test('with both filters off the same model instance is returned unchanged', () => {
	const source = model([{ id: 'a', degree: 0 }], []);
	const filtered = filterModelForView(source, false, 0);
	assert.equal(filtered, source);
});

test('an edge surviving on both ends is kept when only one side of the graph is filtered', () => {
	const source = model(
		[{ id: 'a', degree: 1 }, { id: 'b', degree: 1 }, { id: 'isolated', degree: 0 }],
		[{ from: 'a', to: 'b' }],
	);
	const filtered = filterModelForView(source, true, 0);
	assert.equal(filtered.edges.length, 1);
	assert.equal(filtered.edges[0].from, 'a');
	assert.equal(filtered.edges[0].to, 'b');
});

test('filterModelToDepth keeps only nodes with a depth entry at or under maxDepth', () => {
	const source = model(
		[{ id: 'root', degree: 2 }, { id: 'near', degree: 2 }, { id: 'far', degree: 1 }],
		[{ from: 'root', to: 'near' }, { from: 'near', to: 'far' }],
	);
	const depths = new Map([['root', 0], ['near', 1], ['far', 2]]);
	const filtered = filterModelToDepth(source, depths, 1);
	assert.deepEqual(filtered.nodes.map((n) => n.id).sort(), ['near', 'root']);
	assert.equal(filtered.edges.length, 1);
});

test('filterModelToDepth drops a node absent from depths, same as one unreachable from the root', () => {
	const source = model(
		[{ id: 'root', degree: 1 }, { id: 'reached', degree: 1 }, { id: 'unreached', degree: 0 }],
		[{ from: 'root', to: 'reached' }],
	);
	const depths = new Map([['root', 0], ['reached', 1]]);
	const filtered = filterModelToDepth(source, depths, 3);
	assert.deepEqual(filtered.nodes.map((n) => n.id).sort(), ['reached', 'root']);
});

test('filterModelToDepth returns the same model instance when nothing is dropped', () => {
	const source = model([{ id: 'root', degree: 0 }], []);
	const depths = new Map([['root', 0]]);
	const filtered = filterModelToDepth(source, depths, 3);
	assert.equal(filtered, source);
});

test('a graph drawing everything it was given says nothing', () => {
	assert.equal(describeGraphNotice({
		totalNodes: 10,
		drawnNodes: 10,
		truncated: null,
		showOrphans: false,
		maxLinks: 0,
	}), null);
});

test('a graph that drew nothing explains itself rather than leaving a blank canvas', () => {
	const notice = describeGraphNotice({
		totalNodes: 24,
		drawnNodes: 0,
		truncated: null,
		showOrphans: false,
		maxLinks: 0,
	});
	assert.ok(notice);
	assert.match(notice, /Orphans/);
});

test('an empty graph with orphans already on blames the link limit when there is one', () => {
	assert.match(describeGraphNotice({
		totalNodes: 24,
		drawnNodes: 0,
		truncated: null,
		showOrphans: true,
		maxLinks: 5,
	}) ?? '', /limit/);
	assert.equal(describeGraphNotice({
		totalNodes: 24,
		drawnNodes: 0,
		truncated: null,
		showOrphans: true,
		maxLinks: 0,
	}), 'Nothing to draw.');
});

test('a base that returned nothing at all says nothing, having nothing to explain', () => {
	assert.equal(describeGraphNotice({
		totalNodes: 0,
		drawnNodes: 0,
		truncated: null,
		showOrphans: false,
		maxLinks: 0,
	}), null);
});

test('the node cap notice still reports what it kept', () => {
	assert.equal(describeGraphNotice({
		totalNodes: 600,
		drawnNodes: 600,
		truncated: { shown: 600, total: 900 },
		showOrphans: true,
		maxLinks: 0,
	}), 'Showing 600 of 900 nodes.');
});
