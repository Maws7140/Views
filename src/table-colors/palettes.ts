export type ColorPackId = 'notion' | 'pastel' | 'vivid' | 'earth' | 'custom';

/**
 * Categorical colors. Sized so a view can hold a realistic number of distinct
 * values before it has to repeat one: eight was not enough for a status column,
 * let alone a tag list.
 *
 * Every pair inside a pack is at least ~10 in CIE76 distance, checked rather
 * than eyeballed. The packs are different lengths on purpose, because a muted
 * register genuinely has less room to stay distinguishable in than a saturated
 * one, and padding `earth` out to match `vivid` would only add near duplicates.
 */
export const COLOR_PACKS: Record<Exclude<ColorPackId, 'custom'>, string[]> = {
	notion: [
		'#787774', '#9f6b53', '#d9730d', '#cb912f',
		'#448361', '#337ea9', '#9065b0', '#c14c8a',
		'#d44c47', '#3f8f87', '#5a63a6', '#7f8a45',
		'#5d7385', '#8a4f74', '#b0603c', '#6b4f8a',
		'#a88b3f', '#4a6f5c', '#8f5f5f', '#3f5f8a',
		'#7a8f6b', '#5f8f3f', '#8f7a5f', '#3d3d5c',
		'#c9a227',
	],
	pastel: [
		'#7aa2d6', '#84b59f', '#d6a86e', '#c58caf',
		'#89a9a0', '#d98282', '#9a91c7', '#b5a36a',
		'#c3b2e0', '#8ec7c0', '#e2b3c4', '#bcc98d',
		'#e3c49b', '#a9b8dd', '#6f8fae', '#a67f8c',
		'#8fa87f', '#cfa8a0', '#c98f7a', '#a8b8c9',
	],
	// Tailwind's 600 ramp, which is what the original eight already were.
	vivid: [
		'#2563eb', '#059669', '#d97706', '#dc2626',
		'#7c3aed', '#0891b2', '#db2777', '#65a30d',
		'#0d9488', '#4f46e5', '#c026d3', '#e11d48',
		'#0284c7', '#ea580c', '#16a34a', '#475569',
		'#a16207', '#be123c', '#7e22ce', '#047857',
		'#b91c1c', '#0e7490', '#4d7c0f', '#9f1239',
		'#3f6212', '#0f766e',
	],
	earth: [
		'#8b6f47', '#6b7f5b', '#a66a4c', '#5f7c80',
		'#8a6f8f', '#9b8b63', '#6f766d', '#b06f62',
		'#7b6a55', '#7f8d99', '#6b5f7a', '#94756a',
		'#8c9b7a', '#4f5f6b', '#9b7a8a', '#8b5f4f',
		'#4f6b5f',
	],
};

export function parseCustomPalette(value: string): string[] {
	return value
		.split(/[\s,;]+/)
		.map((color) => color.trim())
		.filter((color) => isCssColor(color));
}

/** Resolve and validate a palette once per settings or render revision. */
export function resolveColorPalette(
	pack: ColorPackId,
	customValues: string | readonly string[],
	fallbackToDefault = true,
): string[] {
	if (pack !== 'custom') return COLOR_PACKS[pack];
	const custom = typeof customValues === 'string'
		? parseCustomPalette(customValues)
		: customValues.filter((color) => isCssColor(color));
	return custom.length ? [...custom] : (fallbackToDefault ? COLOR_PACKS.notion : []);
}

export function isCssColor(value: string): boolean {
	const normalized = normalizeColor(value);
	return Boolean(normalized && CSS.supports('color', normalized));
}

export function normalizeColor(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const normalized = normalizeColor(item);
			if (normalized) return normalized;
		}
		return null;
	}
	if (typeof value === 'object') {
		const object = value as Record<string, unknown>;
		const hsl = colorFromHslObject(object);
		if (hsl) return hsl;
		const rgb = colorFromRgbObject(object);
		if (rgb) return rgb;
		for (const key of ['color', 'hex', 'value', 'css', 'backgroundColor', 'background']) {
			if (!(key in object) || object[key] === value) continue;
			const normalized = normalizeColor(object[key]);
			if (normalized) return normalized;
		}
	}

	const serialized = typeof value === 'string' ? value : String(value);
	let trimmed = serialized.trim();
	if (!trimmed) return null;
	const quoted = trimmed.match(/^(['"])([\s\S]*)\1$/);
	if (quoted) trimmed = quoted[2].trim();
	const aliases: Record<string, string> = {
		gray: '#787774', grey: '#787774', brown: '#9f6b53', orange: '#d9730d',
		yellow: '#cb912f', green: '#448361', blue: '#337ea9', purple: '#9065b0',
		pink: '#c14c8a', red: '#d44c47', cyan: '#0891b2', teal: '#0f766e',
	};
	const alias = aliases[trimmed.toLowerCase()];
	if (alias) return alias;

	// Typed/custom property widgets may serialize as Color(#aabbcc),
	// {"hex":"#aabbcc"}, or a similar wrapper instead of a plain string.
	const hex = trimmed.match(/#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b/i)?.[0];
	if (hex) return hex;
	const functional = trimmed.match(/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/i)?.[0];
	return functional ?? trimmed;
}

function colorFromHslObject(value: Record<string, unknown>): string | null {
	const hue = numericComponent(value.h ?? value.hue);
	const saturation = numericComponent(value.s ?? value.saturation);
	const lightness = numericComponent(value.l ?? value.lightness);
	if (hue === null || saturation === null || lightness === null) return null;
	const alpha = alphaComponent(value.a ?? value.alpha);
	return alpha === null
		? `hsl(${hue} ${saturation}% ${lightness}%)`
		: `hsl(${hue} ${saturation}% ${lightness}% / ${alpha})`;
}

function colorFromRgbObject(value: Record<string, unknown>): string | null {
	const red = numericComponent(value.r ?? value.red);
	const green = numericComponent(value.g ?? value.green);
	const blue = numericComponent(value.b ?? value.blue);
	if (red === null || green === null || blue === null) return null;
	const alpha = alphaComponent(value.a ?? value.alpha);
	return alpha === null ? `rgb(${red} ${green} ${blue})` : `rgb(${red} ${green} ${blue} / ${alpha})`;
}

function numericComponent(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || !value.trim()) return null;
	const parsed = Number(value.replace(/%$/, '').trim());
	return Number.isFinite(parsed) ? parsed : null;
}

function alphaComponent(value: unknown): string | number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || !value.trim()) return null;
	const trimmed = value.trim();
	if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(trimmed)) return trimmed;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Colors for a known set of values, where no two values share a color while the
 * palette still has one free.
 *
 * `stableColor` decides each value on its own, so nothing ever asks what has
 * already been handed out and two values that hash to the same slot both get
 * it. Four statuses in an eight-color pack really did come out with `open` and
 * `done` both green.
 *
 * Each value still asks for its hashed color first, so a value keeps the color
 * it has elsewhere whenever that color is free, and only a genuine clash moves.
 * A displaced value takes the next free slot, scanning from its own preference
 * so the choice stays derived from the value rather than from its position.
 *
 * Distinctness has a price worth knowing: a value's color depends on which
 * other values are present, so a set that gains a colliding value can shift an
 * assignment. Repeats are the thing being fixed, so that is the right trade.
 */
export function assignDistinctColors(values: readonly string[], palette: string[]): Map<string, string> {
	const assigner = new ColorAssigner(palette);
	const assigned = new Map<string, string>();
	for (const value of values) {
		const color = assigner.color('', value);
		if (color) assigned.set(value.trim(), color);
	}
	return assigned;
}

/**
 * The same rule, for the surfaces that meet their values one at a time instead
 * of knowing the whole set up front.
 *
 * A pill renders as its cell is reached, so there is no point at which the view
 * could hand over a complete list. Assignment is therefore lazy: the first
 * value to ask gets its preferred color, and a later clash moves. One instance
 * lives for one render pass, which is what makes "already taken" meaningful.
 *
 * Distinctness is scoped, normally to a property. Two different properties are
 * two different legends, so `status: done` and `priority: high` sharing a color
 * costs nothing and leaves more colors free inside each.
 */
export class ColorAssigner {
	private readonly scopes = new Map<string, { assigned: Map<string, string>; taken: Set<string> }>();

	constructor(private readonly palette: string[]) {}

	color(scope: string, value: unknown): string | null {
		if (!this.palette.length) return null;
		const seed = propertyValueSeed(value);
		if (!seed) return null;

		let state = this.scopes.get(scope);
		if (!state) {
			state = { assigned: new Map(), taken: new Set() };
			this.scopes.set(scope, state);
		}

		const existing = state.assigned.get(seed);
		if (existing) return existing;

		const preferred = stableColor(seed, this.palette);
		if (!preferred) return null;

		const color = pickFreeColor(preferred, state.taken, this.palette);
		state.assigned.set(seed, color);
		state.taken.add(color);
		return color;
	}
}

/**
 * The preferred color when it is free, otherwise the next free one scanning
 * from it, so the choice still derives from the value rather than from the
 * order it happened to arrive in. Past the palette's size a repeat is
 * unavoidable and the honest answer is the value's own color.
 */
function pickFreeColor(preferred: string, taken: Set<string>, palette: string[]): string {
	if (!taken.has(preferred)) return preferred;
	if (taken.size >= palette.length) return preferred;

	const start = palette.indexOf(preferred);
	for (let step = 1; step < palette.length; step += 1) {
		const candidate = palette[(start + step) % palette.length];
		if (!taken.has(candidate)) return candidate;
	}
	return preferred;
}

/** Trimmed text for a value of any shape, which is what a color keys on. */
function propertyValueSeed(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	return String(value).trim();
}

export function stableColor(value: string, palette: string[]): string | null {
	if (!palette.length || !value.trim()) return null;
	let hash = 2166136261;
	for (const char of value.trim().toLocaleLowerCase()) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return palette[Math.abs(hash >>> 0) % palette.length] ?? null;
}
