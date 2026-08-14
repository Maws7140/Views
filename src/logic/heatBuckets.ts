import { addDays, daysBetween, localDayKey, startOfLocalDay } from './dateValue';

export type ThresholdMode = 'linear' | 'quantile' | 'manual';
export type WeekStart = 'sunday' | 'monday';
export type Aggregation = 'sum' | 'average' | 'max' | 'min';
export type Granularity = 'year' | 'month';

/** The rolling period is always this window, matching the reference. */
export const ROLLING_PERIOD = 'rolling';
export const ROLLING_DAYS = 365;

/** A month period is stored as `YYYY-MM`, so it sorts as text and reads plainly. */
const MONTH_PERIOD = /^(\d{4})-(\d{2})$/;

export interface HeatSample {
	/** Start of the local day the note fell on. */
	ts: number;
	value: number;
	path: string;
}

export interface HeatDay {
	key: string;
	ts: number;
	total: number;
	count: number;
	level: number;
	/** First note of the day in the view's native sort order. */
	primaryPath: string;
	paths: string[];
}

export interface HeatLevel {
	color: string;
	/** Inclusive lower bound. Level 0 is the empty cell and has min 0, max 0. */
	min: number;
	/** Inclusive upper bound, null on the open-ended top level. */
	max: number | null;
}

export interface HeatColumn {
	/** Seven slots, Sunday first or Monday first. Null outside the period. */
	cells: (HeatDay | null)[];
	/** Start-of-day timestamps aligned with `cells`, for empty-day tooltips. */
	stamps: (number | null)[];
}

export interface HeatGrid {
	columns: HeatColumn[];
	monthLabels: { column: number; label: string }[];
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Folds samples into one bucket per local day. Order of `samples` is the view's
 * native sort, so the first sample to land on a day becomes that day's primary
 * note and the plugin never sorts anything itself.
 */
export function bucketByDay(samples: HeatSample[], aggregation: Aggregation): Map<string, HeatDay> {
	const days = new Map<string, HeatDay>();
	// Running sums are kept beside the bucket so an average does not need a
	// second pass over every sample.
	const sums = new Map<string, number>();

	for (const sample of samples) {
		const key = localDayKey(sample.ts);
		let day = days.get(key);
		if (!day) {
			day = {
				key,
				ts: startOfLocalDay(sample.ts),
				total: sample.value,
				count: 0,
				level: 0,
				primaryPath: sample.path,
				paths: [],
			};
			days.set(key, day);
			sums.set(key, 0);
		}
		day.count += 1;
		day.paths.push(sample.path);
		const sum = (sums.get(key) ?? 0) + sample.value;
		sums.set(key, sum);

		if (aggregation === 'sum') day.total = sum;
		else if (aggregation === 'average') day.total = sum / day.count;
		else if (aggregation === 'max') day.total = Math.max(day.total, sample.value);
		else day.total = Math.min(day.total, sample.value);
	}

	return days;
}

/**
 * Builds the level bands. Level 0 is always "no value" and is not one of the
 * user's colors, so `colors` describes the positive levels only and the two can
 * never disagree about how many there are.
 *
 * `manual` takes the numbers the user typed. Anything it does not cover falls
 * back to a linear split of the remaining range, so a half-filled list still
 * produces a usable scale instead of collapsing every day into one band.
 */
export function buildLevels(
	values: number[],
	colors: string[],
	mode: ThresholdMode,
	manualThresholds: number[],
): HeatLevel[] {
	const positive = values.filter((value) => value > 0).sort((a, b) => a - b);
	const count = colors.length;
	if (!count) return [];

	const max = positive.length ? positive[positive.length - 1] : 0;
	// Each entry is the inclusive lower bound of the level above the previous one.
	let bounds: number[];

	if (mode === 'manual' && manualThresholds.length) {
		const sorted = [...manualThresholds].sort((a, b) => a - b);
		bounds = [];
		for (let index = 0; index < count; index += 1) {
			if (index < sorted.length) bounds.push(sorted[index]);
			else {
				// Continue linearly from the last number the user gave, up to the
				// observed maximum, so unfilled slots still separate.
				const from = bounds[bounds.length - 1] ?? 0;
				const remaining = count - index;
				const step = Math.max((max - from) / (remaining + 1), Number.EPSILON);
				bounds.push(from + step);
			}
		}
	} else if (mode === 'quantile' && positive.length) {
		bounds = [Number.MIN_VALUE];
		for (let index = 1; index < count; index += 1) {
			const rank = Math.floor((index / count) * positive.length);
			bounds.push(positive[Math.min(rank, positive.length - 1)]);
		}
	} else {
		const step = max > 0 ? max / count : 1;
		bounds = [];
		for (let index = 0; index < count; index += 1) {
			bounds.push(index === 0 ? Number.MIN_VALUE : step * index);
		}
	}

	// A flat dataset can produce repeated bounds. Nudging them apart keeps every
	// swatch reachable rather than silently unused.
	for (let index = 1; index < bounds.length; index += 1) {
		if (bounds[index] <= bounds[index - 1]) bounds[index] = bounds[index - 1] + Number.EPSILON;
	}

	return colors.map((color, index) => ({
		color,
		min: bounds[index],
		max: index === count - 1 ? null : bounds[index + 1],
	}));
}

/** Level 0 means no value. Anything positive lands in the highest band it clears. */
export function levelFor(total: number, levels: HeatLevel[]): number {
	if (total <= 0 || !levels.length) return 0;
	for (let index = levels.length - 1; index >= 0; index -= 1) {
		if (total >= levels[index].min) return index + 1;
	}
	return 1;
}

/**
 * The calendar grid. Columns are weeks, rows are weekdays, so the first column
 * is padded with nulls up to the period's first day and the last column is
 * padded after its last, exactly as the reference renders.
 */
export function buildGrid(
	fromTs: number,
	toTs: number,
	days: Map<string, HeatDay>,
	weekStart: WeekStart,
): HeatGrid {
	const offset = weekStart === 'monday' ? 1 : 0;
	const start = startOfLocalDay(fromTs);
	const end = startOfLocalDay(toTs);
	const span = Math.max(0, daysBetween(start, end));

	const columns: HeatColumn[] = [];
	let current: HeatColumn | null = null;

	for (let index = 0; index <= span; index += 1) {
		const ts = addDays(start, index);
		const row = (new Date(ts).getDay() - offset + 7) % 7;

		// A new column opens on the configured week start. The first column can
		// begin mid-week, so its earlier slots stay null.
		if (!current || (row === 0 && index > 0)) {
			current = { cells: Array(7).fill(null), stamps: Array(7).fill(null) };
			columns.push(current);
		}

		current.cells[row] = days.get(localDayKey(ts)) ?? null;
		current.stamps[row] = ts;
	}

	// A column is labelled by the month its first real day falls in, and only
	// when that month has not been labelled yet. Deriving this from the finished
	// columns keeps labels in ascending column order by construction.
	const monthLabels: { column: number; label: string }[] = [];
	let lastMonth = -1;
	columns.forEach((column, index) => {
		const first = column.stamps.find((stamp): stamp is number => stamp !== null);
		if (first === undefined) return;
		const month = new Date(first).getMonth();
		if (month === lastMonth) return;
		lastMonth = month;
		monthLabels.push({ column: index, label: MONTH_NAMES[month] });
	});

	return { columns, monthLabels };
}

/** Inclusive bounds of the window a period selection describes. */
export function periodRange(period: string, now: number): { from: number; to: number } {
	const month = MONTH_PERIOD.exec(period);
	if (month) {
		const year = Number(month[1]);
		const index = Number(month[2]) - 1;
		// Day 0 of the next month is the last day of this one, so month length and
		// leap years need no table.
		return {
			from: new Date(year, index, 1).getTime(),
			to: new Date(year, index + 1, 0).getTime(),
		};
	}
	const year = Number(period);
	if (period !== ROLLING_PERIOD && Number.isFinite(year)) {
		return {
			from: new Date(year, 0, 1).getTime(),
			to: new Date(year, 11, 31).getTime(),
		};
	}
	const to = startOfLocalDay(now);
	return { from: addDays(to, -(ROLLING_DAYS - 1)), to };
}

/** Rolling first, then every calendar year the data actually covers, newest first. */
export function availablePeriods(days: Map<string, HeatDay>): string[] {
	return [ROLLING_PERIOD, ...availableYears(days).map(String)];
}

/** Every calendar year the data covers, newest first. */
export function availableYears(days: Map<string, HeatDay>): number[] {
	const years = new Set<number>();
	for (const day of days.values()) years.add(new Date(day.ts).getFullYear());
	return [...years].sort((a, b) => b - a);
}

/**
 * All twelve months of a year, January first. The full year is listed rather
 * than only the months holding data, because these buttons are how the user
 * moves around and a missing month would be a hole in the path rather than a
 * fact about the data.
 */
export function monthPeriods(year: number): string[] {
	return MONTH_NAMES.map((_, index) => `${year}-${String(index + 1).padStart(2, '0')}`);
}

export function periodYear(period: string): number | null {
	const month = MONTH_PERIOD.exec(period);
	return month ? Number(month[1]) : null;
}

/** The month a period names, shifted by whole years. Non-month periods pass through. */
export function shiftPeriodYear(period: string, delta: number): string {
	const month = MONTH_PERIOD.exec(period);
	return month ? `${Number(month[1]) + delta}-${month[2]}` : period;
}

/** The button label. Under a year stepper a month needs no year on it. */
export function periodLabel(period: string): string {
	if (period === ROLLING_PERIOD) return 'Last year';
	const month = MONTH_PERIOD.exec(period);
	return month ? MONTH_NAMES[Number(month[2]) - 1] : period;
}

/** The trailing half of the headline, which does name the year. */
export function periodHeadline(period: string): string {
	if (period === ROLLING_PERIOD) return 'in the last year';
	const month = MONTH_PERIOD.exec(period);
	return month ? `in ${MONTH_NAMES[Number(month[2]) - 1]} ${month[1]}` : `in ${period}`;
}

export function parseNumbers(values: unknown): number[] {
	if (!Array.isArray(values)) return [];
	return values
		.map((value) => (typeof value === 'number' ? value : Number(String(value).trim())))
		.filter((value): value is number => Number.isFinite(value));
}
