import { Plugin } from 'obsidian';
import { BaseViewTabsEnhancer } from './base-tabs/BaseViewTabsEnhancer';
import { TimelinePluginSettingTab } from './settings/PluginSettingsTab';
import { DEFAULT_SETTINGS, migrateSettings, ViewsPluginSettings } from './settings/settings';
import { TableColorEnhancer } from './table-colors/TableColorEnhancer';
import { VIEW_DEFINITIONS } from './views/definitions';

export type { ViewsPluginSettings } from './settings/settings';

export default class ViewsPlugin extends Plugin {
	settings: ViewsPluginSettings = DEFAULT_SETTINGS;
	private tableColors: TableColorEnhancer | null = null;
	private viewTabs: BaseViewTabsEnhancer | null = null;
	private readonly propertyColorSettingsListeners = new Set<() => void>();

	async onload(): Promise<void> {
		await this.loadSettings();

		if (VIEW_DEFINITIONS.map((definition) => definition.register(this)).some((registered) => !registered)) {
			console.warn('[Views] Bases is not enabled in this vault.');
		}
		this.viewTabs = new BaseViewTabsEnhancer(this.app, () => this.settings);
		this.addChild(this.viewTabs);

		this.tableColors = new TableColorEnhancer(
			this.app,
			() => this.settings,
			() => this.saveSettings(),
		);
		this.addChild(this.tableColors);
		this.addSettingTab(new TimelinePluginSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const migrated = migrateSettings(await this.loadData());
		this.settings = migrated.settings;
		if (migrated.changed) await this.saveData(this.settings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.tableColors?.refresh();
		this.viewTabs?.refresh();
		for (const listener of this.propertyColorSettingsListeners) listener();
	}

	/**
	 * Writes settings without the refresh fan-out. Remembered scroll positions
	 * save while the user is scrolling, and must not repaint every open view.
	 */
	async persistSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onPropertyColorSettingsChanged(listener: () => void): () => void {
		this.propertyColorSettingsListeners.add(listener);
		return () => this.propertyColorSettingsListeners.delete(listener);
	}
}
