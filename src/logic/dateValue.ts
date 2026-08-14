import type { BasesEntry, BasesPropertyId, DateValue, ListValue } from 'obsidian';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Reading a date out of a Bases property, in one place. The Timeline grew this
 * first and the Heatmap needs exactly the same three cases, so it lives here
 * rather than being written twice with slightly different edges.
 *
 * A property can hold a native `DateValue`, a list containing one, or a plain
 * string, and each is tried in that order.
 */
export function extractTimestamp(entry: BasesEntry, property: BasesPropertyId | null): number | null {
	if (!property) return null;

	let value: unknown;
	try {
		value = entry.getValue(property);
	} catch {
		// A renamed or stale property must not take the view down.
		return null;
	}
	if (!value) return null;

	if (isDateValue(value)) return parseDateValue(value.dateOnly());

	const fromList = dateValueFromList(value);
	if (fromList) return parseDateValue(fromList.dateOnly());

	const serialized = value.toString();
	return serialized ? parseDateString(serialized) : null;
}

export function isDateValue(value: unknown): value is DateValue {
	return Boolean(value && typeof (value as DateValue).dateOnly === 'function');
}

export function parseDateValue(value: DateValue): number | null {
	return parseDateString(value.toString());
}

/** Year first, any of the usual separators: 2026-05-13, 2026/5/13, 2026.05.13. */
const YEAR_FIRST = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;
/** Day or month first, four-digit year last: 13/05/2026, 5-13-2026. */
const YEAR_LAST = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
/** Compact, as daily-note filenames often are: 20260513. */
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
/** Anything that pins the string to a real instant rather than a calendar day. */
const CARRIES_TIME = /\d:\d|[Tt]\d{2}:|[Zz]$|[+-]\d{2}:?\d{2}$|\b[AaPp]\.?[Mm]\b/;

/**
 * Strips the wrapping a vault puts around a date so a property does not have to
 * hold a clean string to be usable: a wikilink to a daily note, a markdown link,
 * a quoted or backticked value, an alias after a pipe, a `.md` extension. What
 * survives is the part that might name a day. A folder path is left on, because
 * removing it here would turn "2026/05/13" into "13".
 */
function unwrap(input: string): string {
	let text = input.trim();
	const markdown = text.match(/^\[[^\]]*\]\(([^)]+)\)$/);
	if (markdown) text = markdown[1];
	text = text.replace(/^\[\[/, '').replace(/\]\]$/, '');
	text = text.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
	// A wikilink alias describes the link, not the day it points at.
	const pipe = text.indexOf('|');
	if (pipe !== -1) text = text.slice(0, pipe);
	return text.replace(/\.md$/i, '').trim();
}

/**
 * Local midnight for a calendar day, and null for anything that is not a real
 * date. `new Date(2026, 12, 45)` rolls over into the next year rather than
 * failing, so the parts are checked before they are trusted.
 */
function localDate(year: number, month: number, day: number): number | null {
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return date.getTime();
}

/**
 * A bare `YYYY-MM-DD` is parsed as **local** midnight, not UTC.
 *
 * `Date.parse` reads a date-only string as UTC by spec, so west of Greenwich
 * "2026-05-13" becomes the evening of the 12th. A timeline bar is wide enough to
 * hide that; a heatmap cell is one day and lands in the wrong square. A string
 * that carries its own time or zone is left to `Date.parse`, since it means a
 * real instant rather than a calendar day.
 *
 * Everything below that is about not making the user retype their vault. A date
 * property is often a link to a daily note, a filename, or a sentence with a
 * date in it, and all of those name a day perfectly well.
 */
export function parseDateString(input: string): number | null {
	const text = unwrap(input);
	if (!text) return null;

	const direct = readDay(text);
	if (direct !== null) return direct;

	// A folder path only now, once the whole string has failed. Doing it earlier
	// would turn "2026/05/13" into "13".
	const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
	return slash === -1 ? null : readDay(text.slice(slash + 1).trim());
}

function readDay(text: string): number | null {
	if (!text) return null;

	// A string carrying a time or a zone is a real instant. It goes to Date.parse
	// untouched so the offset it states is the offset that is used.
	if (CARRIES_TIME.test(text)) {
		const instant = Date.parse(text);
		if (Number.isFinite(instant)) return instant;
	}

	// Each numeric shape below is decided here and not passed on. A string that
	// looks like a date but names an impossible one is an error worth showing, and
	// Date.parse would quietly roll it over instead: it reads "2026-02-30" as the
	// 1st of March and "99/99/2026" as the end of 2025.
	const compact = text.match(COMPACT);
	if (compact) return localDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));

	// Day and month cannot be told apart here, so the only honest rule is that a
	// number above twelve can only be a day. Otherwise month first, matching what
	// Date.parse would have done with the same string.
	const yearLast = text.match(YEAR_LAST);
	if (yearLast) {
		const first = Number(yearLast[1]);
		const second = Number(yearLast[2]);
		const year = Number(yearLast[3]);
		return first > 12 ? localDate(year, second, first) : localDate(year, first, second);
	}

	// Searched rather than anchored, so "Daily/2026-05-13 Monday" still resolves.
	const yearFirst = text.match(YEAR_FIRST);
	if (yearFirst) return localDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));

	// Named months and anything else the engine recognises: "13 May 2026",
	// "May 13, 2026". Date-only strings in these forms are already local.
	//
	// A purely numeric string never reaches Date.parse, because every numeric
	// shape worth supporting is handled above and what is left is a fragment.
	// Date.parse answers a bare "2026" with the 1st of January, which for a
	// leftover path segment is an invention rather than a reading.
	if (!/[a-z]/i.test(text)) return null;
	const timestamp = Date.parse(text);
	return Number.isFinite(timestamp) ? timestamp : null;
}

/** Bases exposes a list either through `length`/`get` or through `toArray`. */
export function dateValueFromList(value: unknown): DateValue | null {
	if (!value) return null;

	const list = value as ListValue;
	if (typeof list.length === 'function' && typeof list.get === 'function') {
		for (let index = 0; index < list.length(); index += 1) {
			const item = list.get(index);
			if (isDateValue(item)) return item;
		}
	}

	const withToArray = value as { toArray?: () => unknown[] };
	if (typeof withToArray.toArray === 'function') {
		const array = withToArray.toArray();
		if (Array.isArray(array)) {
			for (const item of array) {
				if (isDateValue(item)) return item;
			}
		}
	}

	return null;
}

/**
 * Midnight in the user's own timezone. A heatmap cell is a calendar day as the
 * user experiences it, so UTC truncation would push evening notes onto the
 * following day for anyone west of Greenwich.
 */
export function startOfLocalDay(timestamp: number): number {
	const date = new Date(timestamp);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** `YYYY-MM-DD` in local time, the key a day bucket is stored under. */
export function localDayKey(timestamp: number): string {
	const date = new Date(timestamp);
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

export function addDays(timestamp: number, days: number): number {
	// Rebuilt through Date rather than adding milliseconds, so a daylight saving
	// transition inside the span does not shift every later day by an hour.
	const date = new Date(timestamp);
	date.setDate(date.getDate() + days);
	return date.getTime();
}

export function daysBetween(from: number, to: number): number {
	return Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / MS_PER_DAY);
}
