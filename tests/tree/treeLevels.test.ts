import assert from 'node:assert/strict';
import test from 'node:test';
import type { BasesPropertyId } from 'obsidian';
import { resolveNestLevels } from '../../src/tree/treeLevels';
import { buildTreeModel } from '../../src/tree/treeModel';

const folder = 'file.folder' as BasesPropertyId;
const clazz = 'note.class' as BasesPropertyId;
const status = 'note.status' as BasesPropertyId;

function levels(overrides: Partial<Parameters<typeof resolveNestLevels>[0]> = {}): string[] {
	return resolveNestLevels({
		groupProperty: null,
		slots: [],
		legacyProperty: null,
		...overrides,
	}).map(String);
}

test('the legacy hierarchyProperty applies when the base does not group', () => {
	assert.deepEqual(levels({ legacyProperty: folder }), ['file.folder']);
});

test('the base Group by beats the legacy hierarchyProperty, which is the bug that shipped', () => {
	// Notionclasses.base carries both. Applying both nested the folder tree
	// inside itself.
	assert.deepEqual(levels({ groupProperty: folder, legacyProperty: folder }), []);
});

test('Group by wins over the legacy key even when they name different properties', () => {
	// The rule is about who owns the outermost level, not about collision:
	// once Bases has grouped, its answer stands.
	assert.deepEqual(levels({ groupProperty: folder, legacyProperty: clazz }), []);
});

test('a slot repeating the Group by property is skipped', () => {
	assert.deepEqual(levels({ groupProperty: folder, slots: [folder] }), []);
});

test('bare and note-prefixed spellings of the same property count as one', () => {
	// Bases writes `groupBy: class` bare while a view slot writes `note.class`.
	// Comparing raw strings would let both claim a level.
	assert.deepEqual(levels({ groupProperty: 'class' as BasesPropertyId, slots: [clazz] }), []);
});

test('a slot repeating an earlier slot is skipped', () => {
	assert.deepEqual(levels({ slots: [clazz, clazz, status] }), ['note.class', 'note.status']);
});

test('empty and null slots are dropped without stopping later ones', () => {
	assert.deepEqual(
		levels({ slots: [null, '' as BasesPropertyId, clazz] }),
		['note.class'],
	);
});

test('slots suppress the legacy key entirely', () => {
	assert.deepEqual(levels({ slots: [clazz], legacyProperty: folder }), ['note.class']);
});

test('a distinct slot still nests inside the Group by', () => {
	assert.deepEqual(levels({ groupProperty: folder, slots: [clazz] }), ['note.class']);
});

test('end to end: the doubled folder tree collapses to one', () => {
	// The exact shape from Notionclasses.base: groupBy file.folder plus a
	// legacy hierarchyProperty of file.folder, over one note.
	const entry = {
		file: { path: 'Skoo/CS 360/hw1.md', basename: 'hw1' },
		getValue: (id: BasesPropertyId) => (String(id) === 'file.folder' ? 'Skoo/CS 360' : null),
	};
	const nestBy = resolveNestLevels({ groupProperty: folder, slots: [], legacyProperty: folder });
	const model = buildTreeModel([{ key: 'Skoo/CS 360', entries: [entry] }], {
		nestBy,
		parentProperty: null,
		splitNestedValues: true,
		mergeFolderNotes: true,
	});

	const chainOf = (labels: string[], nodes = model.roots): string[] => {
		if (nodes.length === 0) return labels;
		return chainOf([...labels, nodes[0].label], nodes[0].children);
	};
	assert.deepEqual(chainOf([]), ['Skoo', 'CS 360', 'hw1']);
});
