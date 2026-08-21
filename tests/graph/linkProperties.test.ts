import assert from 'node:assert/strict';
import test from 'node:test';
import {
	LINK_PROPERTY_SLOT_COUNT,
	linkPropertySlotKey,
	linkPropertySlotKeys,
	resolveLinkProperties,
} from '../../src/graph/linkProperties';

test('a base with nothing set resolves to an empty list, which still means every property is a link', () => {
	// The semantics pin: empty has always meant "no filter". If this ever came
	// back non-empty for an untouched base, every graph in every vault would
	// suddenly draw only the properties this list happened to contain.
	assert.deepEqual(resolveLinkProperties([undefined, undefined, undefined, undefined], undefined), []);
	assert.deepEqual(resolveLinkProperties([], undefined), []);
});

test('slots alone resolve in the order they appear in the settings pane', () => {
	assert.deepEqual(
		resolveLinkProperties(['note.related', 'note.parent', undefined, undefined], undefined),
		['note.related', 'note.parent'],
	);
});

test('a legacy linkProperties array alone keeps working with no slots set', () => {
	// This is the whole compatibility contract: .base files on disk hold this
	// key and must keep filtering the same edges after the option changed type.
	assert.deepEqual(
		resolveLinkProperties([undefined, undefined, undefined, undefined], ['note.related', 'note.parent']),
		['note.related', 'note.parent'],
	);
});

test('slots and the legacy array are unioned, slots first, with duplicates collapsed', () => {
	assert.deepEqual(
		resolveLinkProperties(['note.related', 'note.owner'], ['note.parent', 'note.related']),
		['note.related', 'note.owner', 'note.parent'],
	);
});

test('bare frontmatter names are normalized before the dedupe, so class and note.class are one property', () => {
	// The bug this guards: a typed `class` never matched the extracted
	// `note.class`, and naming any link property at all emptied the graph.
	assert.deepEqual(resolveLinkProperties(['class'], undefined), ['note.class']);
	assert.deepEqual(resolveLinkProperties(['class'], ['note.class']), ['note.class']);
	assert.deepEqual(resolveLinkProperties(['note.class'], ['class']), ['note.class']);
	// file. and formula. ids are already fully qualified and must be left alone.
	assert.deepEqual(resolveLinkProperties(['file.tags', 'formula.Progress'], undefined), ['file.tags', 'formula.Progress']);
});

test('blank and non-string entries are dropped rather than coerced', () => {
	// An unset dropdown is the blank case, and it is the common one: read as a
	// real property it would filter every edge out.
	assert.deepEqual(resolveLinkProperties(['', '   ', null, 7, {}], undefined), []);
	assert.deepEqual(resolveLinkProperties(['note.related', ''], ['', null]), ['note.related']);
});

test('a legacy value that is not an array is ignored instead of being read as one property', () => {
	assert.deepEqual(resolveLinkProperties([], 'note.related'), []);
	assert.deepEqual(resolveLinkProperties(['note.owner'], { note: 'related' }), ['note.owner']);
});

test('a legacy array longer than the slot count is not truncated', () => {
	// Slots are capped at four, the stored array never was, so a base that
	// named more than four properties keeps all of them.
	const legacy = ['a', 'b', 'c', 'd', 'e', 'f'];
	assert.deepEqual(
		resolveLinkProperties([], legacy),
		['note.a', 'note.b', 'note.c', 'note.d', 'note.e', 'note.f'],
	);
});

test('slot keys are stable and distinct from the legacy key', () => {
	assert.equal(LINK_PROPERTY_SLOT_COUNT, 4);
	assert.deepEqual(linkPropertySlotKeys(), ['linkProperty1', 'linkProperty2', 'linkProperty3', 'linkProperty4']);
	assert.equal(linkPropertySlotKey(0), 'linkProperty1');
	assert.ok(!linkPropertySlotKeys().includes('linkProperties'), 'a slot must never collide with the legacy array key');
});
