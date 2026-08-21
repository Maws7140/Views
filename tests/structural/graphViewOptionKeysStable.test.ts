import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { linkPropertySlotKeys } from '../../src/graph/linkProperties';

/**
 * GraphView.ts imports 'obsidian' as a value (it extends BasesView), so it
 * cannot be loaded headless in Node the way the graph's pure modules are.
 * This test reads its source text directly instead, the same source-level
 * approach `pureModulesImportObsidianAsTypeOnly.test.ts` already uses, to
 * pin down the one thing the Obsidian-vocabulary rename absolutely must not
 * touch: the stored option keys. `repulsion` and friends are already
 * persisted in real .base files, so a key rename here would silently orphan
 * every value a user has already saved, even though the display name next
 * to it is free to change to whatever Obsidian calls the same slider.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const source = readFileSync(join(repoRoot, 'src/GraphView.ts'), 'utf8');
/** The graph's icon options are no longer declared in GraphView: they come
 * from the plugin's shared Icons group, which is the whole point of there
 * being one icon path. The keys still have to be pinned, so the group's own
 * source is read alongside. */
const appearanceSource = readFileSync(join(repoRoot, 'src/collection/appearance.ts'), 'utf8');

/** Every `displayName: '...'` immediately followed (within a few lines) by
 * `key: '...'` in the same option object, in source order. Deliberately
 * simple rather than a real parser: `getViewOptions` is hand-written object
 * literals, not generated, so a small window between the two fields is
 * enough and keeps this test readable as a plain regex. */
function extractDisplayNameToKey(text: string): Map<string, string> {
	const pattern = /displayName:\s*'([^']*)'[^]{0,80}?key:\s*'([^']*)'/g;
	const result = new Map<string, string>();
	for (const match of text.matchAll(pattern)) {
		result.set(match[1], match[2]);
	}
	return result;
}

test('every option that existed before the Obsidian-vocabulary rename keeps its exact stored key', () => {
	const byDisplayName = extractDisplayNameToKey(source);

	// The rename table from the plan: display name changed or added, key
	// unchanged (or, for genuinely new options, newly introduced here).
	assert.equal(byDisplayName.get('Repel force'), 'repulsion', 'Repulsion -> Repel force must keep the "repulsion" key');
	assert.equal(byDisplayName.get('Link distance'), 'linkDistance');
	assert.equal(byDisplayName.get('Node cap'), 'nodeCap');
	assert.equal(byDisplayName.get('Hide nodes with more than N links'), 'maxLinks');
	assert.equal(byDisplayName.get('Depth'), 'depth');
	assert.equal(byDisplayName.get('Mode'), 'mode');
	assert.equal(byDisplayName.get('Edge labels'), 'showEdgeLabels');
	assert.equal(byDisplayName.get('Type property'), 'typeProperty');
	// `iconProperty` moved to the shared Icons group rather than disappearing:
	// bases saved with a graph icon property keep meaning what they meant.
	assert.ok(
		source.includes('iconViewOptions('),
		'the graph should take its icon options from the shared group rather than declaring its own',
	);
	// The shared group writes `key` before `displayName`, the opposite order
	// to GraphView's own literals, so it is matched on its own terms.
	assert.ok(
		/key:\s*'iconProperty',\s*displayName:\s*'Frontmatter icon property'/.test(appearanceSource),
		'the shared Icons group must keep the iconProperty key',
	);
	// `Link properties` is no longer a single multitext option: it is now a set
	// of native property dropdowns, one stored key each, because Bases has a
	// `property` option type but no multi-property one. The keys are built by
	// `linkPropertySlotKeys()` rather than written out as literals here, so the
	// display names are matched separately below and the legacy key is pinned
	// as a read-only fallback the same way `valueNodeProperties` is.
	assert.equal(byDisplayName.get('Link properties'), undefined, 'the free-text Link properties option should be gone from the settings UI');
	assert.ok(
		source.includes('linkPropertySlotKeys()') && source.includes("type: 'property' as const"),
		'the link property slots must be declared as native property dropdowns',
	);
	assert.ok(
		source.includes("this.config.get('linkProperties')"),
		'a base saved with the legacy linkProperties array must still be read, even with the multitext option gone',
	);
	assert.equal(byDisplayName.get('Show body links'), 'showBodyLinks');
	// `Value nodes` is no longer an option: value nodes come from the base's
	// own Group by now. The key survives as a read-only fallback, so a base
	// saved with it keeps its value nodes until its owner sets a Group by,
	// which is the same compatibility shape `showOrphans` uses.
	assert.equal(byDisplayName.get('Value nodes'), undefined, 'the Value nodes option should be gone from the settings UI');
	assert.ok(
		source.includes("this.propertyList('valueNodeProperties')"),
		'a base saved with valueNodeProperties must still be read, even with the option gone',
	);
	assert.equal(byDisplayName.get('Include attachments'), 'includeAttachments');
	// Group nodes is a new key backing a new toggle. It defaults off, which is
	// what keeps a base that merely carries a groupBy (most do, since a view
	// copied from a table brings its grouping along) from growing a node per
	// group value nobody asked for.
	assert.equal(byDisplayName.get('Group nodes'), 'showGroupNodes');
	assert.match(
		source.slice(source.indexOf("key: 'showGroupNodes'")),
		/^key: 'showGroupNodes',\s+default: false,/,
		'Group nodes must default to off',
	);

	// The old display name must be gone: this is a rename, not an addition,
	// so "Repulsion" should no longer appear as a displayName anywhere.
	assert.ok(!source.includes("displayName: 'Repulsion'"), 'the old Repulsion display name should have been replaced, not left alongside the new one');
	assert.ok(!source.includes("displayName: 'Hide unlinked nodes'"), 'the old Hide unlinked nodes display name should have been replaced');

	// New options this pass adds. Center force and Link force are new
	// stored keys backing genuinely new sliders (not renames of anything),
	// so there is no old key for them to orphan.
	assert.equal(byDisplayName.get('Center force'), 'centerForce');
	assert.equal(byDisplayName.get('Link force'), 'linkForce');
	assert.equal(byDisplayName.get('Arrows'), 'showArrows');
	assert.equal(byDisplayName.get('Text fade threshold'), 'fadeThreshold');
	assert.equal(byDisplayName.get('Node style'), 'nodeStyle');
	// Orphans is a new key (`showOrphans`), not a rename of `hideUnlinked`,
	// because the toggle's polarity flips (a show toggle replacing a hide
	// toggle): see orphanVisibility.ts for why reusing the old key directly
	// would have silently inverted an explicitly configured base.
	assert.equal(byDisplayName.get('Orphans'), 'showOrphans');
});

test('the link property slot keys keep their exact stored names', () => {
	// These are built from a template rather than written as object literals, so
	// the regex above cannot see them. Pinned here instead: once a base has
	// saved `linkProperty2`, renaming that key silently drops the property the
	// user picked and quietly widens their graph's edge filter.
	assert.deepEqual(linkPropertySlotKeys(), ['linkProperty1', 'linkProperty2', 'linkProperty3', 'linkProperty4']);
	for (const key of linkPropertySlotKeys()) {
		assert.ok(source.includes('linkPropertySlotKeys()'), `GraphView must build its option for ${key} from the shared key list`);
	}
});

test('no user-facing option display name contains an em dash', () => {
	for (const match of source.matchAll(/displayName:\s*'([^']*)'/g)) {
		assert.ok(!match[1].includes('—'), `"${match[1]}" contains an em dash`);
	}
});
