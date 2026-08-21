import assert from 'node:assert/strict';
import test from 'node:test';
import {
	bucketSamples,
	buildMonth,
	detectKind,
	monthKey,
	numberRange,
	parseMonthKey,
	rampColor,
	shiftMonth,
	startOfWeek,
	weekNumber,
	type CalendarSample,
	type MarkerOptions,
} from '../../src/logic/calendarGrid';

function localTs(year: number, month: number, day: number): number {
	return new Date(year, month - 1, day).getTime();
}

const noColorOptions: MarkerOptions = { colors: null, scope: 'status', rampColors: ['#111', '#222', '#333'], maxMarkers: 8 };

test('monthKey/parseMonthKey round-trip, and parseMonthKey rejects a bad month', () => {
	assert.equal(monthKey(2026, 4), '2026-05');
	assert.deepEqual(parseMonthKey('2026-05'), { year: 2026, month: 4 });
	assert.equal(parseMonthKey('2026-13'), null);
	assert.equal(parseMonthKey(42), null);
});

test('shiftMonth rolls over a year boundary in both directions', () => {
	assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
	assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
});

test('startOfWeek respects the configured week start', () => {
	const wednesday = localTs(2026, 5, 13);
	assert.equal(startOfWeek(wednesday, 'sunday'), localTs(2026, 5, 10));
	assert.equal(startOfWeek(wednesday, 'monday'), localTs(2026, 5, 11));
});

test('weekNumber counts from the week holding January 1st, per the user\'s week start', () => {
	assert.equal(weekNumber(localTs(2026, 1, 1), 'sunday'), 1);
	assert.equal(weekNumber(localTs(2026, 1, 8), 'sunday'), 2);
});

test('bucketSamples folds by local day, preserving entry order within a day', () => {
	const samples: CalendarSample[] = [
		{ ts: localTs(2026, 5, 1), path: 'a.md', title: 'A', readings: [] },
		{ ts: localTs(2026, 5, 1), path: 'b.md', title: 'B', readings: [] },
	];
	const buckets = bucketSamples(samples);
	assert.equal(buckets.get('2026-05-01')?.length, 2);
	assert.equal(buckets.get('2026-05-01')?.[0].path, 'a.md');
});

test('detectKind requires every reading to agree before claiming a specialised kind', () => {
	const boolOnly: CalendarSample[] = [{ ts: 0, path: 'a', title: 'A', readings: [{ seed: 'true', label: 'true', number: null, boolean: true }] }];
	assert.equal(detectKind(boolOnly), 'boolean');

	const numberOnly: CalendarSample[] = [{ ts: 0, path: 'a', title: 'A', readings: [{ seed: '5', label: '5', number: 5, boolean: null }] }];
	assert.equal(detectKind(numberOnly), 'number');

	const mixed: CalendarSample[] = [
		{ ts: 0, path: 'a', title: 'A', readings: [{ seed: '5', label: '5', number: 5, boolean: null }] },
		{ ts: 0, path: 'b', title: 'B', readings: [{ seed: 'x', label: 'x', number: null, boolean: null }] },
	];
	assert.equal(detectKind(mixed), 'category', 'one stray non-number reading forces the whole month to category');

	assert.equal(detectKind([]), 'plain');
});

test('numberRange spans every numeric reading across all samples', () => {
	const samples: CalendarSample[] = [
		{ ts: 0, path: 'a', title: 'A', readings: [{ seed: '5', label: '5', number: 5, boolean: null }] },
		{ ts: 0, path: 'b', title: 'B', readings: [{ seed: '1', label: '1', number: 1, boolean: null }, { seed: '9', label: '9', number: 9, boolean: null }] },
	];
	assert.deepEqual(numberRange(samples), { min: 1, max: 9 });
});

test('numberRange with no numeric readings is null', () => {
	assert.equal(numberRange([{ ts: 0, path: 'a', title: 'A', readings: [] }]), null);
});

test('rampColor: a value at the low or high end returns the stop exactly, no mixing', () => {
	const stops = ['#000000', '#808080', '#ffffff'];
	assert.equal(rampColor(0, 0, 10, stops), '#000000');
	assert.equal(rampColor(10, 0, 10, stops), '#ffffff');
});

test('rampColor: a flat range (max <= min) takes the top of the ramp', () => {
	assert.equal(rampColor(5, 5, 5, ['#a', '#b', '#c']), '#c');
});

test('rampColor: a single stop is always returned as-is', () => {
	assert.equal(rampColor(5, 0, 10, ['#only']), '#only');
});

test('rampColor: a value strictly between two stops mixes them with color-mix', () => {
	const mixed = rampColor(5, 0, 10, ['#000000', '#ffffff']);
	assert.match(mixed as string, /^color-mix\(in srgb, #ffffff 50%, #000000\)$/);
});

test('buildMonth reports a 4-to-6 week grid sized to the actual month, not a fixed 6', () => {
	// February 2026 starts on a Sunday and ends on a Saturday: exactly 4 weeks,
	// no spill into a 5th or 6th row, with a Sunday-first calendar.
	const month = buildMonth(2026, 1, new Map(), 'sunday', noColorOptions);
	assert.equal(month.weeks.length, 4);
	assert.ok(month.weeks.every((week) => week.days.length === 7));
});

test('buildMonth marks in-month days correctly against the spill days around it', () => {
	const month = buildMonth(2026, 4, new Map(), 'sunday', noColorOptions); // May 2026
	const inMonthCount = month.weeks.flatMap((w) => w.days).filter((d) => d.inMonth).length;
	assert.equal(inMonthCount, 31);
});

test('buildMonth caps markers per day and reports overflow', () => {
	const buckets = bucketSamples(Array.from({ length: 5 }, (_, i) => ({
		ts: localTs(2026, 5, 13),
		path: `n${i}.md`,
		title: `N${i}`,
		readings: [],
	})));
	const options: MarkerOptions = { colors: null, scope: 'status', rampColors: [], maxMarkers: 2 };
	const month = buildMonth(2026, 4, buckets, 'sunday', options);
	const day = month.weeks.flatMap((w) => w.days).find((d) => d.key === '2026-05-13');
	assert.ok(day);
	assert.equal(day?.markers.length, 2);
	assert.equal(day?.overflow, 3);
});
