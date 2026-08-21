import assert from 'node:assert/strict';
import test from 'node:test';
import { buildComponentLayout, buildShapedLayout, connectedComponents } from '../../src/graph/graphComponents';
import { shapeGeometry, shapeSignedDistance } from '../../src/graph/layoutShapes';
import type { GraphEdge, GraphNode } from '../../src/graph/types';

function node(id: string): GraphNode {
	return { id, kind: 'note', label: id, icons: [], typeValue: null, degree: 0 };
}

function edge(from: string, to: string): GraphEdge {
	return { from, to, label: null, property: null, reciprocal: false };
}

test('a connected graph is one component centred at the origin', () => {
	const layout = buildComponentLayout(
		['a', 'b', 'c'].map(node),
		[edge('a', 'b'), edge('b', 'c')],
	);
	assert.equal(layout.count, 1);
	for (const id of ['a', 'b', 'c']) {
		assert.deepEqual(layout.centers.get(id), { x: 0, y: 0 });
	}
});

test('edges are followed in both directions, so direction does not split a component', () => {
	// `a -> b` and `c -> b`: nothing is reachable from `a` following arrows,
	// but all three are one component.
	const layout = buildComponentLayout(
		['a', 'b', 'c'].map(node),
		[edge('a', 'b'), edge('c', 'b')],
	);
	assert.equal(layout.count, 1);
});

test('islands get their own centres, and the largest one keeps the origin', () => {
	const layout = buildComponentLayout(
		['a', 'b', 'c', 'x', 'y', 'lonely'].map(node),
		[edge('a', 'b'), edge('b', 'c'), edge('x', 'y')],
	);
	assert.equal(layout.count, 3);
	assert.deepEqual(layout.centers.get('a'), { x: 0, y: 0 });
	// Every member of a component shares one centre, and the other components
	// are somewhere else.
	assert.deepEqual(layout.centers.get('b'), layout.centers.get('c'));
	assert.deepEqual(layout.centers.get('x'), layout.centers.get('y'));
	assert.notDeepEqual(layout.centers.get('x'), { x: 0, y: 0 });
	assert.notDeepEqual(layout.centers.get('lonely'), layout.centers.get('x'));
});

test('component discs do not overlap, which is what stops islands interleaving', () => {
	const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(node);
	const layout = buildComponentLayout(nodes, [edge('a', 'b'), edge('b', 'c')]);
	const distinct = new Set(Array.from(layout.centers.values(), (c) => `${c.x},${c.y}`));
	// Six components: one triple and five singles.
	assert.equal(layout.count, 6);
	const points = Array.from(distinct, (key) => {
		const [x, y] = key.split(',').map(Number);
		return { x, y };
	});
	for (let i = 0; i < points.length; i += 1) {
		for (let j = i + 1; j < points.length; j += 1) {
			assert.ok(
				Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) > 1,
				'two components landed on the same point',
			);
		}
	}
});

test('a node is seeded near its own component centre, not the origin', () => {
	const layout = buildComponentLayout(
		['a', 'b', 'x', 'y'].map(node),
		[edge('a', 'b'), edge('x', 'y')],
	);
	const center = layout.centers.get('y');
	const seed = layout.seeds.get('y');
	assert.ok(center && seed);
	// Within the seeding spiral's own spacing of its centre: the point is
	// that it starts inside its island rather than being dragged there.
	assert.ok(Math.hypot(seed.x - center.x, seed.y - center.y) < 100);
});

test('the same model lays out identically twice, so a base does not reshuffle between opens', () => {
	const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`));
	const edges = [edge('n0', 'n1'), edge('n1', 'n2'), edge('n5', 'n6')];
	const first = buildComponentLayout(nodes, edges);
	const second = buildComponentLayout(nodes, edges);
	assert.deepEqual(Array.from(first.centers), Array.from(second.centers));
	assert.deepEqual(Array.from(first.seeds), Array.from(second.seeds));
});

test('an edge naming a node that is not in the model is ignored rather than throwing', () => {
	const layout = buildComponentLayout(['a'].map(node), [edge('a', 'missing')]);
	assert.equal(layout.count, 1);
	assert.deepEqual(layout.centers.get('a'), { x: 0, y: 0 });
});

test('an empty model produces an empty layout', () => {
	const layout = buildComponentLayout([], []);
	assert.equal(layout.count, 0);
	assert.equal(layout.centers.size, 0);
});

test('connectedComponents orders groups largest first, deterministically', () => {
	const nodes = ['a', 'b', 'c', 'x', 'y', 'lonely'].map(node);
	const edges = [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')];
	const groups = connectedComponents(nodes, edges);
	assert.deepEqual(groups.map((group) => group.length), [3, 2, 1]);
	// Same input, same answer: the two layouts built on top of this are only
	// deterministic because this is.
	assert.deepEqual(connectedComponents(nodes, edges), groups);
});

test('a shaped layout seeds every node inside the shape', () => {
	const geometry = shapeGeometry('triangle', 500);
	assert.ok(geometry);
	const nodes = Array.from({ length: 40 }, (_, i) => node(`n${i}`));
	const layout = buildShapedLayout(nodes, [edge('n0', 'n1'), edge('n2', 'n3')], geometry);
	assert.equal(layout.seeds.size, 40);
	for (const seed of layout.seeds.values()) {
		assert.ok(shapeSignedDistance(geometry, seed.x, seed.y).distance < 0);
	}
});

test('a shaped layout keeps every component in its own patch of the fill', () => {
	const geometry = shapeGeometry('circle', 600);
	assert.ok(geometry);
	// One long chain and one pair, seeded in that order (largest component
	// first), so the pair takes two consecutive points of the fill and lands
	// together rather than being scattered across the shape.
	const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`));
	const edges = Array.from({ length: 27 }, (_, i) => edge(`n${i}`, `n${i + 1}`));
	edges.push(edge('n28', 'n29'));
	const layout = buildShapedLayout(nodes, edges, geometry);
	assert.equal(layout.count, 2);
	assert.equal(layout.seeds.size, 30);

	const first = layout.seeds.get('n28');
	const second = layout.seeds.get('n29');
	assert.ok(first && second);
	// Consecutive points of a phyllotaxis fill are about one spacing apart, so
	// the pair starts as neighbours. The shape is 600 across at its narrowest.
	assert.ok(Math.hypot(first.x - second.x, first.y - second.y) < 200);
});

test('a shaped layout carries no component centres, since it runs with centring off', () => {
	const geometry = shapeGeometry('circle', 400);
	assert.ok(geometry);
	const layout = buildShapedLayout([node('a'), node('b')], [], geometry);
	assert.equal('centers' in layout, false);
});

test('a shaped layout fills the shape rather than crowding the centre', () => {
	const geometry = shapeGeometry('circle', 400);
	assert.ok(geometry);
	const nodes = Array.from({ length: 200 }, (_, i) => node(`n${i}`));
	const layout = buildShapedLayout(nodes, [], geometry);
	let furthest = 0;
	for (const seed of layout.seeds.values()) furthest = Math.max(furthest, Math.hypot(seed.x, seed.y));
	assert.ok(furthest > 300, `the fill only reached ${furthest}`);
});

test('a shaped layout is deterministic', () => {
	const geometry = shapeGeometry('hexagon', 350);
	assert.ok(geometry);
	const nodes = ['a', 'b', 'c', 'x', 'y'].map(node);
	const edges = [edge('a', 'b'), edge('x', 'y')];
	const first = buildShapedLayout(nodes, edges, geometry);
	const second = buildShapedLayout(nodes, edges, geometry);
	for (const id of ['a', 'b', 'c', 'x', 'y']) {
		assert.deepEqual(first.seeds.get(id), second.seeds.get(id));
	}
});
