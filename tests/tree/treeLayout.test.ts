import assert from 'node:assert/strict';
import test from 'node:test';
import type { BasesPropertyId } from 'obsidian';
import { computeTreeLayout, isExpanded, type TreeLayoutOptions } from '../../src/tree/treeLayout';
import { buildTreeModel, type TreeEntryLike, type TreeModel } from '../../src/tree/treeModel';

const folder = 'file.folder' as BasesPropertyId;

function entry(path: string, folderValue: string): TreeEntryLike {
	const basename = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
	return {
		file: { path, basename },
		getValue: (id: BasesPropertyId) => (String(id) === 'file.folder' ? folderValue : null),
	};
}

/** `Skoo` over two courses, five notes. Deep enough that collapsing a branch
 * has something to hide and wide enough that the forest packing is exercised. */
function sampleModel(): TreeModel {
	return buildTreeModel(
		[{
			key: null,
			entries: [
				entry('Skoo/CS 360/hw1.md', 'Skoo/CS 360'),
				entry('Skoo/CS 360/hw2.md', 'Skoo/CS 360'),
				entry('Skoo/CS 221/lab1.md', 'Skoo/CS 221'),
				entry('Skoo/CS 221/lab2.md', 'Skoo/CS 221'),
				entry('Skoo/CS 221/lab3.md', 'Skoo/CS 221'),
			],
		}],
		{ nestBy: [folder], parentProperty: null, splitNestedValues: true, mergeFolderNotes: true },
	);
}

function options(overrides: Partial<TreeLayoutOptions> = {}): TreeLayoutOptions {
	return {
		orientation: 'leftToRight',
		nodeWidth: 160,
		nodeHeight: 32,
		siblingGap: 10,
		levelGap: 60,
		toggled: new Map(),
		expandToDepth: 10,
		...overrides,
	};
}

test('every visible node is placed exactly once', () => {
	const layout = computeTreeLayout(sampleModel(), options());
	// Skoo, two courses, five notes.
	assert.equal(layout.placed.length, 8);
	assert.equal(layout.byId.size, 8);
});

test('an edge is emitted for every parent-child pair drawn', () => {
	const layout = computeTreeLayout(sampleModel(), options());
	assert.equal(layout.edges.length, 7);
	for (const edge of layout.edges) {
		assert.ok(layout.byId.has(edge.parent.node.id));
		assert.ok(layout.byId.has(edge.child.node.id));
	}
});

test('a collapsed node is laid out as a leaf and its subtree is not placed', () => {
	// The point of pruning before layout rather than after: a hidden subtree
	// must not reserve space, or one open branch draws in a strip beside a
	// wide blank area.
	const toggled = new Map<string, boolean>([['Skoo/CS 221', false]]);
	const layout = computeTreeLayout(sampleModel(), options({ toggled }));

	const labels = layout.placed.map((p) => p.node.label);
	assert.ok(labels.includes('CS 221'));
	assert.ok(!labels.includes('lab1'));
	assert.ok(!labels.includes('lab3'));
	assert.equal(layout.placed.length, 5);
});

test('a collapsed node is flagged so the renderer can draw a twisty on it', () => {
	const toggled = new Map<string, boolean>([['Skoo/CS 221', false]]);
	const layout = computeTreeLayout(sampleModel(), options({ toggled }));
	const collapsed = layout.placed.filter((p) => p.collapsed).map((p) => p.node.label);
	assert.deepEqual(collapsed, ['CS 221']);
});

test('a leaf with nothing hidden is not flagged collapsed', () => {
	// A twisty on a real leaf would be a control that does nothing.
	const layout = computeTreeLayout(sampleModel(), options());
	assert.deepEqual(layout.placed.filter((p) => p.collapsed), []);
});

test('expandToDepth alone collapses without any toggle', () => {
	const layout = computeTreeLayout(sampleModel(), options({ expandToDepth: 1 }));
	assert.deepEqual(layout.placed.map((p) => p.node.label).sort(), ['CS 221', 'CS 360', 'Skoo']);
});

test('an explicit toggle beats expandToDepth in both directions', () => {
	const opened = new Map<string, boolean>([['Skoo/CS 360', true]]);
	const layout = computeTreeLayout(sampleModel(), options({ expandToDepth: 1, toggled: opened }));
	const labels = layout.placed.map((p) => p.node.label);
	assert.ok(labels.includes('hw1'), 'an explicitly opened row shows its children below the depth');
	assert.ok(!labels.includes('lab1'), 'its untouched sibling still follows the depth');
});

test('generations march along x when left to right, and along y when top down', () => {
	const model = sampleModel();
	const across = computeTreeLayout(model, options({ orientation: 'leftToRight' }));
	const down = computeTreeLayout(model, options({ orientation: 'topDown' }));

	const depthOf = (layout: ReturnType<typeof computeTreeLayout>, label: string) =>
		layout.placed.find((p) => p.node.label === label) as { x: number; y: number };

	assert.ok(depthOf(across, 'CS 360').x > depthOf(across, 'Skoo').x);
	assert.equal(depthOf(across, 'CS 360').y !== depthOf(across, 'CS 221').y, true);

	assert.ok(depthOf(down, 'CS 360').y > depthOf(down, 'Skoo').y);
	assert.equal(depthOf(down, 'CS 360').x !== depthOf(down, 'CS 221').x, true);
});

test('siblings never overlap along the cross axis', () => {
	const layout = computeTreeLayout(sampleModel(), options());
	const notes = layout.placed.filter((p) => p.node.kind === 'note').map((p) => p.y).sort((a, b) => a - b);
	for (let index = 1; index < notes.length; index += 1) {
		assert.ok(notes[index] - notes[index - 1] >= 32, `rows ${index - 1} and ${index} overlap`);
	}
});

test('the layout is stable across two identical runs', () => {
	// A diagram that shifted between renders would make every re-query look
	// like the tree changed.
	const first = computeTreeLayout(sampleModel(), options());
	const second = computeTreeLayout(sampleModel(), options());
	assert.deepEqual(
		first.placed.map((p) => [p.node.chain, p.x, p.y]),
		second.placed.map((p) => [p.node.chain, p.x, p.y]),
	);
});

test('an empty model lays out to nothing rather than throwing', () => {
	const empty = buildTreeModel([], {
		nestBy: [folder], parentProperty: null, splitNestedValues: true, mergeFolderNotes: true,
	});
	const layout = computeTreeLayout(empty, options());
	assert.deepEqual(layout.placed, []);
	assert.deepEqual(layout.edges, []);
});

test('isExpanded is keyed by chain, so a level reorder does not invalidate it', () => {
	const model = sampleModel();
	const course = model.roots[0].children[0];
	assert.equal(course.chain, 'Skoo/CS 360');
	assert.equal(isExpanded(course, { toggled: new Map(), expandToDepth: 10 }), true);
	assert.equal(
		isExpanded(course, { toggled: new Map([['Skoo/CS 360', false]]), expandToDepth: 10 }),
		false,
	);
});
