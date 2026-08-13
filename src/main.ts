import { Plugin } from 'obsidian';
import { TimelinePluginSettingTab } from './settings/PluginSettingsTab';
import { DEFAULT_SETTINGS, migrateSettings, ViewsPluginSettings } from './settings/settings';
import { TableColorEnhancer } from './table-colors/TableColorEnhancer';
import { VIEW_DEFINITIONS } from './views/definitions';

export type { ViewsPluginSettings } from './settings/settings';

export default class ViewsPlugin extends Plugin {
	settings: ViewsPluginSettings = DEFAULT_SETTINGS;
	private tableColors: TableColorEnhancer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		if (VIEW_DEFINITIONS.map((definition) => definition.register(this)).some((registered) => !registered)) {
			console.warn('[Views] Bases is not enabled in this vault.');
		}

		this.tableColors = new TableColorEnhancer(
			() => this.settings,
			() => this.saveSettings(),
		);
		this.addChild(this.tableColors);
		this.addCommand({
			id: 'refresh-native-table-colors',
			name: 'Refresh native table colors',
			callback: () => this.tableColors?.refresh(),
		});
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
	}
}
