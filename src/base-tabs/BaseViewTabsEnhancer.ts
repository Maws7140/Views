import { App, Component, TFile, WorkspaceLeaf } from 'obsidian';
import type { ViewsPluginSettings } from '../settings/settings';
import { BaseViewTabsController } from './BaseViewTabsController';
import {
	EmbeddedBasesController,
	EmbeddedBaseViewTabsHost,
	WorkspaceLeafBaseViewTabsHost,
} from './BaseViewTabsHost';

const HEADER_SELECTOR = '.bases-header';

interface InternalComponent {
	_children?: unknown;
}

interface InternalBaseEmbed extends InternalComponent {
	containerEl?: unknown;
	controller?: unknown;
	file?: unknown;
}

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
		this.app.workspace.onLayoutReady(() => this.refresh());
		this.registerEvent(this.app.workspace.on('layout-change', () => this.refresh()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refresh()));
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
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) this.attachLeaf(leaf);
		this.attachEmbeddedBases();
		this.prune();
	}

	private handleMutations(records: MutationRecord[]): void {
		if (!this.getSettings().horizontalViewTabsEnabled || document.body.hasClass('is-phone')) return;
		for (const record of records) {
			for (const node of Array.from(record.addedNodes)) {
				if (!(node instanceof HTMLElement)) continue;
				if (node.matches(HEADER_SELECTOR) || node.querySelector(HEADER_SELECTOR)) this.refresh();
			}
			const target = record.target instanceof Element ? record.target : record.target.parentElement;
			const nativeItem = target?.closest<HTMLElement>('.bases-toolbar-item.bases-toolbar-views-menu');
			const header = nativeItem?.closest<HTMLElement>(HEADER_SELECTOR);
			if (header) this.controllers.get(header)?.scheduleRefresh();
		}
		this.prune();
	}

	private attachLeaf(leaf: WorkspaceLeaf): void {
		if (leaf.isDeferred) return;
		const leafEl = leaf.view.containerEl.closest<HTMLElement>('.workspace-leaf') ?? leaf.view.containerEl;
		const header = leafEl.querySelector<HTMLElement>(HEADER_SELECTOR);
		if (!header) return;
		if (this.controllers.has(header) || !header.isConnected) return;
		const controller = BaseViewTabsController.create(
			this.app,
			new WorkspaceLeafBaseViewTabsHost(this.app, leaf),
			header,
			(element, callback) => this.observeResize(element, callback),
			(element, callback) => this.unobserveResize(element, callback),
		);
		if (controller) this.controllers.set(header, controller);
	}

	private attachEmbeddedBases(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			for (const component of this.walkComponents(leaf.view)) this.attachEmbeddedBase(component);
		}
	}

	private attachEmbeddedBase(candidate: unknown): void {
		if (!candidate || typeof candidate !== 'object') return;
		const embed = candidate as InternalBaseEmbed;
		if (!(embed.containerEl instanceof HTMLElement) || !embed.containerEl.hasClass('bases-embed')) return;
		if (!(embed.file instanceof TFile) || embed.file.extension !== 'base') return;
		if (!this.isEmbeddedController(embed.controller)) return;
		const header = embed.containerEl.querySelector<HTMLElement>(HEADER_SELECTOR);
		if (!header || !header.isConnected || this.controllers.has(header)) return;
		const controller = BaseViewTabsController.create(
			this.app,
			new EmbeddedBaseViewTabsHost(embed.file, embed.controller),
			header,
			(element, callback) => this.observeResize(element, callback),
			(element, callback) => this.unobserveResize(element, callback),
		);
		if (controller) this.controllers.set(header, controller);
	}

	private *walkComponents(root: unknown): Generator<unknown> {
		const stack = [root];
		const visited = new Set<unknown>();
		while (stack.length) {
			const current = stack.pop();
			if (!current || typeof current !== 'object' || visited.has(current)) continue;
			visited.add(current);
			yield current;
			const children = (current as InternalComponent)._children;
			if (!Array.isArray(children)) continue;
			for (const child of children) stack.push(child);
		}
	}

	private isEmbeddedController(value: unknown): value is EmbeddedBasesController {
		return !!value
			&& typeof value === 'object'
			&& typeof (value as EmbeddedBasesController).selectView === 'function';
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
