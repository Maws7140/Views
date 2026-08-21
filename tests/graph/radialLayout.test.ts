import assert from 'node:assert/strict';
import test from 'node:test';
import { computeRadialLayout } from '../../src/graph/radialLayout';
import type { GraphModel } from '../../src/graph/types';

function model(nodeIds: string[], edges: { from: string; to: string }[]): GraphModel {
	return {
		nodes: nodeIds.map((id) => ({ id, kind: 'note', label: id, icons: [], typeValue: null, degree: 0 })),
		edges: edges.map((edge) => ({ from: edge.from, to: edge.to, label: null, property: null, reciprocal: false })),
		truncated: null,
	};
}

test('the root sits at the origin', () => {
	const source = model(['a', 'b'], [{ from: 'a', to: 'b' }]);
	const positions = computeRadialLayout(source, 'a', 100);
	assert.deepEqual(positions.get('a'), { x: 0, y: 0, ring: 0 });
});

test('ring radius is fixed by depth, not by how many nodes share it', () => {
	const source = model(
		['a', 'b1', 'b2', 'b3'],
		[{ from: 'a', to: 'b1' }, { from: 'a', to: 'b2' }, { from: 'a', to: 'b3' }],
	);
	const positions = computeRadialLayout(source, 'a', 100);
	for (const id of ['b1', 'b2', 'b3']) {
		const pos = positions.get(id);
		assert.ok(pos);
		assert.equal(pos?.ring, 1);
		assert.ok(Math.abs(Math.hypot(pos!.x, pos!.y) - 100) < 1e-9);
	}
});

test('a wider ring at depth 2 sits at exactly twice the depth-1 radius', () => {
	const source = model(
		['a', 'b', 'c'],
		[{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
	);
	const positions = computeRadialLayout(source, 'a', 100);
	const depth1 = positions.get('b');
	const depth2 = positions.get('c');
	assert.ok(Math.abs(Math.hypot(depth1!.x, depth1!.y) - 100) < 1e-9);
	assert.ok(Math.abs(Math.hypot(depth2!.x, depth2!.y) - 200) < 1e-9);
});

test('siblings on the same ring are spread apart rather than stacked', () => {
	const source = model(
		['a', 'b1', 'b2'],
		[{ from: 'a', to: 'b1' }, { from: 'a', to: 'b2' }],
	);
	const positions = computeRadialLayout(source, 'a', 100);
	const p1 = positions.get('b1') as { x: number; y: number };
	const p2 = positions.get('b2') as { x: number; y: number };
	assert.ok(Math.hypot(p1.x - p2.x, p1.y - p2.y) > 100);
});

test('a child stays within its parent\'s angular slice rather than anywhere on its ring', () => {
	// Root's two depth-1 children split the circle into [0, pi) and [pi, 2pi).
	// b1's own child (c) must land inside b1's half, not b2's.
	const source = model(
		['a', 'b1', 'b2', 'c'],
		[{ from: 'a', to: 'b1' }, { from: 'a', to: 'b2' }, { from: 'b1', to: 'c' }],
	);
	const positions = computeRadialLayout(source, 'a', 100);
	const b1 = positions.get('b1') as { x: number; y: number };
	const c = positions.get('c') as { x: number; y: number };
	const b1Angle = Math.atan2(b1.y, b1.x);
	const cAngle = Math.atan2(c.y, c.x);
	// b1 owns the full first half (0 to pi) since it is the only depth-1
	// child on that side, so its own child inherits that entire slice too.
	const normalized = (angle: number) => (angle < 0 ? angle + Math.PI * 2 : angle);
	assert.ok(normalized(cAngle) >= 0 && normalized(cAngle) <= Math.PI);
	assert.ok(Math.abs(normalized(b1Angle) - Math.PI / 2) < 1e-9);
});

test('a node unreachable from the root has no position at all', () => {
	const source = model(['a', 'b', 'isolated'], [{ from: 'a', to: 'b' }]);
	const positions = computeRadialLayout(source, 'a', 100);
	assert.equal(positions.has('isolated'), false);
});

test('a root missing from the model produces an empty layout', () => {
	const source = model(['a', 'b'], [{ from: 'a', to: 'b' }]);
	const positions = computeRadialLayout(source, 'missing', 100);
	assert.equal(positions.size, 0);
});
