import assert from 'node:assert/strict';
import test from 'node:test';
import { ForceSimulation } from '../../src/graph/forceLayout';

/**
 * What shipped: a fixed centring coefficient pulls each node toward the
 * origin with a spring whose strength grows linearly with distance, but
 * repulsion between a growing, disconnected cloud of nodes grows with the
 * cloud's own node count (each node fights off more neighbours within its
 * cutoff as the cloud gets denser and its own footprint grows to match).
 * With a fixed coefficient the point where the two balance drifts outward as
 * the graph gets bigger, so a large disconnected base opened up far more
 * loosely than a small one at the same settings. The fix scales the
 * centring coefficient by `sqrt(nodeCount)` in `ForceSimulation.tick()`, and
 * this test is the one named in the plan: bounded at both N=50 and N=500,
 * not scaling with N.
 */

function settledRadius(nodeCount: number, maxTicks = 400): number {
	const sim = new ForceSimulation();
	const ids = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
	sim.setGraph(ids, []);
	sim.reheat(1);
	for (let i = 0; i < maxTicks && sim.isRunning(); i += 1) sim.tick();

	let maxRadius = 0;
	for (const position of sim.positions().values()) {
		const radius = Math.hypot(position.x, position.y);
		if (radius > maxRadius) maxRadius = radius;
	}
	return maxRadius;
}

test('a disconnected cloud settles within a bounded radius at N=50 and N=500', () => {
	const radius50 = settledRadius(50);
	const radius500 = settledRadius(500);

	assert.ok(Number.isFinite(radius50) && radius50 > 0, 'a 50-node cloud must spread out at all');
	assert.ok(Number.isFinite(radius500) && radius500 > 0, 'a 500-node cloud must spread out at all');

	// Neither radius may run away. This is generous headroom over what the
	// current defaults actually produce (a few hundred world units), not a
	// tight bound on the exact number.
	assert.ok(radius50 < 5000, `N=50 equilibrium radius ${radius50} is unbounded`);
	assert.ok(radius500 < 5000, `N=500 equilibrium radius ${radius500} is unbounded`);

	// The point of the fix: a 10x larger disconnected cloud may spread wider
	// (sqrt(10) is the deliberate, accepted growth), but nothing close to a
	// linear 10x. A linear scaling regression would put this ratio near 10;
	// bounded growth keeps it well under that.
	const ratio = radius500 / radius50;
	assert.ok(ratio < 6, `equilibrium radius grew ${ratio}x from N=50 to N=500, expected roughly sqrt(N) growth`);
});
