export type TimelineZoomLevel = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type TimelineDensity = 'comfortable' | 'compact';

export type ViewType = 'timeline' | 'table' | 'board' | 'calendar' | 'team';

export interface BaseViewConfig {
	viewType: ViewType;
}

export interface TimelineConfig extends BaseViewConfig {
	viewType: 'timeline';
	startProp: string;
	endProp?: string;
	groupBy?: string;
	/** 'property' uses startProp/endProp, 'lifespan' uses file ctime/mtime */
	dateSource?: 'property' | 'lifespan';
	zoomLevel: TimelineZoomLevel;
	showWeekends: boolean;
	density: TimelineDensity;
	highContrast: boolean;
}

export interface TimelineItem {
	id: string;
	title: string;
	startTs?: number;
	endTs?: number;
	groupKey?: string;
	status?: string;
	assignee?: string;
}
