import assert from 'node:assert/strict';
import test from 'node:test';
import type { BasesPropertyId } from 'obsidian';
import { buildTreeModel, filterTree, type TreeGroup, type TreeModelOptions, type TreeNode } from '../../src/tree/treeModel';

/** Most tests exercise nesting inside a base with no Group by, which is what
 * Bases hands over as a single keyless group. `grouped` below covers the case
 * where the base does group. */
function ungrouped(entries: TreeGroup['entries']): TreeGroup[] {
	return [{ key: null, entries }];
}

function grouped(groups: [string | null, TreeGroup['entries']][]): TreeGroup[] {
	return groups.map(([key, entries]) => ({ key, entries }));
}

interface Fixture {
	path: string;
	values?: Record<string, unknown>;
}

function entry(fixture: Fixture) {
	const withoutFolder = fixture.path.slice(fixture.path.lastIndexOf('/') + 1);
	const dot = withoutFolder.lastIndexOf('.');
	return {
		file: {
			path: fixture.path,
			basename: dot > 0 ? withoutFolder.slice(0, dot) : withoutFolder,
		},
		getValue: (propertyId: BasesPropertyId) => (fixture.values ?? {})[String(propertyId)] ?? null,
	};
}

function options(overrides: Partial<TreeModelOptions> = {}): TreeModelOptions {
	return {
		nestBy: [],
		parentProperty: null,
		splitNestedValues: true,
		mergeFolderNotes: true,
		...overrides,
	};
}

/** Every label at a level, so a test can assert shape without depending on ids. */
function labels(nodes: TreeNode[]): string[] {
	return nodes.map((node) => node.label);
}

function find(nodes: TreeNode[], label: string): TreeNode {
	for (const node of nodes) {
		if (node.label === label) return node;
		const nested = findOrNull(node.children, label);
		if (nested) return nested;
	}
	throw new Error(`no node labelled ${label}`);
}

function findOrNull(nodes: TreeNode[], label: string): TreeNode | null {
	for (const node of nodes) {
		if (node.label === label) return node;
		const nested = findOrNull(node.children, label);
		if (nested) return nested;
	}
	return null;
}

const folder = 'file.folder' as BasesPropertyId;
const clazz = 'note.class' as BasesPropertyId;
const status = 'note.status' as BasesPropertyId;
const parent = 'note.parent' as BasesPropertyId;

test('a folder path splits into one level per segment rather than one flat row', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/notes.md', values: { 'file.folder': 'Skoo/CS 360' } }),
		entry({ path: 'Skoo/Math 230/notes.md', values: { 'file.folder': 'Skoo/Math 230' } }),
	]), options({ nestBy: [folder] }));

	assert.deepEqual(labels(model.roots), ['Skoo']);
	assert.deepEqual(labels(model.roots[0].children), ['CS 360', 'Math 230']);
});

test('splitting off produces one row per distinct full value, which is the table shape', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/notes.md', values: { 'file.folder': 'Skoo/CS 360' } }),
	]), options({ nestBy: [folder], splitNestedValues: false }));

	assert.deepEqual(labels(model.roots), ['Skoo/CS 360']);
});

test('the same segment under two different parents stays two rows', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/Daily/a.md', values: { 'file.folder': 'Skoo/Daily' } }),
		entry({ path: 'Meta/Daily/b.md', values: { 'file.folder': 'Meta/Daily' } }),
	]), options({ nestBy: [folder] }));

	// Insertion order, not alphabetical: Sort by is the base's control.
	assert.deepEqual(labels(model.roots), ['Skoo', 'Meta']);
	assert.deepEqual(labels(model.roots[0].children), ['Daily']);
	assert.deepEqual(labels(model.roots[1].children), ['Daily']);
	assert.notEqual(model.roots[0].children[0].id, model.roots[1].children[0].id);
});

test('a link value nests under the real note when the base returned it, not a twin beside it', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/CS 360.md' }),
		entry({ path: 'Skoo/CS 360/hw1.md', values: { 'note.class': '[[CS 360]]' } }),
	]), options({
		nestBy: [clazz],
		resolveNotePath: (linkpath) => (linkpath === 'CS 360' ? 'Skoo/CS 360/CS 360.md' : null),
	}));

	const hub = find(model.roots, 'CS 360');
	assert.equal(hub.path, 'Skoo/CS 360/CS 360.md', 'the container is the real note');
	assert.deepEqual(labels(hub.children), ['hw1']);
	// The hub note must not also appear as a loose row beside its own container.
	assert.equal(model.roots.filter((node) => node.label === 'CS 360').length, 1);
});

test('a link that resolves to nothing still nests, under its own text', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'a.md', values: { 'note.class': '[[Missing]]' } }),
	]), options({ nestBy: [clazz], resolveNotePath: () => null }));

	assert.deepEqual(labels(model.roots), ['Missing']);
	assert.equal(model.roots[0].path, undefined);
});

test('a folder note becomes its folder row instead of a child of it', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/CS 360.md', values: { 'file.folder': 'Skoo/CS 360' } }),
		entry({ path: 'Skoo/CS 360/hw1.md', values: { 'file.folder': 'Skoo/CS 360' } }),
	]), options({ nestBy: [folder] }));

	const course = find(model.roots, 'CS 360');
	assert.equal(course.path, 'Skoo/CS 360/CS 360.md');
	assert.deepEqual(labels(course.children), ['hw1'], 'the folder note is not also a child');
});

test('merging off leaves the folder note as an ordinary child', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/CS 360.md', values: { 'file.folder': 'Skoo/CS 360' } }),
		entry({ path: 'Skoo/CS 360/hw1.md', values: { 'file.folder': 'Skoo/CS 360' } }),
	]), options({ nestBy: [folder], mergeFolderNotes: false }));

	const course = find(model.roots, 'CS 360');
	assert.equal(course.path, undefined);
	assert.deepEqual(labels(course.children).sort(), ['CS 360', 'hw1']);
});

test('slots nest in order, outermost first', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'a.md', values: { 'note.status': 'open', 'note.class': 'CS 360' } }),
		entry({ path: 'b.md', values: { 'note.status': 'open', 'note.class': 'Math 230' } }),
		entry({ path: 'c.md', values: { 'note.status': 'done', 'note.class': 'CS 360' } }),
	]), options({ nestBy: [status, clazz] }));

	assert.deepEqual(labels(model.roots), ['open', 'done']);
	assert.deepEqual(labels(find(model.roots, 'open').children), ['CS 360', 'Math 230']);
});

test('a note missing one slot value still nests by the remaining slots', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'a.md', values: { 'note.class': 'CS 360' } }),
	]), options({ nestBy: [status, clazz] }));

	// No status, so the status level contributes nothing and class still does.
	assert.deepEqual(labels(model.roots), ['CS 360']);
	assert.deepEqual(labels(model.roots[0].children), ['a']);
});

test('a note no level can place surfaces at the root rather than vanishing', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'placed.md', values: { 'note.status': 'open' } }),
		entry({ path: 'unplaceable.md' }),
	]), options({ nestBy: [status] }));

	assert.deepEqual(labels(model.roots), ['open', 'unplaceable']);
	assert.equal(model.total, 2, 'every note the base returned is accounted for');
});

test('note counts are notes, not rows, and sum up the tree', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/a.md', values: { 'file.folder': 'Skoo/CS 360' } }),
		entry({ path: 'Skoo/CS 360/b.md', values: { 'file.folder': 'Skoo/CS 360' } }),
		entry({ path: 'Skoo/Math 230/c.md', values: { 'file.folder': 'Skoo/Math 230' } }),
	]), options({ nestBy: [folder] }));

	assert.equal(find(model.roots, 'Skoo').noteCount, 3);
	assert.equal(find(model.roots, 'CS 360').noteCount, 2);
	assert.equal(find(model.roots, 'Math 230').noteCount, 1);
});

test('a parent property builds a recursive chain three levels deep', () => {
	const paths = new Map([['a', 'a.md'], ['b', 'b.md'], ['c', 'c.md']]);
	const model = buildTreeModel(ungrouped([
		entry({ path: 'a.md' }),
		entry({ path: 'b.md', values: { 'note.parent': '[[a]]' } }),
		entry({ path: 'c.md', values: { 'note.parent': '[[b]]' } }),
	]), options({ parentProperty: parent, resolveNotePath: (link) => paths.get(link) ?? null }));

	assert.deepEqual(labels(model.roots), ['a']);
	assert.deepEqual(labels(model.roots[0].children), ['b']);
	assert.deepEqual(labels(model.roots[0].children[0].children), ['c']);
});

test('a parent cycle is broken rather than looping, and every note survives', () => {
	const paths = new Map([['a', 'a.md'], ['b', 'b.md']]);
	const model = buildTreeModel(ungrouped([
		entry({ path: 'a.md', values: { 'note.parent': '[[b]]' } }),
		entry({ path: 'b.md', values: { 'note.parent': '[[a]]' } }),
	]), options({ parentProperty: parent, resolveNotePath: (link) => paths.get(link) ?? null }));

	assert.equal(model.total, 2);
	// One of the two links wins and the other is refused; which one is stable,
	// but the shape that matters is that the result is a tree and not a loop.
	const reachable: string[] = [];
	const walk = (nodes: TreeNode[]): void => {
		for (const node of nodes) {
			reachable.push(node.label);
			walk(node.children);
		}
	};
	walk(model.roots);
	assert.deepEqual(reachable.sort(), ['a', 'b']);
});

test('a self-referential hub is not made its own parent', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/CS 360.md', values: { 'note.parent': '[[CS 360]]' } }),
	]), options({ parentProperty: parent, resolveNotePath: () => 'Skoo/CS 360/CS 360.md' }));

	assert.deepEqual(labels(model.roots), ['CS 360']);
	assert.equal(model.roots[0].children.length, 0);
});

test('only the first value of a multi-valued property is used, so counts still sum', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'a.md', values: { 'note.class': ['CS 360', 'Math 230'] } }),
	]), options({ nestBy: [clazz] }));

	assert.deepEqual(labels(model.roots), ['CS 360']);
	assert.equal(model.roots[0].noteCount, 1);
});

test('the same input builds the same tree twice', () => {
	const build = () => buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/b.md', values: { 'file.folder': 'Skoo/CS 360' } }),
		entry({ path: 'Skoo/Math 230/a.md', values: { 'file.folder': 'Skoo/Math 230' } }),
		entry({ path: 'loose.md' }),
	]), options({ nestBy: [folder] }));

	const shape = (nodes: TreeNode[]): unknown => nodes.map((node) => [node.id, shape(node.children)]);
	assert.deepEqual(shape(build().roots), shape(build().roots));
});

test('row order follows the base, which already applied Sort by', () => {
	// Bases hands entries over already sorted, so the tree must not re-sort
	// them: containers appear in the order their first note appears.
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/Zebra/a.md', values: { 'file.folder': 'Skoo/Zebra' } }),
		entry({ path: 'Skoo/Alpha/b.md', values: { 'file.folder': 'Skoo/Alpha' } }),
	]), options({ nestBy: [folder] }));

	assert.deepEqual(labels(find(model.roots, 'Skoo').children), ['Zebra', 'Alpha']);
});

test('a note ordered before a container by the base stays before it', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'loose.md' }),
		entry({ path: 'grouped.md', values: { 'note.status': 'open' } }),
	]), options({ nestBy: [status] }));

	assert.deepEqual(labels(model.roots), ['loose', 'open']);
});

test('the base Group by supplies the outermost level', () => {
	const model = buildTreeModel(grouped([
		['open', [entry({ path: 'a.md' })]],
		['done', [entry({ path: 'b.md' })]],
	]), options());

	assert.deepEqual(labels(model.roots), ['open', 'done']);
	assert.deepEqual(labels(model.roots[0].children), ['a']);
});

test('a group key splits on slashes, so grouping by file.folder is a folder tree', () => {
	const model = buildTreeModel(grouped([
		['Skoo/CS 360', [entry({ path: 'Skoo/CS 360/a.md' })]],
		['Skoo/Math 230', [entry({ path: 'Skoo/Math 230/b.md' })]],
	]), options());

	assert.deepEqual(labels(model.roots), ['Skoo']);
	assert.deepEqual(labels(model.roots[0].children), ['CS 360', 'Math 230']);
});

test('a group key and a nest-by slot compose, group outermost', () => {
	const model = buildTreeModel(grouped([
		['Skoo', [entry({ path: 'a.md', values: { 'note.class': 'CS 360' } })]],
	]), options({ nestBy: [clazz] }));

	assert.deepEqual(labels(model.roots), ['Skoo']);
	assert.deepEqual(labels(model.roots[0].children), ['CS 360']);
	assert.deepEqual(labels(model.roots[0].children[0].children), ['a']);
});

test('a keyless group adds no level, which is what no Group by looks like', () => {
	const model = buildTreeModel(grouped([[null, [entry({ path: 'a.md' })]]]), options());
	assert.deepEqual(labels(model.roots), ['a']);
});


test('filtering keeps ancestors of a match so a deep hit stays in context', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/damascus.md', values: { 'file.folder': 'Skoo/CS 360' } }),
		entry({ path: 'Skoo/Math 230/other.md', values: { 'file.folder': 'Skoo/Math 230' } }),
	]), options({ nestBy: [folder] }));

	const filtered = filterTree(model.roots, 'damascus');
	assert.deepEqual(labels(filtered), ['Skoo']);
	assert.deepEqual(labels(filtered[0].children), ['CS 360']);
	assert.deepEqual(labels(filtered[0].children[0].children), ['damascus']);
});

test('filtering does not mutate the model, so backspace restores the full tree', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'Skoo/CS 360/a.md', values: { 'file.folder': 'Skoo/CS 360' } }),
		entry({ path: 'Skoo/Math 230/b.md', values: { 'file.folder': 'Skoo/Math 230' } }),
	]), options({ nestBy: [folder] }));

	filterTree(model.roots, 'CS');
	assert.deepEqual(labels(find(model.roots, 'Skoo').children), ['CS 360', 'Math 230']);
});

test('no nesting slots is a flat list of notes, not an error', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'a.md' }),
		entry({ path: 'b.md' }),
	]), options());

	assert.deepEqual(labels(model.roots), ['a', 'b']);
	assert.equal(model.total, 2);
});

test('the same value under two different parents is two containers, not one shared bucket', () => {
	const model = buildTreeModel(ungrouped([
		entry({ path: 'a.md', values: { 'note.status': 'open', 'note.class': 'CS 360' } }),
		entry({ path: 'b.md', values: { 'note.status': 'done', 'note.class': 'CS 360' } }),
	]), options({ nestBy: [status, clazz] }));

	const open = find(model.roots, 'open');
	const done = find(model.roots, 'done');
	assert.deepEqual(labels(open.children), ['CS 360']);
	assert.deepEqual(labels(done.children), ['CS 360']);
	assert.notEqual(open.children[0].id, done.children[0].id);
	// The decisive part: neither bucket swallowed the other's notes.
	assert.deepEqual(labels(open.children[0].children), ['a']);
	assert.deepEqual(labels(done.children[0].children), ['b']);
});
