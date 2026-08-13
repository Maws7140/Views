import { setIcon } from 'obsidian';
import { NativeViewTabModel, NativeViewsMenuAdapter } from './NativeViewsMenuAdapter';

const NATIVE_ITEM_SELECTOR = '.bases-toolbar-item.bases-toolbar-views-menu';
const NATIVE_BUTTON_SELECTOR = `${NATIVE_ITEM_SELECTOR} .text-icon-button`;

export class BaseViewTabsController {
	private readonly toolbarEl: HTMLElement;
	private readonly nativeItemEl: HTMLElement;
	private readonly nativeButtonEl: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly adapter: NativeViewsMenuAdapter;
	private model: NativeViewTabModel[] = [];
	private tabButtons: HTMLButtonElement[] = [];
	private moreButton: HTMLButtonElement | null = null;
	private refreshTimer: number | null = null;
	private layoutFrame: number | null = null;
	private disposed = false;

	static create(
		headerEl: HTMLElement,
		observeResize: (element: Element, callback: () => void) => void,
		unobserveResize: (element: Element, callback: () => void) => void,
	): BaseViewTabsController | null {
		const toolbarEl = headerEl.querySelector<HTMLElement>('.bases-toolbar');
		const nativeItemEl = headerEl.querySelector<HTMLElement>(NATIVE_ITEM_SELECTOR);
		const nativeButtonEl = headerEl.querySelector<HTMLElement>(NATIVE_BUTTON_SELECTOR);
		if (!toolbarEl || !nativeItemEl || !nativeButtonEl) return null;
		return new BaseViewTabsController(
			headerEl,
			toolbarEl,
			nativeItemEl,
			nativeButtonEl,
			observeResize,
			unobserveResize,
		);
	}

	private constructor(
		readonly headerEl: HTMLElement,
		toolbarEl: HTMLElement,
		nativeItemEl: HTMLElement,
		nativeButtonEl: HTMLElement,
		private readonly observeResize: (element: Element, callback: () => void) => void,
		private readonly unobserveResize: (element: Element, callback: () => void) => void,
	) {
		this.toolbarEl = toolbarEl;
		this.nativeItemEl = nativeItemEl;
		this.nativeButtonEl = nativeButtonEl;
		this.adapter = new NativeViewsMenuAdapter(nativeButtonEl);
		this.tabsEl = document.createElement('div');
		this.tabsEl.className = 'views-view-tabs';
		this.tabsEl.setAttribute('role', 'tablist');
		this.tabsEl.setAttribute('aria-label', 'Base views');
		this.tabsEl.hidden = true;
		toolbarEl.insertBefore(this.tabsEl, nativeItemEl);
		this.observeResize(toolbarEl, this.scheduleLayout);
		void this.refresh();
	}

	scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer !== null) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 80);
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		if (this.layoutFrame !== null) window.cancelAnimationFrame(this.layoutFrame);
		this.unobserveResize(this.toolbarEl, this.scheduleLayout);
		this.headerEl.removeClass('views-tabs-enabled');
		this.tabsEl.remove();
	}

	private async refresh(): Promise<void> {
		if (this.disposed || !this.nativeButtonEl.isConnected) return;
		const model = await this.adapter.capture();
		if (this.disposed || !this.headerEl.isConnected) return;
		if (!model.length) {
			this.disableEnhancement();
			return;
		}
		this.render(model);
	}

	private render(model: NativeViewTabModel[]): void {
		this.model = model;
		this.tabsEl.empty();
		this.tabButtons = model.map((view, index) => this.createTab(view, index));
		this.moreButton = this.tabsEl.createEl('button', {
			cls: 'views-view-tabs-more',
			text: 'More…',
			attr: { type: 'button', 'aria-label': 'Manage Base views' },
		});
		this.moreButton.addEventListener('click', () => this.openManager());
		this.tabsEl.hidden = false;
		this.headerEl.addClass('views-tabs-enabled');
		this.scheduleLayout();
	}

	private createTab(view: NativeViewTabModel, index: number): HTMLButtonElement {
		const button = this.tabsEl.createEl('button', {
			cls: `views-view-tab${view.active ? ' is-active' : ''}`,
			attr: {
				type: 'button',
				role: 'tab',
				'aria-selected': view.active ? 'true' : 'false',
				'aria-label': view.name,
				title: view.name,
				tabindex: view.active ? '0' : '-1',
			},
		});
		setIcon(button.createSpan({ cls: 'views-view-tab-icon' }), view.icon);
		button.createSpan({ cls: 'views-view-tab-label', text: view.name });
		button.addEventListener('click', () => {
			if (view.active) this.openManager();
			else void this.activate(view, button);
		});
		button.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.openManager();
		});
		button.addEventListener('keydown', (event) => this.handleKeyDown(event, index));
		return button;
	}

	private async activate(view: NativeViewTabModel, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		const activated = await this.adapter.activate(view);
		if (!activated) {
			button.disabled = false;
			this.disableEnhancement();
			return;
		}
		window.setTimeout(() => this.scheduleRefresh(), 100);
	}

	private openManager(): void {
		void this.adapter.openVisible(
			(model) => {
				if (model.length) this.render(model);
			},
			() => this.scheduleRefresh(),
		).then((opened) => {
			if (!opened) this.disableEnhancement();
		});
	}

	private handleKeyDown(event: KeyboardEvent, index: number): void {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		const visible = this.tabButtons
			.map((button, buttonIndex) => ({ button, buttonIndex }))
			.filter(({ button }) => !button.hidden);
		if (!visible.length) return;
		const current = visible.findIndex((item) => item.buttonIndex === index);
		let next = current;
		if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = visible.length - 1;
		else {
			const rtl = window.getComputedStyle(this.tabsEl).direction === 'rtl';
			const forward = event.key === 'ArrowRight' ? !rtl : rtl;
			next = (current + (forward ? 1 : -1) + visible.length) % visible.length;
		}
		event.preventDefault();
		visible[next]?.button.focus();
	}

	private readonly scheduleLayout = (): void => {
		if (this.disposed || this.layoutFrame !== null) return;
		this.layoutFrame = window.requestAnimationFrame(() => {
			this.layoutFrame = null;
			this.layoutTabs();
		});
	};

	private layoutTabs(): void {
		if (!this.model.length || !this.moreButton || !this.tabsEl.isConnected) return;
		for (const button of this.tabButtons) button.hidden = false;
		this.moreButton.hidden = false;
		this.moreButton.setText(`${this.model.length} more…`);
		const available = this.tabsEl.clientWidth;
		if (available <= 0) return;
		const widths = this.tabButtons.map((button) => Math.ceil(button.getBoundingClientRect().width));
		const gap = Number.parseFloat(window.getComputedStyle(this.tabsEl).columnGap) || 0;
		const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
		if (total <= available) {
			this.moreButton.hidden = true;
			return;
		}

		const moreWidth = Math.ceil(this.moreButton.getBoundingClientRect().width);
		const budget = Math.max(0, available - moreWidth - gap);
		const visible = new Set<number>();
		let used = 0;
		for (let index = 0; index < widths.length; index += 1) {
			const required = widths[index] + (visible.size ? gap : 0);
			if (used + required > budget) break;
			visible.add(index);
			used += required;
		}
		const activeIndex = this.model.findIndex((view) => view.active);
		if (activeIndex >= 0 && !visible.has(activeIndex)) {
			while (visible.size) {
				const visibleItems = Array.from(visible);
				const last = visibleItems[visibleItems.length - 1];
				if (last === undefined) break;
				visible.delete(last);
				const visibleWidth = Array.from(visible).reduce((sum, item) => sum + widths[item], 0)
					+ gap * Math.max(0, visible.size - 1);
				if (visibleWidth + (visible.size ? gap : 0) + widths[activeIndex] <= budget) break;
			}
			visible.add(activeIndex);
		}
		if (!visible.size && activeIndex >= 0) visible.add(activeIndex);
		this.tabButtons.forEach((button, index) => { button.hidden = !visible.has(index); });
		const hiddenCount = this.model.length - visible.size;
		this.moreButton.hidden = hiddenCount <= 0;
		this.moreButton.setText(`${hiddenCount} more…`);
		this.moreButton.setAttr('aria-label', `${hiddenCount} more Base views`);
	}

	private disableEnhancement(): void {
		this.headerEl.removeClass('views-tabs-enabled');
		this.tabsEl.hidden = true;
	}
}
