import { setIcon } from 'obsidian';
import { isInteractiveTarget } from '../ui/EntryInteractions';
import { reportPerformance } from '../performance/metrics';

// This view was called Raycast before it was renamed to Search. The DOM class
// prefix stays `mbv-ray-*`: renaming it touches roughly 40 selectors in
// styles.css for no user-visible gain and risks a missed one.

export interface SearchRow {
	path: string;
	/** Position within this render, `${groupIndex}:${rowIndex}:${path}`. A file
	 * that belongs to two groups (a list property grouping) produces two rows
	 * with the same path, so DOM identity and selection have to key on this
	 * instead of the path alone. */
	key: string;
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
	/** Pagination turned itself on because the base is large and the user never
	 * touched the setting. Surfaced in the pagination bar so it is not mysterious. */
	autoPaginated: boolean;
	/** Everything that changes the resolved width of a property column: the
	 * property set, density, whether values are shown, whether colors are on.
	 * Column measurement is re-run only when this changes, never on scroll or
	 * paging. */
	columnSignature: string;
}

export interface SearchCallbacks {
	open(path: string, newLeaf: boolean): void;
	create(name: string): void;
	copyLink(path: string): void;
	reveal(path: string): void;
	menu(path: string, anchor: HTMLElement): void;
	/** Returns true when the row has a list-valued property, so the caller can
	 * mark the row without the style engine tracking a `:has()` invalidation on
	 * every row subtree. */
	renderProperties(containerEl: HTMLElement, path: string): boolean;
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
	autoPaginated: false,
	columnSignature: '',
};

/** Below this many rows on one page, everything renders synchronously in one
 * pass, same as before progressive rendering existed. At or above it, a
 * bounded sample renders immediately and the rest streams in behind a
 * frame-budgeted queue, pulled forward by an IntersectionObserver sentinel. */
const LARGE_RESULT_THRESHOLD = 200;
/** Rows (or headings) rendered synchronously before the queue takes over. */
const INITIAL_SYNC_ITEMS = 60;
const ROWS_PER_FRAME = 24;
const FRAME_BUDGET_MS = 8;
/** Real debounce, not a per-frame scheduler: a keystroke should not pay for a
 * DOM rebuild until typing actually pauses. */
const INPUT_DEBOUNCE_MS = 120;

type RenderItem =
	| { kind: 'heading'; text: string; continued: boolean }
	| { kind: 'row'; row: SearchRow };

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
	 * point at a row that is not drawn. Populated in full even while progressive
	 * rendering has not built the DOM for every one of them yet. */
	private visible: SearchRow[] = [];
	private selected = 0;
	private selectedKey: string | null = null;
	private page = 0;
	/** Absolute index of the first row on the current page. The anchor, not the
	 * page number, is what survives a page-size change: re-deriving `page` from
	 * it after `pageSize` changes keeps the user near the rows they were on. */
	private anchorIndex = 0;
	private lastFilteredTotal = 0;
	private readonly rowEls = new Map<string, HTMLElement>();

	/** Incremental refine: when the new query extends the previous one, the new
	 * result set is a subset of it, so filtering the previous filtered groups
	 * costs O(surviving rows) instead of O(all rows). Invalidated on every data
	 * update ( `update()` clears it), never on typing alone. */
	private lastQuery = '';
	private lastFilteredGroups: SearchGroup[] = [];
	private filterDebounceTimer: number | null = null;

	/** Bumped on every render so a queued or observed callback from a previous
	 * render can recognise itself as stale and do nothing. */
	private renderGeneration = 0;
	private pendingItems: RenderItem[] = [];
	private pendingIndex = 0;
	private pendingGeneration = 0;
	private queueFrame: number | null = null;
	private queueObserver: IntersectionObserver | null = null;
	private sentinelEl: HTMLElement | null = null;

	private readonly resizeObserver: ResizeObserver;
	private measuredSignature = '';
	private measuredWidth = 0;
	private measureFrame: number | null = null;

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
			this.selectedKey = null;
			this.page = 0;
			this.anchorIndex = 0;
			this.scheduleFilter();
		});
		// Bound to the root, not the field: clicking Prev/Next or a row moves
		// focus off the input, and the view's entire keyboard language depends on
		// a keydown listener that still fires from wherever focus lands.
		this.rootEl.addEventListener('keydown', (event) => this.handleKey(event));
		this.resultsEl.addEventListener('click', (event) => {
			if (isInteractiveTarget(event)) return;
			const rowEl = event.target instanceof Element ? event.target.closest<HTMLElement>('.mbv-ray-row') : null;
			const key = rowEl?.dataset.key;
			if (!key) return;
			const index = this.visible.findIndex((row) => row.key === key);
			if (index < 0) return;
			this.select(index);
			this.callbacks.open(this.visible[index].path, event.metaKey || event.ctrlKey);
		});
		this.resultsEl.addEventListener('contextmenu', (event) => {
			const rowEl = event.target instanceof Element ? event.target.closest<HTMLElement>('.mbv-ray-row') : null;
			if (!rowEl?.dataset.path) return;
			event.preventDefault();
			this.callbacks.menu(rowEl.dataset.path, rowEl);
		});
		this.resizeObserver = new ResizeObserver(() => {
			if (Math.abs(this.resultsEl.clientWidth - this.measuredWidth) > 1) this.measureAndFreezeColumns();
		});
		this.resizeObserver.observe(this.resultsEl);
	}

	update(model: SearchModel): void {
		this.model = model;
		this.inputEl.placeholder = model.placeholder;
		// The column count drives the grid, and every row is a subgrid of it, so a
		// property occupies the same column in every row rather than sitting
		// wherever its own row's text happened to end.
		this.resultsEl.style.setProperty('--mbv-ray-columns', String(model.showProperties ? model.propertyCount : 0));
		this.rootEl.toggleClass('is-compact', model.density === 'compact');
		// A data refresh means the group contents may no longer match whatever the
		// incremental filter cache holds, so it is invalidated here and rebuilt on
		// the next `renderResults`, not carried forward from before this update.
		this.lastQuery = '';
		this.lastFilteredGroups = [];
		this.renderResults();
		if (model.columnSignature !== this.measuredSignature
			|| Math.abs(this.resultsEl.clientWidth - this.measuredWidth) > 1) {
			this.measureAndFreezeColumns();
		}
	}

	focusSearch(): void {
		this.inputEl.focus();
	}

	destroy(): void {
		if (this.filterDebounceTimer !== null) window.clearTimeout(this.filterDebounceTimer);
		this.cancelPendingRowQueue();
		if (this.measureFrame !== null) window.cancelAnimationFrame(this.measureFrame);
		this.resizeObserver.disconnect();
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
				// Mirrors ArrowDown: walking up off the first row of a page pages
				// backwards and lands on the last row of what is now on screen, so
				// the user can retrace their own path instead of hitting a wall.
				if (this.selected <= 0 && this.goToPage(this.page - 1, 'last')) return;
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
		const rowEl = this.rowEls.get(current.key);
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
		if (this.filterDebounceTimer !== null) {
			window.clearTimeout(this.filterDebounceTimer);
			this.filterDebounceTimer = null;
		}
		this.query = value;
		this.inputEl.value = value;
		this.selected = 0;
		this.selectedKey = null;
		this.page = 0;
		this.anchorIndex = 0;
		this.renderResults();
	}

	private scheduleFilter(): void {
		if (this.filterDebounceTimer !== null) window.clearTimeout(this.filterDebounceTimer);
		this.filterDebounceTimer = window.setTimeout(() => {
			this.filterDebounceTimer = null;
			this.renderResults();
		}, INPUT_DEBOUNCE_MS);
	}

	/** Returns false at either end, so a caller can fall back to its own edge
	 * behavior. `landOn` places the selection after the new page renders: 'last'
	 * is what lets ArrowUp retrace its way back across a page boundary. */
	private goToPage(page: number, landOn: 'first' | 'last' = 'first'): boolean {
		if (this.model.pageSize <= 0) return false;
		const pageSize = this.model.pageSize;
		const pageCount = Math.max(1, Math.ceil(this.lastFilteredTotal / pageSize));
		const clamped = Math.max(0, Math.min(page, pageCount - 1));
		if (clamped === this.page) return false;
		this.anchorIndex = clamped * pageSize;
		this.renderResults();
		// Incidental collapse-to-zero from emptying the container is not
		// guaranteed once rows are appended progressively instead of destroyed
		// wholesale, so the reset is explicit.
		this.resultsEl.scrollTop = 0;
		this.selected = landOn === 'last' ? Math.max(0, this.visible.length - 1) : 0;
		const row = this.visible[this.selected];
		if (row) this.ensureRendered(row.key);
		this.selectedKey = row?.key ?? null;
		this.paintSelection();
		// A click on Prev/Next moved focus onto the button; without this the
		// keyboard is dead until the user clicks back into the field.
		this.inputEl.focus();
		return true;
	}

	private select(index: number): void {
		if (!this.visible.length) return;
		this.selected = Math.max(0, Math.min(index, this.visible.length - 1));
		const row = this.visible[this.selected];
		if (row) this.ensureRendered(row.key);
		this.selectedKey = row?.key ?? null;
		this.paintSelection();
	}

	private paintSelection(): void {
		const current = this.visible[this.selected];
		for (const [key, rowEl] of this.rowEls) {
			rowEl.toggleClass('is-selected', key === current?.key);
		}
		if (!current) return;
		const rowEl = this.rowEls.get(current.key);
		if (!rowEl) return;
		// `scrollIntoView` walks up and scrolls every scrollable ancestor, not
		// just the nearest one, which shoves the whole Bases pane. Scrolling
		// `resultsEl` directly, and only when the row is actually out of view,
		// keeps the motion inside the list and skips two forced layouts per key.
		const rowTop = rowEl.offsetTop;
		const rowBottom = rowTop + rowEl.offsetHeight;
		const viewTop = this.resultsEl.scrollTop;
		const viewBottom = viewTop + this.resultsEl.clientHeight;
		if (rowTop < viewTop) this.resultsEl.scrollTop = rowTop;
		else if (rowBottom > viewBottom) this.resultsEl.scrollTop = rowBottom - this.resultsEl.clientHeight;
	}

	private renderResults(): void {
		const startedAt = performance.now();
		this.resultsEl.empty();
		this.rowEls.clear();
		this.visible = [];
		this.renderGeneration += 1;
		this.cancelPendingRowQueue();
		const query = this.query.trim().toLowerCase();

		// Launcher mode is a state, not a layout: the results are withheld until
		// there is a query, and everything else about the view is unchanged.
		if (this.model.launcher && !query) {
			this.renderNotice('Type to search');
			this.renderPagination(0, 0, 0);
			this.renderFooter();
			this.lastQuery = '';
			this.lastFilteredGroups = [];
			reportPerformance('search render', startedAt, { rows: 0 });
			return;
		}

		// Filtered first, across every group, so paging counts and slices
		// exactly what the row list is about to show. When the new query extends
		// the previous one, refining the previous filtered groups instead of the
		// full model turns this from O(all rows) into O(surviving rows).
		const source = query && this.lastQuery && query.startsWith(this.lastQuery)
			? this.lastFilteredGroups
			: this.model.groups;
		const filteredGroups: SearchGroup[] = [];
		let total = 0;
		for (const group of source) {
			const rows = query
				? group.rows.filter((row) => row.searchText.includes(query))
				: group.rows;
			if (!rows.length) continue;
			filteredGroups.push({ key: group.key, rows });
			total += rows.length;
		}
		this.lastQuery = query;
		this.lastFilteredGroups = filteredGroups;
		this.lastFilteredTotal = total;

		const pageSize = this.model.pageSize;
		const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
		// The anchor, not the page index, is the source of truth (A2): re-deriving
		// `page` from it here is what keeps the visible rows roughly put when
		// `pageSize` changes out from under an unrelated page index.
		this.page = pageSize > 0 ? Math.max(0, Math.min(Math.floor(this.anchorIndex / pageSize), pageCount - 1)) : 0;
		this.anchorIndex = this.page * pageSize;
		const start = pageSize > 0 ? this.page * pageSize : 0;
		const end = pageSize > 0 ? start + pageSize : total;

		// Everything the base handed over, within the page, is rendered. How many
		// rows the base returned in total is the base's own limit to state; a
		// second cap here only slices what pagination itself asked for.
		const items: RenderItem[] = [];
		let index = 0;
		for (const group of filteredGroups) {
			const groupStart = index;
			index += group.rows.length;
			if (index <= start || groupStart >= end) continue;
			const pageRows = group.rows.slice(Math.max(0, start - groupStart), Math.min(group.rows.length, end - groupStart));
			if (!pageRows.length) continue;
			if (this.model.showGroupHeadings) {
				const continued = Math.max(0, start - groupStart) > 0;
				items.push({ kind: 'heading', text: group.key || 'Ungrouped', continued });
			}
			for (const row of pageRows) items.push({ kind: 'row', row });
			this.visible.push(...pageRows);
		}

		if (!total) {
			this.renderNotice(query
				? `No result for "${this.query.trim()}"`
				: this.model.emptyNotice || 'Nothing to show');
		} else if (items.length >= LARGE_RESULT_THRESHOLD) {
			const synchronousCount = Math.min(items.length, INITIAL_SYNC_ITEMS);
			this.renderItemsRange(items, 0, synchronousCount);
			if (synchronousCount < items.length) this.queueRemainingItems(items, synchronousCount, this.renderGeneration);
		} else {
			this.renderItemsRange(items, 0, items.length);
		}

		// Re-resolve the selection by the row's own identity rather than its slot:
		// a data refresh, a filter change or a page change all rebuild `visible`,
		// and a stale numeric index would silently highlight a different note.
		if (this.selectedKey) {
			const resolved = this.visible.findIndex((row) => row.key === this.selectedKey);
			this.selected = resolved >= 0 ? resolved : 0;
		} else {
			this.selected = 0;
		}
		this.selectedKey = this.visible[this.selected]?.key ?? null;
		const selectedRow = this.visible[this.selected];
		if (selectedRow) this.ensureRendered(selectedRow.key);
		this.paintSelection();
		this.renderPagination(start, total, pageSize);
		this.renderFooter();
		reportPerformance('search render', startedAt, { rows: this.visible.length, groups: filteredGroups.length });
	}

	private renderPagination(start: number, total: number, pageSize: number): void {
		this.paginationEl.empty();
		this.paginationEl.toggleClass('is-visible', pageSize > 0 && total > 0);
		if (pageSize <= 0 || !total) return;
		const shown = Math.min(pageSize, total - start);
		const pageCount = Math.max(1, Math.ceil(total / pageSize));
		const infoEl = this.paginationEl.createDiv({ cls: 'mbv-ray-page-info' });
		infoEl.createSpan({
			cls: 'mbv-ray-page-count',
			text: `${start + 1} to ${start + shown} of ${total}`,
		});
		infoEl.createSpan({
			cls: 'mbv-ray-page-position',
			text: `Page ${this.page + 1} of ${pageCount}`,
		});
		if (this.model.autoPaginated) {
			infoEl.createSpan({ cls: 'mbv-ray-page-auto', text: 'Paginated automatically' });
		}
		const navEl = this.paginationEl.createDiv({ cls: 'mbv-ray-page-nav' });
		const atStart = this.page <= 0;
		const atEnd = start + shown >= total;
		const firstEl = this.createPageButton(navEl, 'First');
		firstEl.disabled = atStart;
		firstEl.addEventListener('click', () => this.goToPage(0));
		const prevEl = this.createPageButton(navEl, 'Prev');
		prevEl.disabled = atStart;
		prevEl.addEventListener('click', () => this.goToPage(this.page - 1));
		const nextEl = this.createPageButton(navEl, 'Next');
		nextEl.disabled = atEnd;
		nextEl.addEventListener('click', () => this.goToPage(this.page + 1));
		const lastEl = this.createPageButton(navEl, 'Last');
		lastEl.disabled = atEnd;
		lastEl.addEventListener('click', () => this.goToPage(pageCount - 1));
	}

	/** `type="button"` keeps a stray Enter from resubmitting anything, and
	 * `tabindex="-1"` keeps Tab from walking into the bar and stranding focus
	 * off the search field, the same way a click already can. */
	private createPageButton(parentEl: HTMLElement, text: string): HTMLButtonElement {
		return parentEl.createEl('button', {
			cls: 'mbv-ray-page-btn',
			text,
			attr: { type: 'button', tabindex: '-1' },
		});
	}

	private renderItemsRange(items: RenderItem[], start: number, end: number): void {
		for (let i = start; i < end; i += 1) this.appendItem(items[i]);
	}

	/** Inserts before the load-more sentinel when one exists, so a queued batch
	 * lands in document order instead of after it. With no sentinel this is a
	 * plain append. */
	private appendItem(item: RenderItem): void {
		const el = item.kind === 'heading' ? this.buildHeadingEl(item) : this.buildRowEl(item.row);
		this.resultsEl.insertBefore(el, this.sentinelEl);
	}

	private buildHeadingEl(item: { text: string; continued: boolean }): HTMLElement {
		const headingEl = document.createElement('div');
		headingEl.className = 'mbv-ray-group';
		headingEl.textContent = item.continued ? `${item.text} (continued)` : item.text;
		headingEl.classList.toggle('is-continued', item.continued);
		return headingEl;
	}

	private buildRowEl(row: SearchRow): HTMLElement {
		const rowEl = document.createElement('div');
		rowEl.className = 'mbv-ray-row';
		rowEl.dataset.key = row.key;
		rowEl.dataset.path = row.path;
		const mainEl = rowEl.createDiv({ cls: 'mbv-ray-row-main' });
		mainEl.createSpan({ cls: 'mbv-ray-title', text: row.title });
		if (row.subtitle) mainEl.createSpan({ cls: 'mbv-ray-subtitle', text: row.subtitle });
		// The cells go straight into the row: a wrapper around them would be one
		// grid item and the columns inside it would be its own, not the list's.
		if (this.model.showProperties) {
			const hasList = this.callbacks.renderProperties(rowEl, row.path);
			rowEl.toggleClass('has-list', hasList);
		}
		this.rowEls.set(row.key, rowEl);
		return rowEl;
	}

	private queueRemainingItems(items: RenderItem[], start: number, generation: number): void {
		this.pendingItems = items;
		this.pendingIndex = start;
		this.pendingGeneration = generation;
		this.sentinelEl = this.resultsEl.createDiv({ cls: 'mbv-ray-load-more' });
		this.queueObserver = new IntersectionObserver((records) => {
			if (records.some((record) => record.isIntersecting)) this.scheduleQueueFrame();
		}, { root: this.resultsEl, rootMargin: '600px 0px', threshold: 0.01 });
		this.queueObserver.observe(this.sentinelEl);
		this.scheduleQueueFrame();
	}

	private scheduleQueueFrame(): void {
		if (this.queueFrame !== null || this.pendingIndex >= this.pendingItems.length) return;
		const generation = this.pendingGeneration;
		this.queueFrame = window.requestAnimationFrame(() => {
			this.queueFrame = null;
			if (generation !== this.renderGeneration) return;
			this.flushQueueBudgeted();
		});
	}

	private flushQueueBudgeted(): void {
		const startedAt = performance.now();
		let count = 0;
		while (
			this.pendingIndex < this.pendingItems.length
			&& count < ROWS_PER_FRAME
			&& (count === 0 || performance.now() - startedAt < FRAME_BUDGET_MS)
		) {
			this.appendItem(this.pendingItems[this.pendingIndex]);
			this.pendingIndex += 1;
			count += 1;
		}
		if (this.pendingIndex >= this.pendingItems.length) {
			this.finishQueue();
		} else {
			this.scheduleQueueFrame();
		}
	}

	/** Guarantees keyboard navigation stays correct even mid-progressive-render:
	 * jumping to a row (Home, End, a page boundary) that has not streamed in yet
	 * forces the queue forward, in order, up to and including that row, instead
	 * of leaving the selection on a row with nothing to paint. */
	private ensureRendered(key: string): void {
		if (this.rowEls.has(key) || !this.pendingItems.length || this.pendingGeneration !== this.renderGeneration) return;
		while (this.pendingIndex < this.pendingItems.length) {
			const item = this.pendingItems[this.pendingIndex];
			this.appendItem(item);
			this.pendingIndex += 1;
			if (item.kind === 'row' && item.row.key === key) break;
		}
		if (this.pendingIndex >= this.pendingItems.length) this.finishQueue();
	}

	private finishQueue(): void {
		this.queueObserver?.disconnect();
		this.queueObserver = null;
		this.sentinelEl?.remove();
		this.sentinelEl = null;
	}

	private cancelPendingRowQueue(): void {
		this.pendingItems = [];
		this.pendingIndex = 0;
		if (this.queueFrame !== null) {
			window.cancelAnimationFrame(this.queueFrame);
			this.queueFrame = null;
		}
		this.queueObserver?.disconnect();
		this.queueObserver = null;
		this.sentinelEl = null;
	}

	/**
	 * A `max-content` property column has to be measured against every row in
	 * it, every time anything in the grid changes; that cost is what makes the
	 * view slow non-linearly rather than linearly. Measuring the resolved width
	 * once, against the bounded sample that has already rendered, and writing
	 * it back as an explicit pixel track turns every later render into
	 * independent, unmeasured rows.
	 */
	private measureAndFreezeColumns(): void {
		if (this.measureFrame !== null) return;
		this.measureFrame = window.requestAnimationFrame(() => {
			this.measureFrame = null;
			if (!this.rootEl.isConnected || !this.visible.length) return;
			// Natural sizing first: a frozen template from a previous, differently
			// shaped render would otherwise be measured against itself.
			this.resultsEl.style.removeProperty('grid-template-columns');
			this.rootEl.removeClass('is-columns-frozen');
			const resolved = window.getComputedStyle(this.resultsEl).gridTemplateColumns;
			const tracks = resolved.split(' ').filter(Boolean);
			if (tracks.length > 1) {
				const propertyTracks = tracks.slice(1);
				this.resultsEl.style.gridTemplateColumns =
					`minmax(var(--mbv-ray-title-min), 1fr) ${propertyTracks.join(' ')}`;
				this.rootEl.addClass('is-columns-frozen');
			}
			this.measuredSignature = this.model.columnSignature;
			this.measuredWidth = this.resultsEl.clientWidth;
		});
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
