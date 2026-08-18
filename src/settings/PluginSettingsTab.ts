import { App, parseYaml, PluginSettingTab, Setting } from 'obsidian';
import type ViewsPlugin from '../main';
import { clearPropertyValueColorOverride, isPropertyColorEnabled, normalizeColorPropertyId } from './settings';

type SettingsSection = 'general' | 'colors';

const FILE_PROPERTY_IDS = [
	'file.file', 'file.name', 'file.basename', 'file.fullname', 'file.path', 'file.folder',
	'file.ext', 'file.ctime', 'file.mtime', 'file.size', 'file.links', 'file.backlinks',
	'file.embeds', 'file.tags',
];

export class TimelinePluginSettingTab extends PluginSettingTab {
	private section: SettingsSection = 'general';
	private propertyFilter = '';
	private propertyRenderToken = 0;

	constructor(app: App, private plugin: ViewsPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Views' });
		this.renderSectionTabs(containerEl);
		if (this.section === 'colors') this.renderColorSettings(containerEl);
		else this.renderGeneralSettings(containerEl);
	}

	private renderSectionTabs(container: HTMLElement): void {
		const tabs = container.createDiv({ cls: 'views-settings-tabs', attr: { role: 'tablist' } });
		for (const [section, label] of [['general', 'General'], ['colors', 'Colors']] as const) {
			const button = tabs.createEl('button', {
				cls: 'views-settings-tab',
				text: label,
				attr: {
					type: 'button',
					role: 'tab',
					'aria-selected': this.section === section ? 'true' : 'false',
				},
			});
			button.toggleClass('is-active', this.section === section);
			button.addEventListener('click', () => {
				this.section = section;
				this.display();
			});
		}
	}

	private renderGeneralSettings(container: HTMLElement): void {
		new Setting(container)
			.setName('Horizontal Base view tabs')
			.setDesc('Show Base views as responsive horizontal tabs while preserving the native view manager in Obsidian.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.horizontalViewTabsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.horizontalViewTabsEnabled = value;
					await this.plugin.saveSettings();
				}));

		container.createEl('h3', { text: 'Timeline defaults' });
		container.createEl('p', {
			text: 'Set defaults for new timeline views. You can override these per view from the Timeline toolbar.',
		});

		new Setting(container)
			.setName('Default date source')
			.setDesc('Choose whether to use a frontmatter property or file metadata for item dates by default.')
			.addDropdown((dropdown) => dropdown
				.addOption('property', 'Property')
				.addOption('lifespan', 'File lifespan (created to modified)')
				.setValue(this.plugin.settings.defaultDateSource ?? 'property')
				.onChange(async (value) => {
					this.plugin.settings.defaultDateSource = value as 'property' | 'lifespan';
					await this.plugin.saveSettings();
				}));

		new Setting(container)
			.setName('Default start property')
			.setDesc('Property ID used as the start date when a view has none configured. Example: note.published')
			.addText((text) => text
				.setPlaceholder('note.created')
				.setValue(this.plugin.settings.defaultStartProp ?? '')
				.onChange(async (value) => {
					this.plugin.settings.defaultStartProp = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(container)
			.setName('Default end property')
			.setDesc('Optional property ID used for end dates when no view preference exists.')
			.addText((text) => text
				.setPlaceholder('note.due')
				.setValue(this.plugin.settings.defaultEndProp ?? '')
				.onChange(async (value) => {
					this.plugin.settings.defaultEndProp = value.trim();
					await this.plugin.saveSettings();
				}));

	}

	private renderColorSettings(container: HTMLElement): void {
		container.createEl('h3', { text: 'Automatic property colors' });
		container.createEl('p', {
			text: 'One palette and one property policy apply across Collection views, native Bases tables, and note Properties.',
		});

		new Setting(container)
			.setName('Enable property colors')
			.setDesc('Enable the shared automatic property-value color system. Values only gain a colored pill once their property is enabled below.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.tableColorsEnabled)
				.onChange(async (value) => {
					this.plugin.settings.tableColorsEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(container)
			.setName('Color pack')
			.setDesc('The same normalized value receives the same color everywhere.')
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
			new Setting(container)
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

		container.createEl('h3', { text: 'Properties' });
		container.createEl('p', {
			text: 'Control automatic colors globally by property key. A disabled property renders exactly as Obsidian renders it, with no pill, in every Base, Collection, and open note.',
		});
		const propertyIds = this.discoverSynchronousPropertyIds();
		const listEl = container.createDiv({ cls: 'views-property-color-settings' });
		new Setting(listEl)
			.setName('Find a property')
			.setDesc(`${propertyIds.size} properties found · properties start disabled`)
			.addSearch((search) => search
				.setPlaceholder('Status, file.folder, formula')
				.setValue(this.propertyFilter)
				.onChange((value) => {
					this.propertyFilter = value;
					this.renderPropertyToggles(listEl, propertyIds);
				}))
			.addButton((button) => button
				.setButtonText('Enable all')
				.onClick(async () => {
					this.plugin.settings.tableColorEnabledProperties = [...propertyIds].map((id) => this.normalizePropertyId(id)).sort();
					await this.plugin.saveSettings();
					this.renderPropertyToggles(listEl, propertyIds);
				}))
			.addButton((button) => button
				.setButtonText('Disable all')
				.onClick(async () => {
					this.plugin.settings.tableColorEnabledProperties = [];
					await this.plugin.saveSettings();
					this.renderPropertyToggles(listEl, propertyIds);
				}));
		this.renderPropertyToggles(listEl, propertyIds);

		const token = ++this.propertyRenderToken;
		void this.discoverBasePropertyIds().then((baseIds) => {
			if (token !== this.propertyRenderToken || this.section !== 'colors' || !listEl.isConnected) return;
			let changed = false;
			for (const id of baseIds) {
				if (!propertyIds.has(id)) changed = true;
				propertyIds.add(id);
			}
			if (changed) this.renderPropertyToggles(listEl, propertyIds);
		});

		this.renderValueColorOverrides(container);
	}

	/**
	 * Only overrides are listed here, never every value a property could hold:
	 * the vault is the source of that, and this tab has no query over it.
	 * Right-click a colored pill anywhere in a Base to set one.
	 */
	private renderValueColorOverrides(container: HTMLElement): void {
		const overrides = this.plugin.settings.propertyValueColorOverrides;
		const entries = Object.entries(overrides)
			.filter(([property]) => isPropertyColorEnabled(this.plugin.settings, property))
			.flatMap(([property, byValue]) => Object.entries(byValue).map(([seed, hex]) => ({ property, seed, hex })))
			.sort((a, b) => a.property.localeCompare(b.property) || a.seed.localeCompare(b.seed));

		container.createEl('h3', { text: 'Value color overrides' });
		container.createEl('p', {
			text: 'Right-click a colored pill in any Base or Collection to set one. Only values with an explicit color are listed here.',
		});
		if (!entries.length) {
			container.createDiv({ cls: 'setting-item-description', text: 'No overrides set.' });
			return;
		}
		for (const { property, seed, hex } of entries) {
			new Setting(container)
				.setName(seed)
				.setDesc(this.propertyLabel(property))
				.addExtraButton((button) => {
					button.extraSettingsEl.addClass('views-value-color-swatch');
					button.extraSettingsEl.style.setProperty('--views-swatch-color', hex);
					button.setTooltip(hex);
				})
				.addButton((button) => button
					.setButtonText('Reset')
					.onClick(async () => {
						clearPropertyValueColorOverride(this.plugin.settings, property, seed);
						await this.plugin.saveSettings();
						this.display();
					}));
		}
	}

	private renderPropertyToggles(container: HTMLElement, propertyIds: Set<string>): void {
		container.querySelector('.views-property-color-list')?.remove();
		const list = container.createDiv({ cls: 'views-property-color-list' });
		const filter = this.propertyFilter.trim().toLocaleLowerCase();
		const ids = [...propertyIds]
			.filter((id) => !filter || id.toLocaleLowerCase().includes(filter) || this.propertyLabel(id).toLocaleLowerCase().includes(filter))
			.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
		if (!ids.length) {
			list.createDiv({ cls: 'setting-item-description', text: 'No matching properties.' });
			return;
		}
		for (const propertyId of ids) {
			const normalized = this.normalizePropertyId(propertyId);
			new Setting(list)
				.setName(this.propertyLabel(propertyId))
				.setDesc(normalized)
				.addToggle((toggle) => toggle
					.setValue(this.isPropertyEnabled(normalized))
					.onChange(async (enabled) => {
						const enabledProperties = new Set(this.plugin.settings.tableColorEnabledProperties.map((id) => this.normalizePropertyId(id)));
						if (enabled) enabledProperties.add(normalized);
						else enabledProperties.delete(normalized);
						this.plugin.settings.tableColorEnabledProperties = [...enabledProperties].sort();
						await this.plugin.saveSettings();
					}));
		}
	}

	private discoverSynchronousPropertyIds(): Set<string> {
		const ids = new Set(FILE_PROPERTY_IDS);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter) continue;
			for (const key of Object.keys(frontmatter)) {
				if (key === 'position') continue;
				ids.add(this.normalizePropertyId(`note.${key}`));
			}
		}
		for (const enabled of this.plugin.settings.tableColorEnabledProperties) ids.add(this.normalizePropertyId(enabled));
		return ids;
	}

	private async discoverBasePropertyIds(): Promise<Set<string>> {
		const ids = new Set<string>();
		const baseFiles = this.app.vault.getFiles().filter((file) => file.extension === 'base');
		for (const file of baseFiles) {
			try {
				const parsed = parseYaml(await this.app.vault.cachedRead(file)) as Record<string, unknown> | null;
				if (!parsed) continue;
				const formulas = parsed.formulas;
				if (formulas && typeof formulas === 'object') {
					for (const key of Object.keys(formulas)) ids.add(`formula.${key}`);
				}
				const views = Array.isArray(parsed.views) ? parsed.views : [];
				for (const view of views) this.collectPropertyIds(view, ids);
			} catch {
				// A malformed or concurrently edited Base should not block settings.
			}
		}
		return ids;
	}

	private collectPropertyIds(value: unknown, ids: Set<string>): void {
		if (Array.isArray(value)) {
			for (const item of value) this.collectPropertyIds(item, ids);
			return;
		}
		if (!value || typeof value !== 'object') return;
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if ((key === 'property' || key.endsWith('Property')) && typeof child === 'string' && child.trim()) {
				ids.add(this.normalizePropertyId(child));
			} else if (key === 'order' && Array.isArray(child)) {
				for (const property of child) if (typeof property === 'string') ids.add(this.normalizePropertyId(property));
			}
			this.collectPropertyIds(child, ids);
		}
	}

	private normalizePropertyId(propertyId: string): string {
		return normalizeColorPropertyId(propertyId);
	}

	private isPropertyEnabled(propertyId: string): boolean {
		return this.plugin.settings.tableColorEnabledProperties
			.some((enabled) => this.normalizePropertyId(enabled) === propertyId);
	}

	private propertyLabel(propertyId: string): string {
		const [source, ...parts] = propertyId.split('.');
		const name = parts.join('.') || propertyId;
		return `${name} · ${source}`;
	}
}
