import {
	BasesEntry,
	BasesPropertyId,
	BasesView,
	BooleanValue,
	ListValue,
	QueryController,
	TFile,
	Value,
	ViewOption,
} from 'obsidian';
import { CalendarRenderer, type CalendarModel } from './calendar/CalendarRenderer';
import {
	bucketSamples,
	buildMonth,
	monthKey,
	parseMonthKey,
	shiftMonth,
	type CalendarSample,
	type ValueReading,
} from './logic/calendarGrid';
import type { WeekStart } from './logic/heatBuckets';
import { EntryInteractions, type EntryTarget } from './ui/EntryInteractions';
import { extractTimestamp } from './logic/dateValue';
import { ColorAssigner, isCssColor, parseCustomPalette, resolveColorPalette } from './table-colors/palettes';
import { isPropertyColorEnabled } from './settings/settings';
import { propertyValueColorSeed, renderPropertyValue } from './ui/PropertyValueRenderer';
import type ViewsPlugin from './main';

export const CalendarViewType = 'more-bases-calendar';

/** Light to deep, so a low day stays legible under the day number. */
const DEFAULT_RAMP = ['#e2ddfb', '#bcb0f7', '#8e7cf0', '#5b47d6'];

const WEEKDAYS_SUNDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_MONDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export class CalendarView extends BasesView {
	type = CalendarViewType;
	private readonly containerEl: HTMLElement;
	private readonly renderer: CalendarRenderer;
	private readonly entriesByPath = new Map<string, BasesEntry>();
	private dateProp: BasesPropertyId | null = null;
	private colorProp: BasesPropertyId | null = null;
	/** View-local, so selecting a day does not write to the base file. */
	private selectedKey: string | null = null;
	/**
	 * One assigner for the whole view, rebuilt per data update. The grid and the
	 * detail panel share it, so a value is the same colour as a dot and as a pill
	 * rather than each surface deciding for itself.
	 */
	private colors: ColorAssigner | null = null;
	private detachInteractions: (() => void) | null = null;

	constructor(
		private readonly plugin: ViewsPlugin,
		controller: QueryController,
		scrollEl: HTMLElement,
	) {
		super(controller);
		this.containerEl = scrollEl.createDiv({ cls: 'mbv-calendar-host' });
		this.renderer = new CalendarRenderer(this.containerEl, {
			onStepMonth: (delta) => this.stepMonth(delta),
			onToday: () => this.goToToday(),
			onSelectDay: (key) => this.selectDay(key),
			renderEntry: (containerEl, path) => this.renderEntryProperties(containerEl, path),
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
				displayName: 'Calendar',
				type: 'group',
				items: [
					{
						displayName: 'Date property',
						type: 'property',
						filter: () => true,
						key: 'dateProperty',
						placeholder: 'The day a note lands on',
					},
					{
						displayName: 'Week starts on',
						type: 'dropdown',
						key: 'weekStart',
						default: 'sunday',
						options: { sunday: 'Sunday', monday: 'Monday' },
					},
					{
						displayName: 'Show week numbers',
						type: 'toggle',
						key: 'showWeekNumbers',
						default: false,
					},
				],
			},
			{
				displayName: 'Day markers',
				type: 'group',
				items: [
					{
						displayName: 'Color property',
						type: 'property',
						filter: () => true,
						key: 'colorProperty',
						placeholder: 'What the markers describe',
					},
					{
						displayName: 'Show day markers',
						type: 'toggle',
						key: 'showMarkers',
						default: true,
					},
					{
						displayName: 'Number colors, low to high',
						type: 'multitext',
						key: 'rampColors',
						default: [...DEFAULT_RAMP],
					},
					{
						displayName: 'Markers per day',
						type: 'slider',
						key: 'maxMarkers',
						default: 4,
						min: 1,
						max: 8,
						step: 1,
						instant: true,
					},
				],
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [
					{
						displayName: 'Show detail panel',
						type: 'toggle',
						key: 'showDetail',
						default: true,
					},
					{
						displayName: 'Day size',
						type: 'slider',
						key: 'cellSize',
						default: 56,
						min: 32,
						max: 120,
						step: 4,
						instant: true,
					},
					{
						displayName: 'Color property values',
						type: 'toggle',
						key: 'propertyValueColors',
						default: true,
					},
				],
			},
		];
	}

	onDataUpdated(): void {
		this.dateProp = this.config.getAsPropertyId('dateProperty');
		this.colorProp = this.config.getAsPropertyId('colorProperty');
		const palette = this.valuePalette();
		this.colors = palette ? new ColorAssigner(palette) : null;
		this.renderer.update(this.buildModel());
	}

	private buildModel(): CalendarModel {
		this.entriesByPath.clear();
		const weekStart: WeekStart = this.config.get('weekStart') === 'monday' ? 'monday' : 'sunday';
		const { year, month } = this.visibleMonth();

		const samples: CalendarSample[] = [];
		for (const entry of this.data?.data ?? []) {
			const ts = extractTimestamp(entry, this.dateProp);
			if (ts === null) continue;
			this.entriesByPath.set(entry.file.path, entry);
			samples.push({
				ts,
				path: entry.file.path,
				title: entry.file.basename,
				readings: this.readings(entry),
			});
		}

		const rampColors = this.rampColors();
		const built = buildMonth(year, month, bucketSamples(samples), weekStart, {
			colors: this.colors,
			// The dots and this property's pills answer to one scope, which is what
			// keeps them the same colour.
			scope: this.colorProp ?? '',
			rampColors,
			maxMarkers: this.numberOption('maxMarkers', 4),
		});

		const first = new Date(year, month, 1);
		return {
			month: built,
			monthLabel: first.toLocaleDateString(undefined, { month: 'long' }),
			yearLabel: String(year),
			weekdayLabels: weekStart === 'monday' ? WEEKDAYS_MONDAY : WEEKDAYS_SUNDAY,
			showWeekNumbers: this.config.get('showWeekNumbers') === true,
			showMarkers: this.config.get('showMarkers') !== false,
			showDetail: this.config.get('showDetail') !== false,
			rampColors,
			selectedKey: this.selectedKey,
			notice: this.notice(samples.length),
			cellSize: this.numberOption('cellSize', 56),
		};
	}

	private notice(sampleCount: number): string {
		if (!this.dateProp) return 'Set a date property to build the calendar.';
		if (!sampleCount) return `No dates found in ${this.config.getDisplayName(this.dateProp)}.`;
		return '';
	}

	/**
	 * Every value of the color property, in order. A list yields one reading per
	 * item, so a note tagged twice contributes two markers rather than one that
	 * names only its first value.
	 */
	private readings(entry: BasesEntry): ValueReading[] {
		if (!this.colorProp) return [];
		let raw: Value | null | undefined;
		try {
			raw = entry.getValue(this.colorProp);
		} catch {
			// A renamed or stale property must not take the view down.
			return [];
		}
		if (raw === null || raw === undefined) return [];

		if (raw instanceof ListValue) {
			const readings: ValueReading[] = [];
			for (let index = 0; index < raw.length(); index += 1) {
				const reading = this.reading(raw.get(index));
				if (reading) readings.push(reading);
			}
			return readings;
		}

		const reading = this.reading(raw);
		return reading ? [reading] : [];
	}

	/**
	 * One value, read three ways at once. The kind is decided later across every
	 * value in the month, so a single reading commits to nothing: it just says
	 * what it could be.
	 */
	private reading(value: unknown): ValueReading | null {
		if (value === null || value === undefined) return null;
		const label = value.toString().trim();
		if (!label) return null;

		const boolean = this.asBoolean(value, label);
		return {
			seed: propertyValueColorSeed(value) || label,
			label,
			// A checkbox is never also a number. Letting it be both would let one
			// true value tip a whole month into the numeric ramp.
			number: boolean === null ? asNumber(label) : null,
			boolean,
		};
	}

	private asBoolean(value: unknown, label: string): boolean | null {
		if (value instanceof BooleanValue || typeof value === 'boolean') {
			return label.toLocaleLowerCase() === 'true';
		}
		const text = label.toLocaleLowerCase();
		if (text === 'true') return true;
		if (text === 'false') return false;
		return null;
	}

	/** One property cell per configured property, the same list every view reads. */
	private renderEntryProperties(containerEl: HTMLElement, path: string): void {
		const entry = this.entriesByPath.get(path);
		if (!entry) return;
		const palette = this.valuePalette();
		for (const property of this.config.getOrder()) {
			const value = entry.getValue(property);
			if (value === null || value === undefined) continue;
			if (!value.toString().trim()) continue;
			const valueEl = containerEl.createDiv({ cls: 'mbv-cal-prop' });
			renderPropertyValue(valueEl, value, {
				app: this.app,
				property,
				displayName: this.config.getDisplayName(property),
				valueColorPalette: palette && isPropertyColorEnabled(this.plugin.settings, property)
					? palette
					: undefined,
				valueColors: isPropertyColorEnabled(this.plugin.settings, property)
					? this.colors ?? undefined
					: undefined,
			});
		}
	}

	/**
	 * The month on screen rides in the view's config, the way the Heatmap's period
	 * does, so reopening a base lands where it was left. The day selection does
	 * not, because it is a glance rather than a setting.
	 */
	private visibleMonth(): { year: number; month: number } {
		const stored = parseMonthKey(this.config.get('month'));
		if (stored) return stored;
		const now = new Date();
		return { year: now.getFullYear(), month: now.getMonth() };
	}

	private stepMonth(delta: number): void {
		const { year, month } = this.visibleMonth();
		const next = shiftMonth(year, month, delta);
		this.selectedKey = null;
		this.config.set('month', monthKey(next.year, next.month));
	}

	private goToToday(): void {
		const now = new Date();
		this.selectedKey = null;
		this.config.set('month', monthKey(now.getFullYear(), now.getMonth()));
	}

	private selectDay(key: string | null): void {
		this.selectedKey = key;
		this.renderer.update(this.buildModel());
	}

	/** Only valid CSS colors count, so a typo cannot silently blank a stop. */
	private rampColors(): string[] {
		const configured = this.config.get('rampColors');
		const values = Array.isArray(configured)
			? configured
				.map((value) => (typeof value === 'string' ? value.trim() : ''))
				.filter((value) => value && isCssColor(value))
			: [];
		return values.length ? values : [...DEFAULT_RAMP];
	}

	private valuePalette(): string[] | undefined {
		if (this.config.get('propertyValueColors') === false) return undefined;
		if (!this.plugin.settings.tableColorsEnabled) return undefined;
		return resolveColorPalette(
			this.plugin.settings.colorPack,
			parseCustomPalette(this.plugin.settings.customPalette),
		);
	}

	private numberOption(key: string, fallback: number): number {
		const value = this.config.get(key);
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		const parsed = typeof value === 'string' ? Number(value) : NaN;
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	/**
	 * A detail row resolves to its own note. A day cell only resolves while the
	 * panel is hidden, which is the one case where the cell is the way in.
	 */
	private resolveTarget(event: Event): EntryTarget | null {
		const target = event.target instanceof Element
			? event.target.closest<HTMLElement>('.mbv-cal-detail-item, .mbv-cal-day')
			: null;
		const path = target?.dataset.path;
		const file = path ? this.entriesByPath.get(path)?.file : null;
		return target && file instanceof TFile ? { el: target, file } : null;
	}
}

/**
 * A number the property actually states. Thousands separators are stripped
 * because a formula or a typed number renders them, but "3 apples" is text and
 * stays text rather than being read as a 3.
 */
function asNumber(label: string): number | null {
	const parsed = Number(label.replace(/,/g, ''));
	return Number.isFinite(parsed) ? parsed : null;
}
