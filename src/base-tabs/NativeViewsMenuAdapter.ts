export interface NativeViewTabModel {
	index: number;
	name: string;
	icon: string;
	active: boolean;
}

const MENU_SELECTOR = '.bases-toolbar-menu.bases-toolbar-views-menu';
const ITEM_SELECTOR = '.suggestion-group[data-group="views"] .bases-toolbar-menu-item';
const PROBE_CLASS = 'views-tabs-is-probing';
let menuQueue: Promise<void> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
	const result = menuQueue.then(task, task);
	menuQueue = result.then(() => undefined, () => undefined);
	return result;
}

export class NativeViewsMenuAdapter {
	constructor(private readonly buttonEl: HTMLElement) {}

	capture(): Promise<NativeViewTabModel[]> {
		return serialized(async () => {
			const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			document.body.addClass(PROBE_CLASS);
			try {
				const menu = await this.openMenu();
				if (!menu) return [];
				const model = this.readModel(menu);
				this.buttonEl.click();
				await this.waitForClose(menu);
				return model;
			} finally {
				document.body.removeClass(PROBE_CLASS);
				if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
			}
		});
	}

	activate(target: NativeViewTabModel): Promise<boolean> {
		return serialized(async () => {
			document.body.addClass(PROBE_CLASS);
			try {
				const menu = await this.openMenu();
				if (!menu) return false;
				const items = this.viewItems(menu);
				let item: HTMLElement | undefined = items[target.index];
				if (!item || this.itemName(item) !== target.name) {
					item = items.find((candidate) =>
						this.itemName(candidate) === target.name && this.itemIcon(candidate) === target.icon,
					);
				}
				if (!item) {
					this.buttonEl.click();
					return false;
				}
				item.click();
				await this.waitForClose(menu);
				return true;
			} finally {
				document.body.removeClass(PROBE_CLASS);
			}
		});
	}

	openVisible(
		onModel: (model: NativeViewTabModel[]) => void,
		onClose: () => void,
	): Promise<boolean> {
		return serialized(async () => {
			const menu = await this.openMenu();
			if (!menu) return false;
			onModel(this.readModel(menu));
			const menuObserver = new MutationObserver(() => onModel(this.readModel(menu)));
			menuObserver.observe(menu, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
			const closeObserver = new MutationObserver(() => {
				if (menu.isConnected) return;
				menuObserver.disconnect();
				closeObserver.disconnect();
				onClose();
			});
			closeObserver.observe(document.body, { childList: true, subtree: true });
			return true;
		});
	}

	private async openMenu(): Promise<HTMLElement | null> {
		if (!this.buttonEl.isConnected) return null;
		const before = new Set(Array.from(document.querySelectorAll<HTMLElement>(MENU_SELECTOR)));
		this.buttonEl.click();
		const immediate = Array.from(document.querySelectorAll<HTMLElement>(MENU_SELECTOR))
			.find((menu) => !before.has(menu));
		if (immediate) return immediate;
		return new Promise((resolve) => {
			let settled = false;
			const finish = (menu: HTMLElement | null): void => {
				if (settled) return;
				settled = true;
				observer.disconnect();
				window.clearTimeout(timeout);
				resolve(menu);
			};
			const observer = new MutationObserver(() => {
				const menu = Array.from(document.querySelectorAll<HTMLElement>(MENU_SELECTOR))
					.find((candidate) => !before.has(candidate));
				if (menu) finish(menu);
			});
			observer.observe(document.body, { childList: true, subtree: true });
			const timeout = window.setTimeout(() => finish(null), 800);
		});
	}

	private waitForClose(menu: HTMLElement): Promise<void> {
		if (!menu.isConnected) return Promise.resolve();
		return new Promise((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				observer.disconnect();
				window.clearTimeout(timeout);
				resolve();
			};
			const observer = new MutationObserver(() => {
				if (!menu.isConnected) finish();
			});
			observer.observe(document.body, { childList: true, subtree: true });
			const timeout = window.setTimeout(finish, 120);
		});
	}

	private readModel(menu: HTMLElement): NativeViewTabModel[] {
		const items = this.viewItems(menu);
		const currentName = this.buttonEl.querySelector<HTMLElement>('.text-button-label')?.textContent?.trim() ?? '';
		const model = items.map((item, index) => ({
			index,
			name: this.itemName(item),
			icon: this.itemIcon(item),
			active: item.hasClass('mod-active'),
		})).filter((item) => item.name);
		if (!model.some((item) => item.active)) {
			const active = model.find((item) => item.name === currentName);
			if (active) active.active = true;
		}
		return model;
	}

	private viewItems(menu: HTMLElement): HTMLElement[] {
		return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
	}

	private itemName(item: HTMLElement): string {
		return item.querySelector<HTMLElement>('.bases-toolbar-menu-item-name')?.textContent?.trim()
			?? item.textContent?.trim()
			?? '';
	}

	private itemIcon(item: HTMLElement): string {
		const icon = item.querySelector<SVGElement>('.bases-toolbar-menu-item-info-icon svg, svg');
		const lucideClass = Array.from(icon?.classList ?? []).find((className) => className.startsWith('lucide-'));
		return lucideClass?.slice('lucide-'.length) ?? 'layout-grid';
	}
}
