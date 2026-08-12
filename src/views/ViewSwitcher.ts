import { setIcon } from 'obsidian';
import type { ViewType } from '../types';

// Configuration for each view tab
interface ViewTab {
	type: ViewType;
	label: string;
	icon: string;
}

// Available view types with their display configuration
const VIEW_TABS: ViewTab[] = [
	{ type: 'timeline', label: 'Timeline', icon: 'lucide-chart-gantt' },
	{ type: 'table', label: 'Table / Phase', icon: 'lucide-table' },
	{ type: 'board', label: 'Board / Status', icon: 'lucide-columns' },
	{ type: 'calendar', label: 'Calendar', icon: 'lucide-calendar' },
	{ type: 'team', label: 'Board / Team', icon: 'lucide-users' },
];

// Callback for when a view tab is selected
export interface ViewSwitcherCallbacks {
	onViewChange: (viewType: ViewType) => void;
}

// Component that renders view type tabs
export class ViewSwitcher {
	private rootEl: HTMLElement;
	private activeView: ViewType;
	private callbacks: ViewSwitcherCallbacks;
	private tabElements = new Map<ViewType, HTMLElement>();

	constructor(
		container: HTMLElement,
		initialView: ViewType,
		callbacks: ViewSwitcherCallbacks
	) {
		this.activeView = initialView;
		this.callbacks = callbacks;
		this.rootEl = this.createDom(container);
	}

	private createDom(container: HTMLElement): HTMLElement {
		const tabsEl = container.createDiv({ cls: 'tl-view-tabs' });

		for (const tab of VIEW_TABS) {
			const tabEl = tabsEl.createDiv({
				cls: 'tl-view-tab',
				attr: {
					'data-view-type': tab.type,
					'role': 'tab',
					'aria-label': tab.label,
				},
			});

			const iconEl = tabEl.createDiv({ cls: 'tl-view-tab-icon' });
			setIcon(iconEl, tab.icon);

			const labelEl = tabEl.createDiv({ cls: 'tl-view-tab-label' });
			labelEl.setText(tab.label);

			if (tab.type === this.activeView) {
				tabEl.addClass('is-active');
			}

			// Only timeline is functional for now
			if (tab.type !== 'timeline') {
				tabEl.addClass('is-disabled');
				tabEl.setAttr('title', `${tab.label} (Coming soon)`);
			}

			tabEl.addEventListener('click', () => {
				if (tab.type !== 'timeline') {
					// Other views not yet implemented
					return;
				}
				this.setActiveView(tab.type);
			});

			this.tabElements.set(tab.type, tabEl);
		}

		return tabsEl;
	}

	// Update the active view
	setActiveView(viewType: ViewType): void {
		if (this.activeView === viewType) return;

		// Remove active class from previous tab
		const prevTab = this.tabElements.get(this.activeView);
		if (prevTab) {
			prevTab.removeClass('is-active');
		}

		// Add active class to new tab
		const newTab = this.tabElements.get(viewType);
		if (newTab) {
			newTab.addClass('is-active');
		}

		this.activeView = viewType;
		this.callbacks.onViewChange(viewType);
	}

	// Get current active view
	getActiveView(): ViewType {
		return this.activeView;
	}

	// Clean up
	destroy(): void {
		this.tabElements.clear();
		this.rootEl.empty();
	}
}

