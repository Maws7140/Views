import {
	BasesEntry,
	BasesEntryGroup,
	BasesPropertyId,
	BasesView,
	Keymap,
	Menu,
	QueryController,
	setIcon,
	SliderOption,
	TFile,
	ViewOption,
} from 'obsidian';
import {
	AutomaticColorSource,
	CollectionAppearanceConfig,
	CollectionColorMode,
	FolderIconSource,
	getNotebookNavigatorApi,
	invalidateNotebookNavigatorIconCache,
	NotebookNavigatorApi,
	parseFolderIconRules,
	renderCollectionIcon,
	resolveCardColor,
	resolveCardIcons,
} from './collection/appearance';
import { ColorPackId, resolveColorPalette } from './table-colors/palettes';
import { isPropertyColorEnabled } from './settings/settings';
import { renderPropertyValue } from './ui/PropertyValueRenderer';
import { isInteractiveTarget, showFileMenu } from './ui/EntryInteractions';
import { CollectionScrollbar, ScrollbarOrientation } from './collection/CollectionScrollbar';
import { reportPerformance } from './performance/metrics';
import type ViewsPlugin from './main';

export const CollectionViewType = 'more-bases-collection';

type CollectionLayout = 'carousel' | 'grid';
type CardAspect = 'flexible' | 'square';
type CardDirection = 'vertical' | 'image-left' | 'image-right';
type MediaFit = 'smart' | 'contain' | 'cover';
type IconPlacement = 'automatic' | 'preview' | 'title';
type CardCorners = 'rounded' | 'square';

interface CollectionConfig extends CollectionAppearanceConfig {
	layout: CollectionLayout;
	mediaProperty: BasesPropertyId | null;
	titleProperty: BasesPropertyId | null;
	cardWidth: number;
	gap: number;
	aspect: CardAspect;
	cardDirection: CardDirection;
	cardHeight: number;
	mediaShare: number;
	mediaFit: MediaFit;
	snap: boolean;
	iconPlacement: IconPlacement;
	propertyValueColors: boolean;
	cardCorners: CardCorners;
}

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const LARGE_COLLECTION_THRESHOLD = 80;
const GRID_PAGE_ROWS = 4;
const CAROUSEL_PAGE_SIZE = 16;
const CARDS_PER_FRAME = 8;
const FRAME_BUDGET_MS = 8;
const DOUBLE_CLICK_DELAY_MS = 350;
const MAX_RETAINED_CARDS = 192;
const RETENTION_MARGIN_PX = 1600;

interface RenderWork {
	generation: number;
	run: () => void;
}

interface DetailProperty {
	property: BasesPropertyId;
	displayName: string;
}

interface CollectionRenderContext {
	config: CollectionConfig;
	detailProperties: DetailProperty[];
	cardPalette: string[];
	valuePalette: string[] | undefined;
	notebookNavigator: NotebookNavigatorApi | null;
	iconCandidates: Map<string, string[]>;
	mediaResources: Map<string, string | null>;
}

interface CollectionScrollState {
	vertical: number;
	horizontal: number[];
}

interface RetainedCard {
	entry: BasesEntry;
	context: CollectionRenderContext;
}

export class CollectionView extends BasesView {
	type = CollectionViewType;
	private readonly scrollHostEl: HTMLElement;
	private readonly containerEl: HTMLElement;
	private renderGeneration = 0;
	private renderFrame: number | null = null;
	private readonly renderQueue: RenderWork[] = [];
	private renderQueueIndex = 0;
	private readonly renderObservers = new Set<IntersectionObserver>();
	private readonly pendingCardOpens = new Set<number>();
	private readonly cardsByPath = new Map<string, Set<HTMLElement>>();
	private readonly placeholdersByPath = new Map<string, Set<HTMLElement>>();
	private readonly entriesByCard = new WeakMap<HTMLElement, BasesEntry>();
	private readonly pendingOpenByCard = new WeakMap<HTMLElement, number>();
	private readonly scrollbars = new Set<CollectionScrollbar>();
	private readonly cardScrollbars = new WeakMap<HTMLElement, CollectionScrollbar>();
	private notebookNavigatorEventsRegistered = false;
	private lastRenderSignature = '';
	private retentionObserver: IntersectionObserver | null = null;
	private readonly retainedCards = new WeakMap<HTMLElement, RetainedCard>();
	private readonly mountedCards = new Set<HTMLElement>();
	private retentionFrame: number | null = null;
	private activeRenderContext: CollectionRenderContext | null = null;

	constructor(private readonly plugin: ViewsPlugin, controller: QueryController, parentEl: HTMLElement) {
		super(controller);
		this.scrollHostEl = parentEl.createDiv({ cls: 'mbv-collection-shell' });
		this.containerEl = this.scrollHostEl.createDiv({ cls: 'mbv-collection' });
		this.registerEvent(this.app.vault.on('delete', (file) => this.removeDeletedFile(file.path)));
		this.registerDomEvent(this.containerEl, 'click', (event) => this.handleCardClick(event));
		this.registerDomEvent(this.containerEl, 'dblclick', (event) => this.handleCardDoubleClick(event));
		this.registerDomEvent(this.containerEl, 'contextmenu', (event) => this.handleCardContextMenu(event));
		this.registerDomEvent(this.containerEl, 'auxclick', (event) => this.handleCardAuxClick(event));
		this.registerDomEvent(this.containerEl, 'keydown', (event) => this.handleCardKeyDown(event));
		this.registerDomEvent(this.containerEl, 'pointerover', (event) => this.ensureHoveredCardScrollbar(event));
		this.registerDomEvent(this.containerEl, 'focusin', (event) => this.ensureHoveredCardScrollbar(event));
		this.register(this.plugin.onPropertyColorSettingsChanged(() => {
			this.lastRenderSignature = '';
			this.onDataUpdated();
		}));
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				type: 'group',
				displayName: 'Layout',
				items: [
					{
						type: 'dropdown',
						key: 'layout',
						displayName: 'Layout style',
						default: 'carousel',
						options: { carousel: 'Horizontal', grid: 'Grid' },
					},
					{
						type: 'slider',
						key: 'cardWidth',
						// Every size slider in the plugin steps by 1.
						displayName: 'Card size',
						default: 240,
						min: 48,
						max: 960,
						step: 1,
						instant: true,
					},
					{
						type: 'slider',
						key: 'cardHeight',
						displayName: 'Card height',
						default: 160,
						min: 48,
						max: 960,
						step: 1,
						instant: true,
						// Obsidian supports this runtime ViewOption predicate even though
						// it is not yet declared in the public type definitions.
						shouldHide: (config: { get(key: string): unknown }) => config.get('aspect') === 'square',
					} as SliderOption & { shouldHide(config: { get(key: string): unknown }): boolean },
					{
						type: 'slider',
						key: 'gap',
						displayName: 'Card gap',
						default: 16,
						min: 0,
						max: 32,
						step: 1,
						instant: true,
					},
					{
						type: 'dropdown',
						key: 'cardCorners',
						displayName: 'Card corners',
						default: 'rounded',
						options: { rounded: 'Rounded', square: 'Square' },
					},
					{
						type: 'dropdown',
						key: 'aspect',
						displayName: 'Card proportions',
						default: 'flexible',
						options: { flexible: 'Flexible', square: 'Square' },
					},
					{
						type: 'dropdown',
						key: 'cardDirection',
						displayName: 'Card direction',
						default: 'vertical',
						options: {
							vertical: 'Top to bottom',
							'image-left': 'Image left',
							'image-right': 'Image right',
						},
					},
					{
						type: 'slider',
						key: 'mediaShare',
						displayName: 'Image space',
						default: 50,
						min: 0,
						max: 100,
						step: 1,
						instant: true,
					},
					{
						type: 'dropdown',
						key: 'mediaFit',
						displayName: 'Image fit',
						default: 'smart',
						options: { smart: 'Smart', contain: 'Contain', cover: 'Cover' },
					},
					{
						type: 'toggle',
						key: 'snap',
						displayName: 'Snap horizontal cards',
						default: true,
					},
				],
			},
			{
				type: 'group',
				displayName: 'Card content',
				items: [
					{
						type: 'property',
						key: 'mediaProperty',
						displayName: 'Media property',
						placeholder: 'Cover, image, or attachment',
					},
					{
						type: 'property',
						key: 'titleProperty',
						displayName: 'Title property',
						default: 'file.name',
					},
				],
			},
			{
				type: 'group',
				displayName: 'Colors',
				items: [
					{
						type: 'dropdown',
						key: 'colorMode',
						displayName: 'Card colors',
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
						options: { title: 'Card title', folder: 'Folder name', property: 'Property value' },
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
			},
			{
				type: 'group',
				displayName: 'Property values',
				items: [
					{
						type: 'toggle',
						key: 'propertyValueColors',
						displayName: 'Automatic tag and list colors',
						default: true,
					},
				],
			},
			{
				type: 'group',
				displayName: 'Icons',
				items: [
					{
						type: 'toggle',
						key: 'showIcons',
						displayName: 'Show card icons',
						default: true,
					},
					{
						type: 'dropdown',
						key: 'iconPlacement',
						displayName: 'Icon placement',
						default: 'automatic',
						options: {
							automatic: 'Preview, or title with image',
							preview: 'Preview slot',
							title: 'Beside title',
						},
					},
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
			},
		];
	}

	onDataUpdated(): void {
		const scrollState = this.captureScrollState();
		const config = this.readConfig();
		const signature = this.renderSignature(config);
		if (signature === this.lastRenderSignature && this.containerEl.childElementCount > 0) {
			if (this.activeRenderContext) this.activeRenderContext.config = config;
			this.applyVisualConfig(config);
			return;
		}
		this.cancelPendingRendering();
		this.lastRenderSignature = signature;
		this.render(config, scrollState);
	}

	onunload(): void {
		this.cancelPendingRendering();
	}

	private readConfig(): CollectionConfig {
		const layout = this.config.get('layout');
		const aspect = this.config.get('aspect');
		const cardDirection = this.config.get('cardDirection');
		const mediaFit = this.config.get('mediaFit');
		const colorMode = this.config.get('colorMode');
		const automaticColorSource = this.config.get('automaticColorSource');
		const automaticColorProperty = this.config.getAsPropertyId('automaticColorProperty');
		const colorPack = this.config.get('colorPack');
		const folderIconSource = this.config.get('folderIconSource');
		const iconPlacement = this.config.get('iconPlacement');
		const cardCorners = this.config.get('cardCorners');
		return {
			layout: layout === 'grid' ? 'grid' : 'carousel',
			mediaProperty: this.config.getAsPropertyId('mediaProperty'),
			titleProperty: this.config.getAsPropertyId('titleProperty') ?? 'file.name',
			cardWidth: this.numberOption('cardWidth', 240, 48, 960),
			gap: this.numberOption('gap', 16, 0, 32),
			// Existing portrait and landscape configs migrate to the same flexible
			// width and height behavior they already shared.
			aspect: aspect === 'square' ? 'square' : 'flexible',
			cardDirection: this.cardDirection(cardDirection),
			cardHeight: this.numberOption('cardHeight', 160, 48, 960),
			mediaShare: this.numberOption('mediaShare', 50, 0, 100),
			mediaFit: mediaFit === 'contain' || mediaFit === 'cover' ? mediaFit : 'smart',
			snap: this.config.get('snap') !== false,
			colorMode: this.colorMode(colorMode),
			colorProperty: this.config.getAsPropertyId('colorProperty') ?? 'note.color',
			// Bases omits dropdown defaults from the saved view. If a user chooses an
			// automatic property while the source dropdown is still at its implicit
			// default, treat that property selection as authoritative instead of
			// silently hashing card titles.
			automaticColorSource: automaticColorSource === undefined && automaticColorProperty
				? 'property'
				: this.automaticColorSource(automaticColorSource),
			automaticColorProperty,
			colorPack: this.colorPack(colorPack),
			customColors: this.stringListOption('customColors'),
			showIcons: this.config.get('showIcons') !== false,
			iconPlacement: this.iconPlacement(iconPlacement),
			propertyValueColors: this.config.get('propertyValueColors') !== false,
			// Preserve the old boolean setting while using an explicit dropdown value
			// that Bases reliably persists for square corners.
			cardCorners: cardCorners === 'square'
				|| (cardCorners === undefined && this.config.get('roundedCorners') === false)
				? 'square'
				: 'rounded',
			iconProperty: this.config.getAsPropertyId('iconProperty')
				?? (this.folderIconSource(folderIconSource) === 'notebook-navigator' ? null : 'note.icon'),
			folderIconSource: this.folderIconSource(folderIconSource),
			folderIconRules: parseFolderIconRules(this.config.get('folderIconRules')),
			inheritFolderIcons: this.config.get('inheritFolderIcons') !== false,
		};
	}

	private colorMode(value: unknown): CollectionColorMode {
		return value === 'property' || value === 'automatic' || value === 'property-auto' ? value : 'none';
	}

	private cardDirection(value: unknown): CardDirection {
		return value === 'image-left' || value === 'image-right' ? value : 'vertical';
	}

	private automaticColorSource(value: unknown): AutomaticColorSource {
		return value === 'folder' || value === 'property' ? value : 'title';
	}

	private colorPack(value: unknown): ColorPackId {
		return value === 'pastel' || value === 'vivid' || value === 'earth' || value === 'custom' ? value : 'notion';
	}

	private folderIconSource(value: unknown): FolderIconSource {
		return value === 'rules' || value === 'notebook-navigator' ? value : 'none';
	}

	private iconPlacement(value: unknown): IconPlacement {
		return value === 'preview' || value === 'title' ? value : 'automatic';
	}

	private stringListOption(key: string): string[] {
		const value = this.config.get(key);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
	}

	private numberOption(key: string, fallback: number, min: number, max: number): number {
		const value = this.config.get(key);
		if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
		return Math.min(max, Math.max(min, value));
	}

	private render(config: CollectionConfig, scrollState?: CollectionScrollState): void {
		const startedAt = performance.now();
		const generation = this.renderGeneration;
		const context = this.createRenderContext(config);
		this.activeRenderContext = context;
		if (context.notebookNavigator) this.registerNotebookNavigatorEvents(context.notebookNavigator);
		this.containerEl.empty();
		this.cardsByPath.clear();
		this.placeholdersByPath.clear();
		this.setupCardRetention(this.data.data.length >= LARGE_COLLECTION_THRESHOLD);
		this.applyVisualConfig(config);
		this.containerEl.toggleClass('is-grid', config.layout === 'grid');
		this.containerEl.toggleClass('is-carousel', config.layout === 'carousel');

		if (!this.data?.data?.length) {
			const emptyEl = this.containerEl.createDiv({ cls: 'mbv-empty' });
			setIcon(emptyEl.createSpan({ cls: 'mbv-empty-icon' }), 'images');
			emptyEl.createDiv({ cls: 'mbv-empty-title', text: 'No items in this collection' });
			emptyEl.createDiv({ cls: 'mbv-empty-description', text: 'Adjust the Base filters or add matching files.' });
			return;
		}

		const groups = this.getVisibleGroups();
		const showHeadings = groups.length > 1 || groups.some((group) => group.key?.isTruthy());

		for (const group of groups) {
			const sectionEl = this.containerEl.createEl('section', { cls: 'mbv-section' });
			if (showHeadings) this.renderGroupHeader(sectionEl, group.key?.toString() || 'Ungrouped', group.entries.length);

			const railEl = sectionEl.createDiv({ cls: 'mbv-rail' });
			railEl.setAttr('role', 'list');
			railEl.setAttr('aria-label', group.key?.toString() || 'Collection items');

			if (this.data.data.length < LARGE_COLLECTION_THRESHOLD) {
				for (const entry of group.entries) {
					if (this.isEntryLive(entry)) this.renderCard(railEl, entry, context);
				}
			} else {
				this.renderGroupOnDemand(sectionEl, railEl, group.entries, context, generation);
			}
			if (config.layout === 'carousel') this.addScrollbar(railEl, sectionEl, 'horizontal', true);
		}
		this.addScrollbar(this.containerEl, this.scrollHostEl, 'vertical', true);
		if (scrollState) this.restoreScrollState(scrollState, generation);
		reportPerformance('collection synchronous render', startedAt, {
			groups: groups.length,
			mountedCards: this.containerEl.querySelectorAll('.mbv-card').length,
			scrollbars: this.scrollbars.size,
		});
	}

	private applyVisualConfig(config: CollectionConfig): void {
		this.containerEl.toggleClass('has-snap', config.snap);
		this.containerEl.toggleClass('is-square', config.aspect === 'square');
		this.containerEl.toggleClass('uses-independent-height', config.aspect !== 'square');
		this.containerEl.toggleClass('is-horizontal', config.cardDirection !== 'vertical');
		this.containerEl.toggleClass('is-image-right', config.cardDirection === 'image-right');
		this.containerEl.toggleClass('media-fit-smart', config.mediaFit === 'smart');
		this.containerEl.toggleClass('media-fit-contain', config.mediaFit === 'contain');
		this.containerEl.toggleClass('media-fit-cover', config.mediaFit === 'cover');
		this.containerEl.setCssProps({
			'--mbv-card-width': `${config.cardWidth}px`,
			'--mbv-gap': `${config.gap}px`,
			'--mbv-card-height': `${config.cardHeight}px`,
			'--mbv-media-share': `${config.mediaShare}%`,
			'--mbv-card-radius': config.cardCorners === 'square' ? '0px' : 'var(--radius-l)',
		});
		this.containerEl.querySelectorAll<HTMLElement>('.mbv-card.has-media').forEach((card) => {
			card.toggleClass('is-preview-hidden', config.mediaShare === 0);
			card.toggleClass('is-content-hidden', config.mediaShare === 100);
		});
	}

	private renderSignature(config: CollectionConfig): string {
		const styleKeys = new Set(['cardWidth', 'gap', 'cardHeight', 'mediaShare', 'cardCorners', 'snap', 'aspect', 'cardDirection', 'mediaFit']);
		const structuralConfig = Object.fromEntries(Object.entries(config)
			.filter(([key]) => !styleKeys.has(key))
			.map(([key, value]) => [key, value instanceof Map ? Array.from(value.entries()) : value]));
		const properties = new Set<BasesPropertyId>(this.config.getOrder());
		for (const property of [config.mediaProperty, config.titleProperty, config.colorProperty, config.automaticColorProperty, config.iconProperty]) {
			if (property) properties.add(property);
		}
		const groups = this.getVisibleGroups().map((group) => ({
			key: group.key?.toString() ?? '',
			entries: group.entries.map((entry) => [
				entry.file.path,
				...Array.from(properties, (property) => entry.getValue(property)?.toString() ?? ''),
			]),
		}));
		return JSON.stringify([structuralConfig, Array.from(properties), groups]);
	}

	private captureScrollState(): CollectionScrollState {
		return {
			vertical: this.containerEl.scrollTop,
			horizontal: Array.from(this.containerEl.querySelectorAll<HTMLElement>('.mbv-rail'), (rail) => rail.scrollLeft),
		};
	}

	private restoreScrollState(state: CollectionScrollState, generation: number): void {
		window.requestAnimationFrame(() => {
			if (generation !== this.renderGeneration || !this.containerEl.isConnected) return;
			this.containerEl.scrollTop = state.vertical;
			this.containerEl.querySelectorAll<HTMLElement>('.mbv-rail').forEach((rail, index) => {
				rail.scrollLeft = state.horizontal[index] ?? 0;
			});
		});
	}

	private createRenderContext(config: CollectionConfig): CollectionRenderContext {
		const excluded = new Set([config.mediaProperty, config.titleProperty].filter(Boolean));
		const detailProperties = this.config.getOrder()
			.filter((property) => !excluded.has(property))
			.map((property) => ({ property, displayName: this.config.getDisplayName(property) }));
		return {
			config,
			detailProperties,
			cardPalette: resolveColorPalette(config.colorPack, config.customColors, false),
			valuePalette: config.propertyValueColors && this.plugin.settings.tableColorsEnabled
				? resolveColorPalette(this.plugin.settings.colorPack, this.plugin.settings.customPalette)
				: undefined,
			notebookNavigator: config.folderIconSource === 'notebook-navigator'
				? getNotebookNavigatorApi(this.app)
				: null,
			iconCandidates: new Map(),
			mediaResources: new Map(),
		};
	}

	private renderGroupOnDemand(
		sectionEl: HTMLElement,
		railEl: HTMLElement,
		entries: BasesEntry[],
		context: CollectionRenderContext,
		generation: number,
	): void {
		const config = context.config;
		let rendered = 0;
		let loading = false;
		const pageSize = config.layout === 'grid'
			? this.gridPageSize(config)
			: CAROUSEL_PAGE_SIZE;
		const sentinelEl = railEl.createDiv({ cls: 'mbv-load-more' });
		const labelEl = sentinelEl.createSpan({
			cls: 'mbv-load-more-label',
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		const buttonEl = sentinelEl.createEl('button', { text: 'Load more' });

		const updateLabel = (): void => {
			labelEl.setText(`${Math.min(rendered, entries.length).toLocaleString()} of ${entries.length.toLocaleString()}`);
		};
		updateLabel();

		let observer: IntersectionObserver | null = null;
		const queuePage = (): void => {
			if (loading || rendered >= entries.length || generation !== this.renderGeneration) return;
			loading = true;
			observer?.unobserve(sentinelEl);
			buttonEl.disabled = true;
			buttonEl.setText('Loading…');
			const end = Math.min(entries.length, rendered + pageSize);
			for (let index = rendered; index < end; index += 1) {
				const entry = entries[index];
				this.renderQueue.push({
					generation,
					run: () => {
						if (!this.isEntryLive(entry)) return;
						const cardEl = this.renderCard(railEl, entry, context);
						railEl.insertBefore(cardEl, sentinelEl);
					},
				});
			}
			this.renderQueue.push({
				generation,
				run: () => {
					rendered = end;
					loading = false;
					updateLabel();
					if (rendered >= entries.length) {
						observer?.disconnect();
						if (observer) this.renderObservers.delete(observer);
						sentinelEl.remove();
						return;
					}
					buttonEl.disabled = false;
					buttonEl.setText('Load more');
					observer?.observe(sentinelEl);
				},
			});
			this.scheduleRenderWork();
		};

		buttonEl.addEventListener('click', queuePage);
		observer = new IntersectionObserver((records) => {
			if (records.some((record) => record.isIntersecting)) queuePage();
		}, {
			root: config.layout === 'carousel' ? railEl : this.containerEl,
			rootMargin: config.layout === 'carousel' ? '0px 640px' : '800px 0px',
			threshold: 0.01,
		});
		this.renderObservers.add(observer);
		sectionEl.addClass('is-progressive');
		observer.observe(sentinelEl);
	}

	private gridPageSize(config: CollectionConfig): number {
		const style = window.getComputedStyle(this.containerEl);
		const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
		const available = Math.max(0, this.containerEl.clientWidth - padding);
		const minimumCardWidth = Math.min(config.cardWidth, available || config.cardWidth);
		const columns = Math.max(1, Math.floor((available + config.gap) / (minimumCardWidth + config.gap)));
		return Math.max(columns * GRID_PAGE_ROWS, CARDS_PER_FRAME);
	}

	private scheduleRenderWork(): void {
		if (this.renderFrame !== null) return;
		this.renderFrame = window.requestAnimationFrame(() => {
			this.renderFrame = null;
			let completedCards = 0;
			const startedAt = performance.now();
			while (
				this.renderQueueIndex < this.renderQueue.length
				&& completedCards < CARDS_PER_FRAME
				&& (completedCards === 0 || performance.now() - startedAt < FRAME_BUDGET_MS)
			) {
				const work = this.renderQueue[this.renderQueueIndex];
				this.renderQueueIndex += 1;
				if (!work || work.generation !== this.renderGeneration) continue;
				try {
					work.run();
				} catch (error) {
					// A file or referenced value can disappear after Bases creates an
					// entry but before progressive rendering reaches it. One stale card
					// must never abort the remaining render queue.
					console.warn('[Views] Skipped a stale Collection card.', error);
				}
				completedCards += 1;
			}
			if (this.renderQueueIndex < this.renderQueue.length) {
				this.scheduleRenderWork();
			} else {
				this.renderQueue.length = 0;
				this.renderQueueIndex = 0;
			}
		});
	}

	private cancelPendingRendering(): void {
		this.renderGeneration += 1;
		this.renderQueue.length = 0;
		this.renderQueueIndex = 0;
		for (const timer of this.pendingCardOpens) window.clearTimeout(timer);
		this.pendingCardOpens.clear();
		if (this.renderFrame !== null) {
			window.cancelAnimationFrame(this.renderFrame);
			this.renderFrame = null;
		}
		for (const observer of this.renderObservers) observer.disconnect();
		this.renderObservers.clear();
		for (const scrollbar of this.scrollbars) scrollbar.destroy();
		this.scrollbars.clear();
		this.retentionObserver?.disconnect();
		this.retentionObserver = null;
		this.mountedCards.clear();
		this.activeRenderContext = null;
		if (this.retentionFrame !== null) {
			window.cancelAnimationFrame(this.retentionFrame);
			this.retentionFrame = null;
		}
	}

	private getVisibleGroups(): BasesEntryGroup[] {
		// groupedData is the Bases API's authoritative render projection. It already
		// applies native grouping, filtering, sorting, and limits, and returns one
		// empty-key group when grouping is disabled. `groupBy` is a core Bases option,
		// so reading it through the custom view-option config incorrectly returned
		// undefined and flattened every Grid into a single group.
		return this.data.groupedData.filter((group) => group.entries.length > 0);
	}

	private renderGroupHeader(sectionEl: HTMLElement, label: string, count: number): void {
		const headerEl = sectionEl.createDiv({ cls: 'mbv-section-header' });
		headerEl.createEl('h3', { cls: 'mbv-section-title', text: label });
		headerEl.createSpan({ cls: 'mbv-section-count', text: String(count), attr: { 'aria-label': `${count} items` } });
	}

	private renderCard(parentEl: HTMLElement, entry: BasesEntry, context: CollectionRenderContext): HTMLElement {
		const config = context.config;
		const title = this.getTitle(entry, config.titleProperty);
		let icons = context.iconCandidates.get(entry.file.path);
		if (!icons) {
			icons = resolveCardIcons(entry, config, context.notebookNavigator);
			context.iconCandidates.set(entry.file.path, icons);
		}
		const mediaResource = config.mediaProperty ? this.getMediaResource(entry, config.mediaProperty, context.mediaResources) : null;
		const iconInPreview = icons.length > 0 && (
			config.iconPlacement === 'preview'
			|| (config.iconPlacement === 'automatic' && !mediaResource)
		);
		const iconBesideTitle = icons.length > 0 && (
			config.iconPlacement === 'title'
			|| (config.iconPlacement === 'automatic' && Boolean(mediaResource))
		);
		const cardEl = parentEl.createEl('article', {
			cls: 'mbv-card',
			attr: { role: 'listitem', tabindex: '0', 'aria-label': title },
		});
		this.trackCard(entry.file.path, cardEl);
		this.entriesByCard.set(cardEl, entry);
		this.mountedCards.add(cardEl);
		this.retainedCards.set(cardEl, { entry, context });
		this.retentionObserver?.observe(cardEl);
		this.scheduleRetentionPrune();
		const color = resolveCardColor(entry, config, title, this.app, context.cardPalette);
		if (color) {
			cardEl.addClass('has-card-color');
			cardEl.setCssProps({ '--mbv-card-color': color });
		}
		if (iconInPreview || config.mediaProperty) {
			cardEl.addClass('has-media');
			cardEl.toggleClass('is-preview-hidden', config.mediaShare === 0);
			cardEl.toggleClass('is-content-hidden', config.mediaShare === 100);
			const mediaEl = cardEl.createDiv({ cls: 'mbv-card-media' });
			if (iconInPreview) {
				mediaEl.addClass('is-icon-preview');
				renderCollectionIcon(mediaEl.createDiv({ cls: 'mbv-card-preview-icon' }), icons, this.app);
			} else {
				this.renderMedia(mediaEl, entry, mediaResource);
			}
		}

		const bodyEl = cardEl.createDiv({ cls: 'mbv-card-body' });
		const headingEl = bodyEl.createDiv({ cls: 'mbv-card-heading' });
		if (iconBesideTitle) renderCollectionIcon(headingEl.createSpan({ cls: 'mbv-card-icon' }), icons, this.app);
		headingEl.createDiv({ cls: 'mbv-card-title', text: title });
		this.renderDetails(bodyEl, entry, context);

		return cardEl;
	}

	private cardEvent(event: Event): { card: HTMLElement; entry: BasesEntry } | null {
		if (!(event.target instanceof Element)) return null;
		const card = event.target.closest<HTMLElement>('.mbv-card');
		if (!card || !this.containerEl.contains(card)) return null;
		const entry = this.entriesByCard.get(card);
		return entry ? { card, entry } : null;
	}

	private isInteractiveTarget(event: Event, includeLinks = true): boolean {
		return isInteractiveTarget(event, includeLinks);
	}

	private cancelCardOpen(card: HTMLElement): void {
		const timer = this.pendingOpenByCard.get(card);
		if (timer === undefined) return;
		window.clearTimeout(timer);
		this.pendingCardOpens.delete(timer);
		this.pendingOpenByCard.delete(card);
	}

	private handleCardClick(event: MouseEvent): void {
		const target = this.cardEvent(event);
		if (!target || this.isInteractiveTarget(event)) return;
		this.cancelCardOpen(target.card);
		if (event.detail > 1) return;
		const timer = window.setTimeout(() => {
			this.pendingCardOpens.delete(timer);
			this.pendingOpenByCard.delete(target.card);
			void this.openEntry(target.entry, Boolean(Keymap.isModEvent(event)));
		}, DOUBLE_CLICK_DELAY_MS);
		this.pendingOpenByCard.set(target.card, timer);
		this.pendingCardOpens.add(timer);
	}

	private handleCardDoubleClick(event: MouseEvent): void {
		const target = this.cardEvent(event);
		if (!target || this.isInteractiveTarget(event)) return;
		event.preventDefault();
		event.stopPropagation();
		this.cancelCardOpen(target.card);
		this.showFileMenu(target.entry, event);
	}

	private handleCardContextMenu(event: MouseEvent): void {
		const target = this.cardEvent(event);
		if (!target || this.isInteractiveTarget(event, false)) return;
		event.preventDefault();
		this.cancelCardOpen(target.card);
		this.showFileMenu(target.entry, event);
	}

	private handleCardAuxClick(event: MouseEvent): void {
		if (event.button !== 1) return;
		const target = this.cardEvent(event);
		if (!target) return;
		event.preventDefault();
		void this.openEntry(target.entry, true);
	}

	private handleCardKeyDown(event: KeyboardEvent): void {
		const target = this.cardEvent(event);
		if (!target || this.isInteractiveTarget(event) || (event.key !== 'Enter' && event.key !== ' ')) return;
		event.preventDefault();
		void this.openEntry(target.entry, Boolean(Keymap.isModEvent(event)));
	}

	private ensureHoveredCardScrollbar(event: Event): void {
		const target = this.cardEvent(event);
		if (!target || this.cardScrollbars.has(target.card)) return;
		window.requestAnimationFrame(() => {
			if (!target.card.isConnected || this.cardScrollbars.has(target.card)) return;
			const body = target.card.querySelector<HTMLElement>('.mbv-card-body');
			if (!body || body.scrollHeight - body.clientHeight <= 4) return;
			const scrollbar = this.addScrollbar(body, target.card, 'vertical');
			this.cardScrollbars.set(target.card, scrollbar);
		});
	}

	private addScrollbar(
		targetEl: HTMLElement,
		hostEl: HTMLElement,
		orientation: ScrollbarOrientation,
		observeMutations = false,
	): CollectionScrollbar {
		const scrollbar = new CollectionScrollbar(targetEl, hostEl, orientation, observeMutations);
		this.scrollbars.add(scrollbar);
		return scrollbar;
	}

	private isEntryLive(entry: BasesEntry): boolean {
		return this.app.vault.getAbstractFileByPath(entry.file.path) === entry.file;
	}

	private trackCard(path: string, cardEl: HTMLElement): void {
		let cards = this.cardsByPath.get(path);
		if (!cards) {
			cards = new Set<HTMLElement>();
			this.cardsByPath.set(path, cards);
		}
		cards.add(cardEl);
	}

	private untrackCard(path: string, cardEl: HTMLElement): void {
		const cards = this.cardsByPath.get(path);
		if (!cards) return;
		cards.delete(cardEl);
		if (!cards.size) this.cardsByPath.delete(path);
	}

	private removeDeletedFile(path: string): void {
		const cards = this.cardsByPath.get(path);
		for (const card of cards ?? []) {
			const scrollbar = this.cardScrollbars.get(card);
			if (scrollbar) {
				scrollbar.destroy();
				this.scrollbars.delete(scrollbar);
				this.cardScrollbars.delete(card);
			}
			card.remove();
			this.mountedCards.delete(card);
		}
		this.cardsByPath.delete(path);
		for (const placeholder of this.placeholdersByPath.get(path) ?? []) {
			this.retentionObserver?.unobserve(placeholder);
			placeholder.remove();
		}
		this.placeholdersByPath.delete(path);
	}

	private setupCardRetention(enabled: boolean): void {
		this.retentionObserver?.disconnect();
		this.retentionObserver = enabled ? new IntersectionObserver((records) => {
			for (const record of records) {
				if (!(record.target instanceof HTMLElement)) continue;
				if (record.target.hasClass('mbv-card-placeholder') && record.isIntersecting) {
					this.restoreRetainedCard(record.target);
				}
			}
		}, {
			root: this.containerEl,
			rootMargin: `${RETENTION_MARGIN_PX}px`,
			threshold: 0,
		}) : null;
	}

	private scheduleRetentionPrune(): void {
		if (!this.retentionObserver || this.mountedCards.size <= MAX_RETAINED_CARDS || this.retentionFrame !== null) return;
		this.retentionFrame = window.requestAnimationFrame(() => {
			this.retentionFrame = null;
			this.pruneDistantCards();
		});
	}

	private pruneDistantCards(): void {
		if (!this.retentionObserver || this.mountedCards.size <= MAX_RETAINED_CARDS) return;
		const viewport = this.containerEl.getBoundingClientRect();
		const distant = Array.from(this.mountedCards).filter((card) => {
			if (!card.isConnected || card.contains(document.activeElement)) return false;
			const rect = card.getBoundingClientRect();
			return rect.bottom < viewport.top - RETENTION_MARGIN_PX
				|| rect.top > viewport.bottom + RETENTION_MARGIN_PX
				|| rect.right < viewport.left - RETENTION_MARGIN_PX
				|| rect.left > viewport.right + RETENTION_MARGIN_PX;
		});
		for (const card of distant) {
			if (this.mountedCards.size <= MAX_RETAINED_CARDS) break;
			this.retainCardAsPlaceholder(card);
		}
	}

	private retainCardAsPlaceholder(card: HTMLElement): void {
		const retained = this.retainedCards.get(card);
		if (!retained || !card.parentElement) return;
		this.cancelCardOpen(card);
		const scrollbar = this.cardScrollbars.get(card);
		if (scrollbar) {
			scrollbar.destroy();
			this.scrollbars.delete(scrollbar);
			this.cardScrollbars.delete(card);
		}
		const placeholder = document.createElement('div');
		placeholder.className = 'mbv-card mbv-card-placeholder';
		placeholder.setAttribute('aria-hidden', 'true');
		this.retainedCards.set(placeholder, retained);
		let placeholders = this.placeholdersByPath.get(retained.entry.file.path);
		if (!placeholders) {
			placeholders = new Set();
			this.placeholdersByPath.set(retained.entry.file.path, placeholders);
		}
		placeholders.add(placeholder);
		this.retentionObserver?.unobserve(card);
		card.replaceWith(placeholder);
		this.mountedCards.delete(card);
		this.untrackCard(retained.entry.file.path, card);
		this.retentionObserver?.observe(placeholder);
	}

	private restoreRetainedCard(placeholder: HTMLElement): void {
		const retained = this.retainedCards.get(placeholder);
		const parent = placeholder.parentElement;
		if (!retained || !parent || !this.isEntryLive(retained.entry)) return;
		this.retentionObserver?.unobserve(placeholder);
		const placeholders = this.placeholdersByPath.get(retained.entry.file.path);
		placeholders?.delete(placeholder);
		if (placeholders && !placeholders.size) this.placeholdersByPath.delete(retained.entry.file.path);
		const card = this.renderCard(parent, retained.entry, retained.context);
		placeholder.replaceWith(card);
	}

	private registerNotebookNavigatorEvents(api: NotebookNavigatorApi): void {
		if (this.notebookNavigatorEventsRegistered) return;
		this.notebookNavigatorEventsRegistered = true;
		const refresh = (): void => {
			invalidateNotebookNavigatorIconCache(this.app);
			this.lastRenderSignature = '';
			this.onDataUpdated();
		};
		const folderChanged = api.on('folder-changed', refresh);
		const storageReady = api.on('storage-ready', refresh);
		this.register(() => {
			api.off(folderChanged);
			api.off(storageReady);
		});
	}

	private renderDetails(bodyEl: HTMLElement, entry: BasesEntry, context: CollectionRenderContext): void {
		if (!context.detailProperties.length) return;

		const detailsEl = bodyEl.createDiv({ cls: 'mbv-card-details' });
		for (const { property, displayName } of context.detailProperties) {
			const value = entry.getValue(property);
			// False checkboxes and numeric zero are meaningful property values.
			if (value === null) continue;
			const rowEl = detailsEl.createDiv({ cls: 'mbv-card-detail' });
			rowEl.createSpan({ cls: 'mbv-card-detail-label', text: displayName });
			const valueEl = rowEl.createDiv({ cls: 'mbv-card-detail-value' });
			const propertyColorsEnabled = isPropertyColorEnabled(this.plugin.settings, property);
			renderPropertyValue(valueEl, value, {
				app: this.app,
				property,
				displayName,
				valueColorPalette: propertyColorsEnabled ? context.valuePalette : undefined,
				onBooleanChange: property.startsWith('note.')
					? (checked) => this.updateBooleanProperty(entry, property, checked)
					: undefined,
			});
		}
	}

	private async updateBooleanProperty(
		entry: BasesEntry,
		property: BasesPropertyId,
		checked: boolean,
	): Promise<void> {
		if (!property.startsWith('note.')) throw new Error('Only note properties can be edited.');
		const file = this.app.vault.getAbstractFileByPath(entry.file.path);
		if (!(file instanceof TFile)) throw new Error('The note is no longer available.');
		const propertyName = property.slice('note.'.length);
		if (!propertyName) throw new Error('The property name is empty.');
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const existingKey = Object.keys(frontmatter)
				.find((key) => key.toLocaleLowerCase() === propertyName.toLocaleLowerCase());
			frontmatter[existingKey ?? propertyName] = checked;
		});
	}

	private renderMedia(mediaEl: HTMLElement, entry: BasesEntry, resource: string | null): void {
		if (resource) {
			mediaEl.createEl('img', {
				attr: { src: resource, alt: '', loading: 'lazy', decoding: 'async' },
			});
			return;
		}

		const fallbackEl = mediaEl.createDiv({ cls: 'mbv-card-media-fallback' });
		setIcon(fallbackEl, this.iconForExtension(entry.file.extension));
	}

	private getMediaResource(
		entry: BasesEntry,
		property: BasesPropertyId,
		cache?: Map<string, string | null>,
	): string | null {
		const source = entry.getValue(property)?.toString() ?? '';
		const key = `${entry.file.path}\u0000${property}\u0000${source}`;
		if (cache?.has(key)) return cache.get(key) ?? null;
		const resource = this.resolveMediaResource(source, entry.file.path)
			?? (IMAGE_EXTENSIONS.has(entry.file.extension.toLowerCase()) ? this.app.vault.getResourcePath(entry.file) : null);
		cache?.set(key, resource);
		return resource;
	}

	private resolveMediaResource(rawValue: string, sourcePath: string): string | null {
		const raw = rawValue.trim();
		if (!raw) return null;
		const markdownMatch = raw.match(/!\[[^\]]*\]\(([^)]+)\)/);
		const wikiMatch = raw.match(/!?\[\[([^\]]+)\]\]/);
		let candidate = markdownMatch?.[1] ?? wikiMatch?.[1] ?? raw.split(',')[0];
		candidate = candidate.trim().replace(/^['"]|['"]$/g, '').split('|')[0].split('#')[0];
		if (/^https?:\/\//i.test(candidate) || /^data:image\//i.test(candidate)) return candidate;
		const file = this.app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
		return file && IMAGE_EXTENSIONS.has(file.extension.toLowerCase()) ? this.app.vault.getResourcePath(file) : null;
	}

	private getTitle(entry: BasesEntry, property: BasesPropertyId | null): string {
		if (property) {
			const title = entry.getValue(property)?.toString().trim();
			if (title) return title;
		}
		return entry.file.basename;
	}

	private iconForExtension(extension: string): string {
		if (extension === 'base') return 'layout-dashboard';
		if (extension === 'canvas') return 'layout-template';
		if (extension === 'pdf') return 'file-text';
		if (['mp3', 'm4a', 'ogg', 'wav'].includes(extension)) return 'audio-lines';
		if (['mp4', 'mov', 'webm'].includes(extension)) return 'film';
		return 'file';
	}

	private openEntry(entry: BasesEntry, newLeaf: boolean): Promise<void> {
		const liveFile = this.app.vault.getAbstractFileByPath(entry.file.path);
		if (!(liveFile instanceof TFile)) return Promise.resolve();
		return this.app.workspace.getLeaf(newLeaf).openFile(liveFile);
	}

	private showFileMenu(entry: BasesEntry, event: MouseEvent): void {
		showFileMenu(this.app, entry.file, event);
	}
}
