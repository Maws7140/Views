import assert from 'node:assert/strict';
import test from 'node:test';
import { floorToPeriodStart, BasicDateScale } from '../../src/logic/dateScale';

function localTs(year: number, month: number, day: number, hour = 0, minute = 0): number {
	return new Date(year, month - 1, day, hour, minute).getTime();
}

test('floorToPeriodStart at day/week level clears the time of day', () => {
	const ts = localTs(2026, 5, 13, 14, 37);
	assert.equal(floorToPeriodStart(ts, 'day'), localTs(2026, 5, 13, 0, 0));
	assert.equal(floorToPeriodStart(ts, 'week'), localTs(2026, 5, 13, 0, 0));
});

test('floorToPeriodStart at month/quarter level lands on the 1st of the month', () => {
	const ts = localTs(2026, 5, 13, 14, 37);
	assert.equal(floorToPeriodStart(ts, 'month'), localTs(2026, 5, 1, 0, 0));
	assert.equal(floorToPeriodStart(ts, 'quarter'), localTs(2026, 5, 1, 0, 0));
});

test('floorToPeriodStart at year level lands on January 1st', () => {
	const ts = localTs(2026, 5, 13, 14, 37);
	assert.equal(floorToPeriodStart(ts, 'year'), localTs(2026, 1, 1, 0, 0));
});

test('toX and fromX are inverses of each other', () => {
	const scale = new BasicDateScale(localTs(2026, 1, 1));
	scale.setPxPerDay(50);
	const ts = localTs(2026, 3, 15);
	const px = scale.toX(ts);
	assert.equal(Math.round(scale.fromX(px)), ts);
});

test('setPxPerDay clamps to the min/max bounds and updates the tick level accordingly', () => {
	const scale = new BasicDateScale(localTs(2026, 1, 1));
	scale.setPxPerDay(10000);
	assert.equal(scale.pxPerDay, 480);
	scale.setPxPerDay(-5);
	assert.equal(scale.pxPerDay, 2);
});

test('getTickLevel reflects the live pxPerDay, not a snapped preset', () => {
	const scale = new BasicDateScale(localTs(2026, 1, 1));
	scale.setPxPerDay(200);
	assert.equal(scale.getTickLevel(), 'day');
	scale.setPxPerDay(60);
	assert.equal(scale.getTickLevel(), 'week');
	scale.setPxPerDay(20);
	assert.equal(scale.getTickLevel(), 'month');
	scale.setPxPerDay(8);
	assert.equal(scale.getTickLevel(), 'quarter');
	scale.setPxPerDay(3);
	assert.equal(scale.getTickLevel(), 'year');
});

test('canZoom reports false only once the corresponding bound is reached', () => {
	const scale = new BasicDateScale(localTs(2026, 1, 1));
	scale.setPxPerDay(480);
	assert.equal(scale.canZoom(1), false);
	assert.equal(scale.canZoom(-1), true);
	scale.setPxPerDay(2);
	assert.equal(scale.canZoom(-1), false);
	assert.equal(scale.canZoom(1), true);
});

test('fitTo spans the item range with leading padding and clamps pxPerDay to the viewport', () => {
	const scale = new BasicDateScale(localTs(2020, 1, 1));
	scale.fitTo(
		[
			{ id: 'a', title: 'A', startTs: localTs(2026, 1, 1) },
			{ id: 'b', title: 'B', startTs: localTs(2026, 1, 1), endTs: localTs(2026, 2, 1) },
		],
		800,
	);
	assert.ok(scale.startTs < localTs(2026, 1, 1), 'fitTo must pad before the earliest item');
	assert.ok(scale.pxPerDay >= 2 && scale.pxPerDay <= 480);
});

test('fitTo with no dated items leaves the scale unchanged', () => {
	const scale = new BasicDateScale(localTs(2020, 1, 1));
	const beforeStart = scale.startTs;
	const beforePxPerDay = scale.pxPerDay;
	scale.fitTo([{ id: 'a', title: 'A' }], 800);
	assert.equal(scale.startTs, beforeStart);
	assert.equal(scale.pxPerDay, beforePxPerDay);
});
