import { App, Component, TFile } from 'obsidian';
import type { ViewsPluginSettings } from '../settings/settings';
import { BaseViewTabsController } from './BaseViewTabsController';

const HEADER_SELECTOR = '.bases-header';

export class BaseViewTabsEnhancer extends Component {
	private observer: MutationObserver | null = null;
	private readonly controllers = new Map<HTMLElement, BaseViewTabsController>();
	private readonly resizeCallbacks = new WeakMap<Element, Set<() => void>>();
	private readonly resizeObserver = new ResizeObserver((entries) => {
		for (const entry of entries) {
			for (const callback of this.resizeCallbacks.get(entry.target) ?? []) callback();
		}
	});

	constructor(
		private readonly app: App,
		private readonly getSettings: () => ViewsPluginSettings,
	) {
		super();
	}

	onload(): void {
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (!(file instanceof TFile) || file.extension !== 'base') return;
			for (const controller of this.controllers.values()) controller.scheduleRefresh();
		}));
		this.observer = new MutationObserver((records) => this.handleMutations(records));
		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
		});
		this.refresh();
	}

	onunload(): void {
		this.observer?.disconnect();
		this.observer = null;
		for (const controller of this.controllers.values()) controller.destroy();
		this.controllers.clear();
		this.resizeObserver.disconnect();
	}

	refresh(): void {
		if (!this.getSettings().horizontalViewTabsEnabled || document.body.hasClass('is-phone')) {
			for (const controller of this.controllers.values()) controller.destroy();
			this.controllers.clear();
			return;
		}
		document.querySelectorAll<HTMLElement>(HEADER_SELECTOR).forEach((header) => this.attach(header));
		this.prune();
	}

	private handleMutations(records: MutationRecord[]): void {
		if (!this.getSettings().horizontalViewTabsEnabled || document.body.hasClass('is-phone')) return;
		for (const record of records) {
			for (const node of Array.from(record.addedNodes)) {
				if (!(node instanceof HTMLElement)) continue;
				if (node.matches(HEADER_SELECTOR)) this.attach(node);
				const ownerHeader = node.closest<HTMLElement>(HEADER_SELECTOR);
				if (ownerHeader) this.attach(ownerHeader);
				if (node.matches('.workspace-leaf-content, .view-content, .bases-embed, .block-language-base, .canvas-node-content')) {
					node.querySelectorAll<HTMLElement>(HEADER_SELECTOR).forEach((header) => this.attach(header));
				}
			}
			const target = record.target instanceof Element ? record.target : record.target.parentElement;
			const nativeItem = target?.closest<HTMLElement>('.bases-toolbar-item.bases-toolbar-views-menu');
			const header = nativeItem?.closest<HTMLElement>(HEADER_SELECTOR);
			if (header) this.controllers.get(header)?.scheduleRefresh();
		}
		this.prune();
	}

	private attach(header: HTMLElement): void {
		if (this.controllers.has(header) || !header.isConnected) return;
		const controller = BaseViewTabsController.create(
			this.app,
			header,
			(element, callback) => this.observeResize(element, callback),
			(element, callback) => this.unobserveResize(element, callback),
		);
		if (controller) this.controllers.set(header, controller);
	}

	private prune(): void {
		for (const [header, controller] of this.controllers) {
			if (header.isConnected) continue;
			controller.destroy();
			this.controllers.delete(header);
		}
	}

	private observeResize(element: Element, callback: () => void): void {
		let callbacks = this.resizeCallbacks.get(element);
		if (!callbacks) {
			callbacks = new Set();
			this.resizeCallbacks.set(element, callbacks);
			this.resizeObserver.observe(element);
		}
		callbacks.add(callback);
	}

	private unobserveResize(element: Element, callback: () => void): void {
		const callbacks = this.resizeCallbacks.get(element);
		if (!callbacks) return;
		callbacks.delete(callback);
		if (callbacks.size) return;
		this.resizeCallbacks.delete(element);
		this.resizeObserver.unobserve(element);
	}
}
