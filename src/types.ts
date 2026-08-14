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
	/** 'property' uses startProp/endProp, 'lifespan' uses file ctime/mtime */
	dateSource?: 'property' | 'lifespan';
	zoomLevel: TimelineZoomLevel;
	showWeekends: boolean;
	density: TimelineDensity;
	highContrast: boolean;
	/** Property whose value tints each bar, subject to the global color allowlist. */
	colorProperty?: string;
	/** Checkbox property that marks an item complete. */
	doneProperty?: string;
	showBarProperties: boolean;
	/** Fixed timeline height in pixels; 0 fills the available space. */
	viewportHeight: number;
}

/** Where the timeline was looking, so a reopened view resumes in place. */
export interface TimelineViewportState {
	startTs: number;
	pxPerDay: number;
	scrollLeft: number;
}

/** A property carried onto a bar, already resolved to a Bases value. */
export interface TimelineItemProperty {
	property: string;
	displayName: string;
	value: unknown;
	/** Present only when this property is color-enabled globally. */
	palette?: string[];
}

export interface TimelineItem {
	id: string;
	title: string;
	startTs?: number;
	endTs?: number;
	groupKey?: string;
	/** Resolved from the "Color by" property through the shared color pipeline. */
	color?: string;
	properties?: TimelineItemProperty[];
	/** Set only when a completion property is configured for the view. */
	done?: boolean;
	status?: string;
	assignee?: string;
}
