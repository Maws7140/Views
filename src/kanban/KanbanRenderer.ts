import { App, setIcon, type BasesPropertyId, type Value } from 'obsidian';
import { renderCollectionIcon } from '../collection/appearance';
import { CollectionScrollbar } from '../collection/CollectionScrollbar';
import { reportPerformance } from '../performance/metrics';
import { RenderScheduler } from '../performance/RenderScheduler';
import { renderPropertyValue } from '../ui/PropertyValueRenderer';
import type { ColorAssigner } from '../table-colors/palettes';
import { NO_LANE_KEY } from '../logic/lanes';

export interface KanbanCardProperty {
	property: string;
	displayName: string;
	value: unknown;
	palette?: string[];
	/** Set when the board wants two values of one property to differ. */
	colors?: ColorAssigner;
}

export interface KanbanCard {
	id: string;
	title: string;
	laneKey: string;
	icons: string[];
	properties: KanbanCardProperty[];
	color?: string;
	cover?: string | null;
}

export interface KanbanColumn {
	key: string;
	label: string;
	color?: string;
	/** Frontmatter icon of a note matching this value, when one exists. */
	icon?: string;
	count: number;
	/**
	 * Lane key to card ids, ordered by the native sort. Ids only: building a
	 * card model means resolving icons and every property, which must not
	 * happen for cards that are nowhere near the viewport.
	 */
	cards: Map<string, string[]>;
}

export interface KanbanLane {
	key: string;
	label: string;
	color?: string;
	count: number;
}

export interface KanbanModel {
	columns: KanbanColumn[];
	lanes: KanbanLane[];
	hasLanes: boolean;
	columnWidth: number;
	coverHeight: number;
	/** Fixed board height in pixels; 0 fills the available space. */
	viewportHeight: number;
	showCounts: boolean;
	compact: boolean;
	canDrag: boolean;
	dragDisabledReason: string;
	canReorder: boolean;
	collapsedLanes: string[];
}

export interface KanbanDropTarget {
	cardId: string;
	columnKey: string;
	laneKey: string;
	/** Index within the destination cell, in visual order. */
	index: number;
}

export interface KanbanRendererCallbacks {
	/** Resolved only for cards that are actually being rendered. */
	resolveCard: (cardId: string, laneKey: string) => KanbanCard | null;
	onDrop?: (target: KanbanDropTarget) => Promise<void> | void;
	onColumnReorder?: (order: string[]) => void;
	onSwimlaneReorder?: (order: string[]) => void;
	onLaneToggle?: (laneKey: string, collapsed: boolean) => void;
}

const DRAG_THRESHOLD = 4;
const AUTOSCROLL_EDGE = 72;
const AUTOSCROLL_SPEED = 18;
/** Cards rendered per cell up front, and per reveal as the cell is scrolled. */
const CARD_CHUNK = 25;

export class KanbanRenderer {
	private rootEl: HTMLElement;
	private boardEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private noticeEl!: HTMLElement;
	private model: KanbanModel | null = null;
	private scrollbars: CollectionScrollbar[] = [];
	private readonly collapsedLanes = new Set<string>();
	private dragState: DragState | null = null;
	private suppressLaneClick = false;
	private autoScrollFrame: number | null = null;
	private readonly revealed = new Map<string, number>();
	private revealObserver!: IntersectionObserver;
	private readonly scheduler = new RenderScheduler(() => this.draw());

	constructor(
		private readonly hostEl: HTMLElement,
		private readonly app: App,
		private readonly callbacks: KanbanRendererCallbacks,
	) {
		this.rootEl = this.createDom();
	}

	update(model: KanbanModel): void {
		this.model = model;
		// Collapse state is owned by the view config, so it survives reloads.
		this.collapsedLanes.clear();
		for (const laneKey of model.collapsedLanes) this.collapsedLanes.add(laneKey);
		this.scheduler.schedule();
	}

	destroy(): void {
		this.scheduler.cancel();
		this.stopAutoScroll();
		this.revealObserver.disconnect();
		for (const scrollbar of this.scrollbars) scrollbar.destroy();
		this.scrollbars = [];
		this.rootEl.removeEventListener('pointerdown', this.handlePointerDown);
		this.rootEl.removeEventListener('click', this.handleClick);
		this.hostEl.empty();
	}

	private createDom(): HTMLElement {
		this.hostEl.empty();
		const root = this.hostEl.createDiv({ cls: 'mbv-kanban' });
		this.noticeEl = root.createDiv({ cls: 'mbv-kanban-notice' });
		this.boardEl = root.createDiv({ cls: 'mbv-kanban-board', attr: { tabIndex: 0 } });
		this.headerEl = this.boardEl.createDiv({ cls: 'mbv-kanban-header' });
		this.bodyEl = this.boardEl.createDiv({ cls: 'mbv-kanban-body' });
		root.addEventListener('pointerdown', this.handlePointerDown);
		root.addEventListener('click', this.handleClick);
		this.revealObserver = new IntersectionObserver(this.handleReveal, {
			root: this.boardEl,
			rootMargin: '200px',
		});
		this.scrollbars = [
			new CollectionScrollbar(this.boardEl, root, 'horizontal'),
			new CollectionScrollbar(this.boardEl, root, 'vertical'),
		];
		return root;
	}

	private draw(): void {
		const model = this.model;
		if (!model) return;
		const startedAt = performance.now();

		this.rootEl.toggleClass('is-compact', model.compact);
		this.rootEl.style.setProperty('--mbv-kanban-column-width', `${model.columnWidth}px`);
		this.rootEl.style.setProperty('--mbv-kanban-cover-height', `${model.coverHeight}px`);
		this.rootEl.toggleClass('is-coverless', model.coverHeight <= 0);
		// 0 fills the leaf; any other value caps the board and lets it scroll.
		this.rootEl.toggleClass('is-fixed-height', model.viewportHeight > 0);
		this.rootEl.style.height = model.viewportHeight > 0 ? `${model.viewportHeight}px` : '';
		this.noticeEl.toggleClass('is-visible', !model.canDrag && !!model.dragDisabledReason);
		this.noticeEl.setText(model.dragDisabledReason);

		this.headerEl.empty();
		this.bodyEl.empty();
		let cardCount = 0;

		for (const column of model.columns) {
			const headEl = this.headerEl.createDiv({ cls: 'mbv-kanban-column-head' });
			headEl.dataset.column = column.key;
			// Deliberately not a `views-property-pill`. A column header names a
			// section of the board; it is not one of the note's values, and at
			// full column width the pill's stadium shape read as a lozenge.
			// `.mbv-kanban-column-head` owns its whole appearance in the
			// stylesheet, including the `has-value-color` tint.
			if (column.color) {
				headEl.addClass('has-value-color');
				headEl.style.setProperty('--views-property-color', column.color);
			}
			// A value that resolves to a note shows that note's icon; the dot is
			// the fallback for plain values.
			if (column.icon) {
				renderCollectionIcon(headEl.createSpan({ cls: 'mbv-kanban-column-icon' }), [column.icon], this.app);
			} else {
				headEl.createSpan({ cls: 'mbv-kanban-dot' });
			}
			headEl.createSpan({ cls: 'mbv-kanban-column-label', text: column.label });
			if (model.showCounts) {
				headEl.createSpan({ cls: 'mbv-kanban-column-count', text: String(column.count) });
			}
		}

		for (const lane of model.lanes) {
			const collapsed = this.collapsedLanes.has(lane.key);
			if (model.hasLanes) {
				const laneHeadEl = this.bodyEl.createDiv({ cls: 'mbv-kanban-lane-head' });
				laneHeadEl.dataset.lane = lane.key;
				laneHeadEl.toggleClass('is-collapsed', collapsed);
				const toggleEl = laneHeadEl.createDiv({ cls: 'mbv-kanban-lane-toggle' });
				setIcon(toggleEl, collapsed ? 'lucide-chevron-right' : 'lucide-chevron-down');
				const laneChipEl = laneHeadEl.createDiv({ cls: 'mbv-kanban-lane-chip views-property-pill' });
				if (lane.color) {
					laneChipEl.addClass('has-value-color');
					laneChipEl.style.setProperty('--views-property-color', lane.color);
				}
				laneChipEl.setText(lane.label);
				if (model.showCounts) {
					laneHeadEl.createSpan({ cls: 'mbv-kanban-lane-count', text: String(lane.count) });
				}
			}
			if (collapsed) continue;

			const rowEl = this.bodyEl.createDiv({ cls: 'mbv-kanban-row' });
			for (const column of model.columns) {
				const cellEl = rowEl.createDiv({ cls: 'mbv-kanban-cell' });
				cellEl.dataset.column = column.key;
				cellEl.dataset.lane = lane.key;
				if (column.color) cellEl.style.setProperty('--views-property-color', column.color);
				const ids = column.cards.get(lane.key) ?? [];
				const cellKey = `${column.key} ${lane.key}`;
				const rendered = Math.min(ids.length, this.revealed.get(cellKey) ?? CARD_CHUNK);
				this.revealed.set(cellKey, rendered);
				this.fillCell(cellEl, ids, lane.key, 0, rendered);
				cardCount += rendered;
			}
		}
		this.pruneRevealed(model);

		reportPerformance('kanban render', startedAt, {
			columns: model.columns.length,
			lanes: model.lanes.length,
			cards: cardCount,
		});
	}

	/**
	 * Renders a window of a cell's cards and, when more remain, a sentinel that
	 * reveals the next chunk once it is scrolled into view. A Base with no Group
	 * by puts every note in a single column, so a cell has to be able to hold
	 * thousands of ids while only ever building a few dozen cards.
	 */
	private fillCell(cellEl: HTMLElement, ids: string[], laneKey: string, from: number, to: number): void {
		for (let index = from; index < to; index += 1) {
			const card = this.callbacks.resolveCard(ids[index], laneKey);
			if (card) this.renderCard(cellEl, card);
		}
		cellEl.querySelector('.mbv-kanban-more')?.remove();
		if (to >= ids.length) return;
		const moreEl = cellEl.createDiv({
			cls: 'mbv-kanban-more',
			text: `${ids.length - to} more`,
		});
		this.revealObserver.observe(moreEl);
	}

	private readonly handleReveal = (entries: IntersectionObserverEntry[]): void => {
		const model = this.model;
		if (!model) return;
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const moreEl = entry.target as HTMLElement;
			const cellEl = moreEl.closest<HTMLElement>('.mbv-kanban-cell');
			if (!cellEl) continue;
			this.revealObserver.unobserve(moreEl);
			const columnKey = cellEl.dataset.column ?? '';
			const laneKey = cellEl.dataset.lane ?? NO_LANE_KEY;
			const ids = model.columns.find((column) => column.key === columnKey)?.cards.get(laneKey) ?? [];
			const cellKey = `${columnKey} ${laneKey}`;
			const rendered = this.revealed.get(cellKey) ?? CARD_CHUNK;
			const next = Math.min(ids.length, rendered + CARD_CHUNK);
			if (next <= rendered) continue;
			this.revealed.set(cellKey, next);
			this.fillCell(cellEl, ids, laneKey, rendered, next);
		}
	};

	private pruneRevealed(model: KanbanModel): void {
		const live = new Set<string>();
		for (const column of model.columns) {
			for (const laneKey of column.cards.keys()) live.add(`${column.key} ${laneKey}`);
		}
		for (const key of this.revealed.keys()) {
			if (!live.has(key)) this.revealed.delete(key);
		}
	}

	private renderCard(cellEl: HTMLElement, card: KanbanCard): void {
		const cardEl = cellEl.createDiv({ cls: 'mbv-kanban-card' });
		cardEl.dataset.id = card.id;
		cardEl.setAttr('role', 'button');
		cardEl.tabIndex = 0;
		if (card.color) {
			cardEl.addClass('has-value-color');
			cardEl.style.setProperty('--views-property-color', card.color);
		}
		if (card.cover) {
			const coverEl = cardEl.createDiv({ cls: 'mbv-kanban-card-cover' });
			coverEl.createEl('img', {
				attr: { src: card.cover, alt: '', loading: 'lazy', decoding: 'async' },
			});
		}
		const headingEl = cardEl.createDiv({ cls: 'mbv-kanban-card-heading' });
		if (card.icons.length) {
			renderCollectionIcon(headingEl.createSpan({ cls: 'mbv-kanban-card-icon' }), card.icons, this.app);
		}
		headingEl.createDiv({ cls: 'mbv-kanban-card-title', text: card.title });

		if (!card.properties.length) return;
		const propertiesEl = cardEl.createDiv({ cls: 'mbv-kanban-card-properties' });
		for (const property of card.properties) {
			const valueEl = propertiesEl.createDiv({ cls: 'mbv-kanban-card-property' });
			renderPropertyValue(valueEl, property.value as Value, {
				app: this.app,
				property: property.property as BasesPropertyId,
				displayName: property.displayName,
				valueColorPalette: property.palette,
				valueColors: property.colors,
			});
		}
	}

	private readonly handleClick = (event: MouseEvent): void => {
		if (this.dragState?.moved) return;
		const target = event.target as HTMLElement | null;
		const laneHead = target?.closest<HTMLElement>('.mbv-kanban-lane-head');
		if (laneHead?.dataset.lane) {
			// A lane drag ends with a pointerup over this same header, which
			// would otherwise read as the click that toggles collapse.
			if (this.suppressLaneClick) return;
			const laneKey = laneHead.dataset.lane;
			const collapsed = !this.collapsedLanes.has(laneKey);
			if (collapsed) this.collapsedLanes.add(laneKey);
			else this.collapsedLanes.delete(laneKey);
			this.callbacks.onLaneToggle?.(laneKey, collapsed);
			this.scheduler.schedule();
			return;
		}
		// Opening a card is handled by the shared EntryInteractions controller.
	};

	/** True while anything is actually being dragged, not merely pressed. */
	isDragging(): boolean {
		return this.dragState?.moved === true;
	}

	private readonly handlePointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('a, input, .mbv-scrollbar')) return;

		// The whole header starts the drag. A click only becomes a drag once the
		// pointer passes DRAG_THRESHOLD, so the lane header's collapse toggle
		// still fires on a plain click.
		const columnHead = target?.closest<HTMLElement>('.mbv-kanban-column-head');
		if (columnHead) {
			const key = columnHead.dataset.column;
			if (!key || !this.model) return;
			this.dragState = {
				kind: 'column',
				key,
				order: this.model.columns.map((column) => column.key),
				startX: event.clientX,
				startY: event.clientY,
				moved: false,
				ghostEl: null,
				pointerId: event.pointerId,
			};
			this.attachDragListeners();
			return;
		}

		const laneHead = target?.closest<HTMLElement>('.mbv-kanban-lane-head');
		if (laneHead) {
			const key = laneHead.dataset.lane;
			if (!key || !this.model) return;
			this.dragState = {
				kind: 'lane',
				key,
				order: this.model.lanes.map((lane) => lane.key),
				startX: event.clientX,
				startY: event.clientY,
				moved: false,
				ghostEl: null,
				pointerId: event.pointerId,
			};
			this.attachDragListeners();
			return;
		}

		if (!this.model?.canDrag) return;
		const cardEl = target?.closest<HTMLElement>('.mbv-kanban-card');
		if (!cardEl?.dataset.id) return;
		this.dragState = {
			kind: 'card',
			cardId: cardEl.dataset.id,
			cardEl,
			startX: event.clientX,
			startY: event.clientY,
			moved: false,
			ghostEl: null,
			pointerId: event.pointerId,
		};
		this.attachDragListeners();
	};

	private attachDragListeners(): void {
		window.addEventListener('pointermove', this.handlePointerMove);
		window.addEventListener('pointerup', this.handlePointerUp);
		window.addEventListener('pointercancel', this.handlePointerUp);
	}

	private readonly handlePointerMove = (event: PointerEvent): void => {
		const state = this.dragState;
		if (!state) return;
		const dx = event.clientX - state.startX;
		const dy = event.clientY - state.startY;
		if (!state.moved) {
			if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
			state.moved = true;
			this.beginDrag(state);
		}
		if (state.ghostEl) {
			state.ghostEl.style.transform = `translate(${event.clientX + 8}px, ${event.clientY + 8}px)`;
		}
		if (state.kind === 'card') this.updateCardDropMarker(event.clientX, event.clientY);
		else if (state.kind === 'column') this.updateColumnDropMarker(state.key, event.clientX);
		else this.updateLaneDropMarker(state.key, event.clientY);
		this.queueAutoScroll(event.clientX, event.clientY);
	};

	private readonly handlePointerUp = (event: PointerEvent): void => {
		const state = this.dragState;
		window.removeEventListener('pointermove', this.handlePointerMove);
		window.removeEventListener('pointerup', this.handlePointerUp);
		window.removeEventListener('pointercancel', this.handlePointerUp);
		this.stopAutoScroll();
		if (!state) return;
		this.dragState = null;
		if (!state.moved) return;

		state.ghostEl?.remove();
		this.rootEl.removeClass('is-dragging');
		this.clearDropMarkers();

		if (state.kind === 'card') {
			state.cardEl.removeClass('is-dragging');
			const drop = this.resolveCardDropTarget(event.clientX, event.clientY);
			if (drop) void this.callbacks.onDrop?.({ cardId: state.cardId, ...drop });
			// The card element is torn down by the next data update, so the moved
			// flag is cleared on the next frame instead of on click.
			window.setTimeout(() => { if (this.dragState === null) state.moved = false; }, 0);
			return;
		}

		if (state.kind === 'column') {
			this.columnHeadElement(state.key)?.removeClass('is-dragging');
			const index = this.resolveColumnDropIndex(state.key, event.clientX);
			const order = state.order.filter((key) => key !== state.key);
			order.splice(index, 0, state.key);
			this.callbacks.onColumnReorder?.(order);
			return;
		}

		this.laneHeadElement(state.key)?.removeClass('is-dragging');
		const index = this.resolveLaneDropIndex(state.key, event.clientY);
		const order = state.order.filter((key) => key !== state.key);
		order.splice(index, 0, state.key);
		this.callbacks.onSwimlaneReorder?.(order);
		// The pointerup that ends a lane drag is followed by a click on the same
		// header, which would otherwise toggle the lane it was just dropped on.
		this.suppressLaneClick = true;
		window.setTimeout(() => { this.suppressLaneClick = false; }, 0);
	};

	private beginDrag(state: DragState): void {
		this.rootEl.addClass('is-dragging');
		if (state.kind === 'card') {
			state.cardEl.addClass('is-dragging');
			state.ghostEl = this.createGhost(state.cardEl);
			return;
		}
		if (state.kind === 'column') {
			const headEl = this.columnHeadElement(state.key);
			if (!headEl) return;
			headEl.addClass('is-dragging');
			state.ghostEl = this.createGhost(headEl, 'mbv-kanban-ghost-column');
			return;
		}
		const headEl = this.laneHeadElement(state.key);
		if (!headEl) return;
		headEl.addClass('is-dragging');
		state.ghostEl = this.createGhost(headEl, 'mbv-kanban-ghost-lane');
	}

	/** Shared by the card, column, and lane drags: a floating clone that follows the pointer. */
	private createGhost(sourceEl: HTMLElement, extraClass?: string): HTMLElement {
		const rect = sourceEl.getBoundingClientRect();
		const ghost = document.body.createDiv({ cls: extraClass ? `mbv-kanban-ghost ${extraClass}` : 'mbv-kanban-ghost' });
		ghost.style.width = `${rect.width}px`;
		ghost.appendChild(sourceEl.cloneNode(true));
		return ghost;
	}

	private updateCardDropMarker(clientX: number, clientY: number): void {
		this.clearDropMarkers();
		const drop = this.resolveCardDropTarget(clientX, clientY);
		if (!drop) return;
		const cellEl = this.cellElement(drop.columnKey, drop.laneKey);
		if (!cellEl) return;
		cellEl.addClass('is-drop-target');
		const cards = Array.from(cellEl.querySelectorAll<HTMLElement>('.mbv-kanban-card'));
		const marker = createDiv({ cls: 'mbv-kanban-drop-marker' });
		const reference = cards[drop.index] ?? null;
		cellEl.insertBefore(marker, reference);
	}

	private resolveCardDropTarget(clientX: number, clientY: number): Omit<KanbanDropTarget, 'cardId'> | null {
		const element = document.elementFromPoint(clientX, clientY);
		const cellEl = element instanceof Element ? element.closest<HTMLElement>('.mbv-kanban-cell') : null;
		if (!cellEl || !this.rootEl.contains(cellEl)) return null;
		const columnKey = cellEl.dataset.column ?? '';
		const laneKey = cellEl.dataset.lane ?? NO_LANE_KEY;
		const cards = Array.from(cellEl.querySelectorAll<HTMLElement>('.mbv-kanban-card'))
			.filter((card) => !card.hasClass('is-dragging'));
		let index = cards.length;
		for (let position = 0; position < cards.length; position += 1) {
			const rect = cards[position].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) {
				index = position;
				break;
			}
		}
		return { columnKey, laneKey, index };
	}

	/** Columns reorder along the inline axis, so the marker is a vertical bar in the header row. */
	private updateColumnDropMarker(draggedKey: string, clientX: number): void {
		this.clearDropMarkers();
		const heads = this.columnHeadElements(draggedKey);
		const index = this.resolveColumnDropIndex(draggedKey, clientX);
		const marker = createDiv({ cls: 'mbv-kanban-drop-marker is-column' });
		this.headerEl.insertBefore(marker, heads[index] ?? null);
	}

	private resolveColumnDropIndex(draggedKey: string, clientX: number): number {
		const heads = this.columnHeadElements(draggedKey);
		for (let index = 0; index < heads.length; index += 1) {
			const rect = heads[index].getBoundingClientRect();
			if (clientX < rect.left + rect.width / 2) return index;
		}
		return heads.length;
	}

	/** Swimlanes reorder along the block axis, so the marker is a horizontal bar in the body. */
	private updateLaneDropMarker(draggedKey: string, clientY: number): void {
		this.clearDropMarkers();
		const heads = this.laneHeadElements(draggedKey);
		const index = this.resolveLaneDropIndex(draggedKey, clientY);
		const marker = createDiv({ cls: 'mbv-kanban-drop-marker is-lane' });
		this.bodyEl.insertBefore(marker, heads[index] ?? null);
	}

	private resolveLaneDropIndex(draggedKey: string, clientY: number): number {
		const heads = this.laneHeadElements(draggedKey);
		for (let index = 0; index < heads.length; index += 1) {
			const rect = heads[index].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return index;
		}
		return heads.length;
	}

	private columnHeadElements(excludingKey?: string): HTMLElement[] {
		return Array.from(this.headerEl.querySelectorAll<HTMLElement>('.mbv-kanban-column-head'))
			.filter((el) => el.dataset.column !== excludingKey);
	}

	private laneHeadElements(excludingKey?: string): HTMLElement[] {
		return Array.from(this.bodyEl.querySelectorAll<HTMLElement>('.mbv-kanban-lane-head'))
			.filter((el) => el.dataset.lane !== excludingKey);
	}

	private columnHeadElement(key: string): HTMLElement | null {
		return this.headerEl.querySelector<HTMLElement>(`.mbv-kanban-column-head[data-column="${CSS.escape(key)}"]`);
	}

	private laneHeadElement(key: string): HTMLElement | null {
		return this.bodyEl.querySelector<HTMLElement>(`.mbv-kanban-lane-head[data-lane="${CSS.escape(key)}"]`);
	}

	private cellElement(columnKey: string, laneKey: string): HTMLElement | null {
		return this.bodyEl.querySelector<HTMLElement>(
			`.mbv-kanban-cell[data-column="${CSS.escape(columnKey)}"][data-lane="${CSS.escape(laneKey)}"]`,
		);
	}

	private clearDropMarkers(): void {
		this.headerEl.querySelectorAll('.mbv-kanban-drop-marker').forEach((marker) => marker.remove());
		this.bodyEl.querySelectorAll('.mbv-kanban-drop-marker').forEach((marker) => marker.remove());
		this.bodyEl.querySelectorAll('.is-drop-target').forEach((cell) => cell.removeClass('is-drop-target'));
	}

	/** Dragging to the edge scrolls the board, so a long board stays reachable. */
	private queueAutoScroll(clientX: number, clientY: number): void {
		const rect = this.boardEl.getBoundingClientRect();
		let deltaX = 0;
		let deltaY = 0;
		if (clientX < rect.left + AUTOSCROLL_EDGE) deltaX = -AUTOSCROLL_SPEED;
		else if (clientX > rect.right - AUTOSCROLL_EDGE) deltaX = AUTOSCROLL_SPEED;
		if (clientY < rect.top + AUTOSCROLL_EDGE) deltaY = -AUTOSCROLL_SPEED;
		else if (clientY > rect.bottom - AUTOSCROLL_EDGE) deltaY = AUTOSCROLL_SPEED;
		if (!deltaX && !deltaY) {
			this.stopAutoScroll();
			return;
		}
		if (this.autoScrollFrame !== null) return;
		const step = (): void => {
			this.boardEl.scrollLeft += deltaX;
			this.boardEl.scrollTop += deltaY;
			this.autoScrollFrame = window.requestAnimationFrame(step);
		};
		this.autoScrollFrame = window.requestAnimationFrame(step);
	}

	private stopAutoScroll(): void {
		if (this.autoScrollFrame === null) return;
		window.cancelAnimationFrame(this.autoScrollFrame);
		this.autoScrollFrame = null;
	}
}

interface CardDragState {
	kind: 'card';
	cardId: string;
	cardEl: HTMLElement;
	startX: number;
	startY: number;
	moved: boolean;
	ghostEl: HTMLElement | null;
	pointerId: number;
}

interface ColumnDragState {
	kind: 'column';
	/** The column key being dragged. */
	key: string;
	/** Column key order at drag start, reordered on drop and handed back whole. */
	order: string[];
	startX: number;
	startY: number;
	moved: boolean;
	ghostEl: HTMLElement | null;
	pointerId: number;
}

interface LaneDragState {
	kind: 'lane';
	/** The swimlane key being dragged. */
	key: string;
	/** Swimlane key order at drag start, reordered on drop and handed back whole. */
	order: string[];
	startX: number;
	startY: number;
	moved: boolean;
	ghostEl: HTMLElement | null;
	pointerId: number;
}

type DragState = CardDragState | ColumnDragState | LaneDragState;
