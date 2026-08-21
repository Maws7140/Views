import assert from 'node:assert/strict';
import test from 'node:test';
import { virtualizeItems } from '../../src/logic/virtualize';
import type { DateScale } from '../../src/logic/dateScale';
import type { TimelineItem } from '../../src/types';

/** A trivial 1:1 date-to-pixel scale, so item positions in these tests are
 * just their startTs/endTs values directly. */
function unitScale(): DateScale {
	return {
		pxPerDay: 1,
		startTs: 0,
		toX: (ts) => ts,
		fromX: (px) => px,
		setZoom: () => {},
		setPxPerDay: () => {},
		canZoom: () => true,
		getTickLevel: () => 'day',
		fitTo: () => {},
	};
}

function item(id: string, startTs?: number, endTs?: number): TimelineItem {
	return { id, title: id, startTs, endTs };
}

test('virtualizeItems keeps items overlapping the viewport plus its buffer', () => {
	const items = [item('inside', 100, 110), item('outside', 10000, 10010)];
	const visible = virtualizeItems(items, unitScale(), 0, 1000);
	assert.deepEqual(visible.map((i) => i.id), ['inside']);
});

test('virtualizeItems includes an item just inside the half-viewport-width buffer', () => {
	// scrollLeft=1000, viewportWidth=1000: window is [500, 2500). An item
	// ending exactly at the window start still counts as overlapping.
	const items = [item('at-edge', 400, 500)];
	const visible = virtualizeItems(items, unitScale(), 1000, 1000);
	assert.equal(visible.length, 1);
});

test('virtualizeItems excludes an item with no start date at all', () => {
	const items = [item('no-date')];
	const visible = virtualizeItems(items, unitScale(), 0, 1000);
	assert.equal(visible.length, 0);
});

test('virtualizeItems treats a start-only item as a zero-width span at its start', () => {
	const items = [item('point', 500)];
	const visible = virtualizeItems(items, unitScale(), 0, 1000);
	assert.equal(visible.length, 1);
});

test('virtualizeItems on an empty item list returns an empty list', () => {
	assert.deepEqual(virtualizeItems([], unitScale(), 0, 1000), []);
});
