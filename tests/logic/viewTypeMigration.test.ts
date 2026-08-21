import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_VIEW_TYPE_IDS, migrateBaseFileContent } from '../../src/logic/viewTypeMigration';

test('migrateBaseFileContent rewrites every legacy view type id to its new id', () => {
	for (const [legacyId, newId] of Object.entries(LEGACY_VIEW_TYPE_IDS)) {
		const source = `filters:\n  and: []\nviews:\n  - type: ${legacyId}\n    name: Table\n`;
		const result = migrateBaseFileContent(source);
		assert.equal(result.changed, true);
		assert.deepEqual(result.replacedTypes, [legacyId]);
		assert.match(result.content, new RegExp(`type: ${newId}\\b`));
		assert.doesNotMatch(result.content, new RegExp(legacyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	}
});

test('migrateBaseFileContent rewrites multiple views in one file and leaves everything else untouched', () => {
	const source = [
		'filters:',
		'  and:',
		'    - file.hasProperty("title")',
		'views:',
		'  - type: more-bases-raycast',
		'    name: Table',
		'    columnSize:',
		'      note.source: 212',
		'  - type: more-bases-collection',
		'    name: Gallery',
	].join('\n');
	const result = migrateBaseFileContent(source);
	assert.equal(result.changed, true);
	assert.deepEqual(result.replacedTypes, ['more-bases-raycast', 'more-bases-collection']);
	assert.match(result.content, /type: views-search/);
	assert.match(result.content, /type: views-collection/);
	assert.match(result.content, /file\.hasProperty\("title"\)/);
	assert.match(result.content, /note\.source: 212/);
});

test('migrateBaseFileContent is idempotent: an already-migrated file is left byte-for-byte untouched', () => {
	const source = 'views:\n  - type: views-search\n    name: Table\n';
	const result = migrateBaseFileContent(source);
	assert.equal(result.changed, false);
	assert.equal(result.content, source);
	assert.deepEqual(result.replacedTypes, []);
});

test('migrateBaseFileContent leaves a file with no view type at all unchanged', () => {
	const source = 'filters:\n  and: []\n';
	const result = migrateBaseFileContent(source);
	assert.equal(result.changed, false);
	assert.equal(result.content, source);
});

test('migrateBaseFileContent preserves quoting, indentation, trailing comments and CRLF line endings', () => {
	const source = 'views:\r\n  - type: "more-bases-kanban" # legacy\r\n    name: Board\r\n';
	const result = migrateBaseFileContent(source);
	assert.equal(result.changed, true);
	assert.equal(result.content, 'views:\r\n  - type: "views-kanban" # legacy\r\n    name: Board\r\n');
});

test('migrateBaseFileContent does not touch a value that merely contains a legacy id as a substring', () => {
	const source = 'views:\n  - type: more-bases-kanban-custom\n    name: Board\n';
	const result = migrateBaseFileContent(source);
	assert.equal(result.changed, false);
	assert.equal(result.content, source);
});
