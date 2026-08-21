import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraphModel, normalizePropertyId } from '../../src/logic/graphModel';
import { fakeEntry, fakeFrontmatterLink, fakeMetadataCache } from '../helpers/fakes';

test('an array property\'s frontmatterLinks keys (related.0, related.1) strip to one edge property', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const c = fakeEntry('C.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', {
			cache: {
				frontmatterLinks: [
					fakeFrontmatterLink('related.0', 'B.md'),
					fakeFrontmatterLink('related.1', 'C.md'),
				],
			},
		}],
		['B.md', { cache: {} }],
		['C.md', { cache: {} }],
	]), [a.file, b.file, c.file]);

	const model = buildGraphModel([a, b, c], cache, {});
	assert.equal(model.edges.length, 2);
	assert.ok(model.edges.every((edge) => edge.label === 'related'));
	assert.ok(model.edges.every((edge) => edge.property === 'note.related'));
});

test('a link with no resolvable file becomes an unresolved node once outside links are asked for', () => {
	const a = fakeEntry('A.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'Nowhere')] } }],
	]), [a.file]);

	const model = buildGraphModel([a], cache, { includeExternalLinks: true });
	assert.equal(model.nodes.length, 2);
	const unresolved = model.nodes.find((node) => node.kind === 'unresolved');
	assert.ok(unresolved);
	assert.equal(unresolved?.label, 'Nowhere');
	assert.equal(model.edges.length, 1);
	assert.equal(model.edges[0].to, unresolved?.id);
});

test('the same unresolved link text from two notes converges on one unresolved node', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'Ghost')] } }],
		['B.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'Ghost')] } }],
	]), [a.file, b.file]);

	const model = buildGraphModel([a, b], cache, { includeExternalLinks: true });
	const unresolvedNodes = model.nodes.filter((node) => node.kind === 'unresolved');
	assert.equal(unresolvedNodes.length, 1);
	assert.equal(model.edges.length, 2);
});

test('the same property value from different notes converges on one value node', () => {
	const a = fakeEntry('A.md', { status: 'Done' });
	const b = fakeEntry('B.md', { status: 'Done' });
	const c = fakeEntry('C.md', { status: 'In progress' });
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: {} }],
		['B.md', { cache: {} }],
		['C.md', { cache: {} }],
	]), [a.file, b.file, c.file]);

	const model = buildGraphModel([a, b, c], cache, { valueNodeProperties: ['note.status'] });
	const valueNodes = model.nodes.filter((node) => node.kind === 'value');
	assert.equal(valueNodes.length, 2, 'Done converges to one node, In progress is a second');
	const doneNode = valueNodes.find((node) => node.label === 'Done');
	assert.ok(doneNode);
	assert.equal(doneNode?.degree, 2, 'both A and B point at the same Done node');
});

test('a value node is not created twice for the same note and value even if getValue is asked more than once', () => {
	const a = fakeEntry('A.md', { status: 'Done' });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, { valueNodeProperties: ['note.status'] });
	assert.equal(model.edges.length, 1);
});

test('a link to a non-markdown file is dropped by default (includeAttachments off)', () => {
	const a = fakeEntry('A.md', {});
	const image = fakeEntry('cover.png', {}, 'png');
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('cover', 'cover.png')] } }],
	]), [a.file, image.file]);

	const model = buildGraphModel([a], cache, {});
	assert.equal(model.nodes.length, 1, 'only A.md; the image is not drawn as a node');
	assert.equal(model.edges.length, 0);
});

test('a link to a non-markdown file becomes a node when includeAttachments is on', () => {
	const a = fakeEntry('A.md', {});
	const image = fakeEntry('cover.png', {}, 'png');
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('cover', 'cover.png')] } }],
	]), [a.file, image.file]);

	const model = buildGraphModel([a], cache, { includeAttachments: true });
	assert.equal(model.nodes.length, 2);
	assert.equal(model.edges.length, 1);
});

test('linkProperties filters which frontmatter properties become edges', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const c = fakeEntry('C.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', {
			cache: {
				frontmatterLinks: [
					fakeFrontmatterLink('related', 'B.md'),
					fakeFrontmatterLink('seeAlso', 'C.md'),
				],
			},
		}],
		['B.md', { cache: {} }],
		['C.md', { cache: {} }],
	]), [a.file, b.file, c.file]);

	const model = buildGraphModel([a, b, c], cache, { linkProperties: ['note.related'] });
	assert.equal(model.edges.length, 1);
	assert.equal(model.edges[0].property, 'note.related');
	// C.md is never linked to under this filter, but every passed-in entry is
	// still a node regardless of whether anything points at it.
	assert.equal(model.nodes.length, 3);
});

test('a node cap prefers the highest-degree nodes and reports truncated', () => {
	const hub = fakeEntry('Hub.md', {});
	const leaves = ['L1.md', 'L2.md', 'L3.md', 'L4.md'].map((path) => fakeEntry(path, {}));
	const loner = fakeEntry('Loner.md', {});
	const entries = [hub, ...leaves, loner];

	const filesByPath = new Map<string, { cache: { frontmatterLinks: ReturnType<typeof fakeFrontmatterLink>[] } }>();
	filesByPath.set('Hub.md', { cache: { frontmatterLinks: leaves.map((leaf) => fakeFrontmatterLink('related', leaf.file.path)) } });
	for (const leaf of leaves) filesByPath.set(leaf.file.path, { cache: { frontmatterLinks: [] } });
	filesByPath.set('Loner.md', { cache: { frontmatterLinks: [] } });

	const cache = fakeMetadataCache(filesByPath, entries.map((entry) => entry.file));
	const model = buildGraphModel(entries, cache, { nodeCap: 3 });

	assert.deepEqual(model.truncated, { shown: 3, total: 6 });
	assert.ok(model.nodes.some((node) => node.id === 'Hub.md'), 'the hub (degree 4) must survive the cap');
	assert.ok(!model.nodes.some((node) => node.id === 'Loner.md'), 'the degree-0 loner is the first to go');
});

test('an entry with no links of its own is still a node', () => {
	const isolated = fakeEntry('Isolated.md', {});
	const cache = fakeMetadataCache(new Map([['Isolated.md', { cache: {} }]]), [isolated.file]);
	const model = buildGraphModel([isolated], cache, {});
	assert.equal(model.nodes.length, 1);
	assert.equal(model.nodes[0].degree, 0);
});

test('typeProperty and the icon resolver fill note nodes from the matching entry', () => {
	const a = fakeEntry('A.md', { kind: 'Person', glyph: 'user' });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	// Icons arrive through a caller-supplied resolver rather than a property
	// id, which is what keeps this module free of Obsidian at runtime while
	// still giving a node the same icon chain its card gets.
	const model = buildGraphModel([a], cache, {
		typeProperty: 'note.kind',
		resolveIcons: (entry) => [String(entry.getValue('note.glyph' as never))],
	});
	assert.equal(model.nodes[0].typeValue, 'Person');
	assert.deepEqual(model.nodes[0].icons, ['user']);
});

test('a note node with no icon resolver gets an empty icon chain, not a null', () => {
	const a = fakeEntry('A.md', {});
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, {});
	assert.deepEqual(model.nodes[0].icons, []);
});

test('a link to a note the base did not return draws nothing by default', () => {
	// The base filtered B out: only A is an entry. B is still a real note in
	// the vault, so the link resolves, and drawing it would put a filtered-out
	// note back on the canvas.
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'B.md')] } }],
		['B.md', { cache: {} }],
	]), [a.file, b.file]);

	const model = buildGraphModel([a], cache, {});
	assert.deepEqual(model.nodes.map((node) => node.id), ['A.md']);
	assert.equal(model.edges.length, 0);
});

test('the same link is drawn once the base is asked for notes outside it', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'B.md')] } }],
		['B.md', { cache: {} }],
	]), [a.file, b.file]);

	const model = buildGraphModel([a], cache, { includeExternalLinks: true });
	assert.equal(model.nodes.length, 2);
	assert.equal(model.edges.length, 1);
	assert.equal(model.edges[0].to, 'B.md');
});

test('an unresolved link draws nothing by default either, being no more in the base than a filtered-out note', () => {
	const a = fakeEntry('A.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'Nowhere')] } }],
	]), [a.file]);

	const model = buildGraphModel([a], cache, {});
	assert.deepEqual(model.nodes.map((node) => node.id), ['A.md']);
	assert.equal(model.edges.length, 0);
});

test('a link between two notes the base did return is drawn without asking for anything', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'B.md')] } }],
		['B.md', { cache: {} }],
	]), [a.file, b.file]);

	const model = buildGraphModel([a, b], cache, {});
	assert.equal(model.nodes.length, 2);
	assert.equal(model.edges.length, 1);
});

test('attachments stay on their own toggle rather than being folded into outside links', () => {
	// An attachment is never a base result, so requiring both toggles would
	// make `includeAttachments` unreachable.
	const a = fakeEntry('A.md', {});
	const cover = { path: 'banner.png', extension: 'png' };
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('cover', 'banner.png')] } }],
	]), [a.file, cover]);

	assert.equal(buildGraphModel([a], cache, {}).nodes.length, 1);
	assert.equal(buildGraphModel([a], cache, { includeAttachments: true }).nodes.length, 2);
});

test('value nodes are unaffected: they come from the base entries themselves', () => {
	const a = fakeEntry('A.md', { status: 'Done' });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, { valueNodeProperties: ['note.status'] });
	assert.equal(model.nodes.filter((node) => node.kind === 'value').length, 1);
	assert.equal(model.edges.length, 1);
});

test('a group becomes one value node with an edge from every entry in it', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const c = fakeEntry('C.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: {} }],
		['B.md', { cache: {} }],
		['C.md', { cache: {} }],
	]), [a.file, b.file, c.file]);

	const model = buildGraphModel([a, b, c], cache, {
		valueGroups: [
			{ label: 'Done', paths: ['A.md', 'B.md'] },
			{ label: 'In progress', paths: ['C.md'] },
		],
	});

	const valueNodes = model.nodes.filter((node) => node.kind === 'value');
	assert.deepEqual(valueNodes.map((node) => node.label).sort(), ['Done', 'In progress']);
	const done = valueNodes.find((node) => node.label === 'Done');
	assert.ok(done);
	assert.equal(done.degree, 2);
	assert.equal(model.edges.length, 3);
});

test('group edges carry no label, since the group node is already the label', () => {
	// The Bases API never exposes the property a group grouped by, and printing
	// it over every edge is what made `status` appear dozens of times across one
	// knot of lines.
	const a = fakeEntry('A.md', {});
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, { valueGroups: [{ label: 'Done', paths: ['A.md'] }] });
	assert.equal(model.edges.length, 1);
	assert.equal(model.edges[0].label, null);
	assert.equal(model.edges[0].property, null);
});

test('a group naming an entry the graph does not hold draws no edge to nothing', () => {
	const a = fakeEntry('A.md', {});
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	// `Gone.md` was dropped by the node cap or is simply not in this result.
	const model = buildGraphModel([a], cache, {
		valueGroups: [{ label: 'Done', paths: ['A.md', 'Gone.md', 'A.md'] }],
	});
	assert.equal(model.edges.length, 1, 'one edge, and the duplicate path did not double it');
	assert.ok(model.nodes.every((node) => node.id !== 'Gone.md'));
});

test('an empty or null group label makes no node', () => {
	const a = fakeEntry('A.md', {});
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, {
		valueGroups: [{ label: '', paths: ['A.md'] }, { label: 'null', paths: ['A.md'] }],
	});
	assert.deepEqual(model.nodes.map((node) => node.id), ['A.md']);
	assert.equal(model.edges.length, 0);
});

test('a group node and a legacy value node of the same name stay separate', () => {
	const a = fakeEntry('A.md', { status: 'Done' });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, {
		valueGroups: [{ label: 'Done', paths: ['A.md'] }],
		valueNodeProperties: ['note.status'],
	});
	const valueNodes = model.nodes.filter((node) => node.kind === 'value');
	assert.equal(valueNodes.length, 2, 'group:Done and note.status:Done are different nodes');
	assert.equal(model.edges.length, 2);
});

test('a bare frontmatter name normalizes to a full property id, a full one is left alone', () => {
	assert.equal(normalizePropertyId('class'), 'note.class');
	assert.equal(normalizePropertyId('note.class'), 'note.class');
	assert.equal(normalizePropertyId('file.tags'), 'file.tags');
	assert.equal(normalizePropertyId('formula.Progress'), 'formula.Progress');
	// Not a source prefix, so it is a frontmatter name with a dot in it.
	assert.equal(normalizePropertyId('my.thing'), 'note.my.thing');
});

test('naming a link property by its bare name filters to it rather than to nothing', () => {
	// The bug this pins: `Link properties` held what the user typed (`related`)
	// while extraction matched `note.related`, so naming any property at all
	// emptied the graph instead of narrowing it.
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const c = fakeEntry('C.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', {
			cache: {
				frontmatterLinks: [
					fakeFrontmatterLink('related', 'B.md'),
					fakeFrontmatterLink('cover', 'C.md'),
				],
			},
		}],
		['B.md', { cache: {} }],
		['C.md', { cache: {} }],
	]), [a.file, b.file, c.file]);

	const model = buildGraphModel([a, b, c], cache, {
		linkProperties: [normalizePropertyId('related')],
	});
	assert.equal(model.edges.length, 1);
	assert.equal(model.edges[0].property, 'note.related');
});

test('connect by a plain text property makes one node per value, with lines from every note carrying it', () => {
	const a = fakeEntry('A.md', { status: 'unread' });
	const b = fakeEntry('B.md', { status: 'unread' });
	const c = fakeEntry('C.md', { status: 'done' });
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: {} }], ['B.md', { cache: {} }], ['C.md', { cache: {} }],
	]), [a.file, b.file, c.file]);

	const model = buildGraphModel([a, b, c], cache, { connectByProperties: ['note.status'] });
	const values = model.nodes.filter((node) => node.kind === 'value');
	assert.deepEqual(values.map((node) => node.label).sort(), ['done', 'unread']);
	const unread = values.find((node) => node.label === 'unread');
	assert.ok(unread);
	assert.equal(unread.degree, 2, 'both notes carrying unread hang off the one node');
	assert.equal(model.edges.length, 3, 'one line per note, never a line per pair');
});

test('a value node carries its own value as its type value, which is what colours it', () => {
	const a = fakeEntry('A.md', { status: 'unread' });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, {
		connectByProperties: ['note.status'],
		connectByIcon: 'lucide-tag',
	});
	const value = model.nodes.find((node) => node.kind === 'value');
	assert.ok(value);
	assert.equal(value.typeValue, 'unread', 'without this the renderer falls through to neutral grey');
	assert.deepEqual(value.icons, ['lucide-tag']);
});

test('the same value under two properties stays two nodes', () => {
	const a = fakeEntry('A.md', { status: 'done', phase: 'done' });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, { connectByProperties: ['note.status', 'note.phase'] });
	assert.equal(model.nodes.filter((node) => node.kind === 'value').length, 2);
	assert.equal(model.edges.length, 2);
});

test('a value that names a real note connects to that note rather than a copy of it', () => {
	// The duplicate-node complaint: `class: "[[CS 221]]"` used to draw a
	// synthetic CS 221 beside the real note already on the canvas, splitting its
	// edges between the two.
	const a = fakeEntry('A.md', { class: '[[CS 221]]' });
	const b = fakeEntry('B.md', { class: 'CS 221' });
	const cs = fakeEntry('CS 221.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: {} }], ['B.md', { cache: {} }], ['CS 221.md', { cache: {} }],
	]), [a.file, b.file, cs.file]);

	const model = buildGraphModel([a, b, cs], cache, { connectByProperties: ['note.class'] });
	assert.equal(model.nodes.filter((node) => node.kind === 'value').length, 0, 'no synthetic twin');
	assert.deepEqual(model.nodes.map((node) => node.id).sort(), ['A.md', 'B.md', 'CS 221.md']);
	// Both forms, the wikilink and the plain name, land on the same real note.
	assert.equal(model.edges.length, 2);
	assert.ok(model.edges.every((edge) => edge.to === 'CS 221.md'));
	const hub = model.nodes.find((node) => node.id === 'CS 221.md');
	assert.equal(hub?.degree, 2, 'the real note is the hub, which is the look being preserved');
});

test('connecting by a link property draws the edge extraction already drew, not a second one', () => {
	const a = fakeEntry('A.md', { class: '[[CS 221]]' });
	const cs = fakeEntry('CS 221.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('class', 'CS 221')] } }],
		['CS 221.md', { cache: {} }],
	]), [a.file, cs.file]);

	const model = buildGraphModel([a, cs], cache, { connectByProperties: ['note.class'] });
	assert.equal(model.edges.length, 1, 'the dedup key is shared, so the two paths collapse');
	assert.equal(model.edges[0].property, 'note.class');
});

test('a value written as a link that resolves to nothing reads as a broken link, not a category', () => {
	const a = fakeEntry('A.md', { class: '[[Nowhere]]' });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, {
		connectByProperties: ['note.class'],
		includeExternalLinks: true,
	});
	const unresolved = model.nodes.find((node) => node.kind === 'unresolved');
	assert.ok(unresolved, 'a written link that goes nowhere is a broken link');
	assert.equal(unresolved.label, 'Nowhere');
});

test('an alias or heading in a linked value still finds the note', () => {
	const a = fakeEntry('A.md', { class: '[[CS 221|my class]]' });
	const b = fakeEntry('B.md', { class: '[[CS 221#Week 1]]' });
	const cs = fakeEntry('CS 221.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: {} }], ['B.md', { cache: {} }], ['CS 221.md', { cache: {} }],
	]), [a.file, b.file, cs.file]);
	const model = buildGraphModel([a, b, cs], cache, { connectByProperties: ['note.class'] });
	assert.equal(model.edges.length, 2);
	assert.ok(model.edges.every((edge) => edge.to === 'CS 221.md'));
});

test('a list property connects a note to every value in the list', () => {
	const a = fakeEntry('A.md', { tags: ['work', 'urgent'] });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, { connectByProperties: ['note.tags'] });
	assert.equal(model.nodes.filter((node) => node.kind === 'value').length, 2);
	assert.equal(model.edges.length, 2);
});

test('empty and null-ish values connect to nothing', () => {
	const a = fakeEntry('A.md', { status: '' });
	const b = fakeEntry('B.md', { status: 'null' });
	const c = fakeEntry('C.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: {} }], ['B.md', { cache: {} }], ['C.md', { cache: {} }],
	]), [a.file, b.file, c.file]);
	const model = buildGraphModel([a, b, c], cache, { connectByProperties: ['note.status'] });
	assert.equal(model.nodes.filter((node) => node.kind === 'value').length, 0);
	assert.equal(model.edges.length, 0);
});

test('a note whose value names itself draws no line to itself', () => {
	const cs = fakeEntry('CS 221.md', { class: '[[CS 221]]' });
	const cache = fakeMetadataCache(new Map([['CS 221.md', { cache: {} }]]), [cs.file]);
	const model = buildGraphModel([cs], cache, { connectByProperties: ['note.class'] });
	assert.equal(model.edges.length, 0);
});

test('a value naming a note outside the base stays a value node unless outside links are asked for', () => {
	const a = fakeEntry('A.md', { class: 'CS 221' });
	const cs = fakeEntry('CS 221.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: {} }], ['CS 221.md', { cache: {} }],
	]), [a.file, cs.file]);

	// CS 221 exists in the vault but the base did not return it.
	const filtered = buildGraphModel([a], cache, { connectByProperties: ['note.class'] });
	assert.equal(filtered.nodes.filter((node) => node.kind === 'value').length, 1);
	assert.ok(filtered.nodes.every((node) => node.id !== 'CS 221.md'));

	const opened = buildGraphModel([a], cache, {
		connectByProperties: ['note.class'],
		includeExternalLinks: true,
	});
	assert.ok(opened.nodes.some((node) => node.id === 'CS 221.md'));
});
