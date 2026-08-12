export type ColorPackId = 'notion' | 'pastel' | 'vivid' | 'earth' | 'custom';

export const COLOR_PACKS: Record<Exclude<ColorPackId, 'custom'>, string[]> = {
	notion: ['#787774', '#9f6b53', '#d9730d', '#cb912f', '#448361', '#337ea9', '#9065b0', '#c14c8a', '#d44c47'],
	pastel: ['#7aa2d6', '#84b59f', '#d6a86e', '#c58caf', '#89a9a0', '#d98282', '#9a91c7', '#b5a36a'],
	vivid: ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'],
	earth: ['#8b6f47', '#6b7f5b', '#a66a4c', '#5f7c80', '#8a6f8f', '#9b8b63', '#6f766d', '#b06f62'],
};

export function parseCustomPalette(value: string): string[] {
	return value
		.split(/[\s,;]+/)
		.map((color) => color.trim())
		.filter((color) => isCssColor(color));
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

export function stableColor(value: string, palette: string[]): string | null {
	if (!palette.length || !value.trim()) return null;
	let hash = 2166136261;
	for (const char of value.trim().toLocaleLowerCase()) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return palette[Math.abs(hash >>> 0) % palette.length] ?? null;
}
