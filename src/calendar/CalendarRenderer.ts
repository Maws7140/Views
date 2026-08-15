import { RenderScheduler } from '../performance/RenderScheduler';
import { reportPerformance } from '../performance/metrics';
import { setIcon } from 'obsidian';
import type { CalendarDay, CalendarMonth } from '../logic/calendarGrid';

export interface CalendarModel {
	month: CalendarMonth;
	/** Split so the year can take the accent the reference gives it. */
	monthLabel: string;
	yearLabel: string;
	weekdayLabels: string[];
	showWeekNumbers: boolean;
	showDetail: boolean;
	/** `YYYY-MM-DD` of the open day, or null when nothing is selected. */
	selectedKey: string | null;
	notice: string;
	cellSize: number;
}

export interface CalendarCallbacks {
	onStepMonth(delta: number): void;
	onToday(): void;
	onSelectDay(key: string | null): void;
	/** The view owns property rendering, the same way the Raycast rows do. */
	renderEntry(containerEl: HTMLElement, path: string): void;
}

export class CalendarRenderer {
	private readonly headerEl: HTMLElement;
	private readonly titleEl: HTMLElement;
	private readonly navEl: HTMLElement;
	private readonly noticeEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly weekdaysEl: HTMLElement;
	private readonly gridEl: HTMLElement;
	private readonly detailEl: HTMLElement;
	private readonly scheduler = new RenderScheduler(() => this.flush());
	private model: CalendarModel | null = null;

	constructor(
		private readonly containerEl: HTMLElement,
		private readonly callbacks: CalendarCallbacks,
	) {
		this.containerEl.addClass('mbv-calendar');
		this.headerEl = this.containerEl.createDiv({ cls: 'mbv-cal-header' });
		this.titleEl = this.headerEl.createDiv({ cls: 'mbv-cal-title' });
		this.navEl = this.headerEl.createDiv({ cls: 'mbv-cal-nav' });
		this.noticeEl = this.containerEl.createDiv({ cls: 'mbv-cal-notice' });
		this.bodyEl = this.containerEl.createDiv({ cls: 'mbv-cal-body' });
		this.weekdaysEl = this.bodyEl.createDiv({ cls: 'mbv-cal-weekdays' });
		this.gridEl = this.bodyEl.createDiv({ cls: 'mbv-cal-grid' });
		this.detailEl = this.containerEl.createDiv({ cls: 'mbv-cal-detail' });

		this.buildNav();
		this.gridEl.addEventListener('click', this.onGridClick);
	}

	update(model: CalendarModel): void {
		this.model = model;
		this.scheduler.schedule();
	}

	destroy(): void {
		this.scheduler.cancel();
		this.gridEl.removeEventListener('click', this.onGridClick);
		this.containerEl.empty();
	}

	/** Built once. Only the labels below it change as months are stepped. */
	private buildNav(): void {
		const back = this.navEl.createEl('button', { cls: 'mbv-cal-step' });
		setIcon(back, 'lucide-chevron-left');
		back.setAttr('aria-label', 'Previous month');
		back.addEventListener('click', () => this.callbacks.onStepMonth(-1));

		const today = this.navEl.createEl('button', { cls: 'mbv-cal-today', text: 'Today' });
		today.setAttr('aria-label', 'Go to today');
		today.addEventListener('click', () => this.callbacks.onToday());

		const forward = this.navEl.createEl('button', { cls: 'mbv-cal-step' });
		setIcon(forward, 'lucide-chevron-right');
		forward.setAttr('aria-label', 'Next month');
		forward.addEventListener('click', () => this.callbacks.onStepMonth(1));
	}

	private flush(): void {
		const model = this.model;
		if (!model) return;
		const startedAt = performance.now();

		this.containerEl.style.setProperty('--mbv-cal-cell', `${model.cellSize}px`);
		this.containerEl.toggleClass('has-week-numbers', model.showWeekNumbers);

		this.titleEl.empty();
		this.titleEl.createSpan({ cls: 'mbv-cal-month-name', text: model.monthLabel });
		this.titleEl.createSpan({ cls: 'mbv-cal-year', text: model.yearLabel });

		this.noticeEl.toggleClass('is-hidden', !model.notice);
		this.noticeEl.setText(model.notice);

		const hidden = Boolean(model.notice);
		this.bodyEl.toggleClass('is-hidden', hidden);
		this.detailEl.toggleClass('is-hidden', hidden || !model.showDetail);
		if (hidden) {
			this.gridEl.empty();
			this.weekdaysEl.empty();
			this.detailEl.empty();
			return;
		}

		this.renderWeekdays(model);
		const days = this.renderGrid(model);
		this.renderDetail(model);

		reportPerformance('calendar render', startedAt, {
			weeks: model.month.weeks.length,
			days,
			markers: model.month.weeks.reduce(
				(carry, week) => carry + week.days.reduce((sum, day) => sum + day.markers.length, 0),
				0,
			),
		});
	}

	private renderWeekdays(model: CalendarModel): void {
		this.weekdaysEl.empty();
		if (model.showWeekNumbers) {
			this.weekdaysEl.createDiv({ cls: 'mbv-cal-weeknum is-heading', text: 'W' });
		}
		for (const label of model.weekdayLabels) {
			this.weekdaysEl.createDiv({ cls: 'mbv-cal-weekday', text: label });
		}
	}

	private renderGrid(model: CalendarModel): number {
		this.gridEl.empty();
		let painted = 0;
		for (const week of model.month.weeks) {
			const rowEl = this.gridEl.createDiv({ cls: 'mbv-cal-week' });
			if (model.showWeekNumbers) {
				rowEl.createDiv({ cls: 'mbv-cal-weeknum', text: String(week.number) });
			}
			for (const day of week.days) {
				this.renderDay(rowEl, day, model);
				painted += 1;
			}
		}
		return painted;
	}

	private renderDay(rowEl: HTMLElement, day: CalendarDay, model: CalendarModel): void {
		const cellEl = rowEl.createDiv({ cls: 'mbv-cal-day' });
		cellEl.dataset.day = day.key;
		cellEl.toggleClass('is-outside', !day.inMonth);
		cellEl.toggleClass('is-today', day.isToday);
		cellEl.toggleClass('is-selected', day.key === model.selectedKey);
		cellEl.toggleClass('is-empty', day.entries.length === 0);
		// With the panel on, a day selects and the panel's rows open. With it off
		// there is nowhere else to go, so the cell itself opens the day's first
		// note and only then carries a path.
		if (day.entries.length) {
			cellEl.tabIndex = 0;
			if (!model.showDetail) cellEl.dataset.path = day.entries[0].path;
		}
		cellEl.setAttr('aria-label', describeDay(day));

		// A heat fill paints the whole cell, so the level rides on the cell and the
		// day number inverts against it in CSS rather than in two code paths.
		if (model.month.style === 'fill') {
			cellEl.dataset.level = String(day.level);
			const color = day.level > 0 ? model.month.levels[day.level - 1]?.color : null;
			if (color) cellEl.style.setProperty('--mbv-cal-fill', color);
		}

		cellEl.createDiv({ cls: 'mbv-cal-number', text: String(day.dayOfMonth) });

		if (model.month.style !== 'dots' || !day.markers.length) return;
		const marksEl = cellEl.createDiv({ cls: 'mbv-cal-marks' });
		for (const marker of day.markers) {
			const dotEl = marksEl.createDiv({ cls: 'mbv-cal-dot' });
			dotEl.toggleClass('is-hollow', !marker.filled);
			if (marker.color) dotEl.style.setProperty('--mbv-cal-dot-color', marker.color);
		}
		if (day.overflow) {
			marksEl.createSpan({ cls: 'mbv-cal-more', text: `+${day.overflow}` });
		}
	}

	/**
	 * The selected day's notes. A day with nothing on it still gets the panel,
	 * so selecting never collapses the layout under the grid.
	 */
	private renderDetail(model: CalendarModel): void {
		this.detailEl.empty();
		if (!model.showDetail) return;

		const day = model.selectedKey ? findDay(model.month, model.selectedKey) : null;
		if (!day) {
			this.detailEl.createDiv({ cls: 'mbv-cal-detail-empty', text: 'Select a day.' });
			return;
		}

		const headingEl = this.detailEl.createDiv({ cls: 'mbv-cal-detail-heading' });
		headingEl.createSpan({ cls: 'mbv-cal-detail-date', text: formatLongDate(day.ts) });
		headingEl.createSpan({
			cls: 'mbv-cal-detail-count',
			text: day.entries.length === 1 ? '1 note' : `${day.entries.length} notes`,
		});

		if (!day.entries.length) {
			this.detailEl.createDiv({ cls: 'mbv-cal-detail-empty', text: 'Nothing on this day.' });
			return;
		}

		const listEl = this.detailEl.createDiv({ cls: 'mbv-cal-detail-list' });
		for (const entry of day.entries) {
			const itemEl = listEl.createDiv({ cls: 'mbv-cal-detail-item' });
			itemEl.dataset.path = entry.path;
			itemEl.tabIndex = 0;
			itemEl.createDiv({ cls: 'mbv-cal-detail-title', text: entry.title });
			this.callbacks.renderEntry(itemEl.createDiv({ cls: 'mbv-cal-detail-props' }), entry.path);
		}
	}

	/**
	 * Selecting is the cell's own job and stays here. Opening a note is not: the
	 * shared entry interactions own the click that opens, so a day and a detail
	 * row behave like every other openable surface in the plugin.
	 */
	private readonly onGridClick = (event: MouseEvent): void => {
		const model = this.model;
		if (!model?.showDetail) return;
		const target = event.target instanceof Element
			? event.target.closest<HTMLElement>('.mbv-cal-day')
			: null;
		const key = target?.dataset.day;
		if (!key) return;
		this.callbacks.onSelectDay(key === model.selectedKey ? null : key);
	};
}

function findDay(month: CalendarMonth, key: string): CalendarDay | null {
	for (const week of month.weeks) {
		for (const day of week.days) {
			if (day.key === key) return day;
		}
	}
	return null;
}

function describeDay(day: CalendarDay): string {
	const date = formatLongDate(day.ts);
	if (!day.entries.length) return date;
	const names = day.entries.slice(0, 5).map((entry) => entry.title);
	if (day.entries.length > names.length) names.push(`and ${day.entries.length - names.length} more`);
	return `${date}\n${names.join('\n')}`;
}

function formatLongDate(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
	});
}
