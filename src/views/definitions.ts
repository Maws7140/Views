import { CollectionView, CollectionViewType } from '../CollectionView';
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
		register: (plugin) => plugin.registerBasesView(CollectionViewType, {
			name: 'Views · Collection',
			icon: 'lucide-gallery-horizontal-end',
			factory: (controller, containerEl) => new CollectionView(controller, containerEl),
			options: CollectionView.getViewOptions,
		}),
	},
];
