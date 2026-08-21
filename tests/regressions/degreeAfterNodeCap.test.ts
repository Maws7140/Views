import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraphModel } from '../../src/logic/graphModel';
import { fakeEntry, fakeFrontmatterLink, fakeMetadataCache } from '../helpers/fakes';

/**
 * What shipped: `GraphNode.degree` was left at its pre-cap value after
 * `nodeCap` dropped nodes and the edges that touched them. A kept node could
 * claim eight neighbours while only two of its edges survived the cap, which
 * is a graph the renderer was not drawing: anything sizing or ranking a node
 * by degree read a number with nothing on screen to back it up. Fix in
 * src/logic/graphModel.ts recomputes degree from `finalEdges` after the cap.
 */

test('degree after a node cap counts only the edges that survived the cap', () => {
	// A hub with five spokes, plus one extra note that links to nothing kept.
	// hub degree pre-cap is 5. Capping to 3 keeps the hub and its two highest
	// -priority neighbours (id order breaks the degree tie among the spokes),
	// so the hub's post-cap degree must read 2, not the pre-cap 5.
	const hub = fakeEntry('Hub.md', {});
	const spokes = ['S1.md', 'S2.md', 'S3.md', 'S4.md', 'S5.md'].map((path) => fakeEntry(path, {}));
	const allEntries = [hub, ...spokes];

	const filesByPath = new Map<string, { cache: { frontmatterLinks: ReturnType<typeof fakeFrontmatterLink>[] } }>();
	filesByPath.set('Hub.md', {
		cache: { frontmatterLinks: spokes.map((spoke) => fakeFrontmatterLink('related', spoke.file.path)) },
	});
	for (const spoke of spokes) filesByPath.set(spoke.file.path, { cache: { frontmatterLinks: [] } });

	const cache = fakeMetadataCache(filesByPath, allEntries.map((entry) => entry.file));
	const model = buildGraphModel(allEntries, cache, { nodeCap: 3 });

	assert.ok(model.truncated, 'a cap that actually drops nodes must report truncated');
	assert.equal(model.truncated?.shown, 3);
	assert.equal(model.truncated?.total, 6);
	assert.equal(model.nodes.length, 3);

	const hubNode = model.nodes.find((node) => node.id === 'Hub.md');
	assert.ok(hubNode, 'the highest-degree node (the hub) must survive the cap');
	// Only 2 spokes survived alongside the hub, so exactly 2 edges touch the
	// hub post-cap. Pre-cap degree was 5; asserting the stale value was
	// exactly the bug.
	assert.equal(hubNode?.degree, 2);
	assert.equal(model.edges.length, 2);

	for (const edge of model.edges) {
		assert.equal(edge.from, 'Hub.md');
	}

	// Every surviving node's degree must equal how many surviving edges
	// actually touch it, not the number the un-capped graph would have shown.
	for (const node of model.nodes) {
		const touching = model.edges.filter((edge) => edge.from === node.id || edge.to === node.id).length;
		assert.equal(node.degree, touching, `${node.id} degree must match its surviving edge count`);
	}
});

test('a cap that keeps every node reports no truncation and leaves degree untouched', () => {
	const a = fakeEntry('A.md', {});
	const b = fakeEntry('B.md', {});
	const cache = fakeMetadataCache(new Map([
		['A.md', { cache: { frontmatterLinks: [fakeFrontmatterLink('related', 'B.md')] } }],
		['B.md', { cache: {} }],
	]), [a.file, b.file]);
	const model = buildGraphModel([a, b], cache, { nodeCap: 10 });
	assert.equal(model.truncated, null);
	assert.equal(model.nodes.find((node) => node.id === 'A.md')?.degree, 1);
	assert.equal(model.nodes.find((node) => node.id === 'B.md')?.degree, 1);
});
