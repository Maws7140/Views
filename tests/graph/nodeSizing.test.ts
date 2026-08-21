import assert from 'node:assert/strict';
import test from 'node:test';
import { degreeScale, DEGREE_SCALE_CEILING, DEGREE_SCALE_FLOOR } from '../../src/graph/nodeSizing';

test('a degree-zero node scales to the floor', () => {
	assert.equal(degreeScale(0), DEGREE_SCALE_FLOOR);
});

test('a negative or non-finite degree is treated the same as zero', () => {
	assert.equal(degreeScale(-3), DEGREE_SCALE_FLOOR);
	assert.equal(degreeScale(Number.NaN), DEGREE_SCALE_FLOOR);
});

test('scale grows monotonically with degree up to the ceiling', () => {
	const low = degreeScale(1);
	const mid = degreeScale(9);
	const high = degreeScale(36);
	assert.ok(low > DEGREE_SCALE_FLOOR);
	assert.ok(mid > low);
	assert.ok(high > mid);
});

test('a single dominant hub is capped at the ceiling, not left to grow without bound', () => {
	const hub = degreeScale(10000);
	assert.equal(hub, DEGREE_SCALE_CEILING);
	// sqrt-growth means even a very large but not extreme degree is already
	// near the ceiling, which is the point: one hub cannot dwarf everything.
	const stillCapped = degreeScale(2000);
	assert.equal(stillCapped, DEGREE_SCALE_CEILING);
});

test('growth follows the square root of degree, not degree itself', () => {
	// Quadrupling degree should add exactly twice the growth term, since
	// sqrt(4x) = 2*sqrt(x); checked well below the ceiling so the cap never
	// interferes with the comparison.
	const base = degreeScale(4) - DEGREE_SCALE_FLOOR;
	const quadrupled = degreeScale(16) - DEGREE_SCALE_FLOOR;
	assert.ok(Math.abs(quadrupled / base - 2) < 1e-9);
});
