import assert from 'node:assert/strict';
import test from 'node:test';
import { addDays, daysBetween, localDayKey, parseDateString, startOfLocalDay } from '../../src/logic/dateValue';

function localTs(year: number, month: number, day: number): number {
	return new Date(year, month - 1, day).getTime();
}

test('parseDateString reads a bare YYYY-MM-DD as local midnight, not UTC', () => {
	const parsed = parseDateString('2026-05-13');
	assert.equal(parsed, localTs(2026, 5, 13));
});

test('parseDateString accepts the other separators year-first', () => {
	assert.equal(parseDateString('2026/5/13'), localTs(2026, 5, 13));
	assert.equal(parseDateString('2026.05.13'), localTs(2026, 5, 13));
});

test('parseDateString: a component above 12 can only be a day, so day/month order is inferred', () => {
	assert.equal(parseDateString('13/05/2026'), localTs(2026, 5, 13));
	// Ambiguous (both parts <= 12): month-first, matching Date.parse's own bias.
	assert.equal(parseDateString('5/6/2026'), localTs(2026, 5, 6));
});

test('parseDateString reads a compact daily-note-style date', () => {
	assert.equal(parseDateString('20260513'), localTs(2026, 5, 13));
});

test('parseDateString rejects an impossible calendar date instead of letting it roll over', () => {
	assert.equal(parseDateString('2026-02-30'), null);
	assert.equal(parseDateString('99/99/2026'), null);
});

test('parseDateString unwraps a wikilink, markdown link, quoting, and a trailing .md', () => {
	assert.equal(parseDateString('[[2026-05-13]]'), localTs(2026, 5, 13));
	assert.equal(parseDateString('[Daily](2026-05-13)'), localTs(2026, 5, 13));
	assert.equal(parseDateString('"2026-05-13"'), localTs(2026, 5, 13));
	assert.equal(parseDateString('2026-05-13.md'), localTs(2026, 5, 13));
});

test('parseDateString drops a wikilink alias, keeping the link target', () => {
	assert.equal(parseDateString('[[2026-05-13|Tuesday]]'), localTs(2026, 5, 13));
});

test('parseDateString falls back to the last path segment once the whole string fails', () => {
	// A compact, unseparated date has no anchor point for a search-based match,
	// so "Daily/20260513" only resolves once the folder is stripped off and
	// "20260513" is read on its own.
	assert.equal(parseDateString('Daily/20260513'), localTs(2026, 5, 13));
});

test('parseDateString finds a separated date embedded in a longer string without needing the path fallback', () => {
	assert.equal(parseDateString('Notes/Daily 2026-05-13 Wednesday'), localTs(2026, 5, 13));
});

test('parseDateString reads a string carrying an explicit time or zone as a real instant via Date.parse', () => {
	const parsed = parseDateString('2026-05-13T10:00:00Z');
	assert.equal(parsed, Date.parse('2026-05-13T10:00:00Z'));
});

test('parseDateString recognises a named month, and leaves a bare fragment unparsed', () => {
	assert.equal(parseDateString('13 May 2026'), localTs(2026, 5, 13));
	assert.equal(parseDateString('2026'), null, 'a leftover numeric fragment is not invented into January 1st');
});

test('parseDateString returns null for text with no date at all', () => {
	assert.equal(parseDateString('just some words'), null);
	assert.equal(parseDateString(''), null);
});

test('startOfLocalDay and localDayKey agree on the same calendar day', () => {
	const ts = new Date(2026, 4, 13, 23, 59).getTime();
	assert.equal(startOfLocalDay(ts), localTs(2026, 5, 13));
	assert.equal(localDayKey(ts), '2026-05-13');
});

test('addDays crosses a daylight-saving transition without shifting the hour of day', () => {
	// Whatever the local timezone's DST rule, adding whole days through Date
	// must land on the same wall-clock hour on the target day.
	const start = new Date(2026, 2, 1, 9, 0).getTime();
	const later = addDays(start, 30);
	assert.equal(new Date(later).getHours(), 9);
	assert.equal(new Date(later).getDate(), 31);
});

test('daysBetween counts whole calendar days regardless of time of day', () => {
	const from = new Date(2026, 4, 1, 23, 0).getTime();
	const to = new Date(2026, 4, 3, 1, 0).getTime();
	assert.equal(daysBetween(from, to), 2);
});
