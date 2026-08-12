import { App, Component, TFile } from 'obsidian';
import type { ViewsPluginSettings } from '../main';
import { COLOR_PACKS, isCssColor, normalizeColor, parseCustomPalette, stableColor } from './palettes';

const BASE_ROOT = '.bases-view, .bases-embed';
const ROW = '.bases-tr';
const CELL = '.bases-td[data-property], .bases-table-cell[data-property]';

export class TableColorEnhancer extends Component {
	private observer: MutationObserver | null = null;
	private refreshQueued = false;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => ViewsPluginSettings,
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
		root.querySelectorAll<HTMLElement>(ROW).forEach((row) => this.decorateRow(row, settings));
		if (!settings.colorValuePills) return;
		root.querySelectorAll<HTMLElement>(CELL).forEach((cell) => this.decorateCellValues(cell, settings));
	}

	private decorateRow(row: HTMLElement, settings: ViewsPluginSettings): void {
		if (!row.querySelector(CELL)) return;
		const file = this.resolveRowFile(row);
		const frontmatter = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
		const manual = this.frontmatterValue(frontmatter, settings.manualColorProperty);
		const automaticValue = this.frontmatterValue(frontmatter, settings.automaticColorProperty)
			?? this.renderedPropertyValue(row, settings.automaticColorProperty);
		const manualColor = normalizeColor(manual);
		const color = manualColor && isCssColor(manualColor)
			? manualColor
			: settings.automaticColorsEnabled && automaticValue
				? stableColor(automaticValue, this.palette(settings))
				: null;
		if (!color) return;
		row.addClass('views-colored-row');
		row.style.setProperty('--views-row-color', color);
	}

	private decorateCellValues(cell: HTMLElement, settings: ViewsPluginSettings): void {
		const propertyId = cell.dataset.property?.trim() ?? '';
		if (!propertyId || propertyId === 'file.name') return;
		const palette = this.palette(settings);
		const pills = cell.querySelectorAll<HTMLElement>('.multi-select-pill');
		if (pills.length) {
			pills.forEach((pill) => {
				const value = pill.querySelector<HTMLElement>('.multi-select-pill-content')?.textContent?.trim() ?? '';
				this.applyPillColor(pill, value, palette);
			});
			return;
		}
		if (!settings.colorScalarValues) return;
		const value = this.renderedCellValue(cell);
		if (!value) return;
		cell.addClass('views-colored-cell');
		const color = stableColor(`${propertyId}:${value}`, palette);
		if (color) cell.style.setProperty('--views-cell-color', color);
	}

	private applyPillColor(pill: HTMLElement, value: string, palette: string[]): void {
		const color = stableColor(value, palette);
		if (!color) return;
		pill.addClass('views-colored-pill');
		pill.style.setProperty('--views-pill-color', color);
	}

	private resolveRowFile(row: HTMLElement): TFile | null {
		const link = row.querySelector<HTMLElement>('.internal-link[data-href], a[data-href]');
		const linkpath = link?.dataset.href?.trim();
		if (!linkpath) return null;
		return this.app.metadataCache.getFirstLinkpathDest(linkpath, '') ?? null;
	}

	private renderedPropertyValue(row: HTMLElement, propertyName: string): string | null {
		const ids = [propertyName, `note.${propertyName}`];
		const cell = Array.from(row.querySelectorAll<HTMLElement>(CELL))
			.find((candidate) => ids.includes(candidate.dataset.property?.trim() ?? ''));
		return cell ? this.renderedCellValue(cell) : null;
	}

	private renderedCellValue(cell: HTMLElement): string | null {
		const values = Array.from(cell.querySelectorAll<HTMLElement>('.multi-select-pill-content'))
			.map((pill) => pill.textContent?.trim() ?? '')
			.filter(Boolean);
		if (values.length) return values.join(', ');
		const input = cell.querySelector<HTMLInputElement>('input');
		if (input?.type === 'checkbox') return input.checked ? 'true' : 'false';
		return (input?.value ?? cell.textContent ?? '').trim() || null;
	}

	private frontmatterValue(frontmatter: Record<string, unknown> | null | undefined, property: string): string | null {
		if (!frontmatter || !property.trim()) return null;
		const raw = frontmatter[property.trim()];
		if (Array.isArray(raw)) return raw.map(String).join(', ');
		return raw === null || raw === undefined ? null : String(raw).trim() || null;
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
			element.removeClass('views-colored-row', 'views-colored-pill', 'views-colored-cell');
			element.style.removeProperty('--views-row-color');
			element.style.removeProperty('--views-pill-color');
			element.style.removeProperty('--views-cell-color');
		});
	}
}
