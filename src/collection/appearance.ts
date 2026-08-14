import {
	App,
	BasesEntry,
	BasesPropertyId,
	BasesViewConfig,
	EventRef,
	TFolder,
	ViewOption,
	getIcon,
	setIcon,
} from 'obsidian';
import { ColorPackId, isCssColor, normalizeColor, resolveColorPalette, stableColor } from '../table-colors/palettes';

export type CollectionColorMode = 'none' | 'property' | 'automatic' | 'property-auto';
export type AutomaticColorSource = 'title' | 'folder' | 'property';
export type FolderIconSource = 'none' | 'rules' | 'notebook-navigator';

export interface CollectionAppearanceConfig {
	colorMode: CollectionColorMode;
	colorProperty: BasesPropertyId | null;
	automaticColorSource: AutomaticColorSource;
	automaticColorProperty: BasesPropertyId | null;
	colorPack: ColorPackId;
	customColors: string[];
	showIcons: boolean;
	iconProperty: BasesPropertyId | null;
	folderIconSource: FolderIconSource;
	folderIconRules: Map<string, string>;
	inheritFolderIcons: boolean;
}

interface FolderMetadata {
	icon?: string;
}

export interface NotebookNavigatorApi {
	isStorageReady(): boolean;
	metadata: {
		getFolderMeta(folder: TFolder): FolderMetadata | null;
	};
	on(event: 'folder-changed' | 'storage-ready', callback: () => void): EventRef;
	off(ref: EventRef): void;
}

interface NotebookNavigatorPlugin {
	api?: NotebookNavigatorApi | null;
	settings?: {
		folderIcons?: Record<string, string | undefined>;
		fileIcons?: Record<string, string | undefined>;
		interfaceIcons?: Record<string, string | undefined>;
		useFrontmatterMetadata?: boolean;
		frontmatterIconField?: string;
	};
}

interface AppWithPlugins extends App {
	appId?: string;
	plugins?: {
		plugins?: Record<string, NotebookNavigatorPlugin | undefined>;
	};
}

interface ExternalIconDescriptor {
	provider: string;
	identifier: string;
	cssClass: string;
}

interface IconAssetRecord {
	metadata?: unknown;
}

const notebookNavigatorRootIcons = new WeakMap<NotebookNavigatorApi, string>();
const notebookNavigatorFolderIcons = new WeakMap<NotebookNavigatorApi, Record<string, string | undefined>>();
const notebookNavigatorFileIcons = new WeakMap<NotebookNavigatorApi, Record<string, string | undefined>>();
const notebookNavigatorFrontmatterIconFields = new WeakMap<NotebookNavigatorApi, string>();
const externalIconMetadata = new Map<string, Promise<Map<string, string>>>();

export function invalidateNotebookNavigatorIconCache(app: App): void {
	const appId = (app as AppWithPlugins).appId || 'default';
	for (const key of externalIconMetadata.keys()) {
		if (key.startsWith(`${appId}:`)) externalIconMetadata.delete(key);
	}
}

export function getNotebookNavigatorApi(app: App): NotebookNavigatorApi | null {
	const plugin = (app as AppWithPlugins).plugins?.plugins?.['notebook-navigator'];
	const candidate = plugin?.api;
	if (!candidate || typeof candidate.isStorageReady !== 'function') return null;
	if (!candidate.metadata || typeof candidate.metadata.getFolderMeta !== 'function') return null;
	if (plugin.settings?.folderIcons) notebookNavigatorFolderIcons.set(candidate, plugin.settings.folderIcons);
	else notebookNavigatorFolderIcons.delete(candidate);
	if (plugin.settings?.fileIcons) notebookNavigatorFileIcons.set(candidate, plugin.settings.fileIcons);
	else notebookNavigatorFileIcons.delete(candidate);
	const frontmatterIconField = plugin.settings?.useFrontmatterMetadata
		? plugin.settings.frontmatterIconField?.trim()
		: '';
	if (frontmatterIconField) notebookNavigatorFrontmatterIconFields.set(candidate, frontmatterIconField);
	else notebookNavigatorFrontmatterIconFields.delete(candidate);
	const rootIcon = plugin.settings?.folderIcons?.['/']?.trim()
		|| plugin.settings?.interfaceIcons?.['nav-folder-root']?.trim();
	if (rootIcon) notebookNavigatorRootIcons.set(candidate, rootIcon);
	else notebookNavigatorRootIcons.delete(candidate);
	return candidate;
}

export function parseFolderIconRules(values: unknown): Map<string, string> {
	const rules = new Map<string, string>();
	if (!Array.isArray(values)) return rules;
	for (const value of values) {
		if (typeof value !== 'string') continue;
		const separator = value.indexOf('=');
		if (separator < 0) continue;
		const path = normalizeFolderPath(value.slice(0, separator));
		const icon = value.slice(separator + 1).trim();
		if (icon) rules.set(path, icon);
	}
	return rules;
}

export function normalizeFolderPath(value: string): string {
	const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	return normalized === '.' || normalized === '/' ? '' : normalized;
}

/**
 * The plugin's shared appearance vocabulary. Every view declares the same color
 * and icon options with the same keys and defaults, so a Base configured for
 * one view means the same thing in another, and a colour choice made in a
 * Collection reads identically on a Kanban card or a timeline bar.
 */
export function colorViewOptions(itemLabel: string): ViewOption {
	return {
		type: 'group',
		displayName: 'Colors',
		items: [
			{
				type: 'dropdown',
				key: 'colorMode',
				displayName: itemLabel,
				default: 'none',
				options: {
					'property-auto': 'Frontmatter, then automatic',
					property: 'Frontmatter only',
					automatic: 'Automatic only',
					none: 'Off',
				},
			},
			{
				type: 'property',
				key: 'colorProperty',
				displayName: 'Frontmatter color property',
				default: 'note.color',
				placeholder: 'Named color or CSS hex value',
			},
			{
				type: 'dropdown',
				key: 'automaticColorSource',
				displayName: 'Automatic colors from',
				default: 'title',
				options: { title: 'Title', folder: 'Folder name', property: 'Property value' },
			},
			{
				type: 'property',
				key: 'automaticColorProperty',
				displayName: 'Automatic color property',
				placeholder: 'Status, type, category…',
			},
			{
				type: 'dropdown',
				key: 'colorPack',
				displayName: 'Color pack',
				default: 'notion',
				options: { notion: 'Notion', pastel: 'Pastel', vivid: 'Vivid', earth: 'Earth', custom: 'Custom' },
			},
			{
				type: 'multitext',
				key: 'customColors',
				displayName: 'Custom palette colors',
				default: [],
			},
		],
	};
}

/** Extra items let a view add its own, such as Collection's icon placement. */
export function iconViewOptions(extraItems: Exclude<ViewOption, { type: 'group' }>[] = []): ViewOption {
	return {
		type: 'group',
		displayName: 'Icons',
		items: [
			{
				type: 'toggle',
				key: 'showIcons',
				displayName: 'Show icons',
				default: true,
			},
			...extraItems,
			{
				type: 'property',
				key: 'iconProperty',
				displayName: 'Frontmatter icon property',
				default: 'note.icon',
				placeholder: 'Emoji or Lucide icon name',
			},
			{
				type: 'dropdown',
				key: 'folderIconSource',
				displayName: 'Folder icon source',
				default: 'none',
				options: {
					'notebook-navigator': 'Notebook Navigator',
					rules: 'Views folder rules',
					none: 'None',
				},
			},
			{
				type: 'multitext',
				key: 'folderIconRules',
				displayName: 'Folder icon rules (path=icon)',
				default: [],
			},
			{
				type: 'toggle',
				key: 'inheritFolderIcons',
				displayName: 'Inherit icons in subfolders',
				default: true,
			},
		],
	} as ViewOption;
}

/** Reads the shared options above out of any view's config, identically. */
export function readAppearanceConfig(config: BasesViewConfig): CollectionAppearanceConfig {
	const automaticColorProperty = config.getAsPropertyId('automaticColorProperty');
	const automaticColorSource = config.get('automaticColorSource');
	const folderIconSource = normalizeFolderIconSource(config.get('folderIconSource'));
	const customColors = config.get('customColors');
	return {
		colorMode: normalizeColorMode(config.get('colorMode')),
		colorProperty: config.getAsPropertyId('colorProperty') ?? ('note.color' as BasesPropertyId),
		// An automatic property set without an explicit source means the user
		// picked the property expecting it to be used.
		automaticColorSource: automaticColorSource === undefined && automaticColorProperty
			? 'property'
			: normalizeAutomaticColorSource(automaticColorSource),
		automaticColorProperty,
		colorPack: normalizeColorPack(config.get('colorPack')),
		customColors: Array.isArray(customColors)
			? customColors.filter((value): value is string => typeof value === 'string')
			: [],
		showIcons: config.get('showIcons') !== false,
		iconProperty: config.getAsPropertyId('iconProperty')
			?? (folderIconSource === 'notebook-navigator' ? null : ('note.icon' as BasesPropertyId)),
		folderIconSource,
		folderIconRules: parseFolderIconRules(config.get('folderIconRules')),
		inheritFolderIcons: config.get('inheritFolderIcons') !== false,
	};
}

function normalizeColorMode(value: unknown): CollectionColorMode {
	return value === 'property' || value === 'automatic' || value === 'property-auto' ? value : 'none';
}

function normalizeAutomaticColorSource(value: unknown): AutomaticColorSource {
	return value === 'folder' || value === 'property' ? value : 'title';
}

function normalizeColorPack(value: unknown): ColorPackId {
	return value === 'pastel' || value === 'vivid' || value === 'earth' || value === 'custom' ? value : 'notion';
}

function normalizeFolderIconSource(value: unknown): FolderIconSource {
	return value === 'rules' || value === 'notebook-navigator' ? value : 'none';
}

export function resolveCardColor(
	entry: BasesEntry,
	config: CollectionAppearanceConfig,
	title: string,
	app?: App,
	automaticPalette?: string[],
): string | null {
	if (config.colorMode === 'none') return null;
	if (config.colorMode === 'property' || config.colorMode === 'property-auto') {
		const basesValue = config.colorProperty ? entry.getValue(config.colorProperty) : null;
		const frontmatterValue = config.colorProperty && app
			? rawFrontmatterValue(app, entry, config.colorProperty)
			: null;
		for (const candidate of [basesValue, frontmatterValue]) {
			const normalized = normalizeColor(candidate);
			if (normalized && isCssColor(normalized)) return normalized;
		}
		if (config.colorMode === 'property') return null;
	}

	return stableColor(
		automaticColorSeed(entry, config, title),
		automaticPalette ?? automaticColorPalette(config),
	);
}

export function automaticColorPalette(config: CollectionAppearanceConfig): string[] {
	return resolveColorPalette(config.colorPack, config.customColors, false);
}

export function automaticColorSeed(
	entry: BasesEntry,
	config: CollectionAppearanceConfig,
	title: string,
): string {
	if (config.automaticColorSource === 'folder') return entry.file.parent?.path || 'Vault';
	if (config.automaticColorSource === 'property') {
		return config.automaticColorProperty ? scalarValue(entry, config.automaticColorProperty) : '';
	}
	return title;
}

export function resolveCardIcons(
	entry: BasesEntry,
	config: CollectionAppearanceConfig,
	notebookNavigator: NotebookNavigatorApi | null,
): string[] {
	if (!config.showIcons) return [];
	const icons: string[] = [];
	const addIcon = (icon: string | null | undefined): void => {
		const normalized = icon?.trim();
		if (normalized && !icons.includes(normalized)) icons.push(normalized);
	};
	const noteIcon = config.iconProperty ? scalarValue(entry, config.iconProperty) : '';
	addIcon(noteIcon);
	if (config.folderIconSource === 'none') return icons;

	if (config.folderIconSource === 'notebook-navigator' && notebookNavigator) {
		const field = notebookNavigatorFrontmatterIconFields.get(notebookNavigator);
		if (field) {
			const property = (field.startsWith('note.') ? field : `note.${field}`) as BasesPropertyId;
			addIcon(scalarValue(entry, property));
		}
		addIcon(notebookNavigatorFileIcons.get(notebookNavigator)?.[entry.file.path]);
	}
	const noteFolder = entry.file.parent;

	for (const folder of folderCandidates(noteFolder, config.inheritFolderIcons)) {
		if (config.folderIconSource === 'rules') {
			addIcon(config.folderIconRules.get(normalizeFolderPath(folder.path)));
		}
		if (config.folderIconSource === 'notebook-navigator' && notebookNavigator) {
			if (notebookNavigator.isStorageReady()) {
				// Metadata is assigned per folder. Walk the real TFolder parent chain so
				// an unstyled subfolder inherits the closest icon above it.
				try {
					const icon = notebookNavigator.metadata.getFolderMeta(folder)?.icon?.trim();
					addIcon(icon);
				} catch {
					// A stale folder object must not stop the rest of the card from rendering.
				}
			}
			// The public metadata API is unavailable during Notebook Navigator's
			// storage bootstrap. Its loaded settings are sufficient for direct folder
			// assignments and prevent large vaults from showing temporary folder icons.
			const folderIcons = notebookNavigatorFolderIcons.get(notebookNavigator);
			addIcon(folderIcons?.[folder.path || '/']);
		}
	}

	// Notebook Navigator does not expose its configurable interface icons through
	// the metadata API. Use the matching Obsidian defaults at the end of the chain
	// instead of leaving an empty preview/icon slot.
	if (config.folderIconSource === 'notebook-navigator') {
		const rootIcon = notebookNavigator ? notebookNavigatorRootIcons.get(notebookNavigator) : null;
		addIcon(rootIcon);
		addIcon(defaultFolderIcon(noteFolder));
	}
	return icons;
}

export function renderCollectionIcon(container: HTMLElement, rawIcons: string[], app: App): void {
	void renderFirstAvailableIcon(container, rawIcons, app);
}

async function renderFirstAvailableIcon(container: HTMLElement, rawIcons: string[], app: App): Promise<void> {
	for (const rawIcon of rawIcons) {
		if (!container.isConnected) return;
		const icon = rawIcon.trim();
		if (!icon) continue;
		const emoji = icon.startsWith('emoji:') ? icon.slice(6) : icon;
		if (containsNonAscii(emoji)) {
			container.setText(emoji);
			container.addClass('is-emoji');
			return;
		}

		const lucideName = icon.replace(/^lucide[:-]/, '');
		if (getIcon(lucideName)) {
			setIcon(container, lucideName);
			return;
		}

		const externalIcon = parseExternalIcon(icon);
		if (externalIcon && await renderExternalIcon(container, externalIcon, app)) return;
	}
	if (!container.isConnected) return;
	setIcon(container, 'folder-closed');
}

function parseExternalIcon(icon: string): ExternalIconDescriptor | null {
	const providers: Record<string, { provider: string; cssClass: string }> = {
		'fontawesome-solid': { provider: 'fontawesome-solid', cssClass: 'nn-iconfont-fa-solid' },
		'rpg-awesome': { provider: 'rpg-awesome', cssClass: 'nn-iconfont-rpg-awesome' },
		'bootstrap-icons': { provider: 'bootstrap-icons', cssClass: 'nn-iconfont-bootstrap-icons' },
		'material-icons': { provider: 'material-icons', cssClass: 'nn-iconfont-material-icons' },
		phosphor: { provider: 'phosphor', cssClass: 'nn-iconfont-phosphor' },
		'simple-icons': { provider: 'simple-icons', cssClass: 'nn-iconfont-simple-icons' },
	};
	const prefixes: Record<string, string> = {
		fas: 'fontawesome-solid',
		ra: 'rpg-awesome',
		bi: 'bootstrap-icons',
		mi: 'material-icons',
		ph: 'phosphor',
		si: 'simple-icons',
	};

	const colon = icon.indexOf(':');
	let providerId = '';
	let identifier = '';
	if (colon > 0) {
		providerId = icon.slice(0, colon);
		identifier = icon.slice(colon + 1);
	} else {
		const separator = icon.indexOf('-');
		if (separator < 1) return null;
		providerId = prefixes[icon.slice(0, separator)] ?? '';
		identifier = icon.slice(separator + 1);
	}
	const provider = providers[providerId];
	if (!provider || !identifier) return null;
	return { ...provider, identifier };
}

async function renderExternalIcon(
	container: HTMLElement,
	descriptor: ExternalIconDescriptor,
	app: App,
): Promise<boolean> {
	try {
		const metadata = await getExternalIconMetadata(app, descriptor.provider);
		if (!container.isConnected) return false;
		const unicode = metadata.get(descriptor.identifier);
		if (!unicode) return false;
		const codePoint = Number.parseInt(unicode.replace(/^0x/i, ''), 16);
		if (!Number.isFinite(codePoint) || codePoint <= 0) return false;
		container.empty();
		container.addClass('nn-iconfont', descriptor.cssClass);
		container.setText(String.fromCodePoint(codePoint));
		container.setAttr('aria-label', descriptor.identifier);
		container.setAttr('title', descriptor.identifier);
		return true;
	} catch {
		return false;
	}
}

function getExternalIconMetadata(app: App, provider: string): Promise<Map<string, string>> {
	const appId = (app as AppWithPlugins).appId || 'default';
	const cacheKey = `${appId}:${provider}`;
	let pending = externalIconMetadata.get(cacheKey);
	if (!pending) {
		pending = readExternalIconMetadata(appId, provider).catch((error: unknown) => {
			externalIconMetadata.delete(cacheKey);
			throw error;
		});
		externalIconMetadata.set(cacheKey, pending);
	}
	return pending;
}

function readExternalIconMetadata(appId: string, provider: string): Promise<Map<string, string>> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(`notebooknavigator/icons/${appId}`);
		request.onupgradeneeded = () => {
			request.transaction?.abort();
			reject(new Error('Notebook Navigator icon database is not installed.'));
		};
		request.onerror = () => reject(request.error ?? new Error('Unable to open Notebook Navigator icon database.'));
		request.onsuccess = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains('providers')) {
				database.close();
				reject(new Error('Notebook Navigator icon provider store is unavailable.'));
				return;
			}
			const transaction = database.transaction('providers', 'readonly');
			const read = transaction.objectStore('providers').get(provider);
			read.onerror = () => reject(read.error ?? new Error('Unable to read Notebook Navigator icon metadata.'));
			read.onsuccess = () => {
				database.close();
				resolve(parseIconMetadata((read.result as IconAssetRecord | undefined)?.metadata));
			};
		};
	});
}

function parseIconMetadata(raw: unknown): Map<string, string> {
	const icons = new Map<string, string>();
	if (typeof raw !== 'string') return icons;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return icons;
	}
	if (Array.isArray(parsed)) {
		for (const value of parsed) addIconMetadata(icons, value);
		return icons;
	}
	if (!parsed || typeof parsed !== 'object') return icons;
	for (const [identifier, value] of Object.entries(parsed)) addIconMetadata(icons, value, identifier);
	return icons;
}

function addIconMetadata(icons: Map<string, string>, raw: unknown, fallbackId = ''): void {
	if (!raw || typeof raw !== 'object') return;
	const value = raw as { id?: unknown; unicode?: unknown };
	const identifier = typeof value.id === 'string' ? value.id : fallbackId;
	const unicode = typeof value.unicode === 'string' || typeof value.unicode === 'number'
		? String(value.unicode).trim()
		: '';
	if (identifier && unicode) icons.set(identifier, unicode);
}

function folderCandidates(folder: TFolder | null, inherit: boolean): TFolder[] {
	if (!folder) return [];
	if (!inherit) return [folder];
	const folders: TFolder[] = [];
	let current: TFolder | null = folder;
	while (current) {
		folders.push(current);
		current = current.parent;
	}
	return folders;
}

function defaultFolderIcon(folder: TFolder | null): string {
	return folder && normalizeFolderPath(folder.path) ? 'folder-closed' : 'vault';
}

function scalarValue(entry: BasesEntry, property: BasesPropertyId): string {
	const raw = entry.getValue(property)?.toString().trim() ?? '';
	if (!raw) return '';
	const quoted = raw.match(/^['"](.*)['"]$/);
	return (quoted?.[1] ?? raw).trim();
}

function rawFrontmatterValue(app: App, entry: BasesEntry, property: BasesPropertyId): unknown {
	if (!property.startsWith('note.')) return null;
	const propertyName = property.slice('note.'.length);
	const frontmatter = app.metadataCache.getFileCache(entry.file)?.frontmatter;
	if (!frontmatter) return null;
	if (Object.prototype.hasOwnProperty.call(frontmatter, propertyName)) return frontmatter[propertyName];
	const matchedKey = Object.keys(frontmatter).find((key) => key.toLocaleLowerCase() === propertyName.toLocaleLowerCase());
	return matchedKey ? frontmatter[matchedKey] : null;
}

function containsNonAscii(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) > 127) return true;
	}
	return false;
}
