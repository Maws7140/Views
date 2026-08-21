import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveShowOrphans } from '../../src/graph/orphanVisibility';

test('a fresh base with neither key present hides orphans by default, matching today\'s behaviour', () => {
	// This is the semantics pin the plan asks for: "Orphans" is a show
	// toggle defaulting off, and off must still mean orphans are hidden,
	// the same outcome "Hide unlinked nodes" defaulting on used to produce.
	assert.equal(resolveShowOrphans(undefined, undefined), false);
});

test('the new key wins outright once a base has it, regardless of any legacy value present', () => {
	assert.equal(resolveShowOrphans(true, true), true);
	assert.equal(resolveShowOrphans(false, false), false);
	assert.equal(resolveShowOrphans(true, false), true);
	assert.equal(resolveShowOrphans(false, true), false);
});

test('a base saved only under the legacy key is read as its inverse, not reused as-is', () => {
	// hideUnlinked: true meant "hide orphans" under the old polarity, which
	// is showOrphans: false under the new one.
	assert.equal(resolveShowOrphans(undefined, true), false);
	// hideUnlinked: false meant the user explicitly asked to see them, which
	// must still mean showOrphans: true, not get silently reversed by a
	// naive same-key reinterpretation.
	assert.equal(resolveShowOrphans(undefined, false), true);
});

test('a non-boolean stored value is treated as absent rather than coerced', () => {
	assert.equal(resolveShowOrphans('yes', true), false);
	assert.equal(resolveShowOrphans(1, false), true);
	assert.equal(resolveShowOrphans(null, null), false);
});
