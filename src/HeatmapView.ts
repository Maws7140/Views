import {
	BasesEntry,
	BasesPropertyId,
	BasesView,
	QueryController,
	TFile,
	ViewOption,
} from 'obsidian';
import { HeatmapRenderer, type HeatmapModel } from './heatmap/HeatmapRenderer';
import {
	ROLLING_PERIOD,
	availablePeriods,
	availableYears,
	bucketByDay,
	buildGrid,
	buildLevels,
	levelFor,
	monthPeriods,
	parseNumbers,
	periodRange,
	periodYear,
	shiftPeriodYear,
	type Aggregation,
	type Granularity,
	type HeatDay,
	type HeatSample,
	type ThresholdMode,
	type WeekStart,
} from './logic/heatBuckets';
import { EntryInteractions, type EntryTarget } from './ui/EntryInteractions';
import { extractTimestamp } from './logic/dateValue';
import { isCssColor } from './table-colors/palettes';

export const HeatmapViewType = 'more-bases-heatmap';

/**
 * GitHub's own ramp. These are the four positive levels; level 0 is the empty
 * cell and takes the theme's background rather than a colour of its own.
 */
const DEFAULT_HEAT_COLORS = ['#0e4429', '#006d32', '#26a641', '#39d353'];

const WEEKDAYS_SUNDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_MONDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export class HeatmapView extends BasesView {
	type = HeatmapViewType;
	private readonly containerEl: HTMLElement;
	private readonly renderer: HeatmapRenderer;
	private readonly filesByPath = new Map<string, TFile>();
	private dateProp: BasesPropertyId | null = null;
	private valueProp: BasesPropertyId | null = null;
	private detachInteractions: (() => void) | null = null;
	/** The period actually on screen, which a fallback can make differ from config. */
	private resolvedPeriod: string = ROLLING_PERIOD;

	constructor(controller: QueryController, scrollEl: HTMLElement) {
		super(controller);
		this.containerEl = scrollEl.createDiv({ cls: 'mbv-heatmap-host' });
		this.renderer = new HeatmapRenderer(this.containerEl, {
			onPeriodChange: (period) => this.config.set('period', period),
			onStepYear: (delta) => this.stepYear(delta),
			describeDay: (day) => this.describeDay(day),
		});
		// Bound here rather than in onload, the same as every other view. Handlers
		// registered in onload never fire.
		this.detachInteractions = new EntryInteractions(this.app, {
			resolve: (event) => this.resolveTarget(event),
		}).attach(this.containerEl);
	}

	onunload(): void {
		this.detachInteractions?.();
		this.renderer.destroy();
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: 'Heatmap',
				type: 'group',
				items: [
					{
						displayName: 'Date property',
						type: 'property',
						key: 'dateProperty',
						filter: () => true,
						placeholder: 'The day a note lands on',
					},
					{
						displayName: 'Value property',
						type: 'property',
						key: 'valueProperty',
						filter: () => true,
						placeholder: 'Number that measures heat',
					},
					{
						displayName: 'Aggregation',
						type: 'dropdown',
						key: 'aggregation',
						default: 'sum',
						options: {
							sum: 'Sum',
							average: 'Average',
							max: 'Maximum',
							min: 'Minimum',
						},
					},
					{
						displayName: 'Period',
						type: 'dropdown',
						key: 'granularity',
						default: 'year',
						options: { year: 'Year', month: 'Month' },
					},
					{
						displayName: 'Week starts on',
						type: 'dropdown',
						key: 'weekStart',
						default: 'sunday',
						options: { sunday: 'Sunday', monday: 'Monday' },
					},
				],
			},
			{
				displayName: 'Heat scale',
				type: 'group',
				items: [
					{
						displayName: 'Heat colors, low to high',
						type: 'multitext',
						key: 'heatColors',
						default: [...DEFAULT_HEAT_COLORS],
					},
					{
						displayName: 'Thresholds from',
						type: 'dropdown',
						key: 'thresholdMode',
						default: 'linear',
						options: {
							linear: 'Equal ranges',
							quantile: 'Equal number of days',
							manual: 'Manual',
						},
					},
					{
						displayName: 'Manual thresholds',
						type: 'multitext',
						key: 'thresholds',
						default: [],
					},
					{
						displayName: 'Show legend',
						type: 'toggle',
						key: 'showLegend',
						default: true,
					},
				],
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [
					{
						displayName: 'Cell size',
						type: 'slider',
						key: 'cellSize',
						default: 11,
						min: 6,
						max: 24,
						step: 1,
						instant: true,
					},
					{
						displayName: 'Cell gap',
						type: 'slider',
						key: 'cellGap',
						default: 3,
						min: 0,
						max: 8,
						step: 1,
						instant: true,
					},
					{
						displayName: 'Show month labels',
						type: 'toggle',
						key: 'showMonthLabels',
						default: true,
					},
					{
						displayName: 'Show weekday labels',
						type: 'toggle',
						key: 'showWeekdayLabels',
						default: true,
					},
					{
						displayName: 'Show total',
						type: 'toggle',
						key: 'showTotal',
						default: true,
					},
				],
			},
		];
	}

	onDataUpdated(): void {
		this.dateProp = this.config.getAsPropertyId('dateProperty');
		this.valueProp = this.config.getAsPropertyId('valueProperty');
		this.renderer.update(this.buildModel());
	}

	/**
	 * One pass over the entries: a date, a number, and a path each. No icon or
	 * property resolution, and the grid itself is bounded at 371 cells, so vault
	 * size does not change the cost of a render.
	 */
	private buildModel(): HeatmapModel {
		this.filesByPath.clear();
		const aggregation = this.aggregation();
		const weekStart: WeekStart = this.config.get('weekStart') === 'monday' ? 'monday' : 'sunday';
		const colors = this.heatColors();
		const valueName = this.valueProp ? this.config.getDisplayName(this.valueProp) : 'value';

		const samples: HeatSample[] = [];
		let datedEntries = 0;
		for (const entry of this.data?.data ?? []) {
			const ts = extractTimestamp(entry, this.dateProp);
			if (ts === null) continue;
			datedEntries += 1;
			const value = this.numericValue(entry);
			if (value === null) continue;
			this.filesByPath.set(entry.file.path, entry.file);
			samples.push({ ts, value, path: entry.file.path });
		}

		const days = bucketByDay(samples, aggregation);
		const years = availableYears(days);
		const granularity = this.granularity();
		const shownYear = granularity === 'month' ? this.shownYear(years) : null;
		const periods = shownYear === null ? availablePeriods(days) : monthPeriods(shownYear);
		const activePeriod = this.activePeriod(periods, days, shownYear);
		this.resolvedPeriod = activePeriod;
		const range = periodRange(activePeriod, Date.now());

		// Levels are computed from the visible window, so switching year rescales
		// the ramp to that year rather than to an outlier in a different one.
		const visible = new Map<string, HeatDay>();
		for (const [key, day] of days) {
			if (day.ts >= range.from && day.ts <= range.to) visible.set(key, day);
		}
		const levels = buildLevels(
			[...visible.values()].map((day) => day.total),
			colors,
			this.thresholdMode(),
			parseNumbers(this.config.get('thresholds')),
		);
		for (const day of visible.values()) day.level = levelFor(day.total, levels);

		return {
			grid: buildGrid(range.from, range.to, visible, weekStart),
			days: visible,
			levels,
			periods,
			activePeriod,
			stepper: shownYear === null ? null : {
				label: String(shownYear),
				canStepBack: years.length > 0 && shownYear > years[years.length - 1],
				canStepForward: years.length > 0 && shownYear < years[0],
			},
			total: [...visible.values()].reduce((sum, day) => sum + day.total, 0),
			valueName,
			notice: this.notice(datedEntries, samples.length),
			cellSize: this.numberOption('cellSize', 11),
			cellGap: this.numberOption('cellGap', 3),
			weekdayLabels: weekStart === 'monday' ? WEEKDAYS_MONDAY : WEEKDAYS_SUNDAY,
			showMonthLabels: this.config.get('showMonthLabels') !== false,
			showWeekdayLabels: this.config.get('showWeekdayLabels') !== false,
			showLegend: this.config.get('showLegend') !== false,
			showTotal: this.config.get('showTotal') !== false,
		};
	}

	/**
	 * The heat is a number property by design, so every way of not having one
	 * gets its own sentence instead of an empty grid the user has to explain.
	 */
	private notice(datedEntries: number, sampleCount: number): string {
		if (!this.dateProp) return 'Set a date property to build the heatmap.';
		if (!this.valueProp) return 'Set a number property to measure heat.';
		if (!this.heatColors().length) return 'Add at least one heat color.';
		const dateName = this.config.getDisplayName(this.dateProp);
		const valueName = this.config.getDisplayName(this.valueProp);
		if (!datedEntries) return `No dates found in ${dateName}.`;
		if (!sampleCount) return `No numeric values found in ${valueName}.`;
		return '';
	}

	/**
	 * A stored period the current granularity does not offer falls back: to
	 * rolling in year granularity, and in month granularity to the last month of
	 * the shown year that holds anything, so switching to Month lands on data
	 * rather than on an empty December.
	 */
	private activePeriod(periods: string[], days: Map<string, HeatDay>, shownYear: number | null): string {
		const stored = this.config.get('period');
		if (typeof stored === 'string' && periods.includes(stored)) return stored;
		if (shownYear === null) return ROLLING_PERIOD;

		let latest = 0;
		for (const day of days.values()) {
			const date = new Date(day.ts);
			if (date.getFullYear() === shownYear) latest = Math.max(latest, date.getMonth());
		}
		return periods[latest];
	}

	/**
	 * The year the month buttons belong to. It rides along in the stored period
	 * rather than in a key of its own, so there is one source of truth and the
	 * two can never disagree about which year is on screen.
	 */
	private shownYear(years: number[]): number {
		const stored = this.config.get('period');
		const year = typeof stored === 'string' ? periodYear(stored) : null;
		if (year !== null) return year;
		return years.length ? years[0] : new Date().getFullYear();
	}

	/**
	 * Keeps the selected month and moves the year, which is what the arrows mean.
	 * It steps the period the user can actually see, not the stored one, so the
	 * first press after a fallback moves from the month on screen.
	 */
	private stepYear(delta: number): void {
		this.config.set('period', shiftPeriodYear(this.resolvedPeriod, delta));
	}

	private granularity(): Granularity {
		return this.config.get('granularity') === 'month' ? 'month' : 'year';
	}

	private aggregation(): Aggregation {
		const value = this.config.get('aggregation');
		return value === 'average' || value === 'max' || value === 'min' ? value : 'sum';
	}

	private thresholdMode(): ThresholdMode {
		const value = this.config.get('thresholdMode');
		return value === 'quantile' || value === 'manual' ? value : 'linear';
	}

	/** Only valid CSS colors count, so a typo cannot silently blank a level. */
	private heatColors(): string[] {
		const configured = this.config.get('heatColors');
		const values = Array.isArray(configured)
			? configured
				.map((value) => (typeof value === 'string' ? value.trim() : ''))
				.filter((value) => value && isCssColor(value))
			: [];
		return values.length ? values : [...DEFAULT_HEAT_COLORS];
	}

	/**
	 * A boolean counts as one so a checkbox property can drive a streak grid,
	 * which is the closest thing to GitHub's own "did something today".
	 */
	private numericValue(entry: BasesEntry): number | null {
		if (!this.valueProp) return null;
		let raw: unknown;
		try {
			raw = entry.getValue(this.valueProp);
		} catch {
			return null;
		}
		if (raw === null || raw === undefined) return null;
		if (typeof raw === 'boolean') return raw ? 1 : 0;
		if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

		const text = raw.toString().trim();
		if (!text) return null;
		if (text === 'true') return 1;
		if (text === 'false') return 0;
		const parsed = Number(text.replace(/,/g, ''));
		return Number.isFinite(parsed) ? parsed : null;
	}

	private numberOption(key: string, fallback: number): number {
		const value = this.config.get(key);
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		const parsed = typeof value === 'string' ? Number(value) : NaN;
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	private describeDay(day: HeatDay): string[] {
		return day.paths.map((path) => this.filesByPath.get(path)?.basename ?? path);
	}

	/**
	 * A cell resolves to one file: the day's first note in the view's native sort
	 * order. The tooltip names it, so what a click opens is never a guess.
	 */
	private resolveTarget(event: Event): EntryTarget | null {
		const target = event.target instanceof Element
			? event.target.closest<HTMLElement>('.mbv-heat-cell')
			: null;
		const path = target?.dataset.path;
		const file = path ? this.filesByPath.get(path) : null;
		return target && file ? { el: target, file } : null;
	}
}
