import assert from 'node:assert/strict';
import test from 'node:test';
import {
	boundsOf,
	clampScale,
	fitTransform,
	padBounds,
	screenToWorld,
	worldToScreen,
	zoomAbout,
	type ViewTransform,
} from '../../src/canvas/viewportMath';

const limits = { min: 0.05, max: 6 };
const identity: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };

test('the world origin sits at the centre of the viewport with no offset', () => {
	assert.deepEqual(worldToScreen({ x: 0, y: 0 }, identity, 800, 600), { x: 400, y: 300 });
});

test('screenToWorld inverts worldToScreen at any transform', () => {
	const transform: ViewTransform = { scale: 2.5, offsetX: -130, offsetY: 44 };
	const world = { x: 37, y: -18 };
	const screen = worldToScreen(world, transform, 800, 600);
	const back = screenToWorld(screen, transform, 800, 600);
	assert.ok(Math.abs(back.x - world.x) < 1e-9);
	assert.ok(Math.abs(back.y - world.y) < 1e-9);
});

test('a zoom keeps the world point under the cursor under the cursor', () => {
	// The whole feel of a wheel zoom is this one property. Anchored away from
	// the centre, because anchoring at the centre passes trivially.
	const anchor = { x: 640, y: 120 };
	const before = screenToWorld(anchor, identity, 800, 600);
	const zoomed = zoomAbout(identity, anchor, 1.8, limits, 800, 600);
	const after = screenToWorld(anchor, zoomed, 800, 600);
	assert.ok(Math.abs(after.x - before.x) < 1e-9);
	assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('a zoom that would exceed the ceiling still holds the anchor', () => {
	const anchor = { x: 700, y: 500 };
	const before = screenToWorld(anchor, identity, 800, 600);
	const zoomed = zoomAbout(identity, anchor, 1000, limits, 800, 600);
	assert.equal(zoomed.scale, limits.max);
	const after = screenToWorld(anchor, zoomed, 800, 600);
	assert.ok(Math.abs(after.x - before.x) < 1e-9);
	assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('clampScale holds the limits and rejects a non-finite scale', () => {
	assert.equal(clampScale(100, limits), 6);
	assert.equal(clampScale(0.0001, limits), 0.05);
	assert.equal(clampScale(Number.NaN, limits), 0.05);
});

test('a fit centres the content it was given', () => {
	const bounds = { minX: 100, minY: 40, maxX: 300, maxY: 240 };
	const transform = fitTransform(bounds, 800, 600, 0, limits) as ViewTransform;
	const center = worldToScreen({ x: 200, y: 140 }, transform, 800, 600);
	assert.ok(Math.abs(center.x - 400) < 1e-9);
	assert.ok(Math.abs(center.y - 300) < 1e-9);
});

test('a fit leaves the whole content on screen', () => {
	const bounds = { minX: -500, minY: -50, maxX: 500, maxY: 50 };
	const transform = fitTransform(bounds, 800, 600, 20, limits) as ViewTransform;
	const left = worldToScreen({ x: bounds.minX, y: bounds.minY }, transform, 800, 600);
	const right = worldToScreen({ x: bounds.maxX, y: bounds.maxY }, transform, 800, 600);
	assert.ok(left.x >= 0 && left.y >= 0, `top left off screen: ${JSON.stringify(left)}`);
	assert.ok(right.x <= 800 && right.y <= 600, `bottom right off screen: ${JSON.stringify(right)}`);
});

test('empty bounds fit to nothing rather than to infinity', () => {
	// An empty model produces exactly this box, and the caller must leave the
	// view where the user put it rather than be handed a transform derived
	// from infinities.
	assert.equal(fitTransform(boundsOf([]), 800, 600, 20, limits), null);
});

test('a single point fits without dividing by a zero extent', () => {
	const transform = fitTransform(boundsOf([{ x: 12, y: -4 }]), 800, 600, 10, limits);
	assert.notEqual(transform, null);
	assert.ok(Number.isFinite((transform as ViewTransform).scale));
	assert.ok((transform as ViewTransform).scale > 0);
});

test('boundsOf spans every point given', () => {
	assert.deepEqual(
		boundsOf([{ x: 1, y: 9 }, { x: -4, y: 2 }, { x: 3, y: 7 }]),
		{ minX: -4, minY: 2, maxX: 3, maxY: 9 },
	);
});

test('padding grows the box by a node half-extent on each side', () => {
	assert.deepEqual(
		padBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 84, 17),
		{ minX: -84, minY: -17, maxX: 94, maxY: 27 },
	);
});

test('padding an empty box leaves it empty', () => {
	// Otherwise the infinities become NaN and fitTransform stops recognising
	// "nothing to frame".
	const padded = padBounds(boundsOf([]), 84, 17);
	assert.equal(fitTransform(padded, 800, 600, 0, limits), null);
});
