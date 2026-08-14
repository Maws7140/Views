import { App, Keymap, Menu, TFile } from 'obsidian';

/**
 * The interaction language every view shares: single click opens, double click
 * opens the file menu, right click opens the same menu, middle click opens in a
 * new tab, Enter and Space open from the keyboard.
 *
 * Lifted out of the Collection view so the Timeline and Kanban behave the same
 * way rather than each growing its own half of it.
 */
export const DOUBLE_CLICK_DELAY_MS = 350;

const INTERACTIVE_SELECTOR = 'button, input, select, textarea, .mbv-scrollbar';

export interface EntryTarget {
	/** The element the interaction resolved to, used to cancel a pending open. */
	el: HTMLElement;
	file: TFile;
}

export interface EntryInteractionOptions {
	/** Resolves an event to the item under it, or null when there is none. */
	resolve: (event: Event) => EntryTarget | null;
	/** Called when the view should ignore an interaction, such as mid-drag. */
	isSuppressed?: () => boolean;
}

export class EntryInteractions {
	private readonly pendingOpens = new Map<HTMLElement, number>();

	constructor(
		private readonly app: App,
		private readonly options: EntryInteractionOptions,
	) {}

	/** Registers every handler on a container. Returns a disposer. */
	attach(containerEl: HTMLElement): () => void {
		const click = (event: MouseEvent) => this.handleClick(event);
		const dblclick = (event: MouseEvent) => this.handleDoubleClick(event);
		const contextmenu = (event: MouseEvent) => this.handleContextMenu(event);
		const auxclick = (event: MouseEvent) => this.handleAuxClick(event);
		const keydown = (event: KeyboardEvent) => this.handleKeyDown(event);
		containerEl.addEventListener('click', click);
		containerEl.addEventListener('dblclick', dblclick);
		containerEl.addEventListener('contextmenu', contextmenu);
		containerEl.addEventListener('auxclick', auxclick);
		containerEl.addEventListener('keydown', keydown);
		return () => {
			this.cancelAll();
			containerEl.removeEventListener('click', click);
			containerEl.removeEventListener('dblclick', dblclick);
			containerEl.removeEventListener('contextmenu', contextmenu);
			containerEl.removeEventListener('auxclick', auxclick);
			containerEl.removeEventListener('keydown', keydown);
		};
	}

	/**
	 * A single click waits, because a double click means the menu rather than
	 * two opens.
	 */
	private handleClick(event: MouseEvent): void {
		const target = this.target(event);
		if (!target || isInteractiveTarget(event)) return;
		this.cancelOpen(target.el);
		if (event.detail > 1) return;
		const timer = window.setTimeout(() => {
			this.pendingOpens.delete(target.el);
			void this.openFile(target.file, Boolean(Keymap.isModEvent(event)));
		}, DOUBLE_CLICK_DELAY_MS);
		this.pendingOpens.set(target.el, timer);
	}

	private handleDoubleClick(event: MouseEvent): void {
		const target = this.target(event);
		if (!target || isInteractiveTarget(event)) return;
		event.preventDefault();
		event.stopPropagation();
		this.cancelOpen(target.el);
		this.showFileMenu(target.file, event);
	}

	private handleContextMenu(event: MouseEvent): void {
		const target = this.target(event);
		if (!target || isInteractiveTarget(event, false)) return;
		event.preventDefault();
		this.cancelOpen(target.el);
		this.showFileMenu(target.file, event);
	}

	private handleAuxClick(event: MouseEvent): void {
		if (event.button !== 1) return;
		const target = this.target(event);
		if (!target) return;
		event.preventDefault();
		void this.openFile(target.file, true);
	}

	private handleKeyDown(event: KeyboardEvent): void {
		const target = this.target(event);
		if (!target || isInteractiveTarget(event) || (event.key !== 'Enter' && event.key !== ' ')) return;
		event.preventDefault();
		void this.openFile(target.file, Boolean(Keymap.isModEvent(event)));
	}

	private target(event: Event): EntryTarget | null {
		if (this.options.isSuppressed?.()) return null;
		return this.options.resolve(event);
	}

	private cancelOpen(el: HTMLElement): void {
		const timer = this.pendingOpens.get(el);
		if (timer === undefined) return;
		window.clearTimeout(timer);
		this.pendingOpens.delete(el);
	}

	private cancelAll(): void {
		for (const timer of this.pendingOpens.values()) window.clearTimeout(timer);
		this.pendingOpens.clear();
	}

	private openFile(file: TFile, newLeaf: boolean): Promise<void> {
		const liveFile = this.app.vault.getAbstractFileByPath(file.path);
		if (!(liveFile instanceof TFile)) return Promise.resolve();
		return this.app.workspace.getLeaf(newLeaf).openFile(liveFile);
	}

	private showFileMenu(file: TFile, event: MouseEvent): void {
		showFileMenu(this.app, file, event);
	}
}

export function isInteractiveTarget(event: Event, includeLinks = true): boolean {
	return event.target instanceof Element
		&& Boolean(event.target.closest(`${includeLinks ? 'a, ' : ''}${INTERACTIVE_SELECTOR}`));
}

/** Obsidian's own file menu, plus the delete item Collection has always added. */
export function showFileMenu(app: App, file: TFile, event: MouseEvent): void {
	const menu = Menu.forEvent(event);
	const menuWithSections = menu as Menu & { addSections?: (sections: string[]) => Menu };
	menuWithSections.addSections?.(['title', 'open', 'action-primary', 'action', 'info', 'view', 'system', '', 'danger']);
	app.workspace.handleLinkContextMenu(menu, file.path, '');
	menu.addItem((item) => item
		.setSection('danger')
		.setTitle('Delete')
		.setIcon('lucide-trash-2')
		.setWarning(true)
		.onClick(() => app.fileManager.promptForDeletion(file)));
}
