import { setIcon } from 'obsidian';
import { BasicDateScale } from './logic/dateScale';
import { virtualizeItems } from './logic/virtualize';
import type { TimelineConfig, TimelineDensity, TimelineItem, TimelineZoomLevel } from './types';

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

export interface TimelineRendererCallbacks {
  openCalendarPicker?: () => void;
  onOpenItem?: (item: TimelineItem) => void;
}

const DEFAULT_LANE_KEY = '__timeline-default';
const ZOOM_LEVELS: TimelineZoomLevel[] = ['day', 'week', 'month', 'quarter', 'year'];
const MIN_BAR_WIDTH = 10;
const DOT_SIZE = 12;
const MIN_TRACK_GAP = 6;
const PADDING_RIGHT = 240;
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
  private currentZoomIndex = ZOOM_LEVELS.indexOf('month');
  private noDateOpen = false;
  private densityOverride: TimelineDensity | null = null;
  private currentData: TimelineRendererData | null = null;
  private currentConfig: TimelineConfig | null = null;
  private collapsedLanes = new Set<string>();
  private cachedLanes: LaneRenderData[] = [];
  private timelineWidth = 0;
  
  private readonly dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  private readonly timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  
  private pendingRenderFrame: number | null = null;

  private handleWheelBound = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const direction = event.deltaY > 0 ? -1 : 1;
    const rect = this.scrollAreaEl.getBoundingClientRect();
    
    const isSingleLane = this.rootEl.hasClass('tl-single-lane');
    const sidebarWidth = isSingleLane ? 0 : 220;
    
    const pivotPx = this.scrollAreaEl.scrollLeft + (event.clientX - rect.left) - sidebarWidth;
    this.adjustZoom(direction as 1 | -1, pivotPx);
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

  private handleCanvasClickBound = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    
    const hit = target.closest('.tl-bar, .tl-dot') as HTMLElement | null;
    if (!hit) return;
    
    const id = hit.getAttribute('data-id') || '';
    const title = hit.getAttribute('data-title') || '';
    
    if (this.callbacks.onOpenItem) {
      this.callbacks.onOpenItem({ id, title });
    }
  };

  constructor(private hostEl: HTMLElement, private callbacks: TimelineRendererCallbacks = {}) {
    this.rootEl = this.createDom();
  }

  updateData(data: TimelineRendererData, config: TimelineConfig): void {
    this.currentData = data;
    this.currentConfig = config;
    this.applySettings(config);
    this.render();
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
    this.scrollAreaEl.addEventListener('click', this.handleCanvasClickBound);
    this.scrollAreaEl.addEventListener('keydown', (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('tl-bar') || target.classList.contains('tl-dot')) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            target.click();
          }
        }
    });
    root.addEventListener('keydown', this.handleKeyDownBound);

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

  private applySettings(config: TimelineConfig): void {
    const zoomIndex = ZOOM_LEVELS.indexOf(config.zoomLevel);
    if (zoomIndex !== -1) {
      this.currentZoomIndex = zoomIndex;
      this.scale.setZoom(config.zoomLevel);
    }
    this.rootEl.toggleClass('tl-high-contrast', !!config.highContrast);
  }

  resize(): void {
      this.render(false);
  }

  private render(refit = true): void {
    if (!this.currentData || !this.currentConfig) {
        this.headerCornerEl.setText('Loading...');
        return;
    }

    const config = this.currentConfig;
    const density = this.getActiveDensity(config);
    
    // Check for single lane
    const isSingleLane = this.cachedLanes.length <= 1;
    this.rootEl.toggleClass('tl-single-lane', isSingleLane);
    const sidebarWidth = isSingleLane ? 0 : 220;

    // viewportWidth is for virtualization. Subtract sidebar width
    const containerWidth = this.scrollAreaEl.clientWidth || 800;
    const viewportWidth = Math.max(100, containerWidth - sidebarWidth); 

    if (refit || !this.cachedLanes.length) {
      this.scale.fitTo(this.currentData.items, viewportWidth);
      this.cachedLanes = this.buildLanes(this.currentData.items);
      const zoomIndex = ZOOM_LEVELS.indexOf(this.scale.getZoomLevel());
      if (zoomIndex !== -1) this.currentZoomIndex = zoomIndex;
      
      // Re-check single lane after building lanes (in case it changed)
      const finalSingle = this.cachedLanes.length <= 1;
      this.rootEl.toggleClass('tl-single-lane', finalSingle);
      // Note: if single lane status changed here, we might need to re-calc viewportWidth, 
      // but it's minor enough to ignore for this frame.
    }

    this.timelineWidth = Math.max(this.calculateTimelineWidth(this.currentData.items), viewportWidth);
    const range = this.getVisibleRange(viewportWidth);

    this.updateToolbar(config);
    this.renderHeader(range);
    this.renderLanes(this.cachedLanes, density, range, config.showWeekends);
    this.renderNoDateDrawer(this.currentData.noDateItems);
    this.updateTodayMarker();
  }

  private updateToolbar(config: TimelineConfig): void {
    const noDateCount = this.currentData?.noDateItems.length ?? 0;
    this.noDateButtonEl.setText(`No date (${noDateCount})`);
    this.noDateButtonEl.toggleClass('is-active', this.noDateOpen);
    const densityLabel = (this.densityOverride ?? config.density) === 'compact' ? 'Compact' : 'Comfortable';
    this.densityButtonEl.setText(`Density: ${densityLabel}`);
    this.zoomOutButtonEl.toggleClass('is-disabled', this.currentZoomIndex <= 0);
    this.zoomInButtonEl.toggleClass('is-disabled', this.currentZoomIndex >= ZOOM_LEVELS.length - 1);
    const disableNoDate = noDateCount === 0;
    this.noDateButtonEl.toggleClass('is-disabled', disableNoDate);
    this.noDateButtonEl.disabled = disableNoDate;
  }

  private renderHeader(range: VisibleRange): void {
      // Render ticks
      this.headerTimeAxisEl.empty();
      this.headerTimeAxisEl.style.width = `${this.timelineWidth + PADDING_RIGHT}px`;
      
      const zoomLabel = this.scale.getZoomLevel();
      this.headerCornerEl.setText(`${this.cachedLanes.length} lanes (${zoomLabel})`);

      const ticks = this.generateTicks(range, this.scale.getZoomLevel());
      for (const tick of ticks) {
        if (tick.position < 0 || tick.position > this.timelineWidth + PADDING_RIGHT) continue;
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
      // Clear existing lane rows (except header row)
      const rows = this.gridEl.querySelectorAll('.tl-lane-row');
      rows.forEach(r => r.remove());

      const trackHeight = density === 'compact' ? 24 : 32;
      const laneGap = density === 'compact' ? 8 : 12;
      const scrollLeft = this.scrollAreaEl.scrollLeft;
      
      const isSingleLane = this.rootEl.hasClass('tl-single-lane');
      const sidebarWidth = isSingleLane ? 0 : 220;
      const viewportWidth = this.scrollAreaEl.clientWidth - sidebarWidth;
      
      const zoomKey = `${this.scale.pxPerDay}`;

      lanes.forEach((lane, index) => {
          const rowEl = this.gridEl.createDiv({ cls: 'tl-lane-row' });
          if (index < lanes.length - 1) rowEl.style.marginBottom = `${laneGap}px`;

          // Lane Header (Sticky Left)
          const headEl = rowEl.createDiv({ cls: 'tl-lane-head' });
          const collapsed = this.collapsedLanes.has(lane.key);
          headEl.toggleClass('is-collapsed', collapsed);
          
          const iconEl = headEl.createDiv({ cls: 'tl-lane-icon' });
          setIcon(iconEl, collapsed ? 'lucide-chevron-right' : 'lucide-chevron-down');
          
          const labelEl = headEl.createDiv({ cls: 'tl-lane-label' });
          labelEl.setText(`${lane.label} (${lane.items.length})`);
          
          headEl.addEventListener('click', () => {
              if (this.collapsedLanes.has(lane.key)) this.collapsedLanes.delete(lane.key); else this.collapsedLanes.add(lane.key);
              this.render(false);
          });

          // Lane Track
          const trackEl = rowEl.createDiv({ cls: 'tl-lane-track' });
          trackEl.style.width = `${this.timelineWidth + PADDING_RIGHT}px`;

          if (collapsed) {
              rowEl.addClass('is-collapsed');
              return;
          }

          // Layout & Render
          if (!lane.layout || lane.layout.zoomLevel !== zoomKey) {
              lane.layout = this.computeLaneLayout(lane.items, zoomKey);
          }

          if (showWeekends) this.renderWeekendShading(trackEl, range.start, range.end);

          const visibleItems = virtualizeItems(lane.items, this.scale, scrollLeft, viewportWidth);
          this.renderLaneItems(trackEl, visibleItems, trackHeight, lane.layout);

          // Set height
          const rowHeight = Math.max(1, lane.layout.maxRows) * trackHeight;
          trackEl.style.height = `${rowHeight}px`;
      });
  }

  private computeLaneLayout(items: TimelineItem[], zoomKey: string): LaneLayout {
      const validItems = items.filter((item) => item.startTs != null);
      if (!validItems.length) {
          return { zoomLevel: zoomKey, maxRows: 1, trackAssignments: new Map() };
      }
      
      const sorted = validItems.slice().sort((a, b) => (a.startTs ?? 0) - (b.startTs ?? 0));
      const trackEndPositions: number[] = [];
      const trackAssignments = new Map<string, number>();
      
      for (const item of sorted) {
          const startPx = Math.round(this.scale.toX(item.startTs!));
          const spanEnd = item.endTs ?? item.startTs!;
          const endPx = Math.round(this.scale.toX(spanEnd));
          
          let assignedTrack = trackEndPositions.findIndex((trackEnd) => startPx - trackEnd >= MIN_TRACK_GAP);
          if (assignedTrack === -1) { 
              trackEndPositions.push(endPx); 
              assignedTrack = trackEndPositions.length - 1; 
          } else { 
              trackEndPositions[assignedTrack] = Math.max(trackEndPositions[assignedTrack], endPx); 
          }
          trackAssignments.set(item.id, assignedTrack);
      }
      
      return {
          zoomLevel: zoomKey,
          maxRows: trackEndPositions.length,
          trackAssignments
      };
  }

  private renderLaneItems(container: HTMLElement, items: TimelineItem[], trackHeight: number, layout: LaneLayout): void {
      for (const item of items) {
          if (item.startTs == null) continue;
          const start = Math.round(this.scale.toX(item.startTs!));
          const spanEnd = item.endTs ?? item.startTs!;
          const end = Math.round(this.scale.toX(spanEnd));
          const width = Math.max(MIN_BAR_WIDTH, end - start);
          
          const trackIndex = layout.trackAssignments.get(item.id) ?? 0;
          const top = trackIndex * trackHeight;
          
          const hasEnd = item.endTs !== undefined && item.endTs !== null;
          const isDot = hasEnd ? false : true;

          const bar = container.createDiv({ cls: isDot ? 'tl-dot' : 'tl-bar' });
          bar.style.left = `${start}px`;
          bar.style.zIndex = '2';
          bar.setAttr('title', this.getItemTooltipSafe(item));
          this.attachBarInteractions(bar, item);

          if (isDot) { 
              bar.style.top = `${Math.round(top + (trackHeight - DOT_SIZE) / 2)}px`; 
              bar.style.width = `${DOT_SIZE}px`; 
              bar.style.height = `${DOT_SIZE}px`; 
          } else { 
              bar.style.top = `${top + 2}px`; 
              bar.style.width = `${width}px`; 
              bar.style.height = `${trackHeight - 4}px`; 
              const labelEl = bar.createDiv({ cls: 'tl-bar-label' }); 
              labelEl.setText(item.title); 
          }
      }
  }

  private attachBarInteractions(el: HTMLElement, item: TimelineItem): void {
      el.setAttr('role', 'button');
      el.tabIndex = 0;
      el.setAttr('data-id', item.id);
      el.setAttr('data-title', item.title);
      el.style.cursor = 'pointer';
  }

  private renderWeekendShading(container: HTMLElement, rangeStart: number, rangeEnd: number): void {
      const track = container.createDiv({ cls: 'tl-weekend-track' });
      const ranges = this.computeWeekendRanges(rangeStart, rangeEnd);
      for (const weekend of ranges) {
          const left = this.scale.toX(weekend.start);
          const width = this.scale.toX(weekend.end) - left;
          if (width <= 0) continue;
          const shade = track.createDiv({ cls: 'tl-weekend' });
          shade.style.left = `${left}px`;
          shade.style.width = `${width}px`;
      }
  }

  private renderNoDateDrawer(items: TimelineItem[]): void {
      this.noDateDrawerEl.toggleClass('is-open', this.noDateOpen);
      this.noDateListEl.empty();
      if (!items.length) { const emptyEl = this.noDateListEl.createDiv({ cls: 'tl-empty' }); emptyEl.setText('All records have start dates.'); return; }
      for (const item of items) { const entryEl = this.noDateListEl.createDiv({ cls: 'tl-drawer-item' }); entryEl.setText(item.title); }
  }

  private updateTodayMarker(): void {
      const today = Date.now();
      const left = Math.round(this.scale.toX(today));
      const isSingleLane = this.rootEl.hasClass('tl-single-lane');
      const sidebarWidth = isSingleLane ? 0 : 220;
      
      this.todayLineEl.style.left = `${left + sidebarWidth}px`;
      this.todayLineEl.removeClass('is-hidden');
      // Ensure it spans the full scrollable height
      this.todayLineEl.style.height = `${this.gridEl.scrollHeight}px`;
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
              case 'week': label = cursor.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }); isMajor = true; cursor.setDate(cursor.getDate() + 1); break;
              case 'month': label = cursor.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); isMajor = cursor.getDate() === 1; cursor.setDate(cursor.getDate() + 7); break;
              case 'quarter': label = cursor.toLocaleDateString(undefined, { month: 'short' }); isMajor = cursor.getMonth() % 3 === 0; cursor.setMonth(cursor.getMonth() + 1); break;
              case 'year': label = cursor.toLocaleDateString(undefined, { month: 'short' }); isMajor = cursor.getMonth() === 0; cursor.setMonth(cursor.getMonth() + 1); break;
          }
          ticks.push({ position, label, isMajor });
      }
      return ticks;
  }

  private computeWeekendRanges(start: number, end: number): Array<{ start: number; end: number }> {
      const ranges: Array<{ start: number; end: number }> = [];
      let cursor = this.floorToDay(start);
      if (cursor > start) cursor -= MS_PER_DAY;
      while (cursor < end) { const day = new Date(cursor).getDay(); if (day === 6) { const rangeStart = Math.max(cursor, start); const rangeEnd = Math.min(cursor + 2 * MS_PER_DAY, end); ranges.push({ start: rangeStart, end: rangeEnd }); cursor += 2 * MS_PER_DAY; } else { cursor += MS_PER_DAY; } }
      return ranges;
  }

  private floorToDay(timestamp: number): number { const date = new Date(timestamp); date.setHours(0, 0, 0, 0); return date.getTime(); }
  
  private toggleNoDateDrawer(): void { this.noDateOpen = !this.noDateOpen; this.render(false); }
  private handleFit(): void { if (!this.currentData) return; this.render(true); }
  private scrollToToday(): void { const today = Date.now(); this.jumpToDate(today); }
  
  jumpToDate(timestamp: number): void { 
      const isSingleLane = this.rootEl.hasClass('tl-single-lane');
      const sidebarWidth = isSingleLane ? 0 : 220;
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

  private calculateTimelineWidth(items: TimelineItem[]): number { let max = 0; for (const item of items) { if (item.startTs == null) continue; const spanEnd = item.endTs ?? item.startTs; const end = this.scale.toX(spanEnd); max = Math.max(max, end); } return Math.max(800, max + PADDING_RIGHT); }
  
  private getVisibleRange(viewportWidth: number): VisibleRange { 
      const scrollLeft = this.scrollAreaEl.scrollLeft; 
      const start = this.scale.startTs + (scrollLeft / this.scale.pxPerDay) * MS_PER_DAY; 
      const end = start + (viewportWidth / this.scale.pxPerDay) * MS_PER_DAY; 
      return { start, end }; 
  }

  private panBy(deltaPx: number): void { this.scrollAreaEl.scrollBy({ left: deltaPx, behavior: 'smooth' }); }
  
  private adjustZoom(step: 1 | -1, pivotPx?: number): void { 
      const nextIndex = this.currentZoomIndex + step; 
      if (nextIndex < 0 || nextIndex >= ZOOM_LEVELS.length) return; 
      
      const isSingleLane = this.rootEl.hasClass('tl-single-lane');
      const sidebarWidth = isSingleLane ? 0 : 220;
      
      const containerWidth = this.scrollAreaEl.clientWidth || 800;
      // Pivot is relative to the timeline area (subtract sidebar)
      const viewportWidth = Math.max(100, containerWidth - sidebarWidth);
      const pivot = pivotPx ?? (this.scrollAreaEl.scrollLeft + viewportWidth / 2); 
      
      const focusTs = this.scale.fromX(pivot); 
      this.currentZoomIndex = nextIndex; 
      this.scale.setZoom(ZOOM_LEVELS[this.currentZoomIndex]); 
      
      const newStart = focusTs - (pivot / this.scale.pxPerDay) * MS_PER_DAY; 
      this.scale.startTs = newStart; 
      this.render(false); 
  }

  destroy(): void { 
      if (this.pendingRenderFrame != null) { cancelAnimationFrame(this.pendingRenderFrame); this.pendingRenderFrame = null; } 
      this.scrollAreaEl.removeEventListener('wheel', this.handleWheelBound); 
      this.rootEl.removeEventListener('keydown', this.handleKeyDownBound); 
      this.collapsedLanes.clear(); 
      this.cachedLanes = []; 
      this.hostEl.empty(); 
  }
}
