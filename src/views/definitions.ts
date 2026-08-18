import { CalendarView, CalendarViewType } from '../CalendarView';
import { CollectionView, CollectionViewType } from '../CollectionView';
import { HeatmapView, HeatmapViewType } from '../HeatmapView';
import { KanbanView, KanbanViewType } from '../KanbanView';
import { SearchView, SearchViewType } from '../SearchView';
import { TimelineView, TimelineViewType } from '../TimelineView';
import type ViewsPlugin from '../main';

export interface ViewDefinition {
	register(plugin: ViewsPlugin): boolean;
}

/** Add future Bases views here without expanding the plugin lifecycle entrypoint. */
export const VIEW_DEFINITIONS: readonly ViewDefinition[] = [
	{
		register: (plugin) => plugin.registerBasesView(TimelineViewType, {
			name: 'Views · Timeline',
			icon: 'lucide-chart-gantt',
			factory: (controller, containerEl) => new TimelineView(plugin, controller, containerEl),
			options: TimelineView.getViewOptions,
		}),
	},
	{
		register: (plugin) => plugin.registerBasesView(KanbanViewType, {
			name: 'Views · Kanban',
			icon: 'lucide-square-kanban',
			factory: (controller, containerEl) => new KanbanView(plugin, controller, containerEl),
			options: KanbanView.getViewOptions,
		}),
	},
	{
		register: (plugin) => plugin.registerBasesView(HeatmapViewType, {
			name: 'Views · Heatmap',
			// Obsidian's bundle spells it with the second hyphen, not Lucide's `grid-3x3`.
			icon: 'lucide-grid-3x-3',
			factory: (controller, containerEl) => new HeatmapView(controller, containerEl),
			options: HeatmapView.getViewOptions,
		}),
	},
	{
		register: (plugin) => plugin.registerBasesView(CalendarViewType, {
			name: 'Views · Calendar',
			icon: 'lucide-calendar-days',
			factory: (controller, containerEl) => new CalendarView(plugin, controller, containerEl),
			options: CalendarView.getViewOptions,
		}),
	},
	{
		register: (plugin) => plugin.registerBasesView(SearchViewType, {
			name: 'Views · Search',
			icon: 'lucide-search',
			factory: (controller, containerEl) => new SearchView(plugin, controller, containerEl),
			options: SearchView.getViewOptions,
		}),
	},
	{
		register: (plugin) => plugin.registerBasesView(CollectionViewType, {
			name: 'Views · Collection',
			icon: 'lucide-gallery-horizontal-end',
			factory: (controller, containerEl) => new CollectionView(plugin, controller, containerEl),
			options: CollectionView.getViewOptions,
		}),
	},
];
