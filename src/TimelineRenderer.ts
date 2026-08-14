import { setIcon, type App, type BasesPropertyId, type Value } from 'obsidian';
import { BasicDateScale } from './logic/dateScale';
import { virtualizeItems } from './logic/virtualize';
import { RenderScheduler } from './performance/RenderScheduler';
import { CollectionScrollbar } from './collection/CollectionScrollbar';
import { reportPerformance } from './performance/metrics';
import { renderPropertyValue } from './ui/PropertyValueRenderer';
import type {
  TimelineConfig,
  TimelineDensity,
  TimelineItem,
  TimelineViewportState,
  TimelineZoomLevel,
} from './types';

export interface TimelineRendererData {
  items: TimelineItem[];
  noDateItems: TimelineItem[];
}

interface LaneLayout {
  zoomLevel: string; // Key derived from zoom level / pxPerDay
  maxRows: number;
  trackAssignments: Map<string, number>;
}

interface LaneRenderData {
  key: string;
  label: string;
  items: TimelineItem[];
  layout?: LaneLayout;
}

interface Tick {
  position: number;
  label: string;
  isMajor: boolean;
}

interface VisibleRange {
  start: number;
  end: number;
}

interface LaneRowDom {
  rowEl: HTMLElement;
  headEl: HTMLElement;
  iconEl: HTMLElement;
  labelEl: HTMLElement;
  trackEl: HTMLElement;
  bandsEl: HTMLElement;
  itemsEl: HTMLElement;
  items: Map<string, ItemDom>;
  bandKey: string;
  collapsed: boolean | null;
  label: string;
}

/**
 * Bars are kept across renders and repositioned. Rebuilding them on every
 * scroll frame meant re-running the property renderer, including Obsidian's
 * rich value renderer, for every visible bar at 60fps.
 */
interface ItemDom {
  el: HTMLElement;
  annexEl: HTMLElement | null;
  contentEl: HTMLElement | null;
  signature: string;
}

export interface TimelineRendererCallbacks {
  openCalendarPicker?: () => void;
  onToggleDone?: (item: TimelineItem, done: boolean) => Promise<void> | void;
  onViewportChanged?: (state: TimelineViewportState) => void;
}

const DEFAULT_LANE_KEY = '__timeline-default';
const ZOOM_LEVELS: TimelineZoomLevel[] = ['day', 'week', 'month', 'quarter', 'year'];
const MIN_BAR_WIDTH = 24;
const DOT_SIZE = 12;
const MIN_TRACK_GAP = 6;
const PADDING_RIGHT = 240;
const SIDEBAR_WIDTH = 220;
const ZOOM_STEP = 1.6;
const ANNEX_GAP = 6;
const CHIP_PADDING = 14;
const CHIP_CHAR_WIDTH = 6.5;
const CHIP_MAX_WIDTH = 220;
/** Ignore pinch jitter below this scale change, and clicks below this drag. */
const PINCH_THRESHOLD = 0.01;
const DRAG_THRESHOLD = 4;
const HEADER_HEIGHT = 32;
const COLLAPSED_LANE_HEIGHT = 32;
/** Ticks and bands are drawn this many viewports beyond the visible window. */
const AXIS_BUFFER_VIEWPORTS = 1.5;
/** Weekend bands become visual noise once a day is only a few pixels wide. */
const MIN_PX_PER_DAY_FOR_WEEKENDS = 18;
/** Keep the label readable when a bar is pinned to the viewport edge. */
const MIN_PINNED_LABEL = 32;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class TimelineRenderer {
  private rootEl: HTMLElement;
  private toolbarEl!: HTMLElement;
  private scrollAreaEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private headerRowEl!: HTMLElement;
  private headerCornerEl!: HTMLElement;
  private headerTimeAxisEl!: HTMLElement;
  private noDateDrawerEl!: HTMLElement;
  private noDateListEl!: HTMLElement;
  private todayLineEl!: HTMLElement;

  private noDateButtonEl!: HTMLButtonElement;
  private fitButtonEl!: HTMLButtonElement;
  private todayButtonEl!: HTMLButtonElement;
  private calendarButtonEl!: HTMLButtonElement;
  private zoomOutButtonEl!: HTMLButtonElement;
  private zoomInButtonEl!: HTMLButtonElement;
  private densityButtonEl!: HTMLButtonElement;

  private scale = new BasicDateScale(Date.now());
  private configuredZoom: TimelineZoomLevel | null = null;
  private hasAppliedScale = false;
  private dataDirty = true;
  private noDateOpen = false;
  private densityOverride: TimelineDensity | null = null;
  private currentData: TimelineRendererData | null = null;
  private currentConfig: TimelineConfig | null = null;
  private collapsedLanes = new Set<string>();
  private cachedLanes: LaneRenderData[] = [];
  private timelineWidth = 0;
  private readonly laneRows = new Map<string, LaneRowDom>();
  private readonly tickFormatters = new Map<string, Intl.DateTimeFormat>();
  private lastNoDateSignature = '';
  private pinchDistance: number | null = null;
  private renderedAxisKey = '';
  private contentHeight = 0;
  private pendingScrollLeft: number | null = null;
  private createdThisFrame = 0;
  private axisRebuiltThisFrame = 0;
  private scrollbars: CollectionScrollbar[] = [];
  
  private readonly dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  private readonly timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  
  private readonly scrollRenderScheduler = new RenderScheduler(() => this.render(false));

  private readonly handleScrollBound = () => {
    this.scrollRenderScheduler.schedule();
    this.callbacks.onViewportChanged?.(this.getViewportState());
  };

  getViewportState(): TimelineViewportState {
    return {
      startTs: this.scale.startTs,
      pxPerDay: this.scale.pxPerDay,
      scrollLeft: this.scrollAreaEl.scrollLeft,
    };
  }

  /**
   * Restores a previous viewport instead of fitting or applying the default
   * zoom, so reopening a Base resumes where the user left off.
   */
  restoreViewport(state: TimelineViewportState): void {
    if (!Number.isFinite(state.startTs) || !Number.isFinite(state.pxPerDay)) return;
    this.scale.startTs = state.startTs;
    this.scale.setPxPerDay(state.pxPerDay);
    this.hasAppliedScale = true;
    this.pendingScrollLeft = Math.max(0, state.scrollLeft || 0);
    this.render(false);
  }

  private handleWheelBound = (event: WheelEvent) => {
    // Trackpad pinch arrives as ctrl+wheel, so this covers pinch on a laptop too.
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -1 : 1;
      this.adjustZoom(direction as 1 | -1, this.pivotFromClientX(event.clientX));
      return;
    }
    // A timeline reads horizontally, so an unmodified wheel with no vertical
    // travel available should pan rather than do nothing.
    const wantsHorizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (!wantsHorizontal) return;
    const delta = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
    if (!delta) return;
    event.preventDefault();
    this.scrollAreaEl.scrollLeft += delta;
  };

  private pivotFromClientX(clientX: number): number {
    const rect = this.scrollAreaEl.getBoundingClientRect();
    const sidebarWidth = this.rootEl.hasClass('tl-single-lane') ? 0 : SIDEBAR_WIDTH;
    return this.scrollAreaEl.scrollLeft + (clientX - rect.left) - sidebarWidth;
  }

  private readonly handleTouchStartBound = (event: TouchEvent) => {
    if (event.touches.length !== 2) {
      this.pinchDistance = null;
      return;
    }
    this.pinchDistance = this.touchDistance(event.touches);
  };

  private readonly handleTouchMoveBound = (event: TouchEvent) => {
    if (event.touches.length !== 2 || this.pinchDistance === null) return;
    const distance = this.touchDistance(event.touches);
    if (distance <= 0) return;
    const ratio = distance / this.pinchDistance;
    if (Math.abs(1 - ratio) < PINCH_THRESHOLD) return;
    event.preventDefault();
    this.pinchDistance = distance;
    const midpoint = (event.touches[0].clientX + event.touches[1].clientX) / 2;
    this.zoomBy(ratio, this.pivotFromClientX(midpoint));
  };

  private readonly handleTouchEndBound = (event: TouchEvent) => {
    if (event.touches.length < 2) this.pinchDistance = null;
  };

  private touchDistance(touches: TouchList): number {
    return Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
  }

  /** Drag the empty canvas to pan, the way every other timeline behaves. */
  private readonly handlePointerDownBound = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.tl-bar, .tl-dot, .tl-bar-annex, .tl-lane-head, .tl-toolbar, .mbv-scrollbar')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startScrollLeft = this.scrollAreaEl.scrollLeft;
    const startScrollTop = this.scrollAreaEl.scrollTop;
    let panning = false;

    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!panning && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      if (!panning) {
        panning = true;
        this.scrollAreaEl.setPointerCapture(moveEvent.pointerId);
        this.rootEl.addClass('is-panning');
      }
      this.scrollAreaEl.scrollLeft = startScrollLeft - dx;
      this.scrollAreaEl.scrollTop = startScrollTop - dy;
    };
    const end = (endEvent: PointerEvent) => {
      this.scrollAreaEl.removeEventListener('pointermove', move);
      this.scrollAreaEl.removeEventListener('pointerup', end);
      this.scrollAreaEl.removeEventListener('pointercancel', end);
      if (panning) {
        this.scrollAreaEl.releasePointerCapture(endEvent.pointerId);
        this.rootEl.removeClass('is-panning');
      }
    };
    this.scrollAreaEl.addEventListener('pointermove', move);
    this.scrollAreaEl.addEventListener('pointerup', end);
    this.scrollAreaEl.addEventListener('pointercancel', end);
  };

  private handleKeyDownBound = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const isWrapperFocused = document.activeElement === this.scrollAreaEl || this.rootEl.contains(document.activeElement);
    if (!isWrapperFocused) return;

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        this.panBy(event.shiftKey ? -800 : -240);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.panBy(event.shiftKey ? 800 : 240);
        break;
      case '+':
      case '=':
        event.preventDefault();
        this.adjustZoom(1);
        break;
      case '-':
        event.preventDefault();
        this.adjustZoom(-1);
        break;
      case 't':
      case 'T':
        event.preventDefault();
        this.scrollToToday();
        break;
      case 'n':
      case 'N':
        event.preventDefault();
        this.toggleNoDateDrawer();
        break;
      default:
        break;
    }
  };

  constructor(
    private hostEl: HTMLElement,
    private app: App,
    private callbacks: TimelineRendererCallbacks = {},
  ) {
    this.rootEl = this.createDom();
  }

  updateData(data: TimelineRendererData, config: TimelineConfig): void {
    this.currentData = data;
    this.currentConfig = config;
    // Bases hands over a fresh result set on every config or vault change, so
    // the lane cache is always stale here. Keeping it made view-option edits
    // appear only after switching views and back.
    this.dataDirty = true;
    const zoomChanged = this.applySettings(config);
    // Refitting on every update threw away the user's zoom and scroll whenever
    // anything else in the vault changed, which read as "zoom does nothing".
    if (!this.hasAppliedScale || zoomChanged) this.applyConfiguredScale(config);
    this.render(false);
  }

  /**
   * The Default zoom option only means something if it survives. Fitting here
   * overwrote it immediately, so a configured zoom anchors to the first item
   * instead, and fitting stays on the Fit button where the user asked for it.
   */
  private applyConfiguredScale(config: TimelineConfig): void {
    this.hasAppliedScale = true;
    const items = this.currentData?.items ?? [];
    if (!items.length) return;
    this.scale.setZoom(config.zoomLevel);
    let earliest = Number.POSITIVE_INFINITY;
    for (const item of items) {
      if (item.startTs != null && item.startTs < earliest) earliest = item.startTs;
    }
    if (!Number.isFinite(earliest)) return;
    const leadDays = Math.max(1, (this.viewportWidth() * 0.05) / this.scale.pxPerDay);
    this.scale.startTs = earliest - leadDays * MS_PER_DAY;
    this.scrollAreaEl.scrollLeft = 0;
  }

  private viewportWidth(): number {
    const sidebarWidth = this.rootEl.hasClass('tl-single-lane') ? 0 : SIDEBAR_WIDTH;
    return Math.max(100, (this.scrollAreaEl.clientWidth || 800) - sidebarWidth);
  }

  private createDom(): HTMLElement {
    this.hostEl.empty();
    const root = this.hostEl.createDiv({ cls: 'tl-root' });

    // Toolbar
    this.toolbarEl = root.createDiv({ cls: 'tl-toolbar', attr: { tabIndex: -1 } });
    this.noDateButtonEl = this.createToolbarButton('No date (0)', () => this.toggleNoDateDrawer());
    this.fitButtonEl = this.createToolbarButton('Fit', () => this.handleFit());
    this.todayButtonEl = this.createToolbarButton('Today', () => this.scrollToToday());
    this.calendarButtonEl = this.createToolbarButton('Jump to date…', () => this.callbacks.openCalendarPicker?.(), 'calendar');
    this.calendarButtonEl.addClass('tl-toolbar-calendar');
    this.zoomOutButtonEl = this.createToolbarButton('Zoom -', () => this.adjustZoom(-1));
    this.zoomInButtonEl = this.createToolbarButton('Zoom +', () => this.adjustZoom(1));
    this.densityButtonEl = this.createToolbarButton('Density: Comfortable', () => this.toggleDensity());

    // Single Scroll Area
    this.scrollAreaEl = root.createDiv({ cls: 'tl-scroll-area', attr: { tabIndex: 0 } });
    this.gridEl = this.scrollAreaEl.createDiv({ cls: 'tl-grid' });

    // Sticky Header Row
    this.headerRowEl = this.gridEl.createDiv({ cls: 'tl-header-row' });
    this.headerCornerEl = this.headerRowEl.createDiv({ cls: 'tl-corner' });
    this.headerTimeAxisEl = this.headerRowEl.createDiv({ cls: 'tl-time-axis' });
    
    // Today line lives in the grid/scroll area but needs to be positioned absolutely relative to the time axis
    // We'll cheat a bit and append it to the grid, but use left positioning matching the time axis
    // Actually, it's easier if we render it into each lane track or use a global overlay in the grid
    // Let's append it to the scrollAreaEl but managing its height manually is annoying.
    // Better: Append to headerRowEl but let it overflow? No.
    // Let's put it in the grid as an overlay.
    this.todayLineEl = this.gridEl.createDiv({ cls: 'tl-today-line is-hidden' });

    // Interactions
    this.scrollAreaEl.addEventListener('wheel', this.handleWheelBound, { passive: false });
    this.scrollAreaEl.addEventListener('scroll', this.handleScrollBound, { passive: true });
    this.scrollAreaEl.addEventListener('pointerdown', this.handlePointerDownBound);
    this.scrollAreaEl.addEventListener('touchstart', this.handleTouchStartBound, { passive: true });
    this.scrollAreaEl.addEventListener('touchmove', this.handleTouchMoveBound, { passive: false });
    this.scrollAreaEl.addEventListener('touchend', this.handleTouchEndBound, { passive: true });
    this.scrollAreaEl.addEventListener('touchcancel', this.handleTouchEndBound, { passive: true });
    root.addEventListener('keydown', this.handleKeyDownBound);

    // Same overlay scrollbars as the Collection view, on both axes.
    this.scrollbars = [
      new CollectionScrollbar(this.scrollAreaEl, root, 'vertical'),
      new CollectionScrollbar(this.scrollAreaEl, root, 'horizontal'),
    ];

    // No Date Drawer
    this.noDateDrawerEl = root.createDiv({ cls: 'tl-drawer' });
    const drawerHeader = this.noDateDrawerEl.createDiv({ cls: 'tl-drawer-header' });
    drawerHeader.setText('Items without a start date');
    this.noDateListEl = this.noDateDrawerEl.createDiv({ cls: 'tl-drawer-list' });

    return root;
  }

  private createToolbarButton(label: string, handler: () => void, icon?: string): HTMLButtonElement {
    const button = this.toolbarEl.createEl('button');
    if (icon) {
      setIcon(button, icon);
      button.addClass('is-icon');
      button.setAttr('aria-label', label);
      button.setAttr('title', label);
    } else {
      button.setText(label);
    }
    button.addEventListener('click', handler);
    return button;
  }

  /** Returns true when the configured default zoom actually changed. */
  private applySettings(config: TimelineConfig): boolean {
    this.rootEl.toggleClass('tl-high-contrast', !!config.highContrast);
    // 0 means "fill the leaf". Any other value caps the timeline and lets the
    // lanes scroll vertically inside it.
    const height = config.viewportHeight ?? 0;
    this.rootEl.toggleClass('tl-fixed-height', height > 0);
    this.rootEl.style.height = height > 0 ? `${height}px` : '';
    if (config.zoomLevel === this.configuredZoom) return false;
    this.configuredZoom = config.zoomLevel;
    if (ZOOM_LEVELS.includes(config.zoomLevel)) this.scale.setZoom(config.zoomLevel);
    return true;
  }

  resize(): void {
      this.render(false);
  }

  private render(refit = true): void {
    if (!this.currentData || !this.currentConfig) {
        this.headerCornerEl.setText('Loading...');
        return;
    }

    const startedAt = performance.now();
    const config = this.currentConfig;
    const density = this.getActiveDensity(config);

    // Lanes decide whether the sidebar exists, so they have to be built before
    // any width is measured. Doing it the other way round mis-sized the first frame.
    if (this.dataDirty || refit || !this.cachedLanes.length) {
      this.cachedLanes = this.buildLanes(this.currentData.items);
      this.dataDirty = false;
    }
    const isSingleLane = this.cachedLanes.length <= 1;
    this.rootEl.toggleClass('tl-single-lane', isSingleLane);
    const sidebarWidth = isSingleLane ? 0 : SIDEBAR_WIDTH;

    const containerWidth = this.scrollAreaEl.clientWidth || 800;
    const viewportWidth = Math.max(100, containerWidth - sidebarWidth);

    if (refit) {
      this.scale.fitTo(this.currentData.items, viewportWidth);
      this.hasAppliedScale = true;
    }

    // Grow the canvas ahead of the scroll position so the timeline never
    // dead-ends past the last bar. Quantised to whole viewports: recomputing an
    // exact width every frame changed the canvas size on every frame, which
    // relaid out the grid, every lane track, and both scrollbars each time.
    const neededWidth = Math.max(
      this.calculateTimelineWidth(this.currentData.items, viewportWidth),
      viewportWidth,
      this.scrollAreaEl.scrollLeft + viewportWidth * 2,
    );
    if (neededWidth > this.timelineWidth || neededWidth < this.timelineWidth * 0.5) {
      this.timelineWidth = Math.ceil(neededWidth / viewportWidth) * viewportWidth;
    }
    const range = this.getVisibleRange(viewportWidth);

    const gridWidth = `${sidebarWidth + this.timelineWidth}px`;
    if (this.gridEl.style.width !== gridWidth) this.gridEl.style.width = gridWidth;

    this.updateToolbar(config);
    this.renderHeader(range, this.scrollAreaEl.scrollLeft, viewportWidth);
    this.renderLanes(this.cachedLanes, density, range, config.showWeekends);
    this.renderNoDateDrawer(this.currentData.noDateItems);
    this.updateTodayMarker(sidebarWidth);

    // Applied last: the scroll range only exists once the track widths are set.
    if (this.pendingScrollLeft !== null) {
      this.scrollAreaEl.scrollLeft = this.pendingScrollLeft;
      this.pendingScrollLeft = null;
    }

    reportPerformance('timeline render', startedAt, {
      refit: refit ? 1 : 0,
      lanes: this.cachedLanes.length,
      items: this.currentData.items.length,
      bars: this.renderedBarCount(),
      created: this.createdThisFrame,
      axisRebuilt: this.axisRebuiltThisFrame,
    });
    this.createdThisFrame = 0;
    this.axisRebuiltThisFrame = 0;
  }

  private renderedBarCount(): number {
    let count = 0;
    for (const dom of this.laneRows.values()) count += dom.items.size;
    return count;
  }

  private updateToolbar(config: TimelineConfig): void {
    const noDateCount = this.currentData?.noDateItems.length ?? 0;
    const noDateLabel = `No date (${noDateCount})`;
    if (this.noDateButtonEl.textContent !== noDateLabel) this.noDateButtonEl.setText(noDateLabel);
    this.noDateButtonEl.toggleClass('is-active', this.noDateOpen);
    const densityLabel = (this.densityOverride ?? config.density) === 'compact' ? 'Compact' : 'Comfortable';
    const densityText = `Density: ${densityLabel}`;
    if (this.densityButtonEl.textContent !== densityText) this.densityButtonEl.setText(densityText);
    this.zoomInButtonEl.toggleClass('is-disabled', !this.scale.canZoom(1));
    this.zoomOutButtonEl.toggleClass('is-disabled', !this.scale.canZoom(-1));
    const disableNoDate = noDateCount === 0;
    this.noDateButtonEl.toggleClass('is-disabled', disableNoDate);
    this.noDateButtonEl.disabled = disableNoDate;
  }

  private renderHeader(range: VisibleRange, scrollLeft: number, viewportWidth: number): void {
      this.headerTimeAxisEl.style.width = `${this.timelineWidth}px`;

      const cornerLabel = `${this.cachedLanes.length} lanes (${this.scale.getZoomLevel()})`;
      if (this.headerCornerEl.textContent !== cornerLabel) this.headerCornerEl.setText(cornerLabel);

      // Ticks cover a band well beyond the viewport, so they only need
      // rebuilding once per half viewport of travel rather than every frame.
      const axisKey = this.axisKey(scrollLeft, viewportWidth);
      if (axisKey === this.renderedAxisKey) return;
      this.renderedAxisKey = axisKey;
      this.axisRebuiltThisFrame = 1;
      this.headerTimeAxisEl.empty();

      const ticks = this.generateTicks(range, this.scale.getTickLevel());
      for (const tick of ticks) {
        if (tick.position < 0 || tick.position > this.timelineWidth) continue;
        const tickEl = this.headerTimeAxisEl.createDiv({ cls: 'tl-tick' });
        if (tick.isMajor) tickEl.addClass('is-major');
        tickEl.style.left = `${tick.position}px`;
        tickEl.setText(tick.label);
      }
  }

  private renderLanes(
    lanes: LaneRenderData[],
    density: TimelineDensity,
    range: VisibleRange,
    showWeekends: boolean
  ): void {
      const trackHeight = density === 'compact' ? 26 : 34;
      const laneGap = density === 'compact' ? 8 : 12;
      const scrollLeft = this.scrollAreaEl.scrollLeft;
      
      const isSingleLane = this.rootEl.hasClass('tl-single-lane');
      const sidebarWidth = isSingleLane ? 0 : SIDEBAR_WIDTH;
      const viewportWidth = this.scrollAreaEl.clientWidth - sidebarWidth;
      
      const zoomKey = `${this.scale.pxPerDay}`;
      const activeKeys = new Set(lanes.map((lane) => lane.key));
      // Weekend stripes at month or year scale are a few pixels wide each and
      // read as noise behind the bars, so coarse zooms get month bands instead.
      const useWeekends = showWeekends && this.scale.pxPerDay >= MIN_PX_PER_DAY_FOR_WEEKENDS;
      const bandRanges = useWeekends
          ? this.computeWeekendRanges(range.start, range.end)
          : this.computeMonthBands(range.start, range.end);

      for (const [key, dom] of this.laneRows) {
          if (activeKeys.has(key)) continue;
          dom.rowEl.remove();
          this.laneRows.delete(key);
      }

      const bandKey = `${this.axisKey(scrollLeft, viewportWidth)}|${useWeekends}`;
      let contentHeight = 0;

      lanes.forEach((lane, index) => {
          let dom = this.laneRows.get(lane.key);
          if (!dom) {
              const rowEl = this.gridEl.createDiv({ cls: 'tl-lane-row' });
              const headEl = rowEl.createDiv({ cls: 'tl-lane-head' });
              const iconEl = headEl.createDiv({ cls: 'tl-lane-icon' });
              const labelEl = headEl.createDiv({ cls: 'tl-lane-label' });
              const trackEl = rowEl.createDiv({ cls: 'tl-lane-track' });
              const bandsEl = trackEl.createDiv({ cls: 'tl-weekend-track' });
              const itemsEl = trackEl.createDiv({ cls: 'tl-lane-items' });
              headEl.addEventListener('click', () => {
                  if (this.collapsedLanes.has(lane.key)) this.collapsedLanes.delete(lane.key);
                  else this.collapsedLanes.add(lane.key);
                  this.render(false);
              });
              dom = {
                  rowEl, headEl, iconEl, labelEl, trackEl, bandsEl, itemsEl,
                  items: new Map(), bandKey: '', collapsed: null, label: '',
              };
              this.laneRows.set(lane.key, dom);
          }
          const { rowEl, headEl, iconEl, labelEl, trackEl, bandsEl, itemsEl } = dom;
          if (rowEl.parentElement !== this.gridEl) this.gridEl.appendChild(rowEl);
          const marginBottom = index < lanes.length - 1 ? `${laneGap}px` : '';
          if (rowEl.style.marginBottom !== marginBottom) rowEl.style.marginBottom = marginBottom;
          const trackWidth = `${this.timelineWidth}px`;
          if (trackEl.style.width !== trackWidth) trackEl.style.width = trackWidth;
          const collapsed = this.collapsedLanes.has(lane.key);
          rowEl.toggleClass('is-collapsed', collapsed);
          headEl.toggleClass('is-collapsed', collapsed);
          // setIcon rewrites an SVG subtree and setText replaces a text node.
          // Both were running for every lane on every scroll frame.
          if (dom.collapsed !== collapsed) {
              dom.collapsed = collapsed;
              setIcon(iconEl, collapsed ? 'lucide-chevron-right' : 'lucide-chevron-down');
          }
          const label = `${lane.label} (${lane.items.length})`;
          if (dom.label !== label) {
              dom.label = label;
              labelEl.setText(label);
          }

          if (collapsed) {
              this.clearLaneItems(dom);
              contentHeight += COLLAPSED_LANE_HEIGHT + laneGap;
              return;
          }

          // Layout & Render
          if (!lane.layout || lane.layout.zoomLevel !== zoomKey) {
              lane.layout = this.computeLaneLayout(lane.items, zoomKey);
          }

          // Bands only change when the scale or the scrolled band changes, so
          // they are not worth rebuilding on every frame.
          if (dom.bandKey !== bandKey) {
              dom.bandKey = bandKey;
              bandsEl.empty();
              if (bandRanges.length) {
                  this.renderWeekendShading(bandsEl, bandRanges, useWeekends ? 'weekend' : 'month');
              }
          }

          const visibleItems = virtualizeItems(lane.items, this.scale, scrollLeft, viewportWidth);
          this.syncLaneItems(dom, itemsEl, visibleItems, trackHeight, lane.layout, scrollLeft);

          const rowHeight = Math.max(1, lane.layout.maxRows) * trackHeight;
          trackEl.style.height = `${rowHeight}px`;
          contentHeight += rowHeight + laneGap;
      });

      this.contentHeight = contentHeight;
  }

  private clearLaneItems(dom: LaneRowDom): void {
      for (const itemDom of dom.items.values()) {
          itemDom.el.remove();
          itemDom.annexEl?.remove();
      }
      dom.items.clear();
  }

  /** Reuse bar elements across frames; only position changes while scrolling. */
  private syncLaneItems(
      dom: LaneRowDom,
      container: HTMLElement,
      items: TimelineItem[],
      trackHeight: number,
      layout: LaneLayout,
      scrollLeft: number,
  ): void {
      const seen = new Set<string>();
      for (const item of items) {
          if (item.startTs == null) continue;
          seen.add(item.id);
          const signature = this.itemSignature(item, trackHeight);
          let itemDom = dom.items.get(item.id);
          if (!itemDom || itemDom.signature !== signature) {
              itemDom?.el.remove();
              itemDom?.annexEl?.remove();
              itemDom = this.createItemDom(container, item, signature);
              dom.items.set(item.id, itemDom);
              this.createdThisFrame += 1;
          }
          this.positionItem(itemDom, item, trackHeight, layout, scrollLeft);
      }
      for (const [id, itemDom] of dom.items) {
          if (seen.has(id)) continue;
          itemDom.el.remove();
          itemDom.annexEl?.remove();
          dom.items.delete(id);
      }
  }

  private itemSignature(item: TimelineItem, trackHeight: number): string {
      const properties = (item.properties ?? [])
          .map((property) => `${property.property}=${property.value == null ? '' : String(property.value)}`)
          .join('');
      const isDot = item.endTs === undefined || item.endTs === null;
      return [item.title, item.color ?? '', String(item.done), String(isDot), String(trackHeight), properties].join(' ');
  }

  /**
   * Rows are packed in the order Bases hands the entries over, which is the
   * user's own Sort by order. Re-sorting by start date here silently overrode
   * it. Because that order is arbitrary, a track has to be tested against every
   * span it already holds rather than just its rightmost end.
   */
  private computeLaneLayout(items: TimelineItem[], zoomKey: string): LaneLayout {
      const validItems = items.filter((item) => item.startTs != null);
      if (!validItems.length) {
          return { zoomLevel: zoomKey, maxRows: 1, trackAssignments: new Map() };
      }

      const tracks: Array<Array<{ start: number; end: number }>> = [];
      const trackAssignments = new Map<string, number>();

      for (const item of validItems) {
          const startPx = Math.round(this.scale.toX(item.startTs!));
          const endPx = Math.round(this.scale.toX(item.endTs ?? item.startTs!));
          const span = {
              start: startPx,
              // Chips render past the bar end, so the space they occupy has to
              // be reserved here or the next bar on this track lands on top.
              end: Math.max(endPx, startPx + MIN_BAR_WIDTH) + this.estimateAnnexWidth(item),
          };

          let assignedTrack = tracks.findIndex((spans) => spans.every((placed) => (
              span.start - placed.end >= MIN_TRACK_GAP || placed.start - span.end >= MIN_TRACK_GAP
          )));
          if (assignedTrack === -1) {
              tracks.push([span]);
              assignedTrack = tracks.length - 1;
          } else {
              tracks[assignedTrack].push(span);
          }
          trackAssignments.set(item.id, assignedTrack);
      }

      return {
          zoomLevel: zoomKey,
          maxRows: tracks.length,
          trackAssignments
      };
  }

  /**
   * Cheap text metric. Measuring the real chips would mean rendering them
   * before layout, and layout runs for every item in the lane, not just the
   * visible ones.
   */
  private estimateAnnexWidth(item: TimelineItem): number {
      const properties = item.properties ?? [];
      if (!properties.length) return 0;
      let width = ANNEX_GAP;
      for (const property of properties) {
          const text = property.value == null ? '' : String(property.value);
          width += Math.min(CHIP_MAX_WIDTH, CHIP_PADDING + text.length * CHIP_CHAR_WIDTH) + ANNEX_GAP;
      }
      return Math.round(width);
  }

  private createItemDom(container: HTMLElement, item: TimelineItem, signature: string): ItemDom {
      const isDot = item.endTs === undefined || item.endTs === null;
      const bar = container.createDiv({ cls: isDot ? 'tl-dot' : 'tl-bar' });
      bar.setAttr('title', this.getItemTooltipSafe(item));
      this.attachBarInteractions(bar, item);
      this.applyItemColor(bar, item);
      if (item.done) bar.addClass('is-done');

      let contentEl: HTMLElement | null = null;
      if (!isDot) {
          contentEl = bar.createDiv({ cls: 'tl-bar-content' });
          this.renderBarLead(contentEl, item);
          contentEl.createDiv({ cls: 'tl-bar-label', text: item.title });
      }
      const annexEl = this.createBarAnnex(container, item);
      return { el: bar, annexEl, contentEl, signature };
  }

  private positionItem(
      itemDom: ItemDom,
      item: TimelineItem,
      trackHeight: number,
      layout: LaneLayout,
      scrollLeft: number,
  ): void {
      const start = Math.round(this.scale.toX(item.startTs!));
      const end = Math.round(this.scale.toX(item.endTs ?? item.startTs!));
      const width = Math.max(MIN_BAR_WIDTH, end - start);
      const top = (layout.trackAssignments.get(item.id) ?? 0) * trackHeight;
      const isDot = itemDom.contentEl === null;

      const style = itemDom.el.style;
      style.left = `${start}px`;
      if (isDot) {
          style.top = `${Math.round(top + (trackHeight - DOT_SIZE) / 2)}px`;
          style.width = `${DOT_SIZE}px`;
          style.height = `${DOT_SIZE}px`;
      } else {
          style.top = `${top + 2}px`;
          style.width = `${width}px`;
          style.height = `${trackHeight - 4}px`;
          this.pinBarContent(itemDom.contentEl!, start, width, scrollLeft);
      }

      if (itemDom.annexEl) {
          const annexStyle = itemDom.annexEl.style;
          annexStyle.left = `${(isDot ? start + DOT_SIZE : start + width) + ANNEX_GAP}px`;
          annexStyle.top = `${top + 2}px`;
          annexStyle.height = `${trackHeight - 4}px`;
      }
  }

  /**
   * A bar that starts left of the viewport keeps its label on screen, matching
   * the reference timelines rather than scrolling the title out of the canvas.
   */
  private pinBarContent(contentEl: HTMLElement, start: number, width: number, scrollLeft: number): void {
      const overhang = scrollLeft - start;
      const offset = overhang > 0
          ? Math.min(overhang, Math.max(0, width - MIN_PINNED_LABEL))
          : 0;
      const transform = offset > 0 ? `translateX(${Math.round(offset)}px)` : '';
      if (contentEl.style.transform !== transform) contentEl.style.transform = transform;
      contentEl.toggleClass('is-pinned', offset > 0);
  }

  private renderBarLead(contentEl: HTMLElement, item: TimelineItem): void {
      if (item.done === undefined) return;
      const checkbox = contentEl.createEl('input', {
          type: 'checkbox',
          cls: 'tl-bar-check',
          attr: { 'aria-label': `Mark ${item.title} complete` },
      });
      checkbox.checked = item.done;
      // The canvas click handler opens the note, which is not what a tick means.
      checkbox.addEventListener('click', (event) => event.stopPropagation());
      checkbox.addEventListener('change', () => {
          const next = checkbox.checked;
          checkbox.disabled = true;
          void Promise.resolve(this.callbacks.onToggleDone?.(item, next))
              .catch(() => { checkbox.checked = !next; })
              .finally(() => { checkbox.disabled = false; });
      });
  }

  /**
   * Property chips sit past the bar end instead of inside it, so a short span
   * still shows its values without the bar lying about its dates.
   */
  private createBarAnnex(container: HTMLElement, item: TimelineItem): HTMLElement | null {
      const properties = item.properties ?? [];
      if (!properties.length) return null;
      const annexEl = container.createDiv({ cls: 'tl-bar-annex' });
      for (const property of properties) {
          const chipEl = annexEl.createDiv({ cls: 'tl-bar-chip' });
          renderPropertyValue(chipEl, property.value as Value, {
              app: this.app,
              property: property.property as BasesPropertyId,
              displayName: property.displayName,
              valueColorPalette: property.palette,
          });
      }
      return annexEl;
  }

  /** Bars reuse the shared property-color surface, so a value looks the same everywhere. */
  private applyItemColor(bar: HTMLElement, item: TimelineItem): void {
      if (!item.color) return;
      bar.addClass('has-value-color');
      bar.style.setProperty('--views-property-color', item.color);
  }

  private attachBarInteractions(el: HTMLElement, item: TimelineItem): void {
      el.setAttr('role', 'button');
      el.tabIndex = 0;
      el.setAttr('data-id', item.id);
      el.setAttr('data-title', item.title);
      el.style.cursor = 'pointer';
  }

  private renderWeekendShading(
    track: HTMLElement,
    ranges: Array<{ start: number; end: number }>,
    variant: 'weekend' | 'month' = 'weekend',
  ): void {
      for (const weekend of ranges) {
          const left = this.scale.toX(weekend.start);
          const width = this.scale.toX(weekend.end) - left;
          if (width <= 0) continue;
          const shade = track.createDiv({ cls: variant === 'month' ? 'tl-weekend is-month-band' : 'tl-weekend' });
          shade.style.left = `${left}px`;
          shade.style.width = `${width}px`;
      }
  }

  private renderNoDateDrawer(items: TimelineItem[]): void {
      this.noDateDrawerEl.toggleClass('is-open', this.noDateOpen);
      const signature = `${this.noDateOpen}:${items.map((item) => `${item.id}\u0000${item.title}`).join('\u0001')}`;
      if (signature === this.lastNoDateSignature) return;
      this.lastNoDateSignature = signature;
      this.noDateListEl.empty();
      if (!items.length) { const emptyEl = this.noDateListEl.createDiv({ cls: 'tl-empty' }); emptyEl.setText('All records have start dates.'); return; }
      for (const item of items) { const entryEl = this.noDateListEl.createDiv({ cls: 'tl-drawer-item' }); entryEl.setText(item.title); }
  }

  private updateTodayMarker(sidebarWidth: number): void {
      const left = Math.round(this.scale.toX(Date.now()));
      this.todayLineEl.style.left = `${left + sidebarWidth}px`;
      this.todayLineEl.removeClass('is-hidden');
      // Height comes from the lane heights we just computed. Reading
      // gridEl.scrollHeight here forced a layout on every scroll frame.
      this.todayLineEl.style.height = `${HEADER_HEIGHT + this.contentHeight}px`;
  }

  /**
   * Identifies the scrolled band, changing once per half viewport. Anything
   * keyed on it survives ordinary scrolling untouched.
   */
  private axisKey(scrollLeft: number, viewportWidth: number): string {
      const bucket = Math.floor(scrollLeft / Math.max(1, viewportWidth * 0.5));
      return `${this.scale.pxPerDay}|${this.scale.startTs}|${this.timelineWidth}|${bucket}`;
  }

  private generateTicks(range: VisibleRange, zoom: TimelineZoomLevel): Tick[] {
      const ticks: Tick[] = [];
      const cursor = new Date(range.start);
      
      // Align cursor
      switch (zoom) {
          case 'day': cursor.setHours(Math.floor(cursor.getHours() / 6) * 6, 0, 0, 0); break;
          case 'week': cursor.setHours(0, 0, 0, 0); cursor.setDate(cursor.getDate() - cursor.getDay()); break;
          case 'month': cursor.setDate(1); cursor.setHours(0, 0, 0, 0); break;
          case 'quarter': cursor.setDate(1); cursor.setHours(0, 0, 0, 0); cursor.setMonth(Math.floor(cursor.getMonth() / 3) * 3); break;
          case 'year': cursor.setMonth(0, 1); cursor.setHours(0, 0, 0, 0); break;
      }
  
      const end = range.end;
      while (cursor.getTime() <= end) {
          const time = cursor.getTime();
          const position = this.scale.toX(time);
          let label = '';
          let isMajor = false;
  
          switch (zoom) {
              case 'day': label = this.timeFormatter.format(time); isMajor = cursor.getHours() === 0; cursor.setHours(cursor.getHours() + 6); break;
          case 'week': label = this.tickFormatter('weekday-day', { weekday: 'short', day: 'numeric' }).format(cursor); isMajor = true; cursor.setDate(cursor.getDate() + 1); break;
          case 'month': label = this.tickFormatter('month-day', { month: 'short', day: 'numeric' }).format(cursor); isMajor = cursor.getDate() === 1; cursor.setDate(cursor.getDate() + 7); break;
          case 'quarter': label = this.tickFormatter('month', { month: 'short' }).format(cursor); isMajor = cursor.getMonth() % 3 === 0; cursor.setMonth(cursor.getMonth() + 1); break;
          case 'year': label = this.tickFormatter('month', { month: 'short' }).format(cursor); isMajor = cursor.getMonth() === 0; cursor.setMonth(cursor.getMonth() + 1); break;
          }
          ticks.push({ position, label, isMajor });
      }
      return ticks;
  }

  private tickFormatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
      let formatter = this.tickFormatters.get(key);
      if (!formatter) {
          formatter = new Intl.DateTimeFormat(undefined, options);
          this.tickFormatters.set(key, formatter);
      }
      return formatter;
  }

  private computeWeekendRanges(start: number, end: number): Array<{ start: number; end: number }> {
      const ranges: Array<{ start: number; end: number }> = [];
      let cursor = this.floorToDay(start);
      if (cursor > start) cursor -= MS_PER_DAY;
      while (cursor < end) { const day = new Date(cursor).getDay(); if (day === 6) { const rangeStart = Math.max(cursor, start); const rangeEnd = Math.min(cursor + 2 * MS_PER_DAY, end); ranges.push({ start: rangeStart, end: rangeEnd }); cursor += 2 * MS_PER_DAY; } else { cursor += MS_PER_DAY; } }
      return ranges;
  }

  /** Alternating month columns, the coarse-zoom equivalent of weekend shading. */
  private computeMonthBands(start: number, end: number): Array<{ start: number; end: number }> {
      const ranges: Array<{ start: number; end: number }> = [];
      const cursor = new Date(start);
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      while (cursor.getTime() < end) {
          const monthStart = cursor.getTime();
          const next = new Date(cursor);
          next.setMonth(next.getMonth() + 1);
          if (cursor.getMonth() % 2 === 1) {
              ranges.push({ start: Math.max(monthStart, start), end: Math.min(next.getTime(), end) });
          }
          cursor.setMonth(cursor.getMonth() + 1);
      }
      return ranges;
  }

  private floorToDay(timestamp: number): number { const date = new Date(timestamp); date.setHours(0, 0, 0, 0); return date.getTime(); }
  
  private toggleNoDateDrawer(): void { this.noDateOpen = !this.noDateOpen; this.render(false); }
  private handleFit(): void { if (!this.currentData) return; this.render(true); }
  private scrollToToday(): void { const today = Date.now(); this.jumpToDate(today); }
  
  jumpToDate(timestamp: number): void { 
      const isSingleLane = this.rootEl.hasClass('tl-single-lane');
      const sidebarWidth = isSingleLane ? 0 : SIDEBAR_WIDTH;
      const containerWidth = this.scrollAreaEl.clientWidth || 800;
      const viewportWidth = Math.max(100, containerWidth - sidebarWidth);
      const halfDays = (viewportWidth / this.scale.pxPerDay) / 2; 
      this.scale.startTs = timestamp - halfDays * MS_PER_DAY; 
      this.render(false); 
  }
  
  private toggleDensity(): void { const current = this.densityOverride ?? this.currentConfig?.density ?? 'comfortable'; this.densityOverride = current === 'comfortable' ? 'compact' : 'comfortable'; this.render(false); }
  private getActiveDensity(config: TimelineConfig): TimelineDensity { return this.densityOverride ?? config.density; }
  private getItemTooltipSafe(item: TimelineItem): string { const start = item.startTs ? this.dateFormatter.format(item.startTs) : 'Unknown'; if (!item.endTs || item.endTs === item.startTs) { return `${item.title}\n${start}`; } const end = this.dateFormatter.format(item.endTs); return `${item.title}\n${start} -> ${end}`; }

  private buildLanes(items: TimelineItem[]): LaneRenderData[] {
      const laneMap = new Map<string, TimelineItem[]>();
      for (const item of items) { if (item.startTs == null) continue; const key = item.groupKey ?? DEFAULT_LANE_KEY; const laneItems = laneMap.get(key) ?? []; laneItems.push(item); laneMap.set(key, laneItems); }
      if (!laneMap.size) { return [{ key: DEFAULT_LANE_KEY, label: 'Timeline', items: [] }]; }
      return Array.from(laneMap.entries()).map(([key, laneItems]) => ({ key, label: key === DEFAULT_LANE_KEY ? 'Timeline' : key, items: laneItems }));
  }

  /**
   * The canvas keeps a viewport of air past the last item so the timeline does
   * not dead-end on the final bar the way a fixed 240px pad did.
   */
  private calculateTimelineWidth(items: TimelineItem[], viewportWidth: number): number {
      let max = 0;
      for (const item of items) {
          if (item.startTs == null) continue;
          const spanEnd = item.endTs ?? item.startTs;
          max = Math.max(max, this.scale.toX(spanEnd));
      }
      return Math.max(800, max + Math.max(PADDING_RIGHT, viewportWidth * 0.75));
  }
  
  /**
   * Ticks and weekend shading use the same half-viewport buffer as bar
   * virtualization, so neither pops in behind the other while scrolling.
   */
  private getVisibleRange(viewportWidth: number): VisibleRange {
      const buffer = viewportWidth * AXIS_BUFFER_VIEWPORTS;
      const scrollLeft = this.scrollAreaEl.scrollLeft;
      const startPx = Math.max(0, scrollLeft - buffer);
      const start = this.scale.startTs + (startPx / this.scale.pxPerDay) * MS_PER_DAY;
      const end = start + ((viewportWidth + buffer * 2) / this.scale.pxPerDay) * MS_PER_DAY;
      return { start, end };
  }

  private panBy(deltaPx: number): void { this.scrollAreaEl.scrollBy({ left: deltaPx, behavior: 'smooth' }); }
  
  /** `step` is user-facing: +1 zooms in, holding the pivot pixel steady. */
  private adjustZoom(step: 1 | -1, pivotPx?: number): void {
      if (!this.scale.canZoom(step)) return;
      this.zoomBy(step > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, pivotPx);
  }

  /** Continuous zoom around a pivot pixel, shared by buttons, wheel, and pinch. */
  private zoomBy(factor: number, pivotPx?: number): void {
      if (factor <= 0 || factor === 1) return;

      const isSingleLane = this.rootEl.hasClass('tl-single-lane');
      const sidebarWidth = isSingleLane ? 0 : SIDEBAR_WIDTH;
      
      const containerWidth = this.scrollAreaEl.clientWidth || 800;
      // Pivot is relative to the timeline area (subtract sidebar)
      const viewportWidth = Math.max(100, containerWidth - sidebarWidth);
      const pivot = pivotPx ?? (this.scrollAreaEl.scrollLeft + viewportWidth / 2); 
      
      const focusTs = this.scale.fromX(pivot);
      this.scale.setPxPerDay(this.scale.pxPerDay * factor);

      this.scale.startTs = focusTs - (pivot / this.scale.pxPerDay) * MS_PER_DAY;
      this.render(false);
  }

  destroy(): void {
      this.scrollRenderScheduler.cancel();
      for (const scrollbar of this.scrollbars) scrollbar.destroy();
      this.scrollbars = [];
      this.scrollAreaEl.removeEventListener('wheel', this.handleWheelBound);
      this.scrollAreaEl.removeEventListener('scroll', this.handleScrollBound);
      this.scrollAreaEl.removeEventListener('pointerdown', this.handlePointerDownBound);
      this.scrollAreaEl.removeEventListener('touchstart', this.handleTouchStartBound);
      this.scrollAreaEl.removeEventListener('touchmove', this.handleTouchMoveBound);
      this.scrollAreaEl.removeEventListener('touchend', this.handleTouchEndBound);
      this.scrollAreaEl.removeEventListener('touchcancel', this.handleTouchEndBound);
      this.rootEl.removeEventListener('keydown', this.handleKeyDownBound); 
      this.collapsedLanes.clear(); 
      this.cachedLanes = []; 
      this.laneRows.clear();
      this.hostEl.empty(); 
  }
}
