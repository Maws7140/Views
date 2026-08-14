import type { ColorPackId } from '../table-colors/palettes';
import type { TimelineViewportState } from '../types';

export const SETTINGS_VERSION = 7;

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
}

export const DEFAULT_SETTINGS: ViewsPluginSettings = {
	settingsVersion: SETTINGS_VERSION,
	defaultStartProp: '', defaultEndProp: '', defaultDateSource: 'property',
	tableColorsEnabled: true, colorPack: 'notion',
	customPalette: '#787774, #9f6b53, #d9730d, #cb912f, #448361, #337ea9, #9065b0, #c14c8a, #d44c47',
	tableColorEnabledProperties: [], tableColorDisabledBases: [],
	horizontalViewTabsEnabled: true,
	timelineViewports: {},
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

/** Automatic colors are opt-in per property and shared by every surface. */
export function isPropertyColorEnabled(settings: ViewsPluginSettings, propertyId: string): boolean {
	if (!settings.tableColorsEnabled) return false;
	const normalized = normalizeColorPropertyId(propertyId);
	if (!normalized) return false;
	return Array.isArray(settings.tableColorEnabledProperties)
		&& settings.tableColorEnabledProperties.some((value) => normalizeColorPropertyId(value) === normalized);
}
