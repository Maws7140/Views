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
import { stableColor } from '../table-colors/palettes';

export interface PropertyValueRenderContext {
	app: App;
	property: BasesPropertyId;
	displayName?: string;
	valueColorPalette?: string[];
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
		container.setText(value.toString());
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
	container.setText(value.toString());
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
	const pillEl = container.createSpan({ cls: 'views-property-pill' });
	if (tag || value instanceof TagValue) pillEl.addClass('is-tag');
	const rawValue = value.toString().trim();
	applyPropertyValueColor(pillEl, rawValue, context.valueColorPalette);
	if (isRichValue(value)) {
		value.renderTo(pillEl, context.app.renderContext);
	} else {
		pillEl.setText(value.toString());
	}
}

/** Apply the shared Collection/Table automatic value-color treatment. */
export function applyPropertyValueColor(
	element: HTMLElement,
	rawValue: string,
	palette: string[] | undefined,
): void {
	const color = palette?.length ? stableColor(rawValue, palette) : null;
	if (!color) return;
	element.addClass('has-value-color');
	element.style.setProperty('--views-property-color', color);
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

function renderIconText(container: HTMLElement, icon: string, text: string, className: string): void {
	container.addClass(className, 'is-icon-text');
	setIcon(container.createSpan({ cls: 'views-property-value-icon' }), icon);
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
	const options: Intl.DateTimeFormatOptions = {
		month: 'short',
		day: 'numeric',
		...(value.getFullYear() === currentYear ? {} : { year: 'numeric' as const }),
		...(includesTime ? { hour: 'numeric' as const, minute: '2-digit' as const } : {}),
	};
	return new Intl.DateTimeFormat(undefined, options).format(value);
}
