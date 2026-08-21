import assert from 'node:assert/strict';
import test from 'node:test';
import { ForceSimulation } from '../../src/graph/forceLayout';

/**
 * What shipped: `Quadtree.insert` folds two bodies at exactly the same
 * coordinates into one bodyless aggregate leaf (see the comment on
 * `MAX_DEPTH` in src/graph/forceLayout.ts) rather than subdividing forever.
 * That is correct for repulsion, but `resolveCollisions`' hit test
 * (`queryBox`) can never report either original id back out of a bodyless
 * leaf, so two nodes seeded or dragged onto the same point stayed stuck at
 * zero distance forever: collision could never separate them. The fix is
 * `ForceSimulation.separateExactDuplicates`, run before the tree is built
 * each collision pass.
 */

test('two nodes pinned onto the exact same point separate once one is released', () => {
	const sim = new ForceSimulation();
	sim.setOptions({ collisionRadius: 22 });
	sim.setGraph(['a', 'b'], []);

	// Force exact coincidence: pin both to the origin, then release one so the
	// simulation is free to move it apart.
	sim.pin('a', 0, 0);
	sim.pin('b', 0, 0);
	sim.unpin('b');

	sim.reheat(1);
	sim.tick();

	const a = sim.getPosition('a');
	const b = sim.getPosition('b');
	assert.ok(a && b);
	const distance = Math.hypot((a as { x: number }).x - (b as { x: number }).x, (a as { y: number }).y - (b as { y: number }).y);
	assert.ok(distance > 0, 'coincident nodes must not stay stuck at zero distance after a tick');
});

test('two unpinned nodes started at the exact same point keep separating over several ticks', () => {
	const sim = new ForceSimulation();
	sim.setOptions({ collisionRadius: 22 });
	sim.setGraph(['a', 'b'], []);
	sim.pin('a', 5, 5);
	sim.pin('b', 5, 5);
	sim.unpin('a');
	sim.unpin('b');

	sim.reheat(1);
	let distance = 0;
	for (let i = 0; i < 10; i += 1) {
		sim.tick();
		const a = sim.getPosition('a') as { x: number; y: number };
		const b = sim.getPosition('b') as { x: number; y: number };
		distance = Math.hypot(a.x - b.x, a.y - b.y);
	}
	// collisionRadius is 22, so fully resolved overlap puts them >= 44 apart;
	// several ticks is enough to clear most of that even with velocity decay.
	assert.ok(distance > 10, `expected coincident nodes to have separated meaningfully, got ${distance}`);
});
