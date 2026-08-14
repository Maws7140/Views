import { CollectionScrollbar } from '../collection/CollectionScrollbar';
import { RenderScheduler } from '../performance/RenderScheduler';
import { periodHeadline, periodLabel, type HeatDay, type HeatGrid, type HeatLevel } from '../logic/heatBuckets';
import { localDayKey } from '../logic/dateValue';
import { reportPerformance } from '../performance/metrics';
import { setIcon } from 'obsidian';

/** The year the month buttons belong to, and where it can still be stepped. */
export interface HeatPeriodStepper {
	label: string;
	canStepBack: boolean;
	canStepForward: boolean;
}

export interface HeatmapModel {
	grid: HeatGrid;
	/** Keyed by `YYYY-MM-DD`, so a hovered cell resolves without scanning. */
	days: Map<string, HeatDay>;
	levels: HeatLevel[];
	periods: string[];
	activePeriod: string;
	/** Present only in month granularity, where the buttons need a year behind them. */
	stepper: HeatPeriodStepper | null;
	/** Sum of every day in the visible period, for the headline. */
	total: number;
	valueName: string;
	notice: string;
	cellSize: number;
	cellGap: number;
	weekdayLabels: string[];
	showMonthLabels: boolean;
	showWeekdayLabels: boolean;
	showLegend: boolean;
	showTotal: boolean;
}

export interface HeatmapCallbacks {
	onPeriodChange(period: string): void;
	/** Moves the month buttons a whole year, keeping the selected month. */
	onStepYear(delta: number): void;
	/** Note names for a day's tooltip, resolved only for the hovered cell. */
	describeDay(day: HeatDay): string[];
}

const WEEKDAY_LABEL_ROWS = new Set([1, 3, 5]);
const TOOLTIP_NOTE_LIMIT = 5;

export class HeatmapRenderer {
	private readonly headerEl: HTMLElement;
	private readonly totalEl: HTMLElement;
	private readonly periodsEl: HTMLElement;
	private readonly noticeEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly weekdaysEl: HTMLElement;
	private readonly scrollEl: HTMLElement;
	private readonly monthsEl: HTMLElement;
	private readonly gridEl: HTMLElement;
	private readonly legendEl: HTMLElement;
	private readonly scheduler = new RenderScheduler(() => this.flush());
	private scrollbar: CollectionScrollbar | null = null;
	private tooltipEl: HTMLElement | null = null;
	private model: HeatmapModel | null = null;

	constructor(
		private readonly containerEl: HTMLElement,
		private readonly callbacks: HeatmapCallbacks,
	) {
		this.containerEl.addClass('mbv-heatmap');
		// The period buttons are a column beside the whole block, not part of the
		// header, which is where the reference puts them.
		const layoutEl = this.containerEl.createDiv({ cls: 'mbv-heat-layout' });
		const mainEl = layoutEl.createDiv({ cls: 'mbv-heat-main' });
		this.headerEl = mainEl.createDiv({ cls: 'mbv-heat-header' });
		this.totalEl = this.headerEl.createDiv({ cls: 'mbv-heat-total' });
		this.noticeEl = mainEl.createDiv({ cls: 'mbv-heat-notice' });
		this.bodyEl = mainEl.createDiv({ cls: 'mbv-heat-body' });
		this.weekdaysEl = this.bodyEl.createDiv({ cls: 'mbv-heat-weekdays' });
		this.scrollEl = this.bodyEl.createDiv({ cls: 'mbv-heat-scroll' });
		this.monthsEl = this.scrollEl.createDiv({ cls: 'mbv-heat-months' });
		this.gridEl = this.scrollEl.createDiv({ cls: 'mbv-heat-grid' });
		this.legendEl = mainEl.createDiv({ cls: 'mbv-heat-legend' });
		this.periodsEl = layoutEl.createDiv({ cls: 'mbv-heat-periods' });

		this.gridEl.addEventListener('pointerover', this.onPointerOver);
		this.gridEl.addEventListener('pointerleave', this.onPointerLeave);
	}

	update(model: HeatmapModel): void {
		this.model = model;
		this.scheduler.schedule();
	}

	destroy(): void {
		this.scheduler.cancel();
		this.gridEl.removeEventListener('pointerover', this.onPointerOver);
		this.gridEl.removeEventListener('pointerleave', this.onPointerLeave);
		this.scrollbar?.destroy();
		this.scrollbar = null;
		this.tooltipEl?.remove();
		this.tooltipEl = null;
		this.containerEl.empty();
	}

	private flush(): void {
		const model = this.model;
		if (!model) return;
		const startedAt = performance.now();

		this.containerEl.style.setProperty('--mbv-heat-cell', `${model.cellSize}px`);
		this.containerEl.style.setProperty('--mbv-heat-gap', `${model.cellGap}px`);

		this.renderNotice(model);
		this.renderPeriods(model);
		this.renderTotal(model);

		const hidden = Boolean(model.notice);
		this.bodyEl.toggleClass('is-hidden', hidden);
		this.legendEl.toggleClass('is-hidden', hidden || !model.showLegend);
		if (hidden) {
			this.gridEl.empty();
			this.monthsEl.empty();
			this.weekdaysEl.empty();
			this.legendEl.empty();
			return;
		}

		this.renderWeekdays(model);
		this.renderMonths(model);
		const cells = this.renderGrid(model);
		this.renderLegend(model);

		// The grid can outrun the pane on a narrow leaf, so it gets the same
		// scrollbar every other view uses rather than the native one.
		if (!this.scrollbar) this.scrollbar = new CollectionScrollbar(this.scrollEl, this.bodyEl, 'horizontal');

		reportPerformance('heatmap render', startedAt, {
			columns: model.grid.columns.length,
			cells,
			levels: model.levels.length,
		});
	}

	private renderNotice(model: HeatmapModel): void {
		this.noticeEl.toggleClass('is-hidden', !model.notice);
		this.noticeEl.setText(model.notice);
	}

	private renderTotal(model: HeatmapModel): void {
		this.totalEl.toggleClass('is-hidden', !model.showTotal || Boolean(model.notice));
		if (!model.showTotal || model.notice) return;
		const window = periodHeadline(model.activePeriod);
		this.totalEl.setText(`${formatNumber(model.total)} ${model.valueName} ${window}`);
	}

	private renderPeriods(model: HeatmapModel): void {
		this.periodsEl.empty();
		if (model.stepper) this.renderStepper(model.stepper);
		for (const period of model.periods) {
			const button = this.periodsEl.createEl('button', {
				cls: 'mbv-heat-period',
				text: periodLabel(period),
			});
			button.toggleClass('is-active', period === model.activePeriod);
			button.addEventListener('click', () => this.callbacks.onPeriodChange(period));
		}
	}

	/**
	 * The year the month buttons sit under. An arrow is disabled rather than
	 * hidden when the data stops, so the row never changes width mid-navigation.
	 */
	private renderStepper(stepper: HeatPeriodStepper): void {
		const row = this.periodsEl.createDiv({ cls: 'mbv-heat-stepper' });
		const back = row.createEl('button', { cls: 'mbv-heat-step' });
		setIcon(back, 'lucide-chevron-left');
		back.setAttribute('aria-label', 'Previous year');
		back.disabled = !stepper.canStepBack;
		back.addEventListener('click', () => this.callbacks.onStepYear(-1));

		row.createDiv({ cls: 'mbv-heat-step-label', text: stepper.label });

		const forward = row.createEl('button', { cls: 'mbv-heat-step' });
		setIcon(forward, 'lucide-chevron-right');
		forward.setAttribute('aria-label', 'Next year');
		forward.disabled = !stepper.canStepForward;
		forward.addEventListener('click', () => this.callbacks.onStepYear(1));
	}

	private renderWeekdays(model: HeatmapModel): void {
		this.weekdaysEl.empty();
		this.weekdaysEl.toggleClass('is-hidden', !model.showWeekdayLabels);
		if (!model.showWeekdayLabels) return;
		// Only alternate rows are labelled, the way the reference does, so the
		// labels stay readable at small cell sizes.
		model.weekdayLabels.forEach((label, row) => {
			this.weekdaysEl.createDiv({
				cls: 'mbv-heat-weekday',
				text: WEEKDAY_LABEL_ROWS.has(row) ? label : '',
			});
		});
	}

	private renderMonths(model: HeatmapModel): void {
		this.monthsEl.empty();
		this.monthsEl.toggleClass('is-hidden', !model.showMonthLabels);
		if (!model.showMonthLabels) return;
		const total = model.grid.columns.length;
		model.grid.monthLabels.forEach((label, index) => {
			const next = model.grid.monthLabels[index + 1];
			const span = (next ? next.column : total) - label.column;
			if (span <= 0) return;
			const el = this.monthsEl.createDiv({ cls: 'mbv-heat-month', text: label.label });
			el.style.gridColumn = `${label.column + 1} / span ${span}`;
		});
		this.monthsEl.style.gridTemplateColumns = `repeat(${total}, var(--mbv-heat-cell))`;
	}

	private renderGrid(model: HeatmapModel): number {
		this.gridEl.empty();
		this.gridEl.style.gridTemplateColumns = `repeat(${model.grid.columns.length}, var(--mbv-heat-cell))`;
		let painted = 0;

		for (const column of model.grid.columns) {
			const columnEl = this.gridEl.createDiv({ cls: 'mbv-heat-column' });
			for (let row = 0; row < 7; row += 1) {
				const stamp = column.stamps[row];
				if (stamp === null) {
					// Outside the period. A spacer holds the row alignment and
					// carries no path, so it can never resolve to a file.
					columnEl.createDiv({ cls: 'mbv-heat-cell is-void' });
					continue;
				}
				const day = column.cells[row];
				const level = day?.level ?? 0;
				const cell = columnEl.createDiv({ cls: 'mbv-heat-cell' });
				cell.dataset.level = String(level);
				cell.dataset.day = localDayKey(stamp);
				if (level > 0) cell.style.setProperty('--mbv-heat-color', model.levels[level - 1].color);
				if (day?.primaryPath) {
					cell.dataset.path = day.primaryPath;
					cell.tabIndex = 0;
				}
				cell.setAttr('aria-label', this.summaryFor(stamp, day, model));
				painted += 1;
			}
		}
		return painted;
	}

	private renderLegend(model: HeatmapModel): void {
		this.legendEl.empty();
		if (!model.showLegend) return;
		this.legendEl.createSpan({ cls: 'mbv-heat-legend-end', text: 'Less' });

		// Level 0 leads the scale so the empty cell is named rather than left as
		// an unexplained gap between "Less" and the first colour.
		const swatch = (level: number, color: string | null, label: string): void => {
			const item = this.legendEl.createDiv({ cls: 'mbv-heat-legend-item' });
			const box = item.createDiv({ cls: 'mbv-heat-cell' });
			box.dataset.level = String(level);
			if (color) box.style.setProperty('--mbv-heat-color', color);
			item.createSpan({ cls: 'mbv-heat-legend-label', text: label });
		};

		swatch(0, null, '0');
		model.levels.forEach((level, index) => {
			swatch(index + 1, level.color, formatRange(level));
		});

		this.legendEl.createSpan({ cls: 'mbv-heat-legend-end', text: 'More' });
	}

	private summaryFor(stamp: number, day: HeatDay | null, model: HeatmapModel): string {
		const date = formatLongDate(stamp);
		if (!day) return `No ${model.valueName} on ${date}`;
		const noun = day.count === 1 ? 'note' : 'notes';
		return `${formatNumber(day.total)} ${model.valueName} from ${day.count} ${noun} on ${date}`;
	}

	private readonly onPointerOver = (event: PointerEvent): void => {
		const model = this.model;
		const target = event.target instanceof Element
			? event.target.closest<HTMLElement>('.mbv-heat-cell')
			: null;
		if (!model || !target || target.hasClass('is-void')) {
			this.hideTooltip();
			return;
		}
		const summary = target.getAttr('aria-label') ?? '';
		const day = model.days.get(target.dataset.day ?? '') ?? null;
		const names = day ? this.callbacks.describeDay(day) : [];
		this.showTooltip(target, summary, names);
	};

	private readonly onPointerLeave = (): void => this.hideTooltip();

	/**
	 * One tooltip element is reused across every cell. It says which note a click
	 * will open, so the single-file rule is visible rather than a guess.
	 */
	private showTooltip(cell: HTMLElement, summary: string, names: string[]): void {
		if (!this.tooltipEl) {
			this.tooltipEl = this.containerEl.createDiv({ cls: 'mbv-heat-tip' });
		}
		const tip = this.tooltipEl;
		tip.empty();
		tip.createDiv({ cls: 'mbv-heat-tip-summary', text: summary });
		for (const name of names.slice(0, TOOLTIP_NOTE_LIMIT)) {
			tip.createDiv({ cls: 'mbv-heat-tip-note', text: name });
		}
		if (names.length > TOOLTIP_NOTE_LIMIT) {
			tip.createDiv({ cls: 'mbv-heat-tip-more', text: `and ${names.length - TOOLTIP_NOTE_LIMIT} more` });
		}
		tip.removeClass('is-hidden');

		const host = this.containerEl.getBoundingClientRect();
		const box = cell.getBoundingClientRect();
		const left = box.left - host.left + box.width / 2;
		tip.style.left = `${Math.round(left)}px`;
		tip.style.top = `${Math.round(box.top - host.top)}px`;
		// Measured after placement, so a tooltip near the right edge pulls back
		// inside instead of widening the view and triggering a scroll.
		const overflow = tip.getBoundingClientRect().right - host.right;
		if (overflow > 0) tip.style.left = `${Math.round(left - overflow - 8)}px`;
	}

	private hideTooltip(): void {
		this.tooltipEl?.addClass('is-hidden');
	}
}

function formatNumber(value: number): string {
	const rounded = Math.round(value * 100) / 100;
	return rounded.toLocaleString();
}

function formatRange(level: HeatLevel): string {
	const min = Math.max(0, Math.ceil(level.min * 100) / 100);
	if (level.max === null) return `${formatNumber(min)}+`;
	const max = Math.floor(level.max * 100) / 100;
	return max <= min ? formatNumber(min) : `${formatNumber(min)} to ${formatNumber(max)}`;
}

function formatLongDate(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}
