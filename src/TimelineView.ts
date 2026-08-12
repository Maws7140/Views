import {
    BasesEntry,
    BasesEntryGroup,
    BasesPropertyId,
    BasesView,
    DateValue,
    QueryController,
    ViewOption,
    TFile,
    type ListValue,
    type StringValue,
} from 'obsidian';
import { TimelineRenderer, type TimelineRendererData } from './TimelineRenderer';
import type { TimelineConfig, TimelineItem } from './types';
import type BasesTimelinePlugin from './main';
import { CalendarPickerModal } from './ui/CalendarPickerModal';

export const TimelineViewType = 'bases-timeline-view';

export class TimelineView extends BasesView {
	type = TimelineViewType;
	private scrollEl: HTMLElement;
	private containerEl: HTMLElement;
    private rendererContainer: HTMLElement;
    private renderer: TimelineRenderer;

	private startProp: BasesPropertyId | null = null;
	private endProp: BasesPropertyId | null = null;
	private groupProp: BasesPropertyId | null = null;

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
        this.renderer = new TimelineRenderer(this.rendererContainer, {
            openCalendarPicker: () => this.openCalendarPicker(),
            onOpenItem: (item) => this.openItem(item),
        });
    }

	onload(): void {
		// Future lifecycle hooks will be registered here.
	}

    onunload(): void {
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
		const config = this.loadConfig();
		const rendererData = this.buildRendererData(config);
		this.renderer.updateData(rendererData, config);
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
						displayName: 'Lane property',
						type: 'property',
						key: 'laneProperty',
						filter: () => true,
						placeholder: 'Group lanes',
					},
				],
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [
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
		];
	}

	private loadConfig(): TimelineConfig {
		this.startProp = this.getConfigPropertyId('startProp');
		this.endProp = this.getConfigPropertyId('endProp');
		this.groupProp = this.getConfigPropertyId('laneProperty') ?? this.getLegacyLanePropertyId();

		// Plugin defaults are runtime fallbacks only. Writing them into the Base from
		// onDataUpdated causes stale values to win over changes made in Obsidian.
		this.startProp ??= this.normalizePropertyId(this.plugin.settings.defaultStartProp);
		this.endProp ??= this.normalizePropertyId(this.plugin.settings.defaultEndProp);
		this.groupProp ??= this.normalizePropertyId(this.plugin.settings.defaultGroupBy);

        const validateString = (key: string, fallback: string) => {
			const value = this.config.get(key);
			return typeof value === 'string' ? value : fallback;
		};

        const config: TimelineConfig = {
            viewType: 'timeline',
            startProp: this.startProp ?? '',
            endProp: this.endProp || undefined,
            groupBy: this.groupProp || undefined,
            dateSource: 'property',
            zoomLevel: 'month',
            showWeekends: true,
            density: 'comfortable',
            highContrast: false
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

	private getLegacyLanePropertyId(): BasesPropertyId | null {
		// Versions <= 0.1.0 incorrectly used the reserved core Bases `groupBy`
		// key. Only accept the legacy value when it is a plain property string;
		// never touch the core grouping object.
		const legacy = this.config.get('groupBy');
		return typeof legacy === 'string' && legacy.trim()
			? (legacy.trim() as BasesPropertyId)
			: null;
	}

	private normalizePropertyId(value: string | undefined | null): BasesPropertyId | null {
		const trimmed = value?.trim();
		return trimmed ? (trimmed as BasesPropertyId) : null;
	}

	private buildRendererData(config: TimelineConfig): TimelineRendererData {
		const items: TimelineItem[] = [];
		const noDate: TimelineItem[] = [];
        const entries = this.data?.data ?? [];

        for (const entry of entries) {
            let groupKey: string | null = null;
            if (this.groupProp) {
                const val = entry.getValue(this.groupProp);
                const str = val ? val.toString() : '';
                groupKey = str ? str : 'Unassigned';
            }

            const item = this.toTimelineItem(entry, groupKey, config);
            if (item.startTs == null) {
                noDate.push(item);
            } else {
                items.push(item);
            }
        }

		return { items, noDateItems: noDate };
	}

	private getGroupKey(group: BasesEntryGroup): string | null {
		const { key } = group;
		const hasKeyFn = (group as { hasKey?: () => boolean }).hasKey;
		const hasKey = typeof hasKeyFn === 'function' ? hasKeyFn.call(group) : key != null;
		if (!hasKey || !key) {
			return null;
		}

		const keyValue: unknown = key;

		if (typeof keyValue === 'string') {
			return keyValue;
		}

		if (this.isStringValue(keyValue)) {
			return keyValue.toString();
		}

		if (this.isDateValue(keyValue)) {
			return keyValue.toString();
		}

		return String(keyValue);
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
		};
	}

	/**
	 * Extract a date from a property value.
	 * This is only called in 'property' mode - lifespan mode uses ctime/mtime directly.
	 */
	private extractDate(entry: BasesEntry, property: BasesPropertyId | null): number | null {
		if (!property) {
			return null;
		}

		const value = entry.getValue(property);
		if (!value) {
			return null;
		}

		// Try DateValue first (Bases native date type)
		if (this.isDateValue(value)) {
			return this.parseDateValue(value.dateOnly());
		}

		// Try extracting from list/array
		const dateFromList = this.extractDateFromUnknown(value);
		if (dateFromList) {
			return this.parseDateValue(dateFromList.dateOnly());
		}

		// Try parsing as string
		const str = value.toString();
		if (str) {
			const parsed = this.parseDateString(str);
			if (parsed != null) {
				return parsed;
			}
		}

		return null;
	}

	private parseDateValue(value: DateValue): number | null {
		const iso = value.toString();
		const timestamp = Date.parse(iso);
		return Number.isFinite(timestamp) ? timestamp : null;
	}

	private isDateValue(value: unknown): value is DateValue {
		return Boolean(value && typeof (value as DateValue).dateOnly === 'function');
	}

	private parseDateString(input: string): number | null {
		const timestamp = Date.parse(input);
		return Number.isFinite(timestamp) ? timestamp : null;
	}

	private isStringValue(value: unknown): value is StringValue {
		return Boolean(value && typeof (value as StringValue).toString === 'function');
	}

  private extractDateFromUnknown(value: unknown): DateValue | null {
    if (!value) return null;
    const maybeList = value as ListValue;
    if (typeof maybeList.length === 'function' && typeof maybeList.get === 'function') {
      for (let i = 0; i < maybeList.length(); i++) {
        const item = maybeList.get(i);
        if (this.isDateValue(item)) {
          return item;
        }
      }
    }

    if (typeof (value as { toArray?: () => unknown[] }).toArray === 'function') {
      const array = (value as { toArray: () => unknown[] }).toArray();
      if (Array.isArray(array)) {
        for (const item of array) {
          if (this.isDateValue(item)) {
            return item;
          }
        }
      }
    }

    return null;
  }
}

function isTimelineZoomLevel(value: string): value is TimelineConfig['zoomLevel'] {
	return value === 'day' || value === 'week' || value === 'month' || value === 'quarter' || value === 'year';
}
