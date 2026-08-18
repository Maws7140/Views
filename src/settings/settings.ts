import type { ColorPackId } from '../table-colors/palettes';
import type { TimelineViewportState } from '../types';

export const SETTINGS_VERSION = 8;

/** Remembered viewports are a convenience, not data. Keep the list bounded. */
const MAX_REMEMBERED_VIEWPORTS = 60;

export interface ViewsPluginSettings {
	settingsVersion: number;
	defaultStartProp: string;
	defaultEndProp: string;
	defaultDateSource: 'property' | 'lifespan';
	tableColorsEnabled: boolean;
	colorPack: ColorPackId;
	customPalette: string;
	tableColorEnabledProperties: string[];
	tableColorDisabledBases: string[];
	horizontalViewTabsEnabled: boolean;
	timelineViewports: Record<string, TimelineViewportState & { updatedAt: number }>;
	/**
	 * An override wins unconditionally over the automatic assigner, keyed by
	 * `normalizeColorPropertyId(property) -> propertyValueColorSeed(value)
	 * lowercased -> hex`, so "Done" on Status can be colored without repainting
	 * "Done" on Priority.
	 */
	propertyValueColorOverrides: Record<string, Record<string, string>>;
}

export const DEFAULT_SETTINGS: ViewsPluginSettings = {
	settingsVersion: SETTINGS_VERSION,
	defaultStartProp: '', defaultEndProp: '', defaultDateSource: 'property',
	tableColorsEnabled: true, colorPack: 'notion',
	customPalette: '#787774, #9f6b53, #d9730d, #cb912f, #448361, #337ea9, #9065b0, #c14c8a, #d44c47',
	tableColorEnabledProperties: [], tableColorDisabledBases: [],
	horizontalViewTabsEnabled: true,
	timelineViewports: {},
	propertyValueColorOverrides: {},
};

const LEGACY_KEYS = [
	'manualColorProperty', 'automaticColorsEnabled', 'automaticColorProperty',
	'colorScalarValues', 'tableColorDisabledProperties', 'colorValuePills',
	// Lanes come from the native Bases Group by menu, so a plugin-side default
	// grouping property no longer has anything to apply to.
	'defaultGroupBy',
	// Native view icons were built and then withdrawn; strip the key if a build
	// that shipped it ever wrote one.
	'nativeViewIcons',
] as const;

export function migrateSettings(raw: unknown): { settings: ViewsPluginSettings; changed: boolean } {
	const source = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
	let changed = source.settingsVersion !== SETTINGS_VERSION;
	for (const key of LEGACY_KEYS) {
		if (!(key in source)) continue;
		delete source[key];
		changed = true;
	}
	const settings = Object.assign({}, DEFAULT_SETTINGS, source, { settingsVersion: SETTINGS_VERSION });
	if (!Array.isArray(settings.tableColorEnabledProperties)) {
		settings.tableColorEnabledProperties = [];
		changed = true;
	} else {
		const original = settings.tableColorEnabledProperties;
		settings.tableColorEnabledProperties = [...new Set(original
			.filter((value): value is string => typeof value === 'string')
			.map((value) => normalizeColorPropertyId(value))
			.filter(Boolean))].sort();
		if (JSON.stringify(settings.tableColorEnabledProperties) !== JSON.stringify(original)) changed = true;
	}
	const viewports = settings.timelineViewports;
	if (!viewports || typeof viewports !== 'object' || Array.isArray(viewports)) {
		settings.timelineViewports = {};
		changed = true;
	} else {
		const valid = Object.entries(viewports).filter(([, state]) => (
			!!state
			&& typeof state === 'object'
			&& Number.isFinite((state as { startTs?: unknown }).startTs as number)
			&& Number.isFinite((state as { pxPerDay?: unknown }).pxPerDay as number)
		));
		valid.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0));
		const trimmed = Object.fromEntries(valid.slice(0, MAX_REMEMBERED_VIEWPORTS));
		if (Object.keys(trimmed).length !== Object.keys(viewports).length) changed = true;
		settings.timelineViewports = trimmed;
	}
	if (!Array.isArray(settings.tableColorDisabledBases)) {
		settings.tableColorDisabledBases = [];
		changed = true;
	} else {
		settings.tableColorDisabledBases = settings.tableColorDisabledBases
			.filter((value): value is string => typeof value === 'string')
			.map((value) => value.trim())
			.filter(Boolean);
	}
	const overrides = settings.propertyValueColorOverrides;
	if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
		settings.propertyValueColorOverrides = {};
		changed = true;
	} else {
		const validated: Record<string, Record<string, string>> = {};
		for (const [property, byValue] of Object.entries(overrides)) {
			if (typeof property !== 'string' || !byValue || typeof byValue !== 'object' || Array.isArray(byValue)) {
				changed = true;
				continue;
			}
			const propKey = normalizeColorPropertyId(property);
			if (!propKey) { changed = true; continue; }
			const validValues: Record<string, string> = {};
			for (const [seed, hex] of Object.entries(byValue as Record<string, unknown>)) {
				if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) { changed = true; continue; }
				const seedKey = seed.trim().toLowerCase();
				if (!seedKey) { changed = true; continue; }
				validValues[seedKey] = hex.toLowerCase();
			}
			if (Object.keys(validValues).length) {
				validated[propKey] = { ...(validated[propKey] ?? {}), ...validValues };
			} else {
				changed = true;
			}
		}
		if (JSON.stringify(validated) !== JSON.stringify(overrides)) changed = true;
		settings.propertyValueColorOverrides = validated;
	}
	return { settings, changed };
}

/**
 * The single property-id spelling used by every color surface. Note keys are
 * case-insensitive in frontmatter, and a bare key always means a note property.
 */
export function normalizeColorPropertyId(propertyId: string): string {
	const trimmed = propertyId.trim();
	if (!trimmed) return '';
	if (/^(?:note|file|formula)\./.test(trimmed)) {
		const [source, ...name] = trimmed.split('.');
		const rest = name.join('.');
		return source === 'note' ? `note.${rest.toLocaleLowerCase()}` : `${source}.${rest}`;
	}
	return `note.${trimmed.toLocaleLowerCase()}`;
}

/** The seed key an override is stored under: same identity, case-insensitive. */
export function propertyValueColorSeedKey(seed: string): string {
	return seed.trim().toLowerCase();
}

/**
 * An explicit color for one property's one value, or undefined for automatic.
 * Takes the overrides map directly (not the whole settings object) so the
 * rendering layer can look one up without depending on `ViewsPluginSettings`.
 */
export function getPropertyValueColorOverride(
	overrides: Record<string, Record<string, string>>,
	property: string,
	seed: string,
): string | undefined {
	if (!seed) return undefined;
	const byValue = overrides[normalizeColorPropertyId(property)];
	return byValue?.[propertyValueColorSeedKey(seed)];
}

export function setPropertyValueColorOverride(
	settings: ViewsPluginSettings,
	property: string,
	seed: string,
	hex: string,
): void {
	const propKey = normalizeColorPropertyId(property);
	const seedKey = propertyValueColorSeedKey(seed);
	if (!propKey || !seedKey) return;
	const byValue = { ...(settings.propertyValueColorOverrides[propKey] ?? {}) };
	byValue[seedKey] = hex.toLowerCase();
	settings.propertyValueColorOverrides = { ...settings.propertyValueColorOverrides, [propKey]: byValue };
}

export function clearPropertyValueColorOverride(
	settings: ViewsPluginSettings,
	property: string,
	seed: string,
): void {
	const propKey = normalizeColorPropertyId(property);
	const seedKey = propertyValueColorSeedKey(seed);
	const byValue = settings.propertyValueColorOverrides[propKey];
	if (!byValue || !(seedKey in byValue)) return;
	const nextByValue = { ...byValue };
	delete nextByValue[seedKey];
	const nextOverrides = { ...settings.propertyValueColorOverrides };
	if (Object.keys(nextByValue).length) nextOverrides[propKey] = nextByValue;
	else delete nextOverrides[propKey];
	settings.propertyValueColorOverrides = nextOverrides;
}

/** Every override hex for one property, for reserving them with `ColorAssigner.reserve` before resolving anything else in a render pass. */
export function overrideColorsForProperty(
	overrides: Record<string, Record<string, string>>,
	property: string | null | undefined,
): string[] {
	if (!property) return [];
	const byValue = overrides[normalizeColorPropertyId(property)];
	return byValue ? Object.values(byValue) : [];
}

/** Automatic colors are opt-in per property and shared by every surface. */
export function isPropertyColorEnabled(settings: ViewsPluginSettings, propertyId: string): boolean {
	if (!settings.tableColorsEnabled) return false;
	const normalized = normalizeColorPropertyId(propertyId);
	if (!normalized) return false;
	return Array.isArray(settings.tableColorEnabledProperties)
		&& settings.tableColorEnabledProperties.some((value) => normalizeColorPropertyId(value) === normalized);
}
