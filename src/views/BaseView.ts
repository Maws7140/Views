import type { TimelineItem } from '../types';

// Base interface for all view renderers
export interface ViewRendererData {
	items: TimelineItem[];
	noDateItems?: TimelineItem[];
}

// Callbacks that views can use to communicate with parent
export interface ViewCallbacks {
	openSettings?: () => void;
	onViewChange?: (viewType: string) => void;
}

// Abstract base class for all view types (Timeline, Table, Board, etc.)
export abstract class BaseView {
	protected rootEl: HTMLElement;
	protected callbacks: ViewCallbacks;

	constructor(protected hostEl: HTMLElement, callbacks: ViewCallbacks = {}) {
		this.callbacks = callbacks;
		this.rootEl = this.createDom();
	}

	// Create the DOM structure for this view
	protected abstract createDom(): HTMLElement;

	// Update the view with new data
	abstract updateData(data: ViewRendererData, config: any): void;

	// Render the view
	protected abstract render(): void;

	// Handle resize events
	onResize(): void {
		// Default implementation - override if needed
	}

	// Clean up resources
	destroy(): void {
		this.hostEl.empty();
	}

	// Get the root element
	getRoot(): HTMLElement {
		return this.rootEl;
	}
}

