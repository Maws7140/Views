import { App, parseYaml, TFile } from 'obsidian';
import type { NativeViewTabModel } from './NativeViewsMenuAdapter';

interface BaseDefinition {
	views?: Array<{ name?: unknown; type?: unknown }>;
}

const VIEW_ICONS: Record<string, string> = {
	table: 'table-2',
	cards: 'layout-grid',
	list: 'list',
	map: 'map',
	calendar: 'calendar-days',
	timeline: 'gantt-chart-square',
	'more-bases-timeline': 'gantt-chart-square',
	'more-bases-collection': 'gallery-horizontal-end',
};

export class BaseViewModelReader {
	constructor(private readonly app: App) {}

	async read(headerEl: HTMLElement, currentName: string): Promise<NativeViewTabModel[]> {
		const file = this.fileForHeader(headerEl);
		if (!file || file.extension !== 'base') return [];
		try {
			const definition = parseYaml(await this.app.vault.cachedRead(file)) as BaseDefinition | null;
			const views = Array.isArray(definition?.views) ? definition.views : [];
			return views.flatMap((view, index) => {
				const name = typeof view.name === 'string' ? view.name.trim() : '';
				if (!name) return [];
				const type = typeof view.type === 'string' ? view.type : '';
				return [{
					index,
					name,
					icon: VIEW_ICONS[type] ?? 'panels-top-left',
					active: name === currentName,
				}];
			});
		} catch (error) {
			console.warn('[Views] Could not read Base views without opening the native menu.', error);
			return [];
		}
	}

	private fileForHeader(headerEl: HTMLElement): TFile | null {
		const ownerFile = this.ownerFileForHeader(headerEl);
		if (ownerFile?.extension === 'base') return ownerFile;

		let node: HTMLElement | null = headerEl;
		while (node && node !== document.body) {
			for (const attribute of ['src', 'data-src', 'data-path']) {
				const raw = node.getAttribute(attribute);
				if (!raw) continue;
				const linkpath = raw.replace(/^!\[\[/, '').replace(/\]\]$/, '').split(/[|#]/, 1)[0]?.trim();
				if (!linkpath) continue;
				const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, ownerFile?.path ?? '');
				if (file?.extension === 'base') return file;
			}
			node = node.parentElement;
		}
		return null;
	}

	private ownerFileForHeader(headerEl: HTMLElement): TFile | null {
		const matches: TFile[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (matches.length || !leaf.view.containerEl.contains(headerEl)) return;
			const file = (leaf.view as typeof leaf.view & { file?: TFile }).file;
			if (file instanceof TFile) matches.push(file);
		});
		return matches[0] ?? null;
	}
}
