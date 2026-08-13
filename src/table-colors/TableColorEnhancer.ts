import { App, Component, Menu } from 'obsidian';
import type { ViewsPluginSettings } from '../main';
import { applyPropertyValueColor } from '../ui/PropertyValueRenderer';
import { COLOR_PACKS, parseCustomPalette } from './palettes';

const BASE_ROOT = '.bases-view, .bases-embed';
const CELL = '.bases-td[data-property], .bases-table-cell[data-property]';
const HEADER = '.bases-thead .bases-td';

export class TableColorEnhancer extends Component {
	private observer: MutationObserver | null = null;
	private refreshQueued = false;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => ViewsPluginSettings,
		private readonly saveSettings: () => Promise<void>,
	) {
		super();
	}

	onload(): void {
		this.observer = new MutationObserver(() => this.queueRefresh());
		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ['data-property', 'href', 'aria-checked'],
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => this.queueRefresh()));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.queueRefresh()));
		this.registerDomEvent(document, 'dblclick', (event) => this.handleColumnDoubleClick(event), true);
		this.refresh();
	}

	onunload(): void {
		this.observer?.disconnect();
		this.clear();
	}

	refresh(): void {
		this.clear();
		const settings = this.getSettings();
		if (!settings.tableColorsEnabled) return;
		document.querySelectorAll<HTMLElement>(BASE_ROOT).forEach((root) => this.decorateRoot(root, settings));
	}

	private queueRefresh(): void {
		if (this.refreshQueued) return;
		this.refreshQueued = true;
		window.requestAnimationFrame(() => {
			this.refreshQueued = false;
			this.refresh();
		});
	}

	private decorateRoot(root: HTMLElement, settings: ViewsPluginSettings): void {
		root.querySelectorAll<HTMLElement>(CELL).forEach((cell) => this.decorateCellValues(cell, settings));
	}

	private decorateCellValues(cell: HTMLElement, settings: ViewsPluginSettings): void {
		const propertyId = cell.dataset.property?.trim() ?? '';
		if (!propertyId || propertyId === 'file.name' || this.isColumnDisabled(propertyId, settings)) return;
		const palette = this.palette(settings);
		// Editable note tag/list properties use multi-select pills, while the
		// read-only core `file.tags` property renders literal anchor.tag elements.
		const pills = cell.querySelectorAll<HTMLElement>('.multi-select-pill, a.tag');
		if (pills.length && settings.colorValuePills) {
			pills.forEach((pill) => {
				const value = pill.querySelector<HTMLElement>('.multi-select-pill-content')?.textContent?.trim()
					?? pill.textContent?.trim()
					?? '';
				this.applyPillColor(pill, value, palette);
			});
		}
	}

	private applyPillColor(pill: HTMLElement, value: string, palette: string[]): void {
		pill.addClass('views-colored-pill');
		applyPropertyValueColor(pill, value, palette);
	}

	private isColumnDisabled(propertyId: string, settings = this.getSettings()): boolean {
		return Array.isArray(settings.tableColorDisabledProperties)
			&& settings.tableColorDisabledProperties.includes(propertyId);
	}

	private handleColumnDoubleClick(event: MouseEvent): void {
		if (!(event.target instanceof Element)) return;
		if (event.target.closest('.bases-table-header-resizer')) return;
		const root = event.target.closest<HTMLElement>(BASE_ROOT);
		const header = event.target.closest<HTMLElement>(HEADER);
		if (!root || !header || !root.contains(header)) return;
		const propertyId = this.propertyIdForHeader(root, header);
		if (!propertyId || propertyId === 'file.name') return;

		event.preventDefault();
		event.stopPropagation();
		const settings = this.getSettings();
		const enabled = !this.isColumnDisabled(propertyId, settings);
		const displayName = header.textContent?.trim() || propertyId.replace(/^note\./, '');
		new Menu()
			.addItem((item) => item
				.setTitle(`Color values in ${displayName}`)
				.setIcon('palette')
				.setChecked(enabled)
				.onClick(() => {
					const disabled = new Set(Array.isArray(settings.tableColorDisabledProperties)
						? settings.tableColorDisabledProperties
						: []);
					if (enabled) disabled.add(propertyId);
					else disabled.delete(propertyId);
					settings.tableColorDisabledProperties = [...disabled].sort();
					void this.saveSettings();
				}))
			.showAtMouseEvent(event);
	}

	private propertyIdForHeader(root: HTMLElement, header: HTMLElement): string {
		const direct = header.dataset.property?.trim();
		if (direct) return direct;
		const headerCells = Array.from(root.querySelectorAll<HTMLElement>(HEADER));
		const columnIndex = headerCells.indexOf(header);
		if (columnIndex < 0) return '';
		for (const row of Array.from(root.querySelectorAll<HTMLElement>('.bases-tr'))) {
			const cells = Array.from(row.children)
				.filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches(CELL));
			const propertyId = cells[columnIndex]?.dataset.property?.trim();
			if (propertyId) return propertyId;
		}
		return '';
	}

	private palette(settings: ViewsPluginSettings): string[] {
		if (settings.colorPack === 'custom') {
			const custom = parseCustomPalette(settings.customPalette);
			if (custom.length) return custom;
		}
		return COLOR_PACKS[settings.colorPack === 'custom' ? 'notion' : settings.colorPack];
	}

	private clear(): void {
		document.querySelectorAll<HTMLElement>('.views-colored-row, .views-colored-pill, .views-colored-cell').forEach((element) => {
			element.removeClass('views-colored-row', 'views-colored-pill', 'views-colored-cell', 'has-value-color');
			element.style.removeProperty('--views-row-color');
			element.style.removeProperty('--views-pill-color');
			element.style.removeProperty('--views-cell-color');
			element.style.removeProperty('--views-property-color');
		});
	}
}
