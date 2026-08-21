import assert from 'node:assert/strict';
import test from 'node:test';
import { isPropertyColorEnabled, normalizeColorPropertyId, type ViewsPluginSettings } from '../../src/settings/settings';

test('normalizeColorPropertyId defaults a bare key to a note property, lowercased', () => {
	assert.equal(normalizeColorPropertyId('Status'), 'note.status');
	assert.equal(normalizeColorPropertyId('status'), 'note.status');
});

test('normalizeColorPropertyId keeps an explicit note./file./formula. source, lowercasing only the note case', () => {
	assert.equal(normalizeColorPropertyId('note.Status'), 'note.status');
	assert.equal(normalizeColorPropertyId('file.Ctime'), 'file.Ctime');
	assert.equal(normalizeColorPropertyId('formula.MyFormula'), 'formula.MyFormula');
});

test('normalizeColorPropertyId trims whitespace and treats an empty id as empty', () => {
	assert.equal(normalizeColorPropertyId('  Status  '), 'note.status');
	assert.equal(normalizeColorPropertyId(''), '');
	assert.equal(normalizeColorPropertyId('   '), '');
});

test('normalizeColorPropertyId memoises: the same input returns an equal result on repeat calls', () => {
	// The cache is keyed on the raw, untrimmed input, so calling twice with the
	// exact same string must not diverge from a single call, and a different
	// (even if equivalent-after-trim) input still resolves the same target.
	const first = normalizeColorPropertyId('Priority');
	const second = normalizeColorPropertyId('Priority');
	assert.equal(first, second);
	assert.equal(first, 'note.priority');
});

function baseSettings(overrides: Partial<ViewsPluginSettings> = {}): ViewsPluginSettings {
	return {
		settingsVersion: 8,
		defaultStartProp: '',
		defaultEndProp: '',
		defaultDateSource: 'property',
		tableColorsEnabled: true,
		colorPack: 'notion',
		customPalette: '',
		tableColorEnabledProperties: [],
		tableColorDisabledBases: [],
		horizontalViewTabsEnabled: true,
		timelineViewports: {},
		propertyValueColorOverrides: {},
		viewTypeMigrationDone: false,
		...overrides,
	};
}

test('isPropertyColorEnabled is false outright when tableColorsEnabled is off', () => {
	const settings = baseSettings({ tableColorsEnabled: false, tableColorEnabledProperties: ['note.status'] });
	assert.equal(isPropertyColorEnabled(settings, 'note.status'), false);
});

test('isPropertyColorEnabled is opt-in per property, matched after normalization', () => {
	const settings = baseSettings({ tableColorEnabledProperties: ['note.status'] });
	assert.equal(isPropertyColorEnabled(settings, 'Status'), true, 'differently-cased id must still match');
	assert.equal(isPropertyColorEnabled(settings, 'note.priority'), false, 'a property not on the list stays off');
});

test('isPropertyColorEnabled rejects an id that normalizes to empty', () => {
	const settings = baseSettings({ tableColorEnabledProperties: [''] });
	assert.equal(isPropertyColorEnabled(settings, '   '), false);
});
