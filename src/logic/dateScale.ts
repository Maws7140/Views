import type { TimelineItem, TimelineZoomLevel } from '../types';

/**
 * Floors a timestamp to the start of the period it belongs to at the given
 * tick level, so a scale origin lands on a real period boundary instead of
 * an arbitrary instant that pushes the first tick off-canvas.
 */
export function floorToPeriodStart(ts: number, level: TimelineZoomLevel): number {
	const d = new Date(ts);
	switch (level) {
		case 'day':
		case 'week':
			d.setHours(0, 0, 0, 0);
			break;
		case 'month':
		case 'quarter':
			d.setDate(1);
			d.setHours(0, 0, 0, 0);
			break;
		case 'year':
			d.setMonth(0, 1);
			d.setHours(0, 0, 0, 0);
			break;
	}
	return d.getTime();
}

export interface DateScale {
	pxPerDay: number;
	startTs: number;
	toX(ts: number): number;
	fromX(px: number): number;
	setZoom(level: TimelineZoomLevel): void;
	setPxPerDay(value: number): void;
	canZoom(step: 1 | -1): boolean;
	getTickLevel(): TimelineZoomLevel;
	fitTo(items: TimelineItem[], viewportWidth: number): void;
}

export class BasicDateScale implements DateScale {
	private static readonly MS_PER_DAY = 24 * 60 * 60 * 1000;
	private static readonly ZOOM_PRESETS: Record<TimelineZoomLevel, number> = {
		day: 320,
		week: 96,
		month: 32,
		quarter: 12,
		year: 5,
	};
	private static readonly MIN_PX_PER_DAY = 2;
	private static readonly MAX_PX_PER_DAY = 480;

	pxPerDay: number;
	startTs: number;
	private zoomLevel: TimelineZoomLevel;

	constructor(initialStart: number, zoom: TimelineZoomLevel = 'month') {
		this.startTs = initialStart;
		this.zoomLevel = zoom;
		this.pxPerDay = BasicDateScale.ZOOM_PRESETS[zoom];
	}

	toX(ts: number): number {
		return ((ts - this.startTs) / BasicDateScale.MS_PER_DAY) * this.pxPerDay;
	}

	fromX(px: number): number {
		return this.startTs + (px / this.pxPerDay) * BasicDateScale.MS_PER_DAY;
	}

	getZoomLevel(): TimelineZoomLevel {
		return this.zoomLevel;
	}

	/**
	 * `fitTo` leaves pxPerDay on an exact fit rather than a preset, so tick
	 * density has to come from the real scale instead of the snapped label.
	 */
	getTickLevel(): TimelineZoomLevel {
		if (this.pxPerDay >= 160) return 'day';
		if (this.pxPerDay >= 48) return 'week';
		if (this.pxPerDay >= 14) return 'month';
		if (this.pxPerDay >= 5) return 'quarter';
		return 'year';
	}

	setZoom(level: TimelineZoomLevel): void {
		this.zoomLevel = level;
		this.pxPerDay = BasicDateScale.ZOOM_PRESETS[level];
	}

	/**
	 * Zoom is continuous. Stepping through presets desynced from the fitted
	 * pxPerDay and made the buttons no-ops at some scales.
	 */
	setPxPerDay(value: number): void {
		this.pxPerDay = Math.min(BasicDateScale.MAX_PX_PER_DAY, Math.max(BasicDateScale.MIN_PX_PER_DAY, value));
		this.zoomLevel = this.getTickLevel();
	}

	canZoom(step: 1 | -1): boolean {
		return step > 0
			? this.pxPerDay < BasicDateScale.MAX_PX_PER_DAY
			: this.pxPerDay > BasicDateScale.MIN_PX_PER_DAY;
	}

	fitTo(items: TimelineItem[], viewportWidth: number): void {
		const datedItems = items.filter((item) => item.startTs != null);
		if (!datedItems.length) return;

		const min = datedItems.reduce((acc, item) => (item.startTs && item.startTs < acc ? item.startTs : acc), Number.POSITIVE_INFINITY);
		const max = datedItems.reduce((acc, item) => {
			const end = item.endTs ?? item.startTs ?? acc;
			return end > acc ? end : acc;
		}, Number.NEGATIVE_INFINITY);

		if (!Number.isFinite(min) || !Number.isFinite(max) || min === Number.POSITIVE_INFINITY || max === Number.NEGATIVE_INFINITY) {
			return;
		}

		const durationDays = Math.max(1, (max - min) / BasicDateScale.MS_PER_DAY);
		// Leading air, so the first bar does not sit flush against the canvas edge
		// and the user can scroll to before the earliest item.
		const padDays = Math.max(1, durationDays * 0.05);
		this.startTs = min - padDays * BasicDateScale.MS_PER_DAY;
		const computed = viewportWidth / (durationDays + padDays * 2);
		this.pxPerDay = Math.min(BasicDateScale.MAX_PX_PER_DAY, Math.max(BasicDateScale.MIN_PX_PER_DAY, computed));
		this.zoomLevel = this.getTickLevel();
		this.startTs = floorToPeriodStart(this.startTs, this.zoomLevel);
	}
}
