import { Modal, App, setIcon } from 'obsidian';

// Callback when a date is selected
export interface CalendarPickerCallbacks {
	onDateSelect: (timestamp: number) => void;
}

// Modal that displays a calendar for date selection
export class CalendarPickerModal extends Modal {
	private callbacks: CalendarPickerCallbacks;
	private currentYear: number;
	private currentMonth: number;
	private calendarGridEl: HTMLElement | null = null;

	constructor(app: App, callbacks: CalendarPickerCallbacks, initialDate?: number) {
		super(app);
		this.callbacks = callbacks;
		
		const date = initialDate ? new Date(initialDate) : new Date();
		this.currentYear = date.getFullYear();
		this.currentMonth = date.getMonth();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('tl-calendar-modal');

		// Header with navigation
		const headerEl = contentEl.createDiv({ cls: 'tl-calendar-header' });

		const prevBtn = headerEl.createEl('button', { cls: 'tl-calendar-nav' });
		setIcon(prevBtn, 'lucide-chevron-left');
		prevBtn.setAttr('aria-label', 'Previous month');
		prevBtn.addEventListener('click', () => this.navigateMonth(-1));

		const titleEl = headerEl.createDiv({ cls: 'tl-calendar-title' });
		
		const nextBtn = headerEl.createEl('button', { cls: 'tl-calendar-nav' });
		setIcon(nextBtn, 'lucide-chevron-right');
		nextBtn.setAttr('aria-label', 'Next month');
		nextBtn.addEventListener('click', () => this.navigateMonth(1));

		// Calendar grid container
		this.calendarGridEl = contentEl.createDiv({ cls: 'tl-calendar-grid' });

		// Initial render
		this.renderCalendar();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}

	private navigateMonth(delta: number): void {
		this.currentMonth += delta;
		if (this.currentMonth < 0) {
			this.currentMonth = 11;
			this.currentYear -= 1;
		} else if (this.currentMonth > 11) {
			this.currentMonth = 0;
			this.currentYear += 1;
		}
		this.renderCalendar();
	}

	private renderCalendar(): void {
		if (!this.calendarGridEl) return;

		// Update title
		const titleEl = this.contentEl.querySelector('.tl-calendar-title');
		if (titleEl) {
			const monthName = new Date(this.currentYear, this.currentMonth).toLocaleDateString(undefined, {
				month: 'long',
				year: 'numeric',
			});
			titleEl.setText(monthName);
		}

		// Clear grid
		this.calendarGridEl.empty();

		// Day headers
		const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		for (const dayName of dayNames) {
			const dayHeaderEl = this.calendarGridEl.createDiv({ cls: 'tl-calendar-day-header' });
			dayHeaderEl.setText(dayName);
		}

		// Get first day of month and number of days
		const firstDay = new Date(this.currentYear, this.currentMonth, 1);
		const lastDay = new Date(this.currentYear, this.currentMonth + 1, 0);
		const firstDayOfWeek = firstDay.getDay();
		const daysInMonth = lastDay.getDate();

		// Today for highlighting
		const today = new Date();
		const todayYear = today.getFullYear();
		const todayMonth = today.getMonth();
		const todayDate = today.getDate();

		// Add empty cells for days before first of month
		for (let i = 0; i < firstDayOfWeek; i++) {
			this.calendarGridEl.createDiv({ cls: 'tl-calendar-day tl-calendar-day-empty' });
		}

		// Add days of month
		for (let day = 1; day <= daysInMonth; day++) {
			const dayEl = this.calendarGridEl.createDiv({ cls: 'tl-calendar-day' });
			dayEl.setText(String(day));
			dayEl.setAttr('data-day', String(day));

			// Highlight today
			if (
				this.currentYear === todayYear &&
				this.currentMonth === todayMonth &&
				day === todayDate
			) {
				dayEl.addClass('is-today');
			}

			// Make clickable
			dayEl.addEventListener('click', () => {
				const selectedDate = new Date(this.currentYear, this.currentMonth, day);
				selectedDate.setHours(0, 0, 0, 0);
				this.callbacks.onDateSelect(selectedDate.getTime());
				this.close();
			});
		}
	}
}

