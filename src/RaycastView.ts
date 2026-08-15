import {
	BasesEntry,
	BasesPropertyId,
	BasesView,
	Notice,
	QueryController,
	TFile,
	ViewOption,
} from 'obsidian';
import {
	RaycastRenderer,
	type RaycastGroup,
	type RaycastModel,
	type RaycastRow,
} from './raycast/RaycastRenderer';
import { isPropertyColorEnabled } from './settings/settings';
import { ColorAssigner, parseCustomPalette, resolveColorPalette } from './table-colors/palettes';
import { renderPropertyValue } from './ui/PropertyValueRenderer';
import { showFileMenu } from './ui/EntryInteractions';
import type ViewsPlugin from './main';

export const RaycastViewType = 'more-bases-raycast';

/**
 * Revealing a file is the file explorer's own job and is not in the public API,
 * so the one method needed is declared here rather than casting the app to any.
 */
interface RevealCapableExplorer {
	revealInFolder(file: TFile): void;
}

interface AppWithInternalPlugins {
	internalPlugins?: { getEnabledPluginById(id: string): unknown };
}

export class RaycastView extends BasesView {
	type = RaycastViewType;
	private readonly containerEl: HTMLElement;
	private readonly renderer: RaycastRenderer;
	private readonly entriesByPath = new Map<string, BasesEntry>();
	/** Rebuilt per render, so two values of a property never share a color. */
	private colors: ColorAssigner | null = null;

	constructor(
		private readonly plugin: ViewsPlugin,
		controller: QueryController,
		scrollEl: HTMLElement,
	) {
		super(controller);
		this.containerEl = scrollEl.createDiv({ cls: 'mbv-raycast-host' });
		this.renderer = new RaycastRenderer(this.containerEl, {
			open: (path, newLeaf) => this.openPath(path, newLeaf),
			create: (name) => void this.createNote(name),
			copyLink: (path) => void this.copyLink(path),
			reveal: (path) => this.reveal(path),
			menu: (path, anchor) => this.openMenu(path, anchor),
			renderProperties: (containerEl, path) => this.renderProperties(containerEl, path),
		});
	}

	onunload(): void {
		this.renderer.destroy();
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: 'Raycast',
				type: 'group',
				items: [
					{
						displayName: 'Title',
						type: 'property',
						key: 'titleProperty',
						default: 'file.name',
					},
					{
						displayName: 'Subtitle',
						type: 'dropdown',
						key: 'subtitle',
						default: 'folder',
						options: { folder: 'Folder', path: 'Full path', none: 'None' },
					},
					{
						displayName: 'Search matches',
						type: 'dropdown',
						key: 'searchScope',
						default: 'all',
						options: { all: 'Title and properties', title: 'Title only' },
					},
					{
						// The spec's "search bar only": the field and nothing under it
						// until something is typed.
						displayName: 'Launcher mode',
						type: 'toggle',
						key: 'launcher',
						default: false,
					},
				],
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [
					{
						displayName: 'Show properties',
						type: 'toggle',
						key: 'showProperties',
						default: true,
					},
					{
						displayName: 'Row density',
						type: 'dropdown',
						key: 'density',
						default: 'comfortable',
						options: { comfortable: 'Comfortable', compact: 'Compact' },
					},
					{
						displayName: 'Color property values',
						type: 'toggle',
						key: 'propertyValueColors',
						default: true,
					},
				],
			},
		];
	}

	onDataUpdated(): void {
		const palette = this.valuePalette();
		this.colors = palette ? new ColorAssigner(palette) : null;
		this.renderer.update(this.buildModel());
	}

	private buildModel(): RaycastModel {
		this.entriesByPath.clear();
		const titleProp = this.config.getAsPropertyId('titleProperty');
		const subtitle = this.stringConfig('subtitle', 'folder');
		const searchProperties = this.stringConfig('searchScope', 'all') !== 'title';
		const properties = this.displayProperties();
		const groups: RaycastGroup[] = [];
		for (const group of this.data?.groupedData ?? []) {
			const rows: RaycastRow[] = [];
			for (const entry of group.entries) {
				this.entriesByPath.set(entry.file.path, entry);
				rows.push(this.buildRow(entry, titleProp, subtitle, searchProperties, properties));
			}
			if (rows.length) groups.push({ key: group.key?.toString() ?? '', rows });
		}
		return {
			groups,
			showGroupHeadings: groups.length > 1 || Boolean(groups[0]?.key),
			launcher: this.config.get('launcher') === true,
			showProperties: this.config.get('showProperties') !== false,
			propertyCount: properties.length,
			density: this.stringConfig('density', 'comfortable') === 'compact' ? 'compact' : 'comfortable',
			placeholder: 'Search',
			emptyNotice: 'This base returned no notes.',
		};
	}

	private buildRow(
		entry: BasesEntry,
		titleProp: BasesPropertyId | null,
		subtitle: string,
		searchProperties: boolean,
		properties: BasesPropertyId[],
	): RaycastRow {
		const title = (titleProp ? entry.getValue(titleProp)?.toString().trim() : '')
			|| entry.file.basename;
		const folder = entry.file.parent?.path ?? '';
		const terms = [title, folder];
		// Matched against what the row actually shows, plus the folder, so a search
		// answers what is on screen rather than the whole note.
		if (searchProperties) {
			for (const property of properties) {
				const value = entry.getValue(property)?.toString();
				if (value) terms.push(value);
			}
		}
		return {
			path: entry.file.path,
			title,
			subtitle: subtitle === 'none' ? '' : subtitle === 'path' ? entry.file.path : folder === '' ? '' : folder,
			searchText: terms.join(' ').toLowerCase(),
		};
	}

	/**
	 * The properties the user put in the view's own property list, which is the
	 * same list every other view here reads, minus the one already used as the
	 * title so it does not appear twice in one row.
	 */
	private displayProperties(): BasesPropertyId[] {
		const titleProp = this.config.getAsPropertyId('titleProperty');
		return this.config.getOrder().filter((property) => property !== titleProp);
	}

	/**
	 * One cell per property, always, and in the same order. A row that skipped a
	 * value it does not have would shift every later value into the wrong column.
	 */
	private renderProperties(rowEl: HTMLElement, path: string): void {
		const entry = this.entriesByPath.get(path);
		if (!entry) return;
		const palette = this.valuePalette();
		for (const property of this.displayProperties()) {
			const valueEl = rowEl.createDiv({ cls: 'mbv-ray-prop' });
			const value = entry.getValue(property);
			if (value === null || value === undefined) continue;
			if (!value.toString().trim()) continue;
			renderPropertyValue(valueEl, value, {
				app: this.app,
				property,
				displayName: this.config.getDisplayName(property),
				valueColorPalette: palette && isPropertyColorEnabled(this.plugin.settings, property)
					? palette
					: undefined,
				valueColors: isPropertyColorEnabled(this.plugin.settings, property)
					? this.colors ?? undefined
					: undefined,
			});
		}
	}

	private valuePalette(): string[] | undefined {
		if (this.config.get('propertyValueColors') === false) return undefined;
		if (!this.plugin.settings.tableColorsEnabled) return undefined;
		return resolveColorPalette(
			this.plugin.settings.colorPack,
			parseCustomPalette(this.plugin.settings.customPalette),
		);
	}

	private fileForPath(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private openPath(path: string, newLeaf: boolean): void {
		const file = this.fileForPath(path);
		if (!file) return;
		void this.app.workspace.getLeaf(newLeaf).openFile(file);
	}

	/**
	 * Alt+Enter creates what was typed. The folder is Obsidian's own answer for
	 * where a new note belongs, so the view does not invent a location of its own.
	 */
	private async createNote(name: string): Promise<void> {
		const parent = this.app.fileManager.getNewFileParent('');
		const folder = parent.path === '/' ? '' : `${parent.path}/`;
		const base = name.replace(/[\\/:*?"<>|]/g, '-').trim();
		if (!base) return;
		let path = `${folder}${base}.md`;
		// A name that is already taken gets a suffix rather than an error, since
		// the point of the action is that typing a name is enough.
		for (let suffix = 1; this.app.vault.getAbstractFileByPath(path); suffix += 1) {
			path = `${folder}${base} ${suffix}.md`;
		}
		try {
			const file = await this.app.vault.create(path, '');
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			new Notice(`Could not create "${base}": ${error instanceof Error ? error.message : error}`);
		}
	}

	private async copyLink(path: string): Promise<void> {
		const file = this.fileForPath(path);
		if (!file) return;
		const link = this.app.fileManager.generateMarkdownLink(file, '');
		await navigator.clipboard.writeText(link);
		new Notice('Link copied');
	}

	/** The file explorer's own reveal, so the note lands selected in the tree. */
	private reveal(path: string): void {
		const file = this.fileForPath(path);
		if (!file) return;
		const internal = (this.app as unknown as AppWithInternalPlugins).internalPlugins;
		const explorer = internal?.getEnabledPluginById('file-explorer') as RevealCapableExplorer | null;
		if (!explorer?.revealInFolder) {
			new Notice('The file explorer is not enabled.');
			return;
		}
		explorer.revealInFolder(file);
	}

	private openMenu(path: string, anchor: HTMLElement): void {
		const file = this.fileForPath(path);
		if (!file) return;
		const rect = anchor.getBoundingClientRect();
		const event = new MouseEvent('contextmenu', {
			clientX: rect.left + 24,
			clientY: rect.bottom,
		});
		showFileMenu(this.app, file, event);
	}

	private stringConfig(key: string, fallback: string): string {
		const value = this.config.get(key);
		return typeof value === 'string' && value ? value : fallback;
	}

}
