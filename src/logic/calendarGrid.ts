import { addDays, daysBetween, localDayKey, startOfLocalDay } from './dateValue';
import { buildLevels, levelFor, type Aggregation, type HeatLevel, type WeekStart } from './heatBuckets';
import { stableColor } from '../table-colors/palettes';

/**
 * How the day markers encode the color property. The kind is read off the
 * property's own values rather than configured, so pointing the view at a
 * checkbox gives two states and pointing it at a number gives a ramp without
 * anyone choosing a mode.
 */
export type MarkerKind = 'plain' | 'boolean' | 'number' | 'category';

/** What a day cell paints. `auto` derives it from the marker kind. */
export type MarkerStyle = 'auto' | 'dots' | 'fill' | 'none';

/** One reading of the color property. A list property yields several. */
export interface ValueReading {
	/** Value identity, hashed for a stable color and used to dedupe. */
	seed: string;
	label: string;
	number: number | null;
	boolean: boolean | null;
}

export interface CalendarSample {
	ts: number;
	path: string;
	title: string;
	readings: ValueReading[];
}

export interface CalendarEntryRef {
	path: string;
	title: string;
}

export interface DayMarker {
	/** Null keeps the theme's neutral dot rather than inventing a color. */
	color: string | null;
	/** Hollow is the false half of a boolean, the `o` of the reference's `* o`. */
	filled: boolean;
	label: string;
}

export interface CalendarDay {
	key: string;
	ts: number;
	dayOfMonth: number;
	/** False for the spill days that fill the first and last weeks. */
	inMonth: boolean;
	isToday: boolean;
	entries: CalendarEntryRef[];
	markers: DayMarker[];
	/** Markers past the cap, shown as `+n`. */
	overflow: number;
	/** Aggregated number for the day, null unless the property holds numbers. */
	total: number | null;
	/** Heat band for fill mode. 0 is an unpainted cell. */
	level: number;
}

export interface CalendarWeek {
	number: number;
	days: CalendarDay[];
}

export interface CalendarMonth {
	year: number;
	/** Zero-based, as `Date` counts them. */
	month: number;
	weeks: CalendarWeek[];
	levels: HeatLevel[];
	kind: MarkerKind;
	/** What the cells actually paint once `auto` has been resolved. */
	style: Exclude<MarkerStyle, 'auto'>;
}

export interface MarkerOptions {
	style: MarkerStyle;
	aggregation: Aggregation;
	palette: string[] | undefined;
	rampColors: string[];
	maxMarkers: number;
}

const MONTH_KEY = /^(\d{4})-(\d{2})$/;

/** `YYYY-MM`, the form a visible month is stored in so it sorts as text. */
export function monthKey(year: number, month: number): string {
	return `${year}-${`${month + 1}`.padStart(2, '0')}`;
}

export function parseMonthKey(value: unknown): { year: number; month: number } | null {
	if (typeof value !== 'string') return null;
	const match = value.match(MONTH_KEY);
	if (!match) return null;
	const month = Number(match[2]) - 1;
	if (month < 0 || month > 11) return null;
	return { year: Number(match[1]), month };
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
	const date = new Date(year, month + delta, 1);
	return { year: date.getFullYear(), month: date.getMonth() };
}

/**
 * The week number as the reference numbers it: week 1 is the week holding
 * January 1st, counted from the user's own week start. ISO's Monday-only,
 * Thursday-anchored rule would print 44 where the reference prints 45, and the
 * column exists to match a wall calendar rather than the standard.
 */
export function weekNumber(ts: number, weekStart: WeekStart): number {
	const date = new Date(ts);
	const firstOfYear = new Date(date.getFullYear(), 0, 1).getTime();
	const span = daysBetween(startOfWeek(firstOfYear, weekStart), startOfWeek(ts, weekStart));
	return Math.floor(span / 7) + 1;
}

export function startOfWeek(ts: number, weekStart: WeekStart): number {
	const offset = weekStart === 'monday' ? 1 : 0;
	const start = startOfLocalDay(ts);
	const row = (new Date(start).getDay() - offset + 7) % 7;
	return addDays(start, -row);
}

/**
 * Folds samples into one bucket per local day. Entry order is the view's native
 * sort, so the first note to land on a day leads its list and the plugin never
 * sorts anything itself.
 */
export function bucketSamples(samples: CalendarSample[]): Map<string, CalendarSample[]> {
	const days = new Map<string, CalendarSample[]>();
	for (const sample of samples) {
		const key = localDayKey(sample.ts);
		const bucket = days.get(key);
		if (bucket) bucket.push(sample);
		else days.set(key, [sample]);
	}
	return days;
}

/**
 * Reads the encoding off the data. Every reading has to agree before a
 * specialised kind is claimed, because a single stray string in a number
 * property would otherwise be scaled as if it were zero.
 */
export function detectKind(samples: CalendarSample[]): MarkerKind {
	let seen = 0;
	let booleans = 0;
	let numbers = 0;
	for (const sample of samples) {
		for (const reading of sample.readings) {
			seen += 1;
			if (reading.boolean !== null) booleans += 1;
			if (reading.number !== null) numbers += 1;
		}
	}
	if (!seen) return 'plain';
	if (booleans === seen) return 'boolean';
	if (numbers === seen) return 'number';
	return 'category';
}

/** Dots for anything countable, a heat fill for a measured quantity. */
export function resolveStyle(style: MarkerStyle, kind: MarkerKind): Exclude<MarkerStyle, 'auto'> {
	if (style !== 'auto') return style;
	return kind === 'number' ? 'fill' : 'dots';
}

/**
 * The month a base's calendar shows: the weeks spanning the first to the last
 * of the month, padded at both ends to whole weeks. Rows vary between four and
 * six with the month, rather than always being six with a blank row.
 */
export function buildMonth(
	year: number,
	month: number,
	buckets: Map<string, CalendarSample[]>,
	weekStart: WeekStart,
	options: MarkerOptions,
): CalendarMonth {
	const first = new Date(year, month, 1).getTime();
	const last = new Date(year, month + 1, 0).getTime();
	const from = startOfWeek(first, weekStart);
	const to = addDays(startOfWeek(last, weekStart), 6);
	const today = startOfLocalDay(Date.now());

	// Levels come from the visible month alone, so moving a month rescales the
	// ramp to what is on screen instead of to an outlier in another year.
	const visible: CalendarSample[] = [];
	for (let ts = from; ts <= to; ts = addDays(ts, 1)) {
		const bucket = buckets.get(localDayKey(ts));
		if (bucket) visible.push(...bucket);
	}
	const kind = detectKind(visible);
	const style = resolveStyle(options.style, kind);

	const totals = new Map<string, number>();
	if (kind === 'number') {
		for (let ts = from; ts <= to; ts = addDays(ts, 1)) {
			const key = localDayKey(ts);
			const bucket = buckets.get(key);
			if (bucket?.length) totals.set(key, aggregate(bucket, options.aggregation));
		}
	}
	const levels = kind === 'number'
		? buildLevels([...totals.values()], options.rampColors, 'linear', [])
		: [];

	const weeks: CalendarWeek[] = [];
	for (let ts = from; ts <= to; ts = addDays(ts, 7)) {
		const days: CalendarDay[] = [];
		for (let index = 0; index < 7; index += 1) {
			const dayTs = addDays(ts, index);
			const key = localDayKey(dayTs);
			const date = new Date(dayTs);
			const bucket = buckets.get(key) ?? [];
			const total = totals.get(key) ?? null;
			const level = total === null ? 0 : levelFor(total, levels);
			const built = buildMarkers(bucket, kind, level, levels, options);
			days.push({
				key,
				ts: dayTs,
				dayOfMonth: date.getDate(),
				inMonth: date.getMonth() === month && date.getFullYear() === year,
				isToday: dayTs === today,
				entries: bucket.map((sample) => ({ path: sample.path, title: sample.title })),
				markers: built.markers,
				overflow: built.overflow,
				total,
				level,
			});
		}
		weeks.push({ number: weekNumber(ts, weekStart), days });
	}

	return { year, month, weeks, levels, kind, style };
}

function aggregate(samples: CalendarSample[], aggregation: Aggregation): number {
	const values: number[] = [];
	for (const sample of samples) {
		for (const reading of sample.readings) {
			if (reading.number !== null) values.push(reading.number);
		}
	}
	if (!values.length) return 0;
	if (aggregation === 'max') return Math.max(...values);
	if (aggregation === 'min') return Math.min(...values);
	const sum = values.reduce((carry, value) => carry + value, 0);
	return aggregation === 'average' ? sum / values.length : sum;
}

/**
 * One marker per value, which for the common single-valued property is one
 * marker per note. The cap is on markers rather than notes, so a busy day
 * reports `+n` instead of growing the row until the cell stops being square.
 */
function buildMarkers(
	samples: CalendarSample[],
	kind: MarkerKind,
	level: number,
	levels: HeatLevel[],
	options: MarkerOptions,
): { markers: DayMarker[]; overflow: number } {
	const markers: DayMarker[] = [];

	for (const sample of samples) {
		if (kind === 'plain' || !sample.readings.length) {
			markers.push({ color: null, filled: true, label: sample.title });
			continue;
		}
		for (const reading of sample.readings) {
			markers.push(markerFor(reading, kind, level, levels, options.palette));
		}
	}

	const cap = Math.max(1, options.maxMarkers);
	return markers.length > cap
		? { markers: markers.slice(0, cap), overflow: markers.length - cap }
		: { markers, overflow: 0 };
}

function markerFor(
	reading: ValueReading,
	kind: MarkerKind,
	level: number,
	levels: HeatLevel[],
	palette: string[] | undefined,
): DayMarker {
	if (kind === 'boolean') {
		// The two colors come from the same palette every other view uses, so
		// true and false read as the same pair they do in a table. Hollow carries
		// the false half on its own where colors are turned off.
		const on = reading.boolean === true;
		return {
			color: palette ? stableColor(on ? 'true' : 'false', palette) : null,
			filled: on,
			label: reading.label,
		};
	}
	if (kind === 'number') {
		return {
			color: level > 0 ? levels[level - 1]?.color ?? null : null,
			filled: true,
			label: reading.label,
		};
	}
	return {
		color: palette ? stableColor(reading.seed, palette) : null,
		filled: true,
		label: reading.label,
	};
}
