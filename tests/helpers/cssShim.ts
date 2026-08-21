/**
 * `table-colors/palettes.ts` validates a color string with the real browser
 * `CSS.supports('color', value)`, which Node has no built-in for. This is not
 * a DOM (no document, no layout, no element tree): it stands in for exactly
 * one global function so `isCssColor`/`parseCustomPalette` can be exercised
 * headless. Good enough to separate well-formed color syntax from garbage;
 * it does not need to match every edge case a real browser's CSS parser
 * would accept.
 */

const NAMED_COLORS = new Set([
	'transparent', 'currentcolor', 'black', 'white', 'red', 'green', 'blue',
	'yellow', 'orange', 'purple', 'pink', 'brown', 'gray', 'grey', 'cyan',
	'teal', 'magenta', 'lime', 'navy', 'maroon', 'olive', 'silver', 'gold',
	'indigo', 'violet', 'coral', 'salmon', 'khaki', 'crimson', 'chocolate',
	'rebeccapurple', 'aliceblue', 'antiquewhite', 'aquamarine', 'azure',
	'beige', 'bisque', 'blueviolet', 'burlywood', 'cadetblue', 'chartreuse',
	'cornflowerblue', 'cornsilk', 'darkblue', 'darkgreen', 'darkred',
	'deepskyblue', 'dimgray', 'firebrick', 'forestgreen', 'goldenrod',
	'hotpink', 'ivory', 'lavender', 'lightblue', 'lightgray', 'lightgreen',
	'linen', 'mintcream', 'orchid', 'peru', 'plum', 'royalblue', 'seagreen',
	'sienna', 'skyblue', 'slateblue', 'steelblue', 'tan', 'thistle',
	'tomato', 'turquoise', 'wheat',
]);

const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL_RE = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*\)$/i;
const VAR_RE = /^var\(--[\w-]+(?:,.*)?\)$/i;

function supportsColor(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (HEX_RE.test(trimmed)) return true;
	if (FUNCTIONAL_RE.test(trimmed)) return true;
	if (VAR_RE.test(trimmed)) return true;
	return NAMED_COLORS.has(trimmed.toLowerCase());
}

/** Installs the shim on `globalThis.CSS` for the current process. `node:test`
 * runs each test file as its own process, so this only needs to run once per
 * file that touches `isCssColor`/`parseCustomPalette`, before either is called. */
export function installCssSupportsShim(): void {
	(globalThis as { CSS?: { supports(property: string, value: string): boolean } }).CSS = {
		supports(property: string, value: string): boolean {
			if (property !== 'color') return false;
			return supportsColor(value);
		},
	};
}
