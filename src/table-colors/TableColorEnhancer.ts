import { Component, Menu } from 'obsidian';
import type { ViewsPluginSettings } from '../settings/settings';
import { RenderScheduler } from '../performance/RenderScheduler';
import { reportPerformance } from '../performance/metrics';
import { applyPropertyValueColor } from '../ui/PropertyValueRenderer';
import { resolveColorPalette } from './palettes';

const BASE_ROOT = '.bases-view, .bases-embed';
const CELL = '.bases-td[data-property], .bases-table-cell[data-property]';
const HEADER = '.bases-thead .bases-td';

export class TableColorEnhancer extends Component {
	private observer: MutationObserver | null = null;
	private readonly pendingCells = new Set<HTMLElement>();
	private readonly pendingRoots = new Set<HTMLElement>();
	private readonly scheduler = new RenderScheduler(() => this.flushPending());
	private readonly decoratedState = new WeakMap<HTMLElement, string>();

	constructor(
		private readonly getSettings: () => ViewsPluginSettings,
		private readonly saveSettings: () => Promise<void>,
	) {
		super();
	}

	onload(): void {
		this.observer = new MutationObserver((records) => this.queueMutations(records));
		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ['data-property', 'href', 'aria-checked'],
		});
		this.registerDomEvent(document, 'dblclick', (event) => this.handleColumnDoubleClick(event), true);
		this.refresh();
	}

	onunload(): void {
		this.observer?.disconnect();
		this.scheduler.cancel();
		this.pendingCells.clear();
		this.pendingRoots.clear();
		this.clear();
	}

	refresh(): void {
		this.scheduler.cancel();
		this.pendingCells.clear();
		this.pendingRoots.clear();
		this.clear();
		const settings = this.getSettings();
		if (!settings.tableColorsEnabled) return;
		const palette = this.palette(settings);
		document.querySelectorAll<HTMLElement>(BASE_ROOT).forEach((root) => this.decorateRoot(root, settings, palette));
	}

	private queueMutations(records: MutationRecord[]): void {
		for (const record of records) {
			const target = record.target instanceof Element ? record.target : record.target.parentElement;
			if (target) this.queueElement(target);
			for (const node of Array.from(record.addedNodes)) {
				if (node instanceof Element) this.queueElement(node);
			}
		}
		if (this.pendingCells.size || this.pendingRoots.size) this.scheduler.schedule();
	}

	private queueElement(element: Element): void {
		const cell = element.matches(CELL) ? element : element.closest(CELL);
		if (cell instanceof HTMLElement && cell.closest(BASE_ROOT)) {
			this.pendingCells.add(cell);
			return;
		}
		if (element.matches(BASE_ROOT) && element instanceof HTMLElement) this.pendingRoots.add(element);
		element.querySelectorAll<HTMLElement>(BASE_ROOT).forEach((root) => this.pendingRoots.add(root));
	}

	private flushPending(): void {
		const startedAt = performance.now();
		const settings = this.getSettings();
		const roots = Array.from(this.pendingRoots);
		const cells = Array.from(this.pendingCells);
		this.pendingRoots.clear();
		this.pendingCells.clear();
		let scannedCells = 0;
		let changedValues = 0;
		if (!settings.tableColorsEnabled) {
			for (const root of roots) this.clearWithin(root);
			for (const cell of cells) this.clearWithin(cell);
		} else {
			const palette = this.palette(settings);
			for (const root of roots) {
				if (!root.isConnected) continue;
				const result = this.decorateRoot(root, settings, palette);
				scannedCells += result.scannedCells;
				changedValues += result.changedValues;
			}
			for (const cell of cells) {
				if (!cell.isConnected || roots.some((root) => root.contains(cell))) continue;
				scannedCells += 1;
				changedValues += this.decorateCellValues(cell, settings, palette);
			}
		}
		reportPerformance('table mutation batch', startedAt, {
			roots: roots.length,
			cells: scannedCells,
			changedValues,
		});
	}

	private decorateRoot(
		root: HTMLElement,
		settings: ViewsPluginSettings,
		palette: string[],
	): { scannedCells: number; changedValues: number } {
		let scannedCells = 0;
		let changedValues = 0;
		root.querySelectorAll<HTMLElement>(CELL).forEach((cell) => {
			scannedCells += 1;
			changedValues += this.decorateCellValues(cell, settings, palette);
		});
		return { scannedCells, changedValues };
	}

	private decorateCellValues(cell: HTMLElement, settings: ViewsPluginSettings, palette: string[]): number {
		const propertyId = cell.dataset.property?.trim() ?? '';
		if (
			!propertyId
			|| propertyId === 'file.name'
			|| this.isColumnDisabled(propertyId, settings)
			|| !settings.colorValuePills
		) {
			this.clearWithin(cell);
			return 0;
		}
		// Editable note tag/list properties use multi-select pills, while the
		// read-only core `file.tags` property renders literal anchor.tag elements.
		const pills = cell.querySelectorAll<HTMLElement>('.multi-select-pill, a.tag');
		let changed = 0;
		pills.forEach((pill) => {
			const value = pill.querySelector<HTMLElement>('.multi-select-pill-content')?.textContent?.trim()
				?? pill.textContent?.trim()
				?? '';
			if (this.applyPillColor(pill, propertyId, value, palette)) changed += 1;
		});
		return changed;
	}

	private applyPillColor(pill: HTMLElement, propertyId: string, value: string, palette: string[]): boolean {
		const state = `${propertyId}\u0000${value}\u0000${palette.join(',')}`;
		if (this.decoratedState.get(pill) === state && pill.hasClass('has-value-color')) return false;
		this.clearElement(pill);
		pill.addClass('views-colored-pill');
		applyPropertyValueColor(pill, value, palette);
		this.decoratedState.set(pill, state);
		return true;
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
		return resolveColorPalette(settings.colorPack, settings.customPalette);
	}

	private clear(): void {
		document.querySelectorAll<HTMLElement>('.views-colored-row, .views-colored-pill, .views-colored-cell').forEach((element) => {
			this.clearElement(element);
		});
	}

	private clearWithin(container: Element): void {
		if (container instanceof HTMLElement && container.matches('.views-colored-row, .views-colored-pill, .views-colored-cell')) {
			this.clearElement(container);
		}
		container.querySelectorAll<HTMLElement>('.views-colored-row, .views-colored-pill, .views-colored-cell')
			.forEach((element) => this.clearElement(element));
	}

	private clearElement(element: HTMLElement): void {
		element.removeClass('views-colored-row', 'views-colored-pill', 'views-colored-cell', 'has-value-color');
		element.style.removeProperty('--views-row-color');
		element.style.removeProperty('--views-pill-color');
		element.style.removeProperty('--views-cell-color');
		element.style.removeProperty('--views-property-color');
		this.decoratedState.delete(element);
	}
}
