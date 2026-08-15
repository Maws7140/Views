export type ColorPackId = 'notion' | 'pastel' | 'vivid' | 'earth' | 'custom';

/**
 * Categorical colors. Long on purpose: a pack is the pool a view draws from, and
 * a short pool means a view repeats a color as soon as it has more values than
 * the pack has entries.
 *
 * Some pairs inside a pack *are* close, and that is fine here, because the pack
 * is not what the reader sees. `ColorAssigner` picks from it, and refuses to
 * hand two similar colors to the same board while any better option is free.
 * Similarity is therefore a property of what ends up on screen together, not of
 * the list. Shrinking the list to make every pair distinct was an earlier
 * attempt at this and it solved the wrong problem: it made small boards no
 * better and large boards worse, because they ran out of colors sooner.
 *
 * The order matters slightly: earlier entries are the original hand-designed
 * colors, and a value prefers its hashed color, so common cases still land on
 * the colors these packs were known for.
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
 * Hands out colors so that no two values shown together look alike.
 *
 * A pill renders as its cell is reached, so no view can hand over its complete
 * set up front. Assignment is therefore lazy: a value asks for its hashed color
 * first, which keeps it consistent with the same value elsewhere, and moves only
 * when that color is unavailable or would look like one already used here.
 *
 * "Unavailable" is stronger than "taken", and that is the point. Two colors can
 * be different entries in the pack and still read as one color in two shades, so
 * a candidate must also clear a perceptual bar against every color already
 * handed out in the same scope.
 *
 * This is why the packs can be long. Closeness inside the pack costs nothing as
 * long as the close pair never lands on the same board, and that is enforced
 * here rather than by shortening the pack. Shortening solved the wrong problem:
 * it left small boards no better and made large ones worse, since they ran out
 * of colors sooner.
 *
 * Distinctness is scoped, normally to a property. Two properties are two
 * legends, so `status: done` and `priority: high` sharing a color costs nothing
 * and leaves more of the pack free inside each.
 */
export class ColorAssigner {
	private readonly scopes = new Map<string, ScopeState>();
	/** Lab per palette entry, computed once per assigner rather than per ask. */
	private readonly labs: Lab[];

	constructor(private readonly palette: string[]) {
		this.labs = palette.map(toLab);
	}

	color(scope: string, value: unknown): string | null {
		if (!this.palette.length) return null;
		const seed = propertyValueSeed(value);
		if (!seed) return null;

		let state = this.scopes.get(scope);
		if (!state) {
			state = { assigned: new Map(), taken: new Set(), usedLabs: [] };
			this.scopes.set(scope, state);
		}

		const existing = state.assigned.get(seed);
		if (existing) return existing;

		const preferred = stableColor(seed, this.palette);
		if (!preferred) return null;

		const color = this.pick(preferred, state);
		state.assigned.set(seed, color);
		state.taken.add(color);
		const lab = this.labs[this.palette.indexOf(color)];
		if (lab) state.usedLabs.push(lab);
		return color;
	}

	/**
	 * The value's own color when it works, then the best remaining one.
	 *
	 * The scan starts at the preferred entry rather than at the top of the pack,
	 * so a displaced value still derives its color from itself and not from the
	 * order it happened to arrive in. Each step down drops one guarantee, and the
	 * last returns the preferred color rather than nothing: a repeat is a worse
	 * answer than a distinct color, and a much better one than no color at all.
	 */
	private pick(preferred: string, state: ScopeState): string {
		const start = this.palette.indexOf(preferred);
		const size = this.palette.length;

		// The value's own color, whenever it is free and works here. Taking it
		// unconditionally is what keeps a value the same color across views.
		if (!state.taken.has(preferred)
			&& state.usedLabs.every((used) => distinctEnough(this.labs[start], used))) {
			return preferred;
		}

		// Otherwise the most separated colour still free, rather than the first
		// one that merely passes. First-fit takes an adequate colour and leaves a
		// better one unused, which strands the board sooner: on `earth` it ran out
		// of clearly distinct options after four values, against nine this way.
		let best: string | null = null;
		let bestScore = -Infinity;
		for (let step = 0; step < size; step += 1) {
			const index = (start + step) % size;
			const candidate = this.palette[index];
			if (state.taken.has(candidate)) continue;
			const score = separationOf(this.labs[index], state.usedLabs);
			if (score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		if (best) return best;

		// Every color is in use, so a repeat is unavoidable.
		return preferred;
	}
}

/** Worst distance from a candidate to anything already on the board. */
function separationOf(candidate: Lab | undefined, used: Lab[]): number {
	if (!candidate || Number.isNaN(candidate[0])) return Infinity;
	let worst = Infinity;
	for (const other of used) {
		if (Number.isNaN(other[0])) continue;
		const distance = Math.hypot(candidate[0] - other[0], candidate[1] - other[1], candidate[2] - other[2]);
		// A shade variant is penalised below its raw distance, so a genuinely
		// different hue wins over a closer-but-same-hue candidate.
		const penalised = distinctEnough(candidate, other) ? distance : distance / 3;
		if (penalised < worst) worst = penalised;
	}
	return worst;
}

interface ScopeState {
	assigned: Map<string, string>;
	taken: Set<string>;
	/** Lab of each color handed out here, for the similarity test. */
	usedLabs: Lab[];
}

type Lab = readonly [number, number, number];

/** Comfortably distinguishable, roughly ColorBrewer's spacing for categories. */
const MIN_DISTANCE = 20;
/** Below this, two colors read as one hue in two shades. */
const MIN_HUE_DEGREES = 25;
/** Past this, lightness alone separates them and hue no longer matters. */
const WAIVE_HUE_ABOVE = 45;
/** A near-grey has no meaningful hue to compare. */
const MIN_CHROMA = 12;

/**
 * Distance alone cannot see a shade variant: a pure lightness change produces
 * plenty of it, which is how `#65a30d` beside `#4d7c0f` measured 20 apart while
 * reading as one green twice. Hence the second, hue-based test.
 */
function distinctEnough(a: Lab | undefined, b: Lab): boolean {
	// An unmeasurable color (a theme variable, a named color) skips the test
	// rather than blocking every candidate.
	if (!a || Number.isNaN(a[0]) || Number.isNaN(b[0])) return true;
	const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	if (distance < MIN_DISTANCE) return false;
	if (distance >= WAIVE_HUE_ABOVE) return true;
	if (chroma(a) < MIN_CHROMA || chroma(b) < MIN_CHROMA) return true;
	return hueGap(a, b) >= MIN_HUE_DEGREES;
}

const chroma = (c: Lab): number => Math.hypot(c[1], c[2]);

function hueGap(a: Lab, b: Lab): number {
	const angle = (c: Lab) => (Math.atan2(c[2], c[1]) * 180 / Math.PI + 360) % 360;
	const gap = Math.abs(angle(a) - angle(b)) % 360;
	return gap > 180 ? 360 - gap : gap;
}

/** Stands in for a color that cannot be measured. Never blocks a pick. */
const UNMEASURED: Lab = [NaN, NaN, NaN];

/** CIE L*a*b* through sRGB and D65, enough to compare two swatches. */
function toLab(color: string): Lab {
	const match = (normalizeColor(color) ?? color).match(/^#([0-9a-f]{6})$/i);
	if (!match) return UNMEASURED;
	const int = parseInt(match[1], 16);
	const [r, g, b] = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((v) => {
		const channel = v / 255;
		return channel > 0.04045 ? ((channel + 0.055) / 1.055) ** 2.4 : channel / 12.92;
	});
	const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
	const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
	const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
	const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
	return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
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
