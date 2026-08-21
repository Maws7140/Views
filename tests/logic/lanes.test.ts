import assert from 'node:assert/strict';
import test from 'node:test';
import { applyManualOrder, NO_LANE_KEY, partitionGroupsIntoLanes } from '../../src/logic/lanes';
import type { BasesEntry, BasesEntryGroup } from 'obsidian';

function entry(values: Record<string, unknown>): BasesEntry {
	return {
		getValue: (property: string) => {
			const key = property.startsWith('note.') ? property.slice('note.'.length) : property;
			const value = values[key];
			return value === undefined ? null : { toString: () => String(value) };
		},
	} as unknown as BasesEntry;
}

function group(key: string, entries: BasesEntry[]): BasesEntryGroup {
	return { key, entries } as unknown as BasesEntryGroup;
}

test('partitionGroupsIntoLanes splits each column by first appearance of the lane value', () => {
	const groups = [
		group('col1', [entry({ assignee: 'Alice' }), entry({ assignee: 'Bob' })]),
		group('col2', [entry({ assignee: 'Bob' })]),
	];
	const partition = partitionGroupsIntoLanes(groups, 'note.assignee', 'assignee', (g) => (g as unknown as { key: string }).key);
	assert.deepEqual(partition.lanes.map((l) => l.key), ['Alice', 'Bob']);

	// Every column gets a cell for every lane, even where that lane has no
	// entries in that column.
	assert.equal(partition.cells.get('col1')?.get('Alice')?.length, 1);
	assert.equal(partition.cells.get('col1')?.get('Bob')?.length, 1);
	assert.equal(partition.cells.get('col2')?.get('Alice')?.length, 0);
	assert.equal(partition.cells.get('col2')?.get('Bob')?.length, 1);
});

test('a missing lane property value falls into the "no lane" bucket', () => {
	const groups = [group('col1', [entry({})])];
	const partition = partitionGroupsIntoLanes(groups, 'note.assignee', 'assignee', (g) => (g as unknown as { key: string }).key);
	assert.deepEqual(partition.lanes.map((l) => l.key), [NO_LANE_KEY]);
	assert.equal(partition.lanes[0].label, 'No assignee');
});

test('a list-valued lane property uses only its first value', () => {
	const groups = [group('col1', [entry({ assignee: 'Alice, Bob' })])];
	const partition = partitionGroupsIntoLanes(groups, 'note.assignee', 'assignee', (g) => (g as unknown as { key: string }).key);
	assert.deepEqual(partition.lanes.map((l) => l.key), ['Alice']);
});

test('with no lane property every entry lands in the single unlabeled lane', () => {
	const groups = [group('col1', [entry({ assignee: 'Alice' })])];
	const partition = partitionGroupsIntoLanes(groups, null, 'assignee', (g) => (g as unknown as { key: string }).key);
	assert.deepEqual(partition.lanes.map((l) => l.key), [NO_LANE_KEY]);
	assert.equal(partition.lanes[0].label, '');
});

test('applyManualOrder ranks known keys by the saved order and appends unknown keys in discovered order', () => {
	const items = [{ key: 'c' }, { key: 'a' }, { key: 'b' }, { key: 'new' }];
	const ordered = applyManualOrder(items, ['a', 'b', 'c']);
	assert.deepEqual(ordered.map((i) => i.key), ['a', 'b', 'c', 'new']);
});

test('applyManualOrder with an empty saved order leaves the items untouched', () => {
	const items = [{ key: 'z' }, { key: 'a' }];
	const ordered = applyManualOrder(items, []);
	assert.equal(ordered, items);
});

test('applyManualOrder: a hidden key (absent from the current items) does not disturb the rank of the ones present', () => {
	// "hidden key keeps its rank" per the plan: the saved order can carry a key
	// for an item that is not currently in `items` (filtered out, deleted); the
	// items that remain still sort by their own position in that saved order.
	const items = [{ key: 'c' }, { key: 'a' }];
	const ordered = applyManualOrder(items, ['a', 'hidden', 'b', 'c']);
	assert.deepEqual(ordered.map((i) => i.key), ['a', 'c']);
});
