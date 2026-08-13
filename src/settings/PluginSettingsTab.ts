import { App, PluginSettingTab, Setting } from 'obsidian';
import type ViewsPlugin from '../main';

export class TimelinePluginSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ViewsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Views' });
		containerEl.createEl('h3', { text: 'Timeline defaults' });
		containerEl.createEl('p', {
			text: 'Set defaults for new timeline views. You can override these per view from the Timeline toolbar.',
		});

		new Setting(containerEl)
			.setName('Default date source')
			.setDesc('Choose whether to use a frontmatter property or file metadata for item dates by default.')
			.addDropdown(dropdown => {
				dropdown
					.addOption('property', 'Property')
					.addOption('lifespan', 'File lifespan (created to modified)')
					.setValue(this.plugin.settings.defaultDateSource ?? 'property')
					.onChange(async (value) => {
						this.plugin.settings.defaultDateSource = value as 'property' | 'lifespan';
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Default start property')
			.setDesc('Property ID used as the start date when a view has none configured. Example: note.published')
			.addText(text => {
				text
					.setPlaceholder('note.created')
					.setValue(this.plugin.settings.defaultStartProp ?? '')
					.onChange(async (value) => {
						this.plugin.settings.defaultStartProp = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Default end property')
			.setDesc('Optional property ID used for end dates when no view preference exists.')
			.addText(text => {
				text
					.setPlaceholder('note.due')
					.setValue(this.plugin.settings.defaultEndProp ?? '')
					.onChange(async (value) => {
						this.plugin.settings.defaultEndProp = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Default lane property')
			.setDesc('Property ID applied for grouping lanes when a view has no configured value.')
			.addText(text => {
				text
					.setPlaceholder('note.status')
					.setValue(this.plugin.settings.defaultGroupBy ?? '')
					.onChange(async (value) => {
						this.plugin.settings.defaultGroupBy = value.trim();
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h3', { text: 'Native table colors' });
		containerEl.createEl('p', {
			text: 'Color individual property values in Obsidian’s built-in Bases table. Double-click a column header to enable or disable colors for that column.',
		});

		new Setting(containerEl)
			.setName('Enable table colors')
			.setDesc('Apply the shared property-value color system to native Bases tables without tinting entire rows.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.tableColorsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.tableColorsEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Color pack')
			.setDesc('Notion is the restrained default. The same value always receives the same color.')
			.addDropdown((dropdown) => dropdown
				.addOption('notion', 'Notion')
				.addOption('pastel', 'Pastel')
				.addOption('vivid', 'Vivid')
				.addOption('earth', 'Earth')
				.addOption('custom', 'Custom')
				.setValue(this.plugin.settings.colorPack)
				.onChange(async (value) => {
					this.plugin.settings.colorPack = value as typeof this.plugin.settings.colorPack;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.colorPack === 'custom') {
			new Setting(containerEl)
				.setName('Custom palette')
				.setDesc('Comma-separated CSS colors. Invalid entries are ignored.')
				.addTextArea((text) => text
					.setPlaceholder('#2563eb, #059669, #d97706')
					.setValue(this.plugin.settings.customPalette)
					.onChange(async (value) => {
						this.plugin.settings.customPalette = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Color list values')
			.setDesc('Color tags and multi-select pills automatically by their value.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.colorValuePills)
				.onChange(async (value) => {
					this.plugin.settings.colorValuePills = value;
					await this.plugin.saveSettings();
				}));

	}
}

