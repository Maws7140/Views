import assert from 'node:assert/strict';
import test from 'node:test';
import { ColorAssigner, parseCustomPalette, stableColor } from '../../src/table-colors/palettes';
import { installCssSupportsShim } from '../helpers/cssShim';

installCssSupportsShim();

test('parseCustomPalette accepts well-formed colors and drops garbage entries', () => {
	// The splitter breaks on any run of whitespace, comma, or semicolon, so a
	// multi-argument functional color (with its own internal commas or
	// spaces) cannot survive as one token; this exercises what the splitter
	// actually hands isCssColor: single-token entries only.
	const parsed = parseCustomPalette('#ff0000, not-a-color, #00ff00, red, ;;; #0000ff');
	assert.deepEqual(parsed, ['#ff0000', '#00ff00', 'red', '#0000ff']);
});

test('parseCustomPalette splits on commas, semicolons, and runs of whitespace alike', () => {
	const parsed = parseCustomPalette('#111111\n#222222,#333333;#444444   #555555');
	assert.deepEqual(parsed, ['#111111', '#222222', '#333333', '#444444', '#555555']);
});

test('parseCustomPalette on an empty or all-invalid string returns an empty list', () => {
	assert.deepEqual(parseCustomPalette(''), []);
	assert.deepEqual(parseCustomPalette('nope, still not a color'), []);
});

test('ColorAssigner memoises: the same seed in the same scope always returns the same color', () => {
	const assigner = new ColorAssigner(['#111111', '#222222', '#333333']);
	const first = assigner.color('status', 'Done');
	const second = assigner.color('status', 'Done');
	assert.equal(first, second);
});

test('ColorAssigner scopes are independent: the same value in two scopes may repeat a color freely', () => {
	const assigner = new ColorAssigner(['#111111']);
	const a = assigner.color('status', 'Done');
	const b = assigner.color('priority', 'Done');
	// Only one color in the palette, so both scopes must fall back to it; the
	// point is that a second scope never refuses a color the first is using.
	assert.equal(a, '#111111');
	assert.equal(b, '#111111');
});

test('ColorAssigner.reserve keeps a reserved color away from automatic assignment in the same scope', () => {
	const palette = ['#d9730d', '#cb912f', '#448361'];
	const assigner = new ColorAssigner(palette);
	// Reserve the color that "Urgent" would otherwise hash to, so a later
	// automatic value must not be handed the same color.
	const seedColor = stableColor('Urgent', palette);
	assert.ok(seedColor);
	assigner.reserve('status', seedColor as string);

	const automatic = assigner.color('status', 'Urgent');
	assert.notEqual(automatic, seedColor, 'the automatic pick must avoid a color already reserved in this scope');
});

test('ColorAssigner.reserve does not affect a different scope', () => {
	const palette = ['#d9730d'];
	const assigner = new ColorAssigner(palette);
	assigner.reserve('status', '#d9730d');
	// Only one color exists, so a different scope must still be free to use it.
	const other = assigner.color('priority', 'High');
	assert.equal(other, '#d9730d');
});

test('stableColor is deterministic and case-insensitive', () => {
	const palette = ['#111111', '#222222', '#333333', '#444444'];
	assert.equal(stableColor('Done', palette), stableColor('done', palette));
	assert.equal(stableColor('Done', palette), stableColor('Done', palette));
});

test('stableColor on an empty palette or empty value returns null', () => {
	assert.equal(stableColor('Done', []), null);
	assert.equal(stableColor('', ['#111111']), null);
});
