import { Plugin } from 'obsidian';
import { TimelineView, TimelineViewType } from './TimelineView';
import { CollectionView, CollectionViewType } from './CollectionView';
import { TimelinePluginSettingTab } from './settings/PluginSettingsTab';
import { TableColorEnhancer } from './table-colors/TableColorEnhancer';
import type { ColorPackId } from './table-colors/palettes';

export interface ViewsPluginSettings {
	defaultStartProp: string;
	defaultEndProp: string;
	defaultGroupBy: string;
	/** 'property' uses startProp/endProp, 'lifespan' uses file ctime/mtime */
	defaultDateSource: 'property' | 'lifespan';
	tableColorsEnabled: boolean;
	manualColorProperty: string;
	automaticColorsEnabled: boolean;
	automaticColorProperty: string;
	colorPack: ColorPackId;
	customPalette: string;
	colorValuePills: boolean;
	colorScalarValues: boolean;
}

const DEFAULT_SETTINGS: ViewsPluginSettings = {
	defaultStartProp: '',
	defaultEndProp: '',
	defaultGroupBy: '',
	defaultDateSource: 'property',
	tableColorsEnabled: true,
	manualColorProperty: 'color',
	automaticColorsEnabled: true,
	automaticColorProperty: 'status',
	colorPack: 'notion',
	customPalette: '#787774, #9f6b53, #d9730d, #cb912f, #448361, #337ea9, #9065b0, #c14c8a, #d44c47',
	colorValuePills: true,
	colorScalarValues: false,
};

export default class ViewsPlugin extends Plugin {
	settings: ViewsPluginSettings = DEFAULT_SETTINGS;
	private tableColors: TableColorEnhancer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		const registered = this.registerBasesView(TimelineViewType, {
			name: 'Views · Timeline',
			icon: 'lucide-chart-gantt',
			factory: (controller, containerEl) => new TimelineView(this, controller, containerEl),
			options: TimelineView.getViewOptions,
		});

		const collectionRegistered = this.registerBasesView(CollectionViewType, {
			name: 'Views · Collection',
			icon: 'lucide-gallery-horizontal-end',
			factory: (controller, containerEl) => new CollectionView(controller, containerEl),
			options: CollectionView.getViewOptions,
		});

		if (!registered || !collectionRegistered) {
			console.warn('[Views] Bases is not enabled in this vault.');
		}

		this.tableColors = new TableColorEnhancer(this.app, () => this.settings);
		this.addChild(this.tableColors);

		this.addSettingTab(new TimelinePluginSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.tableColors?.refresh();
	}
}
