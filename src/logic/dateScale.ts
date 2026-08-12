import type { TimelineItem, TimelineZoomLevel } from '../types';

export interface DateScale {
	pxPerDay: number;
	startTs: number;
	toX(ts: number): number;
	fromX(px: number): number;
	setZoom(level: TimelineZoomLevel): void;
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

	setZoom(level: TimelineZoomLevel): void {
		this.zoomLevel = level;
		this.pxPerDay = BasicDateScale.ZOOM_PRESETS[level];
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

		this.startTs = min;
		const durationDays = Math.max(1, (max - min) / BasicDateScale.MS_PER_DAY);
		const computed = viewportWidth / durationDays;
		const clamped = Math.min(BasicDateScale.MAX_PX_PER_DAY, Math.max(BasicDateScale.MIN_PX_PER_DAY, computed));
		this.pxPerDay = clamped;

		// Snap to the nearest preset so zoom controls remain predictable.
		let closestLevel: TimelineZoomLevel = this.zoomLevel;
		let smallestDelta = Number.POSITIVE_INFINITY;
		for (const [level, value] of Object.entries(BasicDateScale.ZOOM_PRESETS) as Array<[TimelineZoomLevel, number]>) {
			const delta = Math.abs(value - clamped);
			if (delta < smallestDelta) {
				smallestDelta = delta;
				closestLevel = level;
			}
		}
		this.zoomLevel = closestLevel;
	}
}
