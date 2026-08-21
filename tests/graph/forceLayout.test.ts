import assert from 'node:assert/strict';
import test from 'node:test';
import {
	bruteForceRepulsion,
	DEFAULT_FORCE_OPTIONS,
	ForceSimulation,
	Quadtree,
	repulsionSliderToStrength,
	seedPosition,
	type QuadBody,
} from '../../src/graph/forceLayout';
import { boundaryDistanceAt, shapeGeometry, shapeSignedDistance } from '../../src/graph/layoutShapes';

function scatteredBodies(count: number): QuadBody[] {
	return Array.from({ length: count }, (_, i) => {
		const seed = seedPosition(i);
		return { id: `node-${i}`, x: seed.x, y: seed.y };
	});
}

test('at theta 0 the quadtree matches a brute-force sum exactly', () => {
	const bodies = scatteredBodies(40);
	const tree = Quadtree.build(bodies);
	const expected = bruteForceRepulsion(bodies, 260);

	for (const body of bodies) {
		const force = tree.forceOn(body.x, body.y, body.id, 0, 260, Infinity);
		const brute = expected.get(body.id);
		assert.ok(brute);
		assert.ok(Math.abs(force.fx - (brute as { fx: number }).fx) < 1e-6, `fx mismatch for ${body.id}`);
		assert.ok(Math.abs(force.fy - (brute as { fy: number }).fy) < 1e-6, `fy mismatch for ${body.id}`);
	}
});

test('at the production theta the quadtree stays within tolerance of brute force', () => {
	const bodies = scatteredBodies(80);
	const tree = Quadtree.build(bodies);
	const expected = bruteForceRepulsion(bodies, DEFAULT_FORCE_OPTIONS.repulsion);

	let worstRelativeError = 0;
	for (const body of bodies) {
		const force = tree.forceOn(body.x, body.y, body.id, DEFAULT_FORCE_OPTIONS.theta, DEFAULT_FORCE_OPTIONS.repulsion, Infinity);
		const brute = expected.get(body.id) as { fx: number; fy: number };
		const magnitude = Math.hypot(brute.fx, brute.fy) || 1;
		const error = Math.hypot(force.fx - brute.fx, force.fy - brute.fy) / magnitude;
		if (error > worstRelativeError) worstRelativeError = error;
	}
	assert.ok(worstRelativeError < 0.35, `Barnes-Hut approximation drifted ${worstRelativeError} from brute force at theta ${DEFAULT_FORCE_OPTIONS.theta}`);
});

test('distanceMax prunes bodies beyond the cutoff, matching a brute-force sum computed with the same cutoff', () => {
	const near: QuadBody = { id: 'near', x: 10, y: 0 };
	const far: QuadBody = { id: 'far', x: 10000, y: 0 };
	const origin: QuadBody = { id: 'origin', x: 0, y: 0 };
	const bodies = [near, far, origin];
	const tree = Quadtree.build(bodies);

	const bounded = tree.forceOn(0, 0, 'origin', 0, 100, 500);
	const expectedBounded = bruteForceRepulsion(bodies, 100, 500).get('origin') as { fx: number; fy: number };
	assert.ok(Math.abs(bounded.fx - expectedBounded.fx) < 1e-6);
	assert.ok(Math.abs(bounded.fy - expectedBounded.fy) < 1e-6);

	const unbounded = tree.forceOn(0, 0, 'origin', 0, 100, Infinity);
	// The far body is excluded from `bounded` but not `unbounded`, and it
	// pushes the origin the same direction the near body does (away from
	// positive x), so the cutoff must measurably change the result.
	assert.ok(Math.abs(unbounded.fx - bounded.fx) > 1e-9, 'the distant body must contribute when the cutoff is lifted');
});

test('queryBox reports bodies inside the box and excludes bodies outside it', () => {
	const bodies: QuadBody[] = [
		{ id: 'inside-1', x: 5, y: 5 },
		{ id: 'inside-2', x: -5, y: -5 },
		{ id: 'outside', x: 500, y: 500 },
	];
	const tree = Quadtree.build(bodies);
	const hits = tree.queryBox(-10, -10, 10, 10).sort();
	assert.deepEqual(hits, ['inside-1', 'inside-2']);
});

test('cooling reaches alphaMin and then tick() is a genuine no-op', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a', 'b'], [{ source: 'a', target: 'b' }]);
	sim.reheat(1);

	let ticks = 0;
	while (sim.isRunning() && ticks < 2000) {
		sim.tick();
		ticks += 1;
	}
	assert.ok(ticks < 2000, 'simulation must cool to alphaMin within a bounded number of ticks');
	assert.ok(sim.getAlpha() <= DEFAULT_FORCE_OPTIONS.alphaMin);

	const beforeA = sim.getPosition('a');
	const beforeB = sim.getPosition('b');
	const stillRunning = sim.tick();
	assert.equal(stillRunning, false);
	assert.deepEqual(sim.getPosition('a'), beforeA);
	assert.deepEqual(sim.getPosition('b'), beforeB);
});

test('a pinned node never moves across ticks', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a', 'b', 'c'], [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]);
	sim.pin('b', 42, -17);
	sim.reheat(1);

	for (let i = 0; i < 50; i += 1) sim.tick();
	assert.deepEqual(sim.getPosition('b'), { x: 42, y: -17 });
});

test('velocity clamping bounds per-tick displacement to maxSpeed', () => {
	const sim = new ForceSimulation();
	sim.setOptions({ maxSpeed: 5 });
	// Two nodes seeded far apart and yanked close by a strong link, which is
	// the scenario the clamp exists for: the opening alpha=1 tick otherwise
	// throws a node clear across the canvas in one frame.
	sim.setGraph(['a', 'b'], [{ source: 'a', target: 'b' }]);
	sim.setOptions({ linkDistance: 1, linkStrength: 1 });
	sim.reheat(1);

	const before = sim.getPosition('a') as { x: number; y: number };
	sim.tick();
	const after = sim.getPosition('a') as { x: number; y: number };
	const displacement = Math.hypot(after.x - before.x, after.y - before.y);
	assert.ok(displacement <= 5 + 1e-6, `displacement ${displacement} exceeded maxSpeed 5 in one tick`);
});

test('repulsionSliderToStrength is monotonic across the slider range', () => {
	let previous = -Infinity;
	for (let value = 0; value <= 100; value += 5) {
		const strength = repulsionSliderToStrength(value);
		assert.ok(strength > previous);
		previous = strength;
	}
});

test('seedPosition is deterministic for the same index', () => {
	const first = seedPosition(7);
	const second = seedPosition(7);
	assert.deepEqual(first, second);
});

test('the same node in the same graph seeds to the same position on every setGraph call', () => {
	// setGraph seeds a new id by its position in the incoming array, so two
	// independent simulations fed the identical node order must place a
	// brand-new node at the identical point, not just seedPosition in
	// isolation.
	const first = new ForceSimulation();
	first.setGraph(['a', 'b', 'c'], []);
	const second = new ForceSimulation();
	second.setGraph(['a', 'b', 'c'], []);
	assert.deepEqual(first.getPosition('c'), second.getPosition('c'));
});

test('phyllotaxis seeding never coincides two distinct indices', () => {
	const seen = new Set<string>();
	for (let i = 0; i < 200; i += 1) {
		const { x, y } = seedPosition(i);
		const key = `${x.toFixed(6)}|${y.toFixed(6)}`;
		assert.equal(seen.has(key), false, `index ${i} coincided with an earlier seed point`);
		seen.add(key);
	}
});

test('seeding spread scales with node count rather than staying in a fixed small region', () => {
	const boundingRadius = (count: number): number => {
		let max = 0;
		for (let i = 0; i < count; i += 1) {
			const { x, y } = seedPosition(i);
			max = Math.max(max, Math.hypot(x, y));
		}
		return max;
	};
	const small = boundingRadius(20);
	const large = boundingRadius(400);
	assert.ok(large > small * 2, `expected the 400-node spread (${large}) to be well beyond the 20-node spread (${small})`);
});

test('setGraph reports whether the id set actually changed', () => {
	const sim = new ForceSimulation();
	const changedOnFirstSet = sim.setGraph(['a', 'b'], []);
	assert.equal(changedOnFirstSet, true);

	const changedOnSameSet = sim.setGraph(['a', 'b'], []);
	assert.equal(changedOnSameSet, false);

	const changedOnDifferentSet = sim.setGraph(['a', 'c'], []);
	assert.equal(changedOnDifferentSet, true);
});

test('a seed override places a brand-new node exactly there instead of on the spiral', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a'], [], new Map([['a', { x: 123, y: -45 }]]));
	assert.deepEqual(sim.getPosition('a'), { x: 123, y: -45 });
});

test('a node that already existed keeps its position even when a seed override is supplied for it', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a'], []);
	sim.pin('a', 5, 5);
	sim.setGraph(['a'], [], new Map([['a', { x: 999, y: 999 }]]));
	assert.deepEqual(sim.getPosition('a'), { x: 5, y: 5 });
});

test('a ring-constrained node is snapped back onto its exact radius every tick, angle preserved', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['root', 'ring'], [{ source: 'root', target: 'ring' }], new Map([['ring', { x: 100, y: 0 }]]));
	sim.pin('root', 0, 0);
	sim.setRingRadii(new Map([['ring', 100]]));
	sim.reheat(1);

	for (let i = 0; i < 30; i += 1) sim.tick();
	const pos = sim.getPosition('ring') as { x: number; y: number };
	assert.ok(Math.abs(Math.hypot(pos.x, pos.y) - 100) < 1e-6, `expected radius 100, got ${Math.hypot(pos.x, pos.y)}`);
});

test('clearing the ring-radius constraint lets a node settle off its former ring', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a', 'b'], [{ source: 'a', target: 'b' }]);
	sim.setOptions({ linkDistance: 10 });
	sim.setRingRadii(new Map([['b', 500]]));
	sim.reheat(1);
	for (let i = 0; i < 5; i += 1) sim.tick();
	const constrained = sim.getPosition('b') as { x: number; y: number };
	assert.ok(Math.abs(Math.hypot(constrained.x, constrained.y) - 500) < 1e-6);

	sim.setRingRadii(null);
	sim.reheat(1);
	for (let i = 0; i < 200; i += 1) sim.tick();
	const settled = sim.getPosition('b') as { x: number; y: number };
	assert.ok(Math.hypot(settled.x, settled.y) < 400, 'expected the node to move well off the old 500-radius ring once released');
});

test('a hub moves less per tick than the leaves hanging off it', () => {
	// Without degree-normalized link weights the hub takes one full spring
	// impulse per edge and is whipped around by its own neighbourhood, which
	// is the difference between a hairball and a readable star.
	const sim = new ForceSimulation();
	// Links only: repulsion, centring and collision all move a node at the
	// centre of a cloud too, and this is a claim about the link force.
	sim.setOptions({ ...DEFAULT_FORCE_OPTIONS, repulsion: 0, gravity: 0, collisionRadius: 0 });
	const leaves = Array.from({ length: 12 }, (_, i) => `leaf-${i}`);
	sim.setGraph(
		['hub', ...leaves],
		leaves.map((leaf) => ({ source: 'hub', target: leaf })),
	);
	const before = sim.positions();
	sim.reheat(1);
	sim.tick();
	const after = sim.positions();

	const moved = (id: string): number => {
		const a = before.get(id);
		const b = after.get(id);
		return Math.hypot((b?.x ?? 0) - (a?.x ?? 0), (b?.y ?? 0) - (a?.y ?? 0));
	};
	const hubMoved = moved('hub');
	for (const leaf of leaves) {
		assert.ok(hubMoved <= moved(leaf), `hub moved further than ${leaf}`);
	}
});

test('two linked nodes settle at their two radii apart, not at a shared constant', () => {
	const sim = new ForceSimulation();
	sim.setOptions({ ...DEFAULT_FORCE_OPTIONS, gravity: 0 });
	sim.setGraph(['big', 'small'], [{ source: 'big', target: 'small' }]);
	sim.setNodeRadii(new Map([['big', 48], ['small', 12]]));
	sim.reheat(1);
	for (let i = 0; i < 600; i += 1) sim.tick();

	const big = sim.getPosition('big');
	const small = sim.getPosition('small');
	assert.ok(big && small);
	const distance = Math.hypot(big.x - small.x, big.y - small.y);
	const rest = DEFAULT_FORCE_OPTIONS.linkDistance + 48 + 12;
	// Repulsion holds them a little wider than the spring's rest length; what
	// matters is that the rest length grew with the radii rather than staying
	// at the bare link distance.
	assert.ok(distance >= rest * 0.9, `settled at ${distance}, expected near ${rest}`);
});

test('a big node and a small one do not overlap once collision has run', () => {
	const sim = new ForceSimulation();
	sim.setOptions({ ...DEFAULT_FORCE_OPTIONS, gravity: 0, repulsion: 0 });
	sim.setGraph(['big', 'small'], []);
	sim.setNodeRadii(new Map([['big', 48], ['small', 12]]));
	// Drop them almost on top of each other, well inside the bigger radius.
	sim.pin('big', 0, 0);
	sim.pin('small', 5, 0);
	sim.unpin('big');
	sim.unpin('small');
	sim.reheat(1);
	for (let i = 0; i < 60; i += 1) sim.tick();

	const big = sim.getPosition('big');
	const small = sim.getPosition('small');
	assert.ok(big && small);
	const distance = Math.hypot(big.x - small.x, big.y - small.y);
	assert.ok(distance >= 48 + 12 - 1, `settled ${distance} apart, inside the two radii`);
});

test('nodes are centred toward their own component centre, not the origin', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a', 'b'], []);
	sim.setComponentCenters(new Map([
		['a', { x: 1000, y: 0 }],
		['b', { x: -1000, y: 0 }],
	]));
	sim.reheat(1);
	for (let i = 0; i < 400; i += 1) sim.tick();

	const a = sim.getPosition('a');
	const b = sim.getPosition('b');
	assert.ok(a && b);
	assert.ok(a.x > 0, 'a drifted away from its own centre');
	assert.ok(b.x < 0, 'b drifted away from its own centre');
});

test('clearing component centres puts everything back on the origin', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a'], []);
	sim.setComponentCenters(new Map([['a', { x: 900, y: 900 }]]));
	sim.setComponentCenters(null);
	sim.reheat(1);
	for (let i = 0; i < 400; i += 1) sim.tick();

	const a = sim.getPosition('a');
	assert.ok(a);
	assert.ok(Math.hypot(a.x, a.y) < 200, 'node stayed out at the cleared centre');
});

test('a layout shape holds every node inside it, however far out it started', () => {
	for (const shape of ['circle', 'square', 'diamond', 'triangle', 'hexagon'] as const) {
		const geometry = shapeGeometry(shape, 400);
		assert.ok(geometry);
		const sim = new ForceSimulation();
		sim.setShape(geometry);
		const ids = Array.from({ length: 60 }, (_, i) => `n${i}`);
		sim.setGraph(ids, []);
		// Thrown well outside on purpose: the seeding spiral would already be
		// inside, and the claim here is about containment, not about seeding.
		sim.reseedAll(new Map(ids.map((id, i) => [id, {
			x: Math.cos(i) * 4000,
			y: Math.sin(i) * 4000,
		}])));
		sim.reheat(1);
		sim.tick();
		for (const id of ids) {
			const position = sim.getPosition(id);
			assert.ok(position);
			assert.ok(
				shapeSignedDistance(geometry, position.x, position.y).distance <= 1e-6,
				`${shape} left ${id} outside after a tick`,
			);
		}
	}
});

test('containment still holds once the simulation has cooled', () => {
	const geometry = shapeGeometry('circle', 300);
	assert.ok(geometry);
	const sim = new ForceSimulation();
	sim.setShape(geometry);
	const ids = Array.from({ length: 80 }, (_, i) => `n${i}`);
	sim.setGraph(ids, []);
	sim.reheat(1);
	// Well past alphaMin: a containment implemented as an alpha-scaled force
	// would have faded to nothing by here, which is exactly when the graph is
	// being looked at.
	for (let i = 0; i < 600; i += 1) sim.tick();
	assert.equal(sim.isRunning(), false);
	for (const id of ids) {
		const position = sim.getPosition(id);
		assert.ok(position);
		assert.ok(shapeSignedDistance(geometry, position.x, position.y).distance <= 1e-6, `${id} escaped`);
	}
});

test('a shaped layout settles out against its boundary rather than contracting off it', () => {
	// The regression this pins down: with centring left on under a shape, this
	// graph settled at about 40% of the way to the wall, so the boundary never
	// engaged and the silhouette was the old force-equilibrium blob with a
	// different starting arrangement.
	const geometry = shapeGeometry('circle', 500);
	assert.ok(geometry);
	const sim = new ForceSimulation();
	sim.setShape(geometry);
	const ids = Array.from({ length: 120 }, (_, i) => `n${i}`);
	sim.setGraph(ids, []);
	sim.reheat(1);
	for (let i = 0; i < 400; i += 1) sim.tick();

	let furthest = 0;
	let sumFill = 0;
	for (const id of ids) {
		const position = sim.getPosition(id);
		assert.ok(position);
		furthest = Math.max(furthest, Math.hypot(position.x, position.y));
		sumFill += Math.hypot(position.x, position.y) / boundaryDistanceAt(geometry, Math.atan2(position.y, position.x));
	}
	assert.ok(furthest > 500 * 0.85, `the graph only reached ${furthest.toFixed(0)} of a 500 radius`);
	// Mean distance from the centre as a fraction of the boundary. Uniform by
	// area would be two thirds; clusters pulling their own members inward puts
	// a real graph below that, but well clear of the 0.4 the contracted layout
	// managed.
	assert.ok(sumFill / ids.length > 0.45, `mean fill was only ${(sumFill / ids.length).toFixed(2)}`);
});

test('centring still bounds a layout that has no shape', () => {
	// The other half of the same claim: dropping centring is a thing a shape
	// does, not a thing that happened to the simulation generally.
	const sim = new ForceSimulation();
	const ids = Array.from({ length: 120 }, (_, i) => `n${i}`);
	sim.setGraph(ids, []);
	sim.reheat(1);
	for (let i = 0; i < 400; i += 1) sim.tick();
	let furthest = 0;
	for (const id of ids) {
		const position = sim.getPosition(id);
		assert.ok(position);
		furthest = Math.max(furthest, Math.hypot(position.x, position.y));
	}
	assert.ok(Number.isFinite(furthest) && furthest > 0);
});

test('clearing the shape lets a node leave the region it used to be held in', () => {
	const geometry = shapeGeometry('circle', 200);
	assert.ok(geometry);
	const sim = new ForceSimulation();
	sim.setShape(geometry);
	sim.setGraph(['a', 'b'], []);
	sim.reseedAll(new Map([['a', { x: 900, y: 0 }], ['b', { x: -900, y: 0 }]]));
	sim.reheat(1);
	sim.tick();
	const held = sim.getPosition('a');
	assert.ok(held);
	assert.ok(Math.hypot(held.x, held.y) <= 200 + 1e-6);

	sim.setShape(null);
	sim.reseedAll(new Map([['a', { x: 900, y: 0 }]]));
	sim.reheat(1);
	sim.tick();
	const free = sim.getPosition('a');
	assert.ok(free);
	assert.ok(Math.hypot(free.x, free.y) > 200);
});

test('reseedAll moves every unpinned node and leaves a pinned one where the user put it', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a', 'b'], []);
	sim.pin('b', 17, 23);
	sim.reseedAll(new Map([['a', { x: 100, y: -50 }], ['b', { x: -900, y: -900 }]]));
	assert.deepEqual(sim.getPosition('a'), { x: 100, y: -50 });
	assert.deepEqual(sim.getPosition('b'), { x: 17, y: 23 });
});

test('reseedAll ignores ids the simulation does not hold and leaves the rest alone', () => {
	const sim = new ForceSimulation();
	sim.setGraph(['a'], []);
	const before = sim.getPosition('a');
	sim.reseedAll(new Map([['ghost', { x: 1, y: 2 }]]));
	assert.deepEqual(sim.getPosition('a'), before);
});

/** Share of nodes falling in each quarter of a shape's area, inner to outer.
 * Even by area is a quarter each, which is what "the graph fills the shape"
 * means when said precisely. */
function areaQuartiles(sim: ForceSimulation, ids: string[], geometry: ReturnType<typeof shapeGeometry>): number[] {
	assert.ok(geometry);
	const rings = [0, 0, 0, 0];
	for (const id of ids) {
		const position = sim.getPosition(id);
		assert.ok(position);
		const reach = boundaryDistanceAt(geometry, Math.atan2(position.y, position.x));
		const fraction = Math.min(0.999, Math.hypot(position.x, position.y) / reach);
		rings[Math.min(3, Math.floor(fraction * fraction * 4))] += 1;
	}
	return rings.map((count) => count / ids.length);
}

test('a clustered graph still fills its shape evenly by area', () => {
	// Hubs with leaves, which is what a real base is and what the plain force
	// layout cannot spread: measured without this, a graph like it put 41% of
	// its nodes in the innermost quarter of the area and 4% in the outermost.
	const geometry = shapeGeometry('circle', 900);
	assert.ok(geometry);
	const ids: string[] = [];
	const links: { source: string; target: string }[] = [];
	for (let h = 0; h < 6; h += 1) {
		ids.push(`hub${h}`);
		for (let l = 0; l < 30; l += 1) {
			ids.push(`h${h}l${l}`);
			links.push({ source: `h${h}l${l}`, target: `hub${h}` });
		}
	}
	const sim = new ForceSimulation();
	sim.setShape(geometry);
	sim.setGraph(ids, links);
	sim.reheat(1);
	for (let i = 0; i < 400; i += 1) sim.tick();

	for (const [index, share] of areaQuartiles(sim, ids, geometry).entries()) {
		assert.ok(Math.abs(share - 0.25) < 0.06, `quarter ${index + 1} holds ${(share * 100).toFixed(0)}% of the nodes`);
	}
});

test('the fill pass leaves a node angle alone and only moves it along its own ray', () => {
	const geometry = shapeGeometry('circle', 400);
	assert.ok(geometry);
	const sim = new ForceSimulation();
	sim.setShape(geometry);
	const ids = ['a', 'b', 'c', 'd'];
	sim.setGraph(ids, []);
	const before = new Map(ids.map((id) => {
		const position = sim.getPosition(id);
		assert.ok(position);
		return [id, Math.atan2(position.y, position.x)];
	}));
	sim.reheat(1);
	sim.tick();
	for (const id of ids) {
		const position = sim.getPosition(id);
		assert.ok(position);
		// Repulsion and collision move a node off its ray too, so this is not
		// an exact-angle assertion; it is that the fill pass is not the thing
		// swinging nodes around the shape.
		const drift = Math.abs(Math.atan2(position.y, position.x) - (before.get(id) as number));
		assert.ok(drift < Math.PI / 2, `${id} swung ${drift.toFixed(2)} radians`);
	}
});

test('a pinned node is left where the user dropped it, fill pass included', () => {
	const geometry = shapeGeometry('circle', 400);
	assert.ok(geometry);
	const sim = new ForceSimulation();
	sim.setShape(geometry);
	sim.setGraph(Array.from({ length: 30 }, (_, i) => `n${i}`), []);
	sim.pin('n7', 12, 34);
	sim.reheat(1);
	for (let i = 0; i < 50; i += 1) sim.tick();
	assert.deepEqual(sim.getPosition('n7'), { x: 12, y: 34 });
});

test('nothing fills anything when there is no shape', () => {
	// The fill pass is a thing a shape does. Without one the layout is the
	// force layout it always was, bounded by centring.
	const sim = new ForceSimulation();
	const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
	sim.setGraph(ids, []);
	sim.reheat(1);
	for (let i = 0; i < 200; i += 1) sim.tick();
	const geometry = shapeGeometry('circle', 900);
	const quartiles = areaQuartiles(sim, ids, geometry);
	// Not a claim about where it lands, only that it is not the even spread
	// the fill pass produces.
	assert.ok(quartiles.some((share) => Math.abs(share - 0.25) > 0.06));
});
