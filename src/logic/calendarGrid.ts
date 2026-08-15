import { addDays, daysBetween, localDayKey, startOfLocalDay } from './dateValue';
import type { ColorAssigner } from '../table-colors/palettes';
import type { WeekStart } from './heatBuckets';

/**
 * How the day markers encode the color property. The kind is read off the
 * property's own values rather than configured, so pointing the view at a
 * checkbox gives two states and pointing it at a number gives a ramp without
 * anyone choosing a mode.
 */
export type MarkerKind = 'plain' | 'boolean' | 'number' | 'category';

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
	kind: MarkerKind;
	/** The low and high of the visible month, for the number legend. */
	range: { min: number; max: number } | null;
}

export interface MarkerOptions {
	/**
	 * The view's one assigner, shared with everything else it renders, so a value
	 * is the same colour as a dot here and as a pill in the detail panel.
	 */
	colors: ColorAssigner | null;
	/** The colour property, so dots and that property's pills share a scope. */
	scope: string;
	/** Ramp stops, low to high. Values land between them, not on them. */
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

/**
 * A value's place on the ramp, as a color. The stops are the colors the user
 * listed low to high, and a value lands *between* them rather than being
 * bucketed onto one, so a number property reads as a continuous range instead
 * of the handful of bands the Heatmap deliberately shows.
 *
 * The mixing is left to CSS. `color-mix` accepts every color notation the user
 * can type, including a theme variable, which a parser here would have to
 * reimplement and would get wrong for `var(--text-accent)`.
 */
export function rampColor(value: number, min: number, max: number, stops: string[]): string | null {
	if (!stops.length) return null;
	if (stops.length === 1) return stops[0];
	// A month whose values are all the same has no low or high to speak of, so
	// every dot takes the top of the ramp rather than an arbitrary middle.
	if (max <= min) return stops[stops.length - 1];

	const position = clamp((value - min) / (max - min), 0, 1) * (stops.length - 1);
	const index = Math.min(Math.floor(position), stops.length - 2);
	const fraction = position - index;
	if (fraction <= 0.001) return stops[index];
	if (fraction >= 0.999) return stops[index + 1];
	return `color-mix(in srgb, ${stops[index + 1]} ${Math.round(fraction * 100)}%, ${stops[index]})`;
}

/** The low and high of every number in the month, which the ramp spans. */
export function numberRange(samples: CalendarSample[]): { min: number; max: number } | null {
	let min = Infinity;
	let max = -Infinity;
	for (const sample of samples) {
		for (const reading of sample.readings) {
			if (reading.number === null) continue;
			min = Math.min(min, reading.number);
			max = Math.max(max, reading.number);
		}
	}
	return Number.isFinite(min) ? { min, max } : null;
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
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
	// The range comes from the visible month alone, so stepping a month rescales
	// the ramp to what is on screen rather than to an outlier in another year.
	const range = kind === 'number' ? numberRange(visible) : null;

	// Claimed up front, in day order and then the view's own sort, so the grid
	// gets first pick and the assignment is stable for the same data rather than
	// depending on which cell happens to render first.
	if (kind !== 'number' && options.colors) {
		for (const seed of seedsOf(visible, kind)) options.colors.color(options.scope, seed);
	}

	const weeks: CalendarWeek[] = [];
	for (let ts = from; ts <= to; ts = addDays(ts, 7)) {
		const days: CalendarDay[] = [];
		for (let index = 0; index < 7; index += 1) {
			const dayTs = addDays(ts, index);
			const key = localDayKey(dayTs);
			const date = new Date(dayTs);
			const bucket = buckets.get(key) ?? [];
			const built = buildMarkers(bucket, kind, range, options);
			days.push({
				key,
				ts: dayTs,
				dayOfMonth: date.getDate(),
				inMonth: date.getMonth() === month && date.getFullYear() === year,
				isToday: dayTs === today,
				entries: bucket.map((sample) => ({ path: sample.path, title: sample.title })),
				markers: built.markers,
				overflow: built.overflow,
			});
		}
		weeks.push({ number: weekNumber(ts, weekStart), days });
	}

	return { year, month, weeks, kind, range };
}

/**
 * One marker per value, which for the common single-valued property is one
 * marker per note. The cap is on markers rather than notes, so a busy day
 * reports `+n` instead of growing the row until the cell stops being square.
 */
/**
 * Every value that needs a color, in the order it is first seen. A boolean has
 * exactly two, so listing them explicitly keeps true and false apart even in a
 * month where only one of them occurs.
 */
function seedsOf(samples: CalendarSample[], kind: MarkerKind): string[] {
	if (kind === 'boolean') return ['true', 'false'];
	const seeds: string[] = [];
	for (const sample of samples) {
		for (const reading of sample.readings) {
			if (reading.seed) seeds.push(reading.seed);
		}
	}
	return seeds;
}

function buildMarkers(
	samples: CalendarSample[],
	kind: MarkerKind,
	range: { min: number; max: number } | null,
	options: MarkerOptions,
): { markers: DayMarker[]; overflow: number } {
	const markers: DayMarker[] = [];

	for (const sample of samples) {
		if (kind === 'plain' || !sample.readings.length) {
			markers.push({ color: null, filled: true, label: sample.title });
			continue;
		}
		for (const reading of sample.readings) {
			markers.push(markerFor(reading, kind, range, options));
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
	range: { min: number; max: number } | null,
	options: MarkerOptions,
): DayMarker {
	if (kind === 'boolean') {
		// Two colors that are guaranteed to differ, plus hollow carrying the
		// false half on its own where colors are turned off entirely.
		const on = reading.boolean === true;
		return {
			color: options.colors?.color(options.scope, on ? 'true' : 'false') ?? null,
			filled: on,
			label: reading.label,
		};
	}
	// Each value takes its own place on the ramp, so two notes on one day can
	// carry two different colors rather than sharing the day's aggregate.
	if (kind === 'number' && range && reading.number !== null) {
		return {
			color: rampColor(reading.number, range.min, range.max, options.rampColors),
			filled: true,
			label: reading.label,
		};
	}
	return {
		color: options.colors?.color(options.scope, reading.seed) ?? null,
		filled: true,
		label: reading.label,
	};
}
