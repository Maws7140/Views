import assert from 'node:assert/strict';
import test from 'node:test';
import {
	availablePeriods,
	availableYears,
	buildGrid,
	buildLevels,
	bucketByDay,
	levelFor,
	monthPeriods,
	parseNumbers,
	periodHeadline,
	periodLabel,
	periodRange,
	periodYear,
	ROLLING_DAYS,
	ROLLING_PERIOD,
	shiftPeriodYear,
	type HeatSample,
} from '../../src/logic/heatBuckets';

function localTs(year: number, month: number, day: number): number {
	return new Date(year, month - 1, day).getTime();
}

test('bucketByDay folds same-day samples, aggregation sum', () => {
	const samples: HeatSample[] = [
		{ ts: localTs(2026, 5, 1), value: 2, path: 'a.md' },
		{ ts: localTs(2026, 5, 1), value: 3, path: 'b.md' },
		{ ts: localTs(2026, 5, 2), value: 5, path: 'c.md' },
	];
	const days = bucketByDay(samples, 'sum');
	assert.equal(days.get('2026-05-01')?.total, 5);
	assert.equal(days.get('2026-05-01')?.count, 2);
	assert.equal(days.get('2026-05-01')?.primaryPath, 'a.md', 'first sample to land on the day leads it');
	assert.equal(days.get('2026-05-02')?.total, 5);
});

test('bucketByDay aggregation: average, max, min', () => {
	const sameDay = (values: number[]): HeatSample[] => values.map((value, i) => ({ ts: localTs(2026, 5, 1), value, path: `p${i}.md` }));

	assert.equal(bucketByDay(sameDay([2, 4, 6]), 'average').get('2026-05-01')?.total, 4);
	assert.equal(bucketByDay(sameDay([2, 8, 5]), 'max').get('2026-05-01')?.total, 8);
	assert.equal(bucketByDay(sameDay([2, 8, 5]), 'min').get('2026-05-01')?.total, 2);
});

test('buildLevels linear mode splits evenly from 0 to the observed max', () => {
	const levels = buildLevels([10, 20, 30, 40], ['#a', '#b', '#c', '#d'], 'linear', []);
	assert.equal(levels.length, 4);
	assert.equal(levels[0].max, 10);
	assert.equal(levels[3].max, null, 'the top level is open-ended');
});

test('buildLevels manual mode uses the given thresholds and fills unfilled slots linearly', () => {
	const levels = buildLevels([5, 50, 100], ['#a', '#b', '#c'], 'manual', [10]);
	assert.equal(levels[0].min, 10);
	assert.ok(levels[1].min > 10);
	assert.ok(levels[2].min > levels[1].min);
});

test('buildLevels on an all-zero dataset still produces reachable, distinct bounds', () => {
	const levels = buildLevels([0, 0, 0], ['#a', '#b'], 'linear', []);
	assert.equal(levels.length, 2);
	assert.ok(levels[1].min > levels[0].min, 'flat data must not collapse two levels onto the same bound');
});

test('buildLevels with no colors returns no levels', () => {
	assert.deepEqual(buildLevels([1, 2, 3], [], 'linear', []), []);
});

test('levelFor: zero or negative is always level 0, positive values land in the highest band cleared', () => {
	const levels = buildLevels([10, 20, 30], ['#a', '#b', '#c'], 'linear', []);
	assert.equal(levelFor(0, levels), 0);
	assert.equal(levelFor(-5, levels), 0);
	assert.equal(levelFor(1, levels), 1);
	assert.equal(levelFor(30, levels), 3);
});

test('buildGrid pads the first and last week with nulls outside the period', () => {
	// A one-day period starting on a Wednesday, Sunday-first weeks: the first
	// column has 3 real slots before it and 3 after within the same week.
	const wednesday = localTs(2026, 5, 13);
	assert.equal(new Date(wednesday).getDay(), 3);
	const grid = buildGrid(wednesday, wednesday, new Map(), 'sunday');
	assert.equal(grid.columns.length, 1);
	const cells = grid.columns[0].cells;
	assert.equal(cells[3], null, 'the day itself has no samples, so it is null too, but present in the grid');
	assert.equal(cells.filter((c) => c !== null).length, 0);
	assert.equal(grid.columns[0].stamps[3], wednesday);
});

test('buildGrid places a bucketed day in its correct weekday slot', () => {
	const wednesday = localTs(2026, 5, 13);
	const days = bucketByDay([{ ts: wednesday, value: 1, path: 'a.md' }], 'sum');
	const grid = buildGrid(wednesday, wednesday, days, 'sunday');
	assert.equal(grid.columns[0].cells[3]?.total, 1);
});

test('buildGrid month labels appear once per month in ascending column order', () => {
	const from = localTs(2026, 1, 28);
	const to = localTs(2026, 2, 3);
	const grid = buildGrid(from, to, new Map(), 'sunday');
	const labels = grid.monthLabels.map((l) => l.label);
	assert.deepEqual(labels, ['Jan', 'Feb']);
});

test('periodRange: a month period spans the whole month regardless of length', () => {
	const feb = periodRange('2024-02', 0); // 2024 is a leap year
	assert.equal(new Date(feb.to).getDate(), 29);
	const feb2026 = periodRange('2026-02', 0);
	assert.equal(new Date(feb2026.to).getDate(), 28);
});

test('periodRange: a bare year spans January 1 to December 31', () => {
	const range = periodRange('2025', 0);
	assert.equal(new Date(range.from).getMonth(), 0);
	assert.equal(new Date(range.from).getDate(), 1);
	assert.equal(new Date(range.to).getMonth(), 11);
	assert.equal(new Date(range.to).getDate(), 31);
});

test('periodRange: the rolling period spans exactly ROLLING_DAYS ending today', () => {
	const now = localTs(2026, 6, 15);
	const range = periodRange(ROLLING_PERIOD, now);
	assert.equal(range.to, new Date(now).setHours(0, 0, 0, 0));
	const spanDays = Math.round((range.to - range.from) / (24 * 60 * 60 * 1000)) + 1;
	assert.equal(spanDays, ROLLING_DAYS);
});

test('availablePeriods puts rolling first, then every year the data covers, newest first', () => {
	const days = bucketByDay([
		{ ts: localTs(2024, 1, 1), value: 1, path: 'a.md' },
		{ ts: localTs(2026, 1, 1), value: 1, path: 'b.md' },
	], 'sum');
	assert.deepEqual(availablePeriods(days), [ROLLING_PERIOD, '2026', '2024']);
	assert.deepEqual(availableYears(days), [2026, 2024]);
});

test('monthPeriods lists all twelve months of the given year', () => {
	const months = monthPeriods(2026);
	assert.equal(months.length, 12);
	assert.equal(months[0], '2026-01');
	assert.equal(months[11], '2026-12');
});

test('periodYear/shiftPeriodYear/periodLabel/periodHeadline handle month periods, years, and rolling', () => {
	assert.equal(periodYear('2026-05'), 2026);
	assert.equal(periodYear('2026'), null);
	assert.equal(shiftPeriodYear('2026-05', 1), '2027-05');
	assert.equal(shiftPeriodYear('2026', 1), '2026', 'a non-month period passes through unchanged');
	assert.equal(periodLabel(ROLLING_PERIOD), 'Last year');
	assert.equal(periodLabel('2026-05'), 'May');
	assert.equal(periodLabel('2026'), '2026');
	assert.equal(periodHeadline(ROLLING_PERIOD), 'in the last year');
	assert.equal(periodHeadline('2026-05'), 'in May 2026');
	assert.equal(periodHeadline('2026'), 'in 2026');
});

test('parseNumbers coerces strings and drops anything non-finite', () => {
	assert.deepEqual(parseNumbers([1, '2', ' 3 ', 'nope', null, 4]), [1, 2, 3, 4]);
	assert.deepEqual(parseNumbers('not an array'), []);
});
