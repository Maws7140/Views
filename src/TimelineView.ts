import {
    BasesEntry,
    BasesEntryGroup,
    BasesPropertyId,
    BasesView,
    Notice,
    QueryController,
    ViewOption,
    TFile,
} from 'obsidian';
import { TimelineRenderer, type TimelineRendererData } from './TimelineRenderer';
import {
	automaticColorPalette,
	colorViewOptions,
	iconViewOptions,
	readAppearanceConfig,
	resolveCardColor,
	type CollectionAppearanceConfig,
} from './collection/appearance';
import { EntryInteractions, type EntryTarget } from './ui/EntryInteractions';
import { extractTimestamp } from './logic/dateValue';
import { isPropertyColorEnabled, overrideColorsForProperty } from './settings/settings';
import { ColorAssigner, parseCustomPalette, resolveColorPalette } from './table-colors/palettes';
import { resolvePropertyValueColor } from './ui/PropertyValueRenderer';
import type { TimelineConfig, TimelineItem, TimelineItemProperty, TimelineViewportState } from './types';
import type BasesTimelinePlugin from './main';
import { CalendarPickerModal } from './ui/CalendarPickerModal';

export const TimelineViewType = 'bases-timeline-view';

/** Spellings a vault or task plugin uses for a finished item. */
const DONE_VALUES = new Set(['true', 'yes', 'done', 'complete', 'completed', 'x', '✅']);
const VIEWPORT_SAVE_DELAY = 600;

export class TimelineView extends BasesView {
	type = TimelineViewType;
	private scrollEl: HTMLElement;
	private containerEl: HTMLElement;
    private rendererContainer: HTMLElement;
    private renderer: TimelineRenderer;

	private startProp: BasesPropertyId | null = null;
	private endProp: BasesPropertyId | null = null;
	private colorProp: BasesPropertyId | null = null;
	/** Rebuilt per render, so two bar colors in one view never coincide. */
	private barColors: ColorAssigner | null = null;
	private appearanceCache: CollectionAppearanceConfig | null = null;
	private restoredViewport = false;
	private pendingViewport: TimelineViewportState | null = null;
	private viewportSaveTimer: number | null = null;
	private detachInteractions: (() => void) | null = null;
	private unsubscribeColors: (() => void) | null = null;
	private doneProp: BasesPropertyId | null = null;

	constructor(
		private readonly plugin: BasesTimelinePlugin,
		controller: QueryController,
		scrollEl: HTMLElement
	) {
		super(controller);
		this.scrollEl = scrollEl;
        this.containerEl = scrollEl.createDiv({ cls: 'tl-host', attr: { tabIndex: 0 } });
        
        // Create container for the current view renderer
        this.rendererContainer = this.containerEl.createDiv({ cls: 'tl-renderer-container' });
        this.renderer = new TimelineRenderer(this.rendererContainer, this.app, {
            openCalendarPicker: () => this.openCalendarPicker(),
            onToggleDone: (item, done) => this.setItemDone(item, done),
            onViewportChanged: (state) => this.rememberViewport(state),
        });
        // Bound here rather than in onload, matching how the Collection view
        // registers its handlers, so they exist as soon as the view does.
        this.detachInteractions = new EntryInteractions(this.app, {
            resolve: (event) => this.resolveTarget(event),
        }).attach(this.containerEl);
        this.unsubscribeColors = this.plugin.onPropertyColorSettingsChanged(() => this.onDataUpdated());
    }

    /**
     * Scrolling fires continuously, so the write is debounced and skipped when
     * nothing moved. It uses `persistSettings` to avoid repainting every view
     * mid-scroll.
     */
    private rememberViewport(state: TimelineViewportState): void {
        this.pendingViewport = state;
        if (this.viewportSaveTimer !== null) return;
        this.viewportSaveTimer = window.setTimeout(() => {
            this.viewportSaveTimer = null;
            const pending = this.pendingViewport;
            this.pendingViewport = null;
            if (!pending) return;
            const key = this.viewportKey();
            const previous = this.plugin.settings.timelineViewports[key];
            if (previous
                && previous.startTs === pending.startTs
                && previous.pxPerDay === pending.pxPerDay
                && previous.scrollLeft === pending.scrollLeft) return;
            this.plugin.settings.timelineViewports[key] = { ...pending, updatedAt: Date.now() };
            void this.plugin.persistSettings();
        }, VIEWPORT_SAVE_DELAY);
    }

    /**
     * Keyed by base file and view name. The base path is not exposed to views,
     * so it comes from the owning leaf, the same way the table color enhancer
     * resolves it. Falls back to the view name alone for embedded bases.
     */
    private viewportKey(): string {
        for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
            if (!leaf.view.containerEl.contains(this.containerEl)) continue;
            const filePath = leaf.getViewState().state?.file;
            if (typeof filePath === 'string') return `${filePath}::${this.config.name}`;
        }
        return `::${this.config.name}`;
    }

	onload(): void {
		// Handlers are bound in the constructor.
	}

	private resolveTarget(event: Event): EntryTarget | null {
		const target = event.target instanceof Element
			? event.target.closest<HTMLElement>('.tl-bar, .tl-dot')
			: null;
		const path = target?.getAttribute('data-id');
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		return target && file instanceof TFile ? { el: target, file } : null;
	}

    onunload(): void {
        if (this.viewportSaveTimer !== null) {
            window.clearTimeout(this.viewportSaveTimer);
            this.viewportSaveTimer = null;
            if (this.pendingViewport) {
                this.plugin.settings.timelineViewports[this.viewportKey()] = {
                    ...this.pendingViewport,
                    updatedAt: Date.now(),
                };
                void this.plugin.persistSettings();
            }
        }
        this.detachInteractions?.();
        this.unsubscribeColors?.();
        this.renderer.destroy();
    }

	private openCalendarPicker(): void {
		const modal = new CalendarPickerModal(this.app, {
			onDateSelect: (timestamp) => {
				// Jump timeline to selected date
				this.renderer.jumpToDate(timestamp);
			},
		});
		modal.open();
	}

    onResize(): void {
        this.renderer.resize();
    }

	public focus(): void {
		this.containerEl.focus({ preventScroll: true });
	}

	onDataUpdated(): void {
		// A fresh assigner per render: distinctness is only meaningful across one
		// pass, and a kept one would freeze colors and grow without bound.
		this.barColors = new ColorAssigner(this.valuePalette());
		const config = this.loadConfig();
		// Reserved before anything else resolves, so the automatic picker never
		// lands a different bar on a color the user already chose.
		for (const hex of overrideColorsForProperty(this.plugin.settings.propertyValueColorOverrides, this.colorProp)) {
			this.barColors.reserve('bar', hex);
		}
		const rendererData = this.buildRendererData(config);
		this.renderer.updateData(rendererData, config);
		if (!this.restoredViewport) {
			this.restoredViewport = true;
			const saved = this.plugin.settings.timelineViewports[this.viewportKey()];
			if (saved && rendererData.items.length) this.renderer.restoreViewport(saved);
		}
	}

    getViewSettingsEl(): HTMLElement {
        return this.containerEl;
    }

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: 'Timeline properties',
				type: 'group',
				items: [
					{
						displayName: 'Date source',
						type: 'dropdown',
						key: 'dateSource',
						default: 'property',
						options: {
							property: 'Property',
							lifespan: 'File lifespan (Created → Modified)',
						},
					},
					{
						displayName: 'Start date property',
						type: 'property',
						key: 'startProp',
						placeholder: 'Start date',
					},
					{
						displayName: 'End date property',
						type: 'property',
						key: 'endProp',
						placeholder: 'Optional end date',
					},
					{
						displayName: 'Color by property',
						type: 'property',
						key: 'colorProperty',
						filter: () => true,
						placeholder: 'Tint bars by value',
					},
					{
						displayName: 'Completed property',
						type: 'property',
						key: 'doneProperty',
						filter: () => true,
						placeholder: 'Checkbox property',
					},
				],
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [
					{
						displayName: 'Show properties on bars',
						type: 'toggle',
						key: 'showBarProperties',
						default: true,
					},
					{
						displayName: 'Timeline height',
						type: 'slider',
						key: 'viewportHeight',
						default: 0,
						min: 0,
						max: 1200,
						step: 1,
						instant: true,
					},
					{
						displayName: 'Show weekends',
						type: 'toggle',
						key: 'showWeekends',
						default: true,
					},
					{
						displayName: 'High contrast',
						type: 'toggle',
						key: 'highContrast',
						default: false,
					},
					{
						displayName: 'Density',
						type: 'dropdown',
						key: 'density',
						default: 'comfortable',
						options: {
							comfortable: 'Comfortable',
							compact: 'Compact',
						},
					},
					{
						displayName: 'Default zoom',
						type: 'dropdown',
						key: 'zoomLevel',
						default: 'month',
						options: {
							day: 'Day',
							week: 'Week',
							month: 'Month',
							quarter: 'Quarter',
							year: 'Year',
						},
					},
				],
			},
			colorViewOptions('Bar colors'),
			iconViewOptions(),
		];
	}

	private loadConfig(): TimelineConfig {
		this.appearanceCache = null;
		this.startProp = this.getConfigPropertyId('startProp');
		this.endProp = this.getConfigPropertyId('endProp');
		this.colorProp = this.getConfigPropertyId('colorProperty');
		this.doneProp = this.getConfigPropertyId('doneProperty');

		// Plugin defaults are runtime fallbacks only. Writing them into the Base from
		// onDataUpdated causes stale values to win over changes made in Obsidian.
		this.startProp ??= this.normalizePropertyId(this.plugin.settings.defaultStartProp);
		this.endProp ??= this.normalizePropertyId(this.plugin.settings.defaultEndProp);

        const validateString = (key: string, fallback: string) => {
			const value = this.config.get(key);
			return typeof value === 'string' ? value : fallback;
		};

        const config: TimelineConfig = {
            viewType: 'timeline',
            startProp: this.startProp ?? '',
            endProp: this.endProp || undefined,
            colorProperty: this.colorProp || undefined,
            doneProperty: this.doneProp || undefined,
            dateSource: 'property',
            zoomLevel: 'month',
            showWeekends: true,
            density: 'comfortable',
            highContrast: false,
            showBarProperties: this.config.get('showBarProperties') !== false,
            viewportHeight: this.numberOption('viewportHeight', 0),
        };

		const dateSource = validateString('dateSource', this.plugin.settings.defaultDateSource ?? 'property');
		// Only two valid modes: 'property' or 'lifespan'
		// Legacy 'created'/'modified' values are mapped to 'lifespan'
		if (dateSource === 'property') {
			config.dateSource = 'property';
		} else {
			// 'lifespan', 'created', 'modified' all map to lifespan mode
			config.dateSource = 'lifespan';
		}

		const zoom = validateString('zoomLevel', 'month');
		if (isTimelineZoomLevel(zoom)) {
			config.zoomLevel = zoom;
		}

		const density = validateString('density', 'comfortable');
		if (density === 'comfortable' || density === 'compact') {
			config.density = density;
		}

		const showWeekends = this.config.get('showWeekends');
		if (typeof showWeekends === 'boolean') {
			config.showWeekends = showWeekends;
		}

		const highContrast = this.config.get('highContrast');
		if (typeof highContrast === 'boolean') {
			config.highContrast = highContrast;
		}

        return config;
	}

    // Open the underlying note for a clicked bar/dot
    private async openItem(item: TimelineItem): Promise<void> {
        try {
            const sourcePath = this.app.workspace.getActiveFile()?.path ?? '';

            // 0) Prefer the actual Bases entry currently in memory
            const entry = this.findEntryForItem(item);
            if (entry) { 
                await this.openInNewLeaf(entry.file as TFile); 
                return; 
            }

            // 1) Direct path resolution (exact match)
            const direct = (this.app.vault as any).getFileByPath?.(item.id) as TFile | undefined;
            if (direct) { 
                await this.openInNewLeaf(direct); 
                return; 
            }

            const abs = this.app.vault.getAbstractFileByPath(item.id);
            if (abs && (abs as any).extension) { 
                await this.openInNewLeaf(abs as TFile); 
                return; 
            }

            // 2) Metadata-based resolution via linkpath
            const tryLink = (link: string) => this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
            const candidates = new Set<string>();
            candidates.add(item.id);
            if (item.id.toLowerCase().endsWith('.md')) candidates.add(item.id.slice(0, -3));
            candidates.add(item.title);

            for (const c of candidates) {
                const dest = tryLink(c);
                if (dest) { 
                    await this.openInNewLeaf(dest); 
                    return; 
                }
            }

            // 3) Vault scan fallback (basename or path)
            const scan = this.app.vault.getFiles().find(f => f.path === item.id || f.basename === item.title);
            if (scan) { 
                await this.openInNewLeaf(scan); 
                return; 
            }

            // 4) Final fallback: let Obsidian try to resolve the link text
            const openLinkText = (this.app.workspace as any).openLinkText?.bind(this.app.workspace);
            if (openLinkText) { 
                openLinkText(item.id, sourcePath, true); 
            }
        } catch (err) {
            console.error('[Timeline View] Error opening item:', item, err);
        }
    }

    private findEntryForItem(item: TimelineItem): BasesEntry | null {
        const data = this.data;
        if (!data) return null;
        // Search ungrouped
        const flat = Array.isArray((data as any).data) ? (data as any).data as BasesEntry[] : [];
        let found = flat.find(e => e.file?.path === item.id || e.file?.basename === item.title);
        if (found) return found;
        // Search grouped
        const groups: BasesEntryGroup[] = Array.isArray((data as any).groupedData) ? (data as any).groupedData as BasesEntryGroup[] : [];
        for (const g of groups) {
            const entry = g.entries.find(e => e.file?.path === item.id || e.file?.basename === item.title);
            if (entry) return entry;
        }
        return null;
    }

    private async openInNewLeaf(file: TFile): Promise<void> {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(file);
        // Ensure the leaf is visible and active
        (this.app.workspace as any).revealLeaf?.(leaf);
        (this.app.workspace as any).setActiveLeaf?.(leaf, { focus: true });
    }

	private getConfigPropertyId(key: string): BasesPropertyId | null {
		const config = this.config as { getAsPropertyId?: (prop: string) => BasesPropertyId | null };
		if (typeof config.getAsPropertyId === 'function') {
			return config.getAsPropertyId(key);
		}
		const value = this.config.get(key);
		if (typeof value !== 'string') {
			return null;
		}
		const trimmed = value.trim();
		return trimmed ? (trimmed as BasesPropertyId) : null;
	}

	private numberOption(key: string, fallback: number): number {
		const value = this.config.get(key);
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		const parsed = typeof value === 'string' ? Number(value) : NaN;
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	private normalizePropertyId(value: string | undefined | null): BasesPropertyId | null {
		const trimmed = value?.trim();
		return trimmed ? (trimmed as BasesPropertyId) : null;
	}

	private buildRendererData(config: TimelineConfig): TimelineRendererData {
		const items: TimelineItem[] = [];
		const noDate: TimelineItem[] = [];

        for (const group of this.getVisibleGroups()) {
            const groupKey = group.key?.isTruthy() ? group.key.toString() : null;
            for (const entry of group.entries) {
                const item = this.toTimelineItem(entry, groupKey, config);
                if (item.startTs == null) noDate.push(item);
                else items.push(item);
            }
        }

		return { items, noDateItems: noDate };
	}

	/**
	 * `groupedData` is the Bases API's authoritative render projection: it has
	 * already applied native grouping, sorting, filtering, and limits. Lanes and
	 * row order come from there rather than from a view option of our own, so
	 * the timeline answers to the same Group by and Sort by menus as every
	 * other Bases view.
	 */
	private getVisibleGroups(): BasesEntryGroup[] {
		return (this.data?.groupedData ?? []).filter((group) => group.entries.length > 0);
	}

	private toTimelineItem(entry: BasesEntry, groupKey: string | null, config: TimelineConfig): TimelineItem {
		const title = entry.file.basename;
		const id = entry.file.path;

		const dateSource = config.dateSource;
		let startTs: number | null = null;
		let endTs: number | null = null;

		if (dateSource === 'lifespan') {
			// Lifespan mode: use file creation and modification times
			startTs = entry.file.stat.ctime;
			endTs = entry.file.stat.mtime;
			if (endTs == null && startTs != null) {
				endTs = startTs;
			}
		} else {
			// Property mode: use the configured startProp and endProp
			startTs = this.extractDate(entry, this.startProp);
			endTs = this.extractDate(entry, this.endProp) ?? null;
		}

		return {
			id,
			title,
			startTs: startTs ?? undefined,
			endTs: endTs ?? undefined,
			groupKey: groupKey ?? undefined,
			color: this.resolveItemColor(entry, groupKey) ?? undefined,
			properties: config.showBarProperties ? this.collectBarProperties(entry) : [],
			done: this.resolveDone(entry),
		};
	}

	/**
	 * Bars are tinted through the same pipeline as pills and table cells, so a
	 * value keeps one color across every surface. Picking "Color by" in the view
	 * is already an explicit choice, so it is not gated by the global allowlist
	 * the way automatic value pills are. With no explicit choice, the native
	 * group key colors the bar, so a grouped timeline is readable with no
	 * configuration at all.
	 */
	private resolveItemColor(entry: BasesEntry, groupKey: string | null): string | null {
		// Same vocabulary as a Collection card: frontmatter colour, automatic
		// colour from title, folder, or a property, or off, with the view's own
		// pack. A one-colour custom pack therefore makes every bar that colour.
		const appearance = this.appearance();
		if (appearance.colorMode !== 'none') {
			const title = entry.file.basename;
			return resolveCardColor(entry, appearance, title, this.app, automaticColorPalette(appearance), this.barColors ?? undefined);
		}
		// Legacy behaviour for views configured before the shared options: an
		// explicit Color by property, else the native group key.
		if (!this.plugin.settings.tableColorsEnabled) return null;
		const seed = this.colorProp ? entry.getValue(this.colorProp) : groupKey;
		if (seed === null || seed === undefined) return null;
		return resolvePropertyValueColor(seed, this.valuePalette(), this.barColors ?? undefined, 'bar', this.colorProp ?? undefined, this.plugin.settings.propertyValueColorOverrides);
	}

	/** View pack when chosen, otherwise the pack from the Colors settings. */
	private appearance(): CollectionAppearanceConfig {
		if (this.appearanceCache) return this.appearanceCache;
		const appearance = readAppearanceConfig(this.config);
		if (this.config.get('colorPack') === undefined) {
			appearance.colorPack = this.plugin.settings.colorPack;
			appearance.customColors = parseCustomPalette(this.plugin.settings.customPalette);
		}
		this.appearanceCache = appearance;
		return appearance;
	}

	/** The view's own Properties menu decides what rides along on each bar. */
	private collectBarProperties(entry: BasesEntry): TimelineItemProperty[] {
		const skip = new Set([this.startProp, this.endProp, this.doneProp].filter(Boolean) as string[]);
		const properties: TimelineItemProperty[] = [];
		for (const property of this.config.getOrder()) {
			if (skip.has(property)) continue;
			const value = entry.getValue(property);
			if (value === null || value === undefined) continue;
			properties.push({
				property,
				displayName: this.config.getDisplayName(property),
				value,
				palette: isPropertyColorEnabled(this.plugin.settings, property)
					? this.valuePalette()
					: undefined,
			});
		}
		return properties;
	}

	private valuePalette(): string[] {
		const appearance = this.appearance();
		return resolveColorPalette(appearance.colorPack, appearance.customColors);
	}

	/**
	 * A completion property is either a real checkbox or a status whose value
	 * reads as finished, which is how most task workflows in a vault spell it.
	 */
	private resolveDone(entry: BasesEntry): boolean | undefined {
		if (!this.doneProp) return undefined;
		const value = entry.getValue(this.doneProp);
		if (value === null || value === undefined) return false;
		const text = value.toString().trim().toLocaleLowerCase();
		if (!text) return false;
		return DONE_VALUES.has(text);
	}

	private async setItemDone(item: TimelineItem, done: boolean): Promise<void> {
		if (!this.doneProp) return;
		const key = this.doneProp.startsWith('note.') ? this.doneProp.slice('note.'.length) : null;
		if (!key) {
			new Notice('Only note properties can be toggled from the timeline.');
			throw new Error('Unsupported completion property');
		}
		const entry = this.findEntryForItem(item);
		const file = entry?.file ?? this.app.vault.getAbstractFileByPath(item.id);
		if (!(file instanceof TFile)) {
			new Notice(`Unable to update ${item.title}.`);
			throw new Error('Missing file for timeline item');
		}
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const existing = Object.keys(frontmatter)
				.find((candidate) => candidate.toLocaleLowerCase() === key.toLocaleLowerCase());
			frontmatter[existing ?? key] = done;
		});
	}

	/**
	 * Extract a date from a property value.
	 * This is only called in 'property' mode - lifespan mode uses ctime/mtime directly.
	 *
	 * The reading itself lives in `logic/dateValue` so the Heatmap resolves a date
	 * exactly the way a bar does.
	 */
	private extractDate(entry: BasesEntry, property: BasesPropertyId | null): number | null {
		return extractTimestamp(entry, property);
	}
}

function isTimelineZoomLevel(value: string): value is TimelineConfig['zoomLevel'] {
	return value === 'day' || value === 'week' || value === 'month' || value === 'quarter' || value === 'year';
}
