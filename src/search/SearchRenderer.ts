import { setIcon } from 'obsidian';
import { isInteractiveTarget } from '../ui/EntryInteractions';

// This view was called Raycast before it was renamed to Search. The DOM class
// prefix stays `mbv-ray-*`: renaming it touches roughly 40 selectors in
// styles.css for no user-visible gain and risks a missed one.

export interface SearchRow {
	path: string;
	title: string;
	subtitle: string;
	/** Everything the query is matched against, lowercased once when built. */
	searchText: string;
}

export interface SearchGroup {
	key: string;
	rows: SearchRow[];
}

export interface SearchModel {
	groups: SearchGroup[];
	showGroupHeadings: boolean;
	/** Nothing but the search field until something is typed. */
	launcher: boolean;
	showProperties: boolean;
	/** One grid column per property, so every row's values line up. */
	propertyCount: number;
	density: 'comfortable' | 'compact';
	placeholder: string;
	/** Why the result list is empty when the base itself returned nothing. */
	emptyNotice: string;
	/** 0 means off: every filtered row renders, same as before pagination existed. */
	pageSize: number;
}

export interface SearchCallbacks {
	open(path: string, newLeaf: boolean): void;
	create(name: string): void;
	copyLink(path: string): void;
	reveal(path: string): void;
	menu(path: string, anchor: HTMLElement): void;
	renderProperties(containerEl: HTMLElement, path: string): void;
}

const EMPTY_MODEL: SearchModel = {
	groups: [],
	showGroupHeadings: false,
	launcher: false,
	showProperties: true,
	propertyCount: 0,
	density: 'comfortable',
	placeholder: 'Search',
	emptyNotice: '',
	pageSize: 0,
};

/**
 * The search field is created once and never rebuilt, only the results below it
 * are. A field replaced mid-render loses focus and caret position, which in a
 * view whose entire premise is typing would be felt on every keystroke.
 */
export class SearchRenderer {
	private readonly rootEl: HTMLElement;
	private readonly inputEl: HTMLInputElement;
	private readonly resultsEl: HTMLElement;
	private readonly paginationEl: HTMLElement;
	private readonly footerEl: HTMLElement;
	private model: SearchModel = EMPTY_MODEL;
	private query = '';
	/** Rows currently on screen, in the order the arrows walk them. Holds the
	 * current page, not the whole filtered set, so End and the selection never
	 * point at a row that is not drawn. */
	private visible: SearchRow[] = [];
	private selected = 0;
	private page = 0;
	private lastFilteredTotal = 0;
	private readonly rowEls = new Map<string, HTMLElement>();

	constructor(containerEl: HTMLElement, private readonly callbacks: SearchCallbacks) {
		this.rootEl = containerEl.createDiv({ cls: 'mbv-ray' });
		const searchEl = this.rootEl.createDiv({ cls: 'mbv-ray-search' });
		setIcon(searchEl.createSpan({ cls: 'mbv-ray-search-icon' }), 'lucide-search');
		this.inputEl = searchEl.createEl('input', {
			cls: 'mbv-ray-input',
			attr: { type: 'text', placeholder: 'Search', spellcheck: 'false' },
		});
		this.resultsEl = this.rootEl.createDiv({ cls: 'mbv-ray-results' });
		this.paginationEl = this.rootEl.createDiv({ cls: 'mbv-ray-pagination' });
		this.footerEl = this.rootEl.createDiv({ cls: 'mbv-ray-footer' });
		this.renderFooter();
		this.inputEl.addEventListener('input', () => {
			this.query = this.inputEl.value;
			this.selected = 0;
			this.page = 0;
			this.renderResults();
		});
		this.inputEl.addEventListener('keydown', (event) => this.handleKey(event));
		this.resultsEl.addEventListener('click', (event) => {
			if (isInteractiveTarget(event)) return;
			const rowEl = event.target instanceof Element ? event.target.closest<HTMLElement>('.mbv-ray-row') : null;
			const path = rowEl?.dataset.path;
			if (!path) return;
			this.select(this.visible.findIndex((row) => row.path === path));
			this.callbacks.open(path, event.metaKey || event.ctrlKey);
		});
		this.resultsEl.addEventListener('contextmenu', (event) => {
			const rowEl = event.target instanceof Element ? event.target.closest<HTMLElement>('.mbv-ray-row') : null;
			if (!rowEl?.dataset.path) return;
			event.preventDefault();
			this.callbacks.menu(rowEl.dataset.path, rowEl);
		});
	}

	update(model: SearchModel): void {
		this.model = model;
		this.inputEl.placeholder = model.placeholder;
		// The column count drives the grid, and every row is a subgrid of it, so a
		// property occupies the same column in every row rather than sitting
		// wherever its own row's text happened to end.
		this.resultsEl.style.setProperty('--mbv-ray-columns', String(model.showProperties ? model.propertyCount : 0));
		this.rootEl.toggleClass('is-compact', model.density === 'compact');
		this.renderResults();
	}

	focusSearch(): void {
		this.inputEl.focus();
	}

	destroy(): void {
		this.rootEl.remove();
	}

	private handleKey(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				// The field holds focus for the life of the view, so paging past the
				// last row of a page is the only gesture available for "next page".
				if (this.selected >= this.visible.length - 1 && this.goToPage(this.page + 1)) return;
				this.select(this.selected + 1);
				return;
			case 'ArrowUp':
				event.preventDefault();
				this.select(this.selected - 1);
				return;
			case 'PageDown':
				event.preventDefault();
				this.goToPage(this.page + 1);
				return;
			case 'PageUp':
				event.preventDefault();
				this.goToPage(this.page - 1);
				return;
			case 'Home':
				if (!this.visible.length) return;
				event.preventDefault();
				this.select(0);
				return;
			case 'End':
				if (!this.visible.length) return;
				event.preventDefault();
				this.select(this.visible.length - 1);
				return;
			case 'Enter': {
				event.preventDefault();
				// Alt+Enter creates whatever was typed, so it is the one action that
				// works with no result under the cursor.
				if (event.altKey) {
					const name = this.query.trim();
					if (name) this.callbacks.create(name);
					return;
				}
				const current = this.visible[this.selected];
				if (current) this.callbacks.open(current.path, event.shiftKey);
				return;
			}
			case 'Escape':
				if (!this.query) return;
				event.preventDefault();
				this.setQuery('');
				return;
			default:
				break;
		}
		// The field holds focus for the life of the view, so a bare letter is a
		// letter. Alt keeps the spec's E/C/R reachable mid-word.
		if (!event.altKey) return;
		const current = this.visible[this.selected];
		if (!current) return;
		const rowEl = this.rowEls.get(current.path);
		switch (event.key.toLowerCase()) {
			case 'e':
				if (!rowEl) return;
				event.preventDefault();
				this.callbacks.menu(current.path, rowEl);
				return;
			case 'c':
				event.preventDefault();
				this.callbacks.copyLink(current.path);
				return;
			case 'r':
				event.preventDefault();
				this.callbacks.reveal(current.path);
				return;
			default:
				break;
		}
	}

	private setQuery(value: string): void {
		this.query = value;
		this.inputEl.value = value;
		this.selected = 0;
		this.page = 0;
		this.renderResults();
	}

	/** Returns false at either end, so a caller can fall back to its own edge behavior. */
	private goToPage(page: number): boolean {
		if (this.model.pageSize <= 0) return false;
		const pageCount = Math.max(1, Math.ceil(this.lastFilteredTotal / this.model.pageSize));
		const clamped = Math.max(0, Math.min(page, pageCount - 1));
		if (clamped === this.page) return false;
		this.page = clamped;
		this.selected = 0;
		this.renderResults();
		return true;
	}

	private select(index: number): void {
		if (!this.visible.length) return;
		this.selected = Math.max(0, Math.min(index, this.visible.length - 1));
		this.paintSelection();
	}

	private paintSelection(): void {
		const current = this.visible[this.selected];
		for (const [path, rowEl] of this.rowEls) {
			rowEl.toggleClass('is-selected', path === current?.path);
		}
		if (!current) return;
		this.rowEls.get(current.path)?.scrollIntoView({ block: 'nearest' });
	}

	private renderResults(): void {
		this.resultsEl.empty();
		this.rowEls.clear();
		this.visible = [];
		const query = this.query.trim().toLowerCase();

		// Launcher mode is a state, not a layout: the results are withheld until
		// there is a query, and everything else about the view is unchanged.
		if (this.model.launcher && !query) {
			this.renderNotice('Type to search');
			this.renderPagination(0, 0, 0);
			this.renderFooter();
			return;
		}

		// Filtered first, across every group, so paging counts and slices
		// exactly what the row list is about to show.
		const filteredGroups: SearchGroup[] = [];
		let total = 0;
		for (const group of this.model.groups) {
			const rows = query
				? group.rows.filter((row) => row.searchText.includes(query))
				: group.rows;
			if (!rows.length) continue;
			filteredGroups.push({ key: group.key, rows });
			total += rows.length;
		}
		this.lastFilteredTotal = total;

		const pageSize = this.model.pageSize;
		const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
		if (this.page > pageCount - 1) this.page = pageCount - 1;
		const start = pageSize > 0 ? this.page * pageSize : 0;
		const end = pageSize > 0 ? start + pageSize : total;

		// Everything the base handed over, within the page, is rendered. How many
		// rows the base returned in total is the base's own limit to state; a
		// second cap here only slices what pagination itself asked for.
		let index = 0;
		for (const group of filteredGroups) {
			const groupStart = index;
			index += group.rows.length;
			if (index <= start || groupStart >= end) continue;
			const pageRows = group.rows.slice(Math.max(0, start - groupStart), Math.min(group.rows.length, end - groupStart));
			if (!pageRows.length) continue;
			if (this.model.showGroupHeadings) {
				this.resultsEl.createDiv({ cls: 'mbv-ray-group', text: group.key || 'Ungrouped' });
			}
			for (const row of pageRows) this.renderRow(row);
			this.visible.push(...pageRows);
		}

		if (!total) {
			this.renderNotice(query
				? `No result for "${this.query.trim()}"`
				: this.model.emptyNotice || 'Nothing to show');
		}
		this.paintSelection();
		this.renderPagination(start, total, pageSize);
		this.renderFooter();
	}

	private renderPagination(start: number, total: number, pageSize: number): void {
		this.paginationEl.empty();
		this.paginationEl.toggleClass('is-visible', pageSize > 0 && total > 0);
		if (pageSize <= 0 || !total) return;
		const shown = Math.min(pageSize, total - start);
		this.paginationEl.createSpan({
			cls: 'mbv-ray-page-count',
			text: `${start + 1} to ${start + shown} of ${total}`,
		});
		const navEl = this.paginationEl.createDiv({ cls: 'mbv-ray-page-nav' });
		const prevEl = navEl.createEl('button', { cls: 'mbv-ray-page-btn', text: 'Prev' });
		prevEl.disabled = this.page <= 0;
		prevEl.addEventListener('click', () => this.goToPage(this.page - 1));
		const nextEl = navEl.createEl('button', { cls: 'mbv-ray-page-btn', text: 'Next' });
		nextEl.disabled = start + shown >= total;
		nextEl.addEventListener('click', () => this.goToPage(this.page + 1));
	}

	private renderRow(row: SearchRow): void {
		const rowEl = this.resultsEl.createDiv({ cls: 'mbv-ray-row' });
		rowEl.dataset.path = row.path;
		const mainEl = rowEl.createDiv({ cls: 'mbv-ray-row-main' });
		mainEl.createSpan({ cls: 'mbv-ray-title', text: row.title });
		if (row.subtitle) mainEl.createSpan({ cls: 'mbv-ray-subtitle', text: row.subtitle });
		// The cells go straight into the row: a wrapper around them would be one
		// grid item and the columns inside it would be its own, not the list's.
		if (this.model.showProperties) this.callbacks.renderProperties(rowEl, row.path);
		this.rowEls.set(row.path, rowEl);
	}

	private renderNotice(text: string): void {
		this.resultsEl.createDiv({ cls: 'mbv-ray-notice', text });
	}

	/** The keyboard language is only useful if it is written down where it is used. */
	private renderFooter(): void {
		this.footerEl.empty();
		const hints: [string, string][] = [
			['↑ ↓', 'navigate'],
			['↵', 'open'],
			['⇧ ↵', 'new pane'],
			['alt ↵', 'create'],
			['alt E', 'actions'],
			['alt C', 'copy link'],
			['alt R', 'reveal'],
		];
		for (const [keys, label] of hints) {
			const hintEl = this.footerEl.createSpan({ cls: 'mbv-ray-hint' });
			hintEl.createSpan({ cls: 'mbv-ray-key', text: keys });
			hintEl.createSpan({ cls: 'mbv-ray-hint-label', text: label });
		}
	}
}
