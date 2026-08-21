import assert from 'node:assert/strict';
import test from 'node:test';
import {
	LAYOUT_SHAPE_LABELS,
	boundaryDistanceAt,
	isLayoutShape,
	projectInside,
	shapeArea,
	shapeFillOrder,
	shapeFillPosition,
	shapeGeometry,
	shapeSignedDistance,
	shapeSizeForNodes,
	type LayoutShape,
} from '../../src/graph/layoutShapes';

const POLYGONS: LayoutShape[] = ['square', 'diamond', 'triangle', 'hexagon'];
const BOUNDED: LayoutShape[] = ['circle', ...POLYGONS];

test('free is the one shape with no geometry, so callers branch on null', () => {
	assert.equal(shapeGeometry('free', 400), null);
	for (const shape of BOUNDED) {
		assert.notEqual(shapeGeometry(shape, 400), null);
	}
});

test('isLayoutShape rejects anything that is not a stored shape value', () => {
	for (const shape of Object.keys(LAYOUT_SHAPE_LABELS)) assert.equal(isLayoutShape(shape), true);
	assert.equal(isLayoutShape('octagon'), false);
	assert.equal(isLayoutShape(undefined), false);
	assert.equal(isLayoutShape(3), false);
});

test('the origin is inside every shape, by the full inradius', () => {
	for (const shape of BOUNDED) {
		const geometry = shapeGeometry(shape, 300);
		assert.ok(geometry);
		const inside = shapeSignedDistance(geometry, 0, 0);
		assert.ok(inside.distance < 0, `${shape} reported the origin outside itself`);
		// The inradius is the centre-to-boundary distance at its closest, so
		// the origin is exactly that far in whichever shape this is.
		assert.ok(Math.abs(inside.distance + 300) < 1e-9, `${shape} inradius is not 300`);
	}
});

test('a point far outside is reported outside, whichever direction it is out in', () => {
	for (const shape of BOUNDED) {
		const geometry = shapeGeometry(shape, 100);
		assert.ok(geometry);
		for (let i = 0; i < 16; i += 1) {
			const angle = (i / 16) * Math.PI * 2;
			const far = shapeSignedDistance(geometry, Math.cos(angle) * 5000, Math.sin(angle) * 5000);
			assert.ok(far.distance > 0, `${shape} reported a distant point inside`);
		}
	}
});

test('projecting a point outside lands it inside, corners included', () => {
	for (const shape of BOUNDED) {
		const geometry = shapeGeometry(shape, 100);
		assert.ok(geometry);
		for (let i = 0; i < 16; i += 1) {
			// A ring of points well outside, so every one of them is out past
			// a corner as often as it is out past an edge.
			const angle = (i / 16) * Math.PI * 2;
			const inside = projectInside(geometry, Math.cos(angle) * 5000, Math.sin(angle) * 5000);
			assert.ok(
				shapeSignedDistance(geometry, inside.x, inside.y).distance <= 1e-6,
				`${shape} projection at ${angle} landed outside`,
			);
		}
	}
});

test('projecting respects a margin, so a node sits inside by its own radius', () => {
	for (const shape of BOUNDED) {
		const geometry = shapeGeometry(shape, 300);
		assert.ok(geometry);
		const inside = projectInside(geometry, 900, 400, 40);
		assert.ok(shapeSignedDistance(geometry, inside.x, inside.y).distance <= -40 + 1e-6, `${shape} ignored the margin`);
	}
});

test('projecting a point already inside leaves it exactly where it is', () => {
	for (const shape of BOUNDED) {
		const geometry = shapeGeometry(shape, 300);
		assert.ok(geometry);
		assert.deepEqual(projectInside(geometry, 10, -20), { x: 10, y: -20 });
	}
});

test('the boundary distance along an angle is the point where inside turns to outside', () => {
	for (const shape of BOUNDED) {
		const geometry = shapeGeometry(shape, 250);
		assert.ok(geometry);
		for (let i = 0; i < 24; i += 1) {
			const angle = (i / 24) * Math.PI * 2;
			const reach = boundaryDistanceAt(geometry, angle);
			const justInside = shapeSignedDistance(geometry, Math.cos(angle) * reach * 0.99, Math.sin(angle) * reach * 0.99);
			const justOutside = shapeSignedDistance(geometry, Math.cos(angle) * reach * 1.01, Math.sin(angle) * reach * 1.01);
			assert.ok(justInside.distance < 0, `${shape} at ${angle} was outside just inside the boundary`);
			assert.ok(justOutside.distance > 0, `${shape} at ${angle} was inside just outside the boundary`);
		}
	}
});

test('a corner reaches further than an edge, which is what makes a shape a shape', () => {
	const square = shapeGeometry('square', 100);
	assert.ok(square);
	// Along +x is straight at an edge; 45 degrees is straight at a corner.
	assert.ok(Math.abs(boundaryDistanceAt(square, 0) - 100) < 1e-9);
	assert.ok(Math.abs(boundaryDistanceAt(square, Math.PI / 4) - 100 * Math.SQRT2) < 1e-6);

	const circle = shapeGeometry('circle', 100);
	assert.ok(circle);
	// A circle has no corners, so every direction reaches the same distance.
	assert.ok(Math.abs(boundaryDistanceAt(circle, Math.PI / 4) - 100) < 1e-9);
});

test('every fill point lands inside its own shape', () => {
	for (const shape of BOUNDED) {
		const geometry = shapeGeometry(shape, 400);
		assert.ok(geometry);
		for (let i = 0; i < 300; i += 1) {
			const point = shapeFillPosition(geometry, i, 300);
			assert.ok(
				shapeSignedDistance(geometry, point.x, point.y).distance < 0,
				`${shape} fill point ${i} landed outside`,
			);
		}
	}
});

test('the fill reaches the corners of a square rather than staying a disc in it', () => {
	const geometry = shapeGeometry('square', 400);
	assert.ok(geometry);
	let furthest = 0;
	for (let i = 0; i < 500; i += 1) {
		const point = shapeFillPosition(geometry, i, 500);
		furthest = Math.max(furthest, Math.hypot(point.x, point.y));
	}
	// A disc-shaped fill could never exceed the inradius; reaching well past
	// it is the whole point of scaling each point to the boundary along its
	// own angle.
	assert.ok(furthest > 400 * 1.2, `fill only reached ${furthest}`);
});

test('the fill spreads out from the centre rather than piling on it', () => {
	const geometry = shapeGeometry('circle', 400);
	assert.ok(geometry);
	const points = Array.from({ length: 200 }, (_, i) => shapeFillPosition(geometry, i, 200));
	const outer = points.filter((point) => Math.hypot(point.x, point.y) > 200).length;
	// Even by area, three quarters of a disc lies outside half its radius, so
	// a fill that spreads by area puts most of its points there.
	assert.ok(outer > 120, `only ${outer} of 200 points landed in the outer half`);
	for (const point of points) {
		assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
	}
});

test('filling is deterministic, so a base does not rearrange itself between opens', () => {
	const geometry = shapeGeometry('hexagon', 333);
	assert.ok(geometry);
	for (let i = 0; i < 50; i += 1) {
		assert.deepEqual(shapeFillPosition(geometry, i, 50), shapeFillPosition(geometry, i, 50));
	}
});

test('shapes of the same size cover the area their own formula says', () => {
	// A polygon's area against its inradius, checked by comparison with the
	// inscribed and circumscribed circles it must fall between.
	for (const shape of POLYGONS) {
		const area = shapeArea(shape, 100);
		const circumradius = boundaryDistanceAt(shapeGeometry(shape, 100)!, Math.PI / 4 + 0.123) ;
		assert.ok(area > Math.PI * 100 * 100, `${shape} came out smaller than its inscribed circle`);
		assert.ok(area < Math.PI * circumradius * circumradius * 4, `${shape} came out implausibly large`);
	}
});

test('a shape is sized so density holds as the node count grows', () => {
	for (const shape of BOUNDED) {
		const small = shapeSizeForNodes(shape as Exclude<LayoutShape, 'free'>, 50, 22);
		const large = shapeSizeForNodes(shape as Exclude<LayoutShape, 'free'>, 200, 22);
		// Four times the nodes needs four times the area, which is twice the
		// size, not four times it.
		assert.ok(Math.abs(large / small - 2) < 1e-6, `${shape} scaled by ${large / small}`);
		const density = (50 * Math.PI * 22 * 22) / shapeArea(shape as Exclude<LayoutShape, 'free'>, small);
		assert.ok(density > 0.1 && density < 0.4, `${shape} packed at ${density}`);
	}
});

test('every shape holds the same number of nodes at the same density', () => {
	const areas = BOUNDED.map((shape) => shapeArea(
		shape as Exclude<LayoutShape, 'free'>,
		shapeSizeForNodes(shape as Exclude<LayoutShape, 'free'>, 120, 22),
	));
	for (const area of areas) {
		assert.ok(Math.abs(area / areas[0] - 1) < 1e-6, 'shapes disagree on the area 120 nodes need');
	}
});

test('a degenerate size still produces a usable shape rather than a point', () => {
	for (const shape of BOUNDED) {
		const geometry = shapeGeometry(shape, 0);
		assert.ok(geometry);
		assert.ok(geometry.size > 0);
		assert.ok(shapeSignedDistance(geometry, 0, 0).distance < 0);
	}
});

test('the spacing scale spreads the same nodes over a larger shape', () => {
	const tight = shapeSizeForNodes('circle', 100, 22);
	const airy = shapeSizeForNodes('circle', 100, 22, 2);
	// Twice the spacing is twice the size, so four times the area for the same
	// node count: this is the Link distance slider's grip on a shaped layout.
	assert.ok(Math.abs(airy / tight - 2) < 1e-6, `scaled by ${airy / tight}`);
	assert.equal(shapeSizeForNodes('circle', 100, 22, 1), tight);
	// A nonsense scale is floored rather than collapsing the shape to a point.
	assert.ok(shapeSizeForNodes('circle', 100, 22, 0) > 0);
});

test('the fill order hands out neighbouring points consecutively', () => {
	const geometry = shapeGeometry('circle', 600);
	assert.ok(geometry);
	const ordered = shapeFillOrder(geometry, 60);
	assert.equal(ordered.length, 60);
	// Every point of the raw fill is still present, just visited in a
	// different order.
	const raw = Array.from({ length: 60 }, (_, i) => shapeFillPosition(geometry, i, 60));
	const key = (p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
	assert.deepEqual(new Set(ordered.map(key)), new Set(raw.map(key)));

	// The claim itself: consecutive points of the raw phyllotaxis are a golden
	// angle apart, and consecutive points of this order are neighbours.
	const gap = (points: { x: number; y: number }[]) => {
		let total = 0;
		for (let i = 1; i < points.length; i += 1) {
			total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
		}
		return total / (points.length - 1);
	};
	assert.ok(gap(ordered) < gap(raw) / 2, `ordered ${gap(ordered).toFixed(0)} vs raw ${gap(raw).toFixed(0)}`);
});
