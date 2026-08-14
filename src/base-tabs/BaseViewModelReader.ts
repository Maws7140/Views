import { App, parseYaml, TFile } from 'obsidian';

export interface BaseViewTabModel {
	index: number;
	name: string;
	icon: string;
	active: boolean;
}

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

	async read(file: TFile | null, currentName: string): Promise<BaseViewTabModel[]> {
		if (!(file instanceof TFile) || file.extension !== 'base') return [];
		const source = await this.app.vault.cachedRead(file);
		let views: Array<{ name?: unknown; type?: unknown }> = [];
		try {
			const definition = parseYaml(source) as BaseDefinition | null;
			views = Array.isArray(definition?.views) ? definition.views : [];
		} catch (error) {
			console.warn('[Views] Falling back to structural Base view parsing.', error);
		}
		if (!views.length) views = this.parseViewBlocks(source);
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
	}

	private parseViewBlocks(source: string): Array<{ name: string; type: string }> {
		const views: Array<{ name: string; type: string }> = [];
		let inViews = false;
		let current: { name: string; type: string } | null = null;
		for (const line of source.split(/\r?\n/)) {
			if (/^views:\s*$/.test(line)) {
				inViews = true;
				continue;
			}
			if (!inViews) continue;
			if (/^\S/.test(line)) break;
			const start = line.match(/^\s{2}-\s+type:\s*(.+?)\s*$/);
			if (start) {
				if (current?.name) views.push(current);
				current = { name: '', type: this.unquote(start[1] ?? '') };
				continue;
			}
			const name = line.match(/^\s{4}name:\s*(.+?)\s*$/);
			if (name && current) current.name = this.unquote(name[1] ?? '');
		}
		if (current?.name) views.push(current);
		return views;
	}

	private unquote(value: string): string {
		const trimmed = value.trim();
		if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
			|| (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
			return trimmed.slice(1, -1);
		}
		return trimmed;
	}
}
