import {
	App,
	BasesPropertyId,
	BooleanValue,
	DateValue,
	DurationValue,
	FileValue,
	HTMLValue,
	IconValue,
	ImageValue,
	LinkValue,
	ListValue,
	NumberValue,
	Notice,
	TagValue,
	UrlValue,
	Value,
	setIcon,
} from 'obsidian';
import { ColorAssigner, stableColor } from '../table-colors/palettes';
import { getPropertyValueColorOverride } from '../settings/settings';

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export interface PropertyValueRenderContext {
	app: App;
	property: BasesPropertyId;
	displayName?: string;
	valueColorPalette?: string[];
	/**
	 * Set by a view that wants two values never to share a color. Without it,
	 * each value is hashed on its own and a collision is possible.
	 */
	valueColors?: ColorAssigner;
	/** An explicit color for one property's one value wins over the assigner. */
	valueColorOverrides?: Record<string, Record<string, string>>;
	onBooleanChange?: (checked: boolean) => Promise<void>;
}

/**
 * Shared semantic presentation for Bases values. Common values are rendered
 * by Views so a date never inherits an editor-like input surface. Values that
 * need Obsidian's rich renderer keep it inside a constrained adapter.
 */
export function renderPropertyValue(
	container: HTMLElement,
	value: Value,
	context: PropertyValueRenderContext,
): void {
	container.addClass('views-property-value');

	if (value instanceof ListValue) {
		renderList(container, value, context);
		return;
	}
	// A scalar takes its pill on an inner span, not on the container. See
	// `renderValueChip`.
	if (!(value instanceof TagValue) && !isScalarValue(value)) {
		applyPropertyValuePill(container, value, context.valueColorPalette, context.valueColors, context.property, context.property, context.valueColorOverrides);
	}
	if (value instanceof DateValue) {
		renderDate(container, value, context.property);
		return;
	}
	if (value instanceof BooleanValue) {
		renderBoolean(container, value, context);
		return;
	}
	if (value instanceof NumberValue) {
		container.addClass('is-number');
		renderValueChip(container, value, context);
		return;
	}
	if (value instanceof DurationValue) {
		renderIconText(container, 'timer', value.toString(), 'is-duration');
		return;
	}
	if (value instanceof TagValue) {
		renderPill(container, value, context, true);
		return;
	}
	if (isRichValue(value)) {
		container.addClass('is-native');
		value.renderTo(container, context.app.renderContext);
		return;
	}

	container.addClass('is-text');
	renderValueChip(container, value, context);
}

/**
 * Everything that ends up as bare text in a container of the view's own making,
 * rather than in an element Obsidian rendered for it.
 */
function isScalarValue(value: Value): boolean {
	return !(value instanceof DateValue)
		&& !(value instanceof BooleanValue)
		&& !(value instanceof DurationValue)
		&& !(value instanceof TagValue)
		&& !isRichValue(value);
}

/**
 * A tag is its own element inside the cell, so colouring it produces a chip
 * around the text. A scalar has no such element, and colouring the container
 * put the chip on the whole cell, which is stretched by its row and so came out
 * as a slab rather than something that hugs its word.
 *
 * Wrapping the text in a span gives a scalar the structure a tag already has.
 * The native views reached the same conclusion first, in
 * `TableColorEnhancer.ensureValueChip`; this is the matching half for the views
 * the plugin renders itself.
 */
function renderValueChip(container: HTMLElement, value: Value, context: PropertyValueRenderContext): void {
	const chipEl = container.createSpan({ cls: 'views-value-chip', text: value.toString() });
	applyPropertyValuePill(chipEl, value, context.valueColorPalette, context.valueColors, context.property, context.property, context.valueColorOverrides);
}

function renderList(container: HTMLElement, value: ListValue, context: PropertyValueRenderContext): void {
	container.addClass('is-list');
	const tags = isTagProperty(context.property);
	for (let index = 0; index < value.length(); index += 1) {
		renderPill(container, value.get(index), context, tags);
	}
}

function renderPill(
	container: HTMLElement,
	value: Value,
	context: PropertyValueRenderContext,
	tag: boolean,
): void {
	const itemEl = container.createSpan({ cls: 'views-property-item' });
	if (tag || value instanceof TagValue) itemEl.addClass('is-tag');
	applyPropertyValuePill(itemEl, value, context.valueColorPalette, context.valueColors, context.property, context.property, context.valueColorOverrides);
	if (isRichValue(value)) {
		value.renderTo(itemEl, context.app.renderContext);
	} else {
		itemEl.setText(value.toString());
	}
}

/**
 * The pill surface exists only to carry an automatic color. A value with no
 * color keeps Obsidian's plain presentation instead of an empty chip.
 */
export function applyPropertyValuePill(
	element: HTMLElement,
	value: unknown,
	palette: string[] | undefined,
	assigner?: ColorAssigner,
	scope?: string,
	property?: string,
	overrides?: Record<string, Record<string, string>>,
): boolean {
	if (!applyPropertyValueColor(element, value, palette, assigner, scope, property, overrides)) return false;
	element.addClass('views-property-pill');
	return true;
}

/** Apply the shared Collection/Table automatic value-color treatment. */
export function applyPropertyValueColor(
	element: HTMLElement,
	value: unknown,
	palette: string[] | undefined,
	assigner?: ColorAssigner,
	scope?: string,
	property?: string,
	overrides?: Record<string, Record<string, string>>,
): boolean {
	const color = resolvePropertyValueColor(value, palette, assigner, scope, property, overrides);
	if (!color) return false;
	element.addClass('has-value-color');
	element.style.setProperty('--views-property-color', color);
	return true;
}

/**
 * The single value-to-color decision used by every property surface.
 *
 * With an assigner, no two values in the same scope share a color. Without one,
 * each value is hashed on its own, which is the old behaviour and can collide.
 * An explicit override, when `property` and `overrides` are both given, wins
 * unconditionally over the assigner and the palette alike.
 */
export function resolvePropertyValueColor(
	value: unknown,
	palette: string[] | undefined,
	assigner?: ColorAssigner,
	scope?: string,
	property?: string,
	overrides?: Record<string, Record<string, string>>,
): string | null {
	const seed = propertyValueColorSeed(value);
	if (!seed) return null;
	if (property && overrides) {
		const override = getPropertyValueColorOverride(overrides, property, seed);
		if (override) return override;
	}
	if (assigner) return assigner.color(scope ?? '', seed);
	if (!palette?.length) return null;
	return stableColor(seed, palette);
}

/** Preserve the underlying value identity instead of hashing formatted UI text. */
export function propertyValueColorSeed(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
	if (typeof value === 'string') return value.trim();
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Value) return value.toString().trim();
	return String(value).trim();
}

function renderDate(container: HTMLElement, value: DateValue, property: BasesPropertyId): void {
	const raw = value.toString().trim();
	const parsed = parseDate(raw);
	const includesTime = isDateTime(raw, property);
	const text = parsed ? formatDate(parsed, includesTime) : raw;
	renderIconText(container, includesTime ? 'clock-3' : 'calendar-days', text, 'is-date');
	container.setAttr('title', raw);
}

function renderBoolean(
	container: HTMLElement,
	value: BooleanValue,
	context: PropertyValueRenderContext,
): void {
	const checked = value.toString().trim().toLocaleLowerCase() === 'true';
	container.addClass('is-boolean');
	const label = container.createEl('label', { cls: 'views-property-checkbox' });
	const input = label.createEl('input', {
		type: 'checkbox',
		attr: { 'aria-label': context.displayName ?? context.property },
	});
	input.checked = checked;
	input.disabled = !context.onBooleanChange;
	label.createSpan({ cls: 'views-property-value-text', text: checked ? 'Yes' : 'No' });
	input.addEventListener('change', () => {
		if (!context.onBooleanChange) return;
		const next = input.checked;
		container.toggleClass('is-checked', next);
		const text = label.querySelector<HTMLElement>('.views-property-value-text');
		if (text) text.setText(next ? 'Yes' : 'No');
		input.disabled = true;
		void context.onBooleanChange(next).catch(() => {
			input.checked = !next;
			container.toggleClass('is-checked', !next);
			if (text) text.setText(next ? 'No' : 'Yes');
			new Notice(`Unable to update ${context.displayName ?? 'checkbox'}.`);
		}).finally(() => {
			input.disabled = false;
		});
	});
	container.toggleClass('is-checked', checked);
}

/** Built once per icon name, everything after is a clone. Shared by every date and
 * duration cell across Search, Collection and Kanban, which is where the repeated
 * `setIcon` calls (parse + insert an SVG) actually add up. */
const iconTemplateCache = new Map<string, SVGElement>();

function iconTemplate(icon: string): SVGElement | null {
	const cached = iconTemplateCache.get(icon);
	if (cached) return cached;
	const holder = document.createElement('span');
	setIcon(holder, icon);
	const svg = holder.firstElementChild;
	if (!(svg instanceof SVGElement)) return null;
	iconTemplateCache.set(icon, svg);
	return svg;
}

function renderIconText(container: HTMLElement, icon: string, text: string, className: string): void {
	container.addClass(className, 'is-icon-text');
	const iconEl = container.createSpan({ cls: 'views-property-value-icon' });
	const template = iconTemplate(icon);
	if (template) {
		iconEl.appendChild(template.cloneNode(true));
	} else {
		setIcon(iconEl, icon);
	}
	container.createSpan({ cls: 'views-property-value-text', text });
}

function isRichValue(value: Value): boolean {
	return value instanceof LinkValue
		|| value instanceof FileValue
		|| value instanceof UrlValue
		|| value instanceof HTMLValue
		|| value instanceof ImageValue
		|| value instanceof IconValue;
}

function isTagProperty(property: BasesPropertyId): boolean {
	return property === 'note.tags' || property === 'file.tags' || property === 'formula.tags';
}

function isDateTime(raw: string, property: BasesPropertyId): boolean {
	return property === 'file.mtime'
		|| property === 'file.ctime'
		|| /T\d{2}:\d{2}|\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(raw);
}

function parseDate(raw: string): Date | null {
	const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateOnly) {
		const [, year, month, day] = dateOnly;
		return new Date(Number(year), Number(month) - 1, Number(day));
	}
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value: Date, includesTime: boolean): string {
	const currentYear = new Date().getFullYear();
	const includesYear = value.getFullYear() !== currentYear;
	const key = `${includesTime ? 'date-time' : 'date'}:${includesYear ? 'year' : 'current'}`;
	const options: Intl.DateTimeFormatOptions = {
		month: 'short',
		day: 'numeric',
		...(includesYear ? { year: 'numeric' as const } : {}),
		...(includesTime ? { hour: 'numeric' as const, minute: '2-digit' as const } : {}),
	};
	let formatter = dateFormatters.get(key);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(undefined, options);
		dateFormatters.set(key, formatter);
	}
	return formatter.format(value);
}
