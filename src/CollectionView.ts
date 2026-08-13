import {
	BasesEntry,
	BasesEntryGroup,
	BasesPropertyId,
	BasesView,
	Keymap,
	Menu,
	QueryController,
	setIcon,
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
	parseFolderIconRules,
	renderCollectionIcon,
	resolveCardColor,
	resolveCardIcons,
} from './collection/appearance';
import { COLOR_PACKS, ColorPackId, isCssColor } from './table-colors/palettes';
import { renderPropertyValue } from './ui/PropertyValueRenderer';
import { CollectionScrollbar, ScrollbarOrientation } from './collection/CollectionScrollbar';

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
	gridColumns: number;
	gap: number;
	aspect: CardAspect;
	cardDirection: CardDirection;
	cardHeight: number;
	mediaShare: number;
	mediaFit: MediaFit;
	snap: boolean;
	iconPlacement: IconPlacement;
	propertyValueColors: boolean;
	propertyValueColorPack: ColorPackId;
	propertyValueCustomColors: string[];
	cardCorners: CardCorners;
}

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const LARGE_COLLECTION_THRESHOLD = 80;
const GRID_PAGE_ROWS = 4;
const CAROUSEL_PAGE_SIZE = 16;
const CARDS_PER_FRAME = 8;
const FRAME_BUDGET_MS = 8;
const DOUBLE_CLICK_DELAY_MS = 350;

interface RenderWork {
	generation: number;
	run: () => void;
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
	private readonly scrollbars = new Set<CollectionScrollbar>();
	private notebookNavigatorEventsRegistered = false;

	constructor(controller: QueryController, parentEl: HTMLElement) {
		super(controller);
		this.scrollHostEl = parentEl.createDiv({ cls: 'mbv-collection-shell' });
		this.containerEl = this.scrollHostEl.createDiv({ cls: 'mbv-collection' });
		this.registerEvent(this.app.vault.on('delete', (file) => this.removeDeletedFile(file.path)));
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
						displayName: 'Card width',
						default: 240,
						min: 48,
						max: 960,
						step: 4,
						instant: true,
					},
					{
						type: 'slider',
						key: 'cardHeight',
						displayName: 'Card height',
						default: 160,
						min: 48,
						max: 960,
						step: 4,
						instant: true,
					},
					{
						type: 'slider',
						key: 'gridColumns',
						displayName: 'Grid columns',
						default: 4,
						min: 1,
						max: 8,
						step: 1,
						instant: true,
					},
					{
						type: 'slider',
						key: 'gap',
						displayName: 'Card gap',
						default: 16,
						min: 4,
						max: 32,
						step: 2,
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
					{
						type: 'dropdown',
						key: 'propertyValueColorPack',
						displayName: 'Property value color pack',
						default: 'notion',
						options: { notion: 'Notion', pastel: 'Pastel', vivid: 'Vivid', earth: 'Earth', custom: 'Custom' },
					},
					{
						type: 'multitext',
						key: 'propertyValueCustomColors',
						displayName: 'Custom property value colors',
						default: [],
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
		this.cancelPendingRendering();
		this.render(this.readConfig());
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
			gridColumns: this.numberOption('gridColumns', 4, 1, 8),
			gap: this.numberOption('gap', 16, 4, 32),
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
			propertyValueColorPack: this.colorPack(this.config.get('propertyValueColorPack')),
			propertyValueCustomColors: this.stringListOption('propertyValueCustomColors'),
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

	private render(config: CollectionConfig): void {
		const generation = this.renderGeneration;
		if (config.folderIconSource === 'notebook-navigator') this.registerNotebookNavigatorEvents();
		this.containerEl.empty();
		this.cardsByPath.clear();
		this.containerEl.toggleClass('is-grid', config.layout === 'grid');
		this.containerEl.toggleClass('is-carousel', config.layout === 'carousel');
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
			'--mbv-grid-columns': String(config.gridColumns),
			'--mbv-gap': `${config.gap}px`,
			'--mbv-card-height': `${config.cardHeight}px`,
			'--mbv-media-share': `${config.mediaShare}%`,
			'--mbv-card-radius': config.cardCorners === 'square' ? '0px' : 'var(--radius-l)',
		});

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
					if (this.isEntryLive(entry)) this.renderCard(railEl, entry, config);
				}
			} else {
				this.renderGroupOnDemand(sectionEl, railEl, group.entries, config, generation);
			}
			if (config.layout === 'carousel') this.addScrollbar(railEl, sectionEl, 'horizontal', true);
		}
		this.addScrollbar(this.containerEl, this.scrollHostEl, 'vertical', true);
	}

	private renderGroupOnDemand(
		sectionEl: HTMLElement,
		railEl: HTMLElement,
		entries: BasesEntry[],
		config: CollectionConfig,
		generation: number,
	): void {
		let rendered = 0;
		let loading = false;
		const pageSize = config.layout === 'grid'
			? Math.max(config.gridColumns * GRID_PAGE_ROWS, CARDS_PER_FRAME)
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
						const cardEl = this.renderCard(railEl, entry, config);
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

	private renderCard(parentEl: HTMLElement, entry: BasesEntry, config: CollectionConfig): HTMLElement {
		const title = this.getTitle(entry, config.titleProperty);
		const icons = resolveCardIcons(entry, config, getNotebookNavigatorApi(this.app));
		const mediaResource = config.mediaProperty ? this.getMediaResource(entry, config.mediaProperty) : null;
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
		const color = resolveCardColor(entry, config, title, this.app);
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
		headingEl.createDiv({ cls: 'mbv-card-title', text: title, attr: { title } });
		this.renderDetails(bodyEl, entry, config);

		let pendingOpen: number | null = null;
		const cancelOpen = (): void => {
			if (pendingOpen === null) return;
			window.clearTimeout(pendingOpen);
			this.pendingCardOpens.delete(pendingOpen);
			pendingOpen = null;
		};
		cardEl.addEventListener('click', (event) => {
			if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea, .mbv-scrollbar')) return;
			cancelOpen();
			if (event.detail > 1) return;
			pendingOpen = window.setTimeout(() => {
				if (pendingOpen !== null) this.pendingCardOpens.delete(pendingOpen);
				pendingOpen = null;
				void this.openEntry(entry, Boolean(Keymap.isModEvent(event)));
			}, DOUBLE_CLICK_DELAY_MS);
			this.pendingCardOpens.add(pendingOpen);
		});
		cardEl.addEventListener('dblclick', (event) => {
			if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea, .mbv-scrollbar')) return;
			event.preventDefault();
			event.stopPropagation();
			cancelOpen();
			this.showFileMenu(entry, event);
		});
		cardEl.addEventListener('contextmenu', (event) => {
			if (event.target instanceof Element && event.target.closest('input, select, textarea, .mbv-scrollbar')) return;
			event.preventDefault();
			cancelOpen();
			this.showFileMenu(entry, event);
		});
		cardEl.addEventListener('auxclick', (event) => {
			if (event.button !== 1) return;
			event.preventDefault();
			void this.openEntry(entry, true);
		});
		cardEl.addEventListener('keydown', (event) => {
			if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea, .mbv-scrollbar')) return;
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			void this.openEntry(entry, Boolean(Keymap.isModEvent(event)));
		});
		this.addScrollbar(bodyEl, cardEl, 'vertical');
		return cardEl;
	}

	private addScrollbar(
		targetEl: HTMLElement,
		hostEl: HTMLElement,
		orientation: ScrollbarOrientation,
		observeMutations = false,
	): void {
		this.scrollbars.add(new CollectionScrollbar(targetEl, hostEl, orientation, observeMutations));
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

	private removeDeletedFile(path: string): void {
		const cards = this.cardsByPath.get(path);
		if (!cards) return;
		for (const card of cards) card.remove();
		this.cardsByPath.delete(path);
	}

	private registerNotebookNavigatorEvents(): void {
		if (this.notebookNavigatorEventsRegistered) return;
		const api = getNotebookNavigatorApi(this.app);
		if (!api) return;
		this.notebookNavigatorEventsRegistered = true;
		const refresh = (): void => {
			invalidateNotebookNavigatorIconCache(this.app);
			this.onDataUpdated();
		};
		const folderChanged = api.on('folder-changed', refresh);
		const storageReady = api.on('storage-ready', refresh);
		this.register(() => {
			api.off(folderChanged);
			api.off(storageReady);
		});
	}

	private renderDetails(bodyEl: HTMLElement, entry: BasesEntry, config: CollectionConfig): void {
		const excluded = new Set([config.mediaProperty, config.titleProperty].filter(Boolean));
		const properties = this.config.getOrder().filter((property) => !excluded.has(property));
		if (!properties.length) return;

		const detailsEl = bodyEl.createDiv({ cls: 'mbv-card-details' });
		const valueColorPalette = this.propertyValuePalette(config);
		for (const property of properties) {
			const value = entry.getValue(property);
			// False checkboxes and numeric zero are meaningful property values.
			if (value === null) continue;
			const rowEl = detailsEl.createDiv({ cls: 'mbv-card-detail' });
			const displayName = this.config.getDisplayName(property);
			rowEl.createSpan({ cls: 'mbv-card-detail-label', text: displayName });
			const valueEl = rowEl.createDiv({ cls: 'mbv-card-detail-value' });
			renderPropertyValue(valueEl, value, {
				app: this.app,
				property,
				displayName,
				valueColorPalette,
				onBooleanChange: property.startsWith('note.')
					? (checked) => this.updateBooleanProperty(entry, property, checked)
					: undefined,
			});
		}
	}

	private propertyValuePalette(config: CollectionConfig): string[] | undefined {
		if (!config.propertyValueColors) return undefined;
		if (config.propertyValueColorPack === 'custom') {
			const custom = config.propertyValueCustomColors.filter(isCssColor);
			if (custom.length) return custom;
		}
		return COLOR_PACKS[config.propertyValueColorPack === 'custom' ? 'notion' : config.propertyValueColorPack];
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

	private getMediaResource(entry: BasesEntry, property: BasesPropertyId): string | null {
		const source = entry.getValue(property)?.toString() ?? '';
		return this.resolveMediaResource(source, entry.file.path)
			?? (IMAGE_EXTENSIONS.has(entry.file.extension.toLowerCase()) ? this.app.vault.getResourcePath(entry.file) : null);
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
		const menu = Menu.forEvent(event);
		const menuWithSections = menu as Menu & { addSections?: (sections: string[]) => Menu };
		menuWithSections.addSections?.(['title', 'open', 'action-primary', 'action', 'info', 'view', 'system', '', 'danger']);
		this.app.workspace.handleLinkContextMenu(menu, entry.file.path, '');
		menu.addItem((item) => item
			.setSection('danger')
			.setTitle('Delete')
			.setIcon('lucide-trash-2')
			.setWarning(true)
			.onClick(() => this.app.fileManager.promptForDeletion(entry.file)));
	}
}
