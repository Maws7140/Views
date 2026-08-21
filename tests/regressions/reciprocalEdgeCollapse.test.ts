import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraphModel } from '../../src/logic/graphModel';
import { fakeEntry, fakeFrontmatterLink, fakeMetadataCache } from '../helpers/fakes';

/**
 * The reciprocal-collapse rule (documented on `buildGraphModel` in
 * src/logic/graphModel.ts): an unordered pair of notes collapses to one
 * `reciprocal: true` edge only when that pair has exactly one directed edge
 * each way. Getting this wrong either draws two overlapping arrows for an
 * ordinary two-way link (the common case a "Criticised by" / "Criticises"
 * pair produces) or silently merges two distinct relationships between the
 * same two notes into one line.
 */

test('a reciprocal pair (A links B, B links A) collapses to one edge', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('criticises', 'B.md')] } }],
		['B.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('criticisedBy', 'A.md')] } }],
	]), [a.file, b.file]);

	const model = buildGraphModel([a, b], cache, {});
	assert.equal(model.edges.length, 1);
	const [edge] = model.edges;
	assert.equal(edge.reciprocal, true);
	assert.equal(edge.from, 'A.md');
	assert.equal(edge.to, 'B.md');
	assert.equal(edge.label, 'criticises');
	assert.equal(edge.reciprocalLabel, 'criticisedBy');
});

test('a one-way pair (A links B, B does not link A) is not collapsed', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'B.md')] } }],
		['B.md', { cache: {} }],
	]), [a.file, b.file]);

	const model = buildGraphModel([a, b], cache, {});
	assert.equal(model.edges.length, 1);
	assert.equal(model.edges[0].reciprocal, false);
	assert.equal(model.edges[0].reciprocalLabel, undefined);
});

test('two different properties both pointing A to B stay two separate edges', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', {
			cache: {
				frontmatterLinks: [
					fakeFrontmatterLink('related', 'B.md'),
					fakeFrontmatterLink('inspiredBy', 'B.md'),
				],
			},
		}],
		['B.md', { cache: {} }],
	]), [a.file, b.file]);

	const model = buildGraphModel([a, b], cache, {});
	assert.equal(model.edges.length, 2, 'two distinct properties are not "the" reciprocal pair for each other');
	assert.ok(model.edges.every((edge) => edge.reciprocal === false));
	const labels = model.edges.map((edge) => edge.label).sort();
	assert.deepEqual(labels, ['inspiredBy', 'related']);
});

test('the same property linking A to B twice (array indices collapsing to one property) becomes one edge', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	// frontmatterLinks keys an array property's elements as related.0, related.1;
	// both point at the same target here, which is the duplicate this test guards.
	const cache = fakeMetadataCache(new Map([
		['A.md', {
			cache: {
				frontmatterLinks: [
					fakeFrontmatterLink('related.0', 'B.md'),
					fakeFrontmatterLink('related.1', 'B.md'),
				],
			},
		}],
		['B.md', { cache: {} }],
	]), [a.file, b.file]);

	const model = buildGraphModel([a, b], cache, {});
	assert.equal(model.edges.length, 1);
	assert.equal(model.edges[0].label, 'related');
});
