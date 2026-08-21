import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraphModel } from '../../src/logic/graphModel';
import { fakeEntry, fakeFrontmatterLink, fakeMetadataCache, stringWrapper } from '../helpers/fakes';

/**
 * What shipped: a Bases `Value` wrapper for an empty property stringifies to
 * the literal text `null` (or `undefined`), which is not the same as the
 * property actually holding that string. The old check only asked whether
 * the stringified text was non-empty, so an empty `status` property put a
 * node labelled "null" on the canvas. Root cause and fix both live in
 * `isMeaningfulValue`/`stringifyValue` in src/logic/graphModel.ts.
 */

test('an empty value-node property does not put a "null" node on the canvas', () => {
	const a = fakeEntry('A.md', { status: stringWrapper('null') });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, { valueNodeProperties: ['note.status'] });
	assert.equal(model.nodes.length, 1, 'only the note itself, no value node');
	assert.equal(model.edges.length, 0);
});

test('an "undefined"-stringifying value-node property is likewise dropped', () => {
	const a = fakeEntry('A.md', { status: stringWrapper('undefined') });
	const cache = fakeMetadataCache(new Map([['A.md', { cache: {} }]]), [a.file]);
	const model = buildGraphModel([a], cache, { valueNodeProperties: ['note.status'] });
	assert.equal(model.nodes.length, 1);
	assert.equal(model.edges.length, 0);
});

test('an empty or whitespace-only value-node property is dropped, a real value is kept', () => {
	const empty = fakeEntry('Empty.md', { status: '' });
	const whitespace = fakeEntry('Whitespace.md', { status: '   ' });
	const real = fakeEntry('Real.md', { status: 'Done' });
	const cache = fakeMetadataCache(new Map([
		['Empty.md', { cache: {} }],
		['Whitespace.md', { cache: {} }],
		['Real.md', { cache: {} }],
	]), [empty.file, whitespace.file, real.file]);
	const model = buildGraphModel([empty, whitespace, real], cache, { valueNodeProperties: ['note.status'] });

	const valueNodes = model.nodes.filter((node) => node.kind === 'value');
	assert.equal(valueNodes.length, 1);
	assert.equal(valueNodes[0].label, 'Done');
});

test('a "null"-stringifying link target is not put on the canvas as an unresolved node', () => {
	// The link path: `resolveLinkTarget` runs the same `isMeaningfulValue`
	// check against `ref.link` before ever asking the metadata cache to
	// resolve it, so a link whose text is the literal "null" never becomes an
	// unresolved node either.
	const a = fakeEntry('A.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'null')] } }],
	]), [a.file]);
	const model = buildGraphModel([a], cache, {});
	assert.equal(model.nodes.length, 1, 'only A.md, no node for the "null" link text');
	assert.equal(model.edges.length, 0);
});

test('a real link target is still resolved once the null-text case is excluded', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'B')] } }],
		['B.md', { cache: {} }],
	]), [a.file, b.file]);
	const model = buildGraphModel([a, b], cache, {});
	assert.equal(model.nodes.length, 2);
	assert.equal(model.edges.length, 1);
	assert.equal(model.edges[0].from, 'A.md');
	assert.equal(model.edges[0].to, 'B.md');
});
