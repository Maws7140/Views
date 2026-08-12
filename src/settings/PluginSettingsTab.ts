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
			text: 'Enhance Obsidian’s built-in Bases table. A valid color in frontmatter always wins; otherwise Views assigns stable colors from the selected pack.',
		});

		new Setting(containerEl)
			.setName('Enable table colors')
			.setDesc('Apply theme-aware row, pill, and optional cell colors to native Bases tables.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.tableColorsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.tableColorsEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Frontmatter color property')
			.setDesc('Property containing a CSS color, hex value, or name such as red, blue, or purple. Default: color.')
			.addText((text) => text
				.setPlaceholder('color')
				.setValue(this.plugin.settings.manualColorProperty)
				.onChange(async (value) => {
					this.plugin.settings.manualColorProperty = value.trim() || 'color';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic colors')
			.setDesc('Assign deterministic colors when the frontmatter color property is empty.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.automaticColorsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.automaticColorsEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic color property')
			.setDesc('Use this frontmatter or visible table property to assign each row a stable automatic color. Default: status.')
			.addText((text) => text
				.setPlaceholder('status')
				.setValue(this.plugin.settings.automaticColorProperty)
				.onChange(async (value) => {
					this.plugin.settings.automaticColorProperty = value.trim() || 'status';
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

		new Setting(containerEl)
			.setName('Color scalar cells')
			.setDesc('Also tint plain text and number cells. Off by default to keep tables calm.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.colorScalarValues)
				.onChange(async (value) => {
					this.plugin.settings.colorScalarValues = value;
					await this.plugin.saveSettings();
				}));
	}
}

