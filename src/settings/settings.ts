import type { ColorPackId } from '../table-colors/palettes';

export const SETTINGS_VERSION = 1;

export interface ViewsPluginSettings {
	settingsVersion: number;
	defaultStartProp: string;
	defaultEndProp: string;
	defaultGroupBy: string;
	defaultDateSource: 'property' | 'lifespan';
	tableColorsEnabled: boolean;
	colorPack: ColorPackId;
	customPalette: string;
	colorValuePills: boolean;
	tableColorDisabledProperties: string[];
}

export const DEFAULT_SETTINGS: ViewsPluginSettings = {
	settingsVersion: SETTINGS_VERSION,
	defaultStartProp: '', defaultEndProp: '', defaultGroupBy: '', defaultDateSource: 'property',
	tableColorsEnabled: true, colorPack: 'notion',
	customPalette: '#787774, #9f6b53, #d9730d, #cb912f, #448361, #337ea9, #9065b0, #c14c8a, #d44c47',
	colorValuePills: true, tableColorDisabledProperties: [],
};

const LEGACY_KEYS = ['manualColorProperty', 'automaticColorsEnabled', 'automaticColorProperty', 'colorScalarValues'] as const;

export function migrateSettings(raw: unknown): { settings: ViewsPluginSettings; changed: boolean } {
	const source = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
	let changed = source.settingsVersion !== SETTINGS_VERSION;
	for (const key of LEGACY_KEYS) {
		if (!(key in source)) continue;
		delete source[key];
		changed = true;
	}
	const settings = Object.assign({}, DEFAULT_SETTINGS, source, { settingsVersion: SETTINGS_VERSION });
	if (!Array.isArray(settings.tableColorDisabledProperties)) {
		settings.tableColorDisabledProperties = [];
		changed = true;
	} else {
		settings.tableColorDisabledProperties = settings.tableColorDisabledProperties
			.filter((value): value is string => typeof value === 'string');
	}
	return { settings, changed };
}
