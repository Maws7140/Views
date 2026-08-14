import { App, Menu, setIcon } from 'obsidian';
import { BaseViewModelReader, BaseViewTabModel } from './BaseViewModelReader';
import type { BaseViewTabsHost } from './BaseViewTabsHost';

const NATIVE_ITEM_SELECTOR = '.bases-toolbar-item.bases-toolbar-views-menu';

export class BaseViewTabsController {
	private readonly toolbarEl: HTMLElement;
	private readonly nativeItemEl: HTMLElement | null;
	private readonly tabsEl: HTMLElement;
	private readonly modelReader: BaseViewModelReader;
	private model: BaseViewTabModel[] = [];
	private tabButtons: HTMLButtonElement[] = [];
	private hiddenViewIndexes = new Set<number>();
	private moreButton: HTMLButtonElement | null = null;
	private refreshTimer: number | null = null;
	private layoutFrame: number | null = null;
	private activating = false;
	private disposed = false;

	static create(
		app: App,
		host: BaseViewTabsHost,
		headerEl: HTMLElement,
		observeResize: (element: Element, callback: () => void) => void,
		unobserveResize: (element: Element, callback: () => void) => void,
	): BaseViewTabsController | null {
		const toolbarEl = headerEl.querySelector<HTMLElement>('.bases-toolbar');
		const nativeItemEl = headerEl.querySelector<HTMLElement>(NATIVE_ITEM_SELECTOR);
		if (!toolbarEl) return null;
		return new BaseViewTabsController(
			app,
			host,
			headerEl,
			toolbarEl,
			nativeItemEl,
			observeResize,
			unobserveResize,
		);
	}

	private constructor(
		private readonly app: App,
		private readonly host: BaseViewTabsHost,
		readonly headerEl: HTMLElement,
		toolbarEl: HTMLElement,
		nativeItemEl: HTMLElement | null,
		private readonly observeResize: (element: Element, callback: () => void) => void,
		private readonly unobserveResize: (element: Element, callback: () => void) => void,
	) {
		this.toolbarEl = toolbarEl;
		this.nativeItemEl = nativeItemEl;
		const nativeButtonEl = nativeItemEl?.querySelector<HTMLElement>('.text-icon-button');
		nativeButtonEl?.setAttr('aria-label', 'Manage Base views');
		nativeButtonEl?.setAttr('title', 'Manage Base views');
		this.modelReader = new BaseViewModelReader(app);
		this.tabsEl = document.createElement('div');
		this.tabsEl.className = 'views-view-tabs';
		this.tabsEl.setAttribute('role', 'tablist');
		this.tabsEl.setAttribute('aria-label', 'Base views');
		this.tabsEl.hidden = true;
		toolbarEl.insertBefore(this.tabsEl, nativeItemEl ?? toolbarEl.firstChild);
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
		if (this.disposed || !this.toolbarEl.isConnected) return;
		const model = await this.modelReader.read(
			this.host.getFile(),
			this.host.getCurrentViewName(),
		);
		if (this.disposed || !this.headerEl.isConnected) return;
		if (!model.length) {
			this.disableEnhancement();
			return;
		}
		this.render(model);
	}

	private render(model: BaseViewTabModel[]): void {
		this.model = model;
		this.tabsEl.empty();
		this.tabButtons = model.map((view, index) => this.createTab(view, index));
		this.moreButton = this.tabsEl.createEl('button', {
			cls: 'views-view-tabs-more',
			text: 'More…',
			attr: { type: 'button', 'aria-label': 'Show more Base views' },
		});
		this.moreButton.addEventListener('click', (event) => this.openOverflowMenu(event));
		this.tabsEl.hidden = false;
		this.headerEl.addClass('views-tabs-enabled');
		this.scheduleLayout();
	}

	private createTab(view: BaseViewTabModel, index: number): HTMLButtonElement {
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
			if (!view.active && !this.activating) void this.activate(view);
		});
		button.addEventListener('keydown', (event) => this.handleKeyDown(event, index));
		return button;
	}

	private async activate(view: BaseViewTabModel): Promise<void> {
		if (this.activating) return;
		this.activating = true;
		this.tabsEl.setAttr('aria-busy', 'true');
		try {
			await this.host.selectView(view.name);
			this.scheduleRefresh();
		} catch (error) {
			console.error('[Views] Could not switch Base view.', error);
		} finally {
			this.activating = false;
			this.tabsEl.removeAttribute('aria-busy');
		}
	}

	private openOverflowMenu(event: MouseEvent): void {
		const hiddenViews = this.model
			.map((view, index) => ({ view, index }))
			.filter(({ index }) => this.hiddenViewIndexes.has(index));
		if (!hiddenViews.length) return;
		const menu = new Menu();
		for (const { view, index } of hiddenViews) {
			menu.addItem((item) => item
				.setTitle(view.name)
				.setIcon(view.icon)
				.setChecked(view.active)
				.onClick(() => {
					if (!view.active && this.tabButtons[index] && !this.activating) void this.activate(view);
				}));
		}
		menu.showAtMouseEvent(event);
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
			this.hiddenViewIndexes.clear();
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
		this.hiddenViewIndexes = new Set(this.model.map((_, index) => index).filter((index) => !visible.has(index)));
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
