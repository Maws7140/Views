import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIconChain } from '../../src/logic/iconChain';

/**
 * The order these candidates come back in is what decides which icon a user
 * actually sees, on every surface in the plugin. It was untestable while it
 * lived inside the Notebook Navigator lookup, which is why it is its own
 * module now.
 */

test('the note property wins over every folder-derived candidate', () => {
	const icons = buildIconChain({
		noteIcon: 'star',
		notebookFileIcon: 'file-heart',
		folders: [{ path: 'Projects', metadataIcon: 'folder-git' }],
		rootIcon: 'vault',
		defaultIcon: 'folder-closed',
		folderSource: 'notebook-navigator',
	});
	assert.equal(icons[0], 'star');
});

test('a file assignment beats the folder it sits in', () => {
	const icons = buildIconChain({
		notebookFileIcon: 'file-heart',
		folders: [{ path: 'Projects', metadataIcon: 'folder-git' }],
		folderSource: 'notebook-navigator',
	});
	assert.deepEqual(icons.slice(0, 2), ['file-heart', 'folder-git']);
});

test('the folder chain is nearest first, so a subfolder overrides its parent', () => {
	const icons = buildIconChain({
		folders: [
			{ path: 'Projects/Active', metadataIcon: 'rocket' },
			{ path: 'Projects', metadataIcon: 'folder-git' },
		],
		folderSource: 'notebook-navigator',
	});
	assert.deepEqual(icons.slice(0, 2), ['rocket', 'folder-git']);
});

test('a folder metadata icon is preferred to the same folder in loaded settings', () => {
	const icons = buildIconChain({
		folders: [{ path: 'Projects', metadataIcon: 'rocket', settingsIcon: 'folder-git' }],
		folderSource: 'notebook-navigator',
	});
	assert.deepEqual(icons.slice(0, 2), ['rocket', 'folder-git']);
});

test('the settings icon carries the folder alone while metadata is still booting', () => {
	// Notebook Navigator's metadata API is unavailable during its storage
	// bootstrap, which is when `metadataIcon` comes back null.
	const icons = buildIconChain({
		folders: [{ path: 'Projects', metadataIcon: null, settingsIcon: 'folder-git' }],
		folderSource: 'notebook-navigator',
	});
	assert.equal(icons[0], 'folder-git');
});

test('folder source none stops at the note property', () => {
	const icons = buildIconChain({
		noteIcon: 'star',
		notebookFileIcon: 'file-heart',
		folders: [{ path: 'Projects', metadataIcon: 'folder-git' }],
		rootIcon: 'vault',
		defaultIcon: 'folder-closed',
		folderSource: 'none',
	});
	assert.deepEqual(icons, ['star']);
});

test('folder source none with no note icon returns nothing rather than a default', () => {
	// A view with icons configured off must not fall back to a folder glyph:
	// an empty chain is what tells the renderer to draw no icon at all.
	assert.deepEqual(buildIconChain({ folderSource: 'none' }), []);
});

test('rules match on the normalized folder path and ignore Notebook Navigator', () => {
	const icons = buildIconChain({
		folders: [
			{ path: 'Projects/Active', metadataIcon: 'rocket' },
			{ path: 'Projects', metadataIcon: 'folder-git' },
		],
		rules: new Map([['Projects', 'briefcase']]),
		rootIcon: 'vault',
		defaultIcon: 'folder-closed',
		folderSource: 'rules',
	});
	// Nothing from Notebook Navigator, and no root or default tail: those two
	// exist to fill Notebook Navigator's interface icons, which its own users
	// expect and a rules user never configured.
	assert.deepEqual(icons, ['briefcase']);
});

test('the root icon and the default close a Notebook Navigator chain, in that order', () => {
	const icons = buildIconChain({
		folders: [{ path: 'Projects' }],
		rootIcon: 'vault',
		defaultIcon: 'folder-closed',
		folderSource: 'notebook-navigator',
	});
	assert.deepEqual(icons, ['vault', 'folder-closed']);
});

test('blank and whitespace-only candidates are skipped, and every entry is trimmed', () => {
	const icons = buildIconChain({
		noteIcon: '   ',
		notebookFileIcon: '  star  ',
		folders: [{ path: 'Projects', metadataIcon: '' }],
		folderSource: 'notebook-navigator',
	});
	assert.equal(icons[0], 'star');
	assert.ok(!icons.includes(''));
});

test('a repeated icon appears once, so a fallback is never tried twice', () => {
	const icons = buildIconChain({
		noteIcon: 'star',
		notebookFileIcon: 'star',
		folders: [{ path: 'Projects', metadataIcon: 'star', settingsIcon: 'star' }],
		rootIcon: 'star',
		defaultIcon: 'star',
		folderSource: 'notebook-navigator',
	});
	assert.deepEqual(icons, ['star']);
});

test('a note with no parent folders still gets the Notebook Navigator tail', () => {
	const icons = buildIconChain({
		folders: [],
		rootIcon: 'vault',
		defaultIcon: 'vault',
		folderSource: 'notebook-navigator',
	});
	assert.deepEqual(icons, ['vault']);
});
