import { App, setIcon } from 'obsidian';
import { filterTree, type TreeModel, type TreeNode } from './treeModel';

/**
 * The indented outline: one row per node, guide lines down the indent,
 * a twisty on anything with children, a note count on the right.
 *
 * DOM rather than canvas, and that is the point rather than a shortcut. The
 * reference this is built against stays legible at a couple of thousand rows,
 * scrolls with the mouse the way every other list in Obsidian does, and gets
 * text selection, native focus and keyboard scrolling for free. A canvas has
 * to reimplement all four before it draws anything.
 *
 * Knows nothing about properties or the metadata cache: it renders whatever
 * `treeModel.ts` returns. Expansion state is the one thing it owns, keyed by
 * node id and handed back to the view to persist.
 */

export interface TreeOutlineOptions {
	showCounts: boolean;
	/** Rows at or above this depth start open. The tree draws every generation
	 * regardless; this only decides what is collapsed on arrival. */
	expandToDepth: number;
	/** Per-node colour, resolved by the view through the same property-value
	 * palette the rest of the plugin uses. Null leaves a row uncoloured. */
	colorOf?: (node: TreeNode) => string | null;
	/** Ordered icon candidates for a row, from the plugin's one resolver. */
	iconsOf?: (node: TreeNode) => string[];
}

export class TreeOutline {
	private readonly listEl: HTMLElement;
	private readonly filterEl: HTMLInputElement;
	private readonly emptyEl: HTMLElement;
	private model: TreeModel = { roots: [], byId: new Map(), total: 0 };
	private options: TreeOutlineOptions = { showCounts: true, expandToDepth: 2 };
	private query = '';
	/**
	 * Rows the user has explicitly toggled, and which way, keyed by
	 * `TreeNode.chain` rather than by `id`.
	 *
	 * A row absent from this map follows `expandToDepth`, so moving that slider
	 * still opens and closes rows nobody has touched while leaving the ones
	 * they have. Keying on the chain is what lets the state survive a change to
	 * the hierarchy: `id` carries level indices, so reordering the levels
	 * renumbers everything and every saved key would go stale at once.
	 */
	private readonly toggled = new Map<string, boolean>();

	constructor(
		private readonly containerEl: HTMLElement,
		private readonly app: App,
		/** Called with a row's `chain`, not its `id`. The view persists it. */
		private readonly onToggle: (chain: string, expanded: boolean) => void,
	) {
		this.containerEl.addClass('views-tree');

		const toolbar = this.containerEl.createDiv({ cls: 'views-tree-toolbar' });
		const expandAll = toolbar.createEl('button', { cls: 'views-tree-tool', attr: { 'aria-label': 'Expand all' } });
		setIcon(expandAll, 'lucide-chevrons-up-down');
		expandAll.addEventListener('click', () => this.setAll(true));
		const collapseAll = toolbar.createEl('button', { cls: 'views-tree-tool', attr: { 'aria-label': 'Collapse all' } });
		setIcon(collapseAll, 'lucide-chevrons-down-up');
		collapseAll.addEventListener('click', () => this.setAll(false));

		this.filterEl = toolbar.createEl('input', {
			cls: 'views-tree-filter',
			attr: { type: 'text', placeholder: 'Filter tree...' },
		});
		this.filterEl.addEventListener('input', () => {
			this.query = this.filterEl.value;
			this.render();
		});

		this.listEl = this.containerEl.createDiv({ cls: 'views-tree-list' });
		this.emptyEl = this.containerEl.createDiv({ cls: 'views-tree-empty' });
		this.emptyEl.hide();
	}

	update(model: TreeModel, options: TreeOutlineOptions, restored: Map<string, boolean>): void {
		this.model = model;
		this.options = options;
		if (this.toggled.size === 0 && restored.size > 0) {
			for (const [id, expanded] of restored) this.toggled.set(id, expanded);
		}
		this.render();
	}

	destroy(): void {
		this.containerEl.empty();
		this.containerEl.removeClass('views-tree');
	}

	private setAll(expanded: boolean): void {
		const walk = (nodes: TreeNode[]): void => {
			for (const node of nodes) {
				if (node.children.length > 0) {
					this.toggled.set(node.chain, expanded);
					this.onToggle(node.chain, expanded);
				}
				walk(node.children);
			}
		};
		walk(this.model.roots);
		this.render();
	}

	private isExpanded(node: TreeNode): boolean {
		// A filter is a request to see the matches, so everything on the way to
		// one opens regardless of what the user collapsed earlier. Collapsing
		// state is remembered, not lost, and comes back on backspace.
		if (this.query.trim().length > 0) return true;
		return this.toggled.get(node.chain) ?? node.depth < this.options.expandToDepth;
	}

	private render(): void {
		this.listEl.empty();
		const roots = filterTree(this.model.roots, this.query);

		if (roots.length === 0) {
			this.emptyEl.show();
			this.emptyEl.empty();
			this.emptyEl.createEl('p', { text: this.emptyMessage() });
			return;
		}

		this.emptyEl.hide();
		for (const node of roots) this.renderNode(node, this.listEl, []);
	}

	/** Tree language, not graph language, and it names the control that
	 * actually fixes the state. The old view said a base was not connected,
	 * which was wrong and unactionable both: a tree does not need
	 * connections, it needs something to nest by. Group by is named first
	 * because it is the base's own control and supplies the outermost level. */
	private emptyMessage(): string {
		if (this.query.trim().length > 0) return 'No rows match this filter.';
		if (this.model.total === 0) return 'This base returned no notes.';
		return 'Nothing to nest by yet. Set the base\'s Group by, or add a Then nest by property. Grouping by file.folder gives you the vault\'s own folders.';
	}

	/**
	 * `ancestorsHaveMore` carries, per ancestor level, whether that ancestor
	 * had a sibling after it. That is what decides whether the guide line at
	 * that level continues past this row or stops, which is the difference
	 * between a tree that reads as connected and a row of loose dashes.
	 */
	private renderNode(node: TreeNode, parentEl: HTMLElement, ancestorsHaveMore: boolean[]): void {
		const row = parentEl.createDiv({ cls: 'views-tree-row' });
		row.dataset.kind = node.kind;

		const guides = row.createDiv({ cls: 'views-tree-guides' });
		for (const continues of ancestorsHaveMore) {
			guides.createDiv({ cls: continues ? 'views-tree-guide' : 'views-tree-guide is-blank' });
		}

		const hasChildren = node.children.length > 0;
		const expanded = hasChildren && this.isExpanded(node);
		const twisty = row.createDiv({ cls: 'views-tree-twisty' });
		if (hasChildren) {
			twisty.addClass('is-clickable');
			setIcon(twisty, expanded ? 'lucide-chevron-down' : 'lucide-chevron-right');
			twisty.addEventListener('click', (event) => {
				event.stopPropagation();
				this.toggled.set(node.chain, !expanded);
				this.onToggle(node.chain, !expanded);
				this.render();
			});
		}

		const icons = this.options.iconsOf?.(node) ?? [];
		if (icons.length > 0) {
			const iconEl = row.createDiv({ cls: 'views-tree-icon' });
			setIcon(iconEl, icons[0]);
		}

		const label = row.createDiv({ cls: 'views-tree-label', text: node.label });
		const color = this.options.colorOf?.(node) ?? null;
		if (color !== null) label.style.setProperty('--views-tree-row-color', color);
		// A container that resolved onto a real note opens like a note does,
		// because that row is a note: the folder note, or the `class` hub.
		if (node.path !== undefined) {
			label.addClass('is-openable');
			label.addEventListener('click', () => this.openNote(node.path as string));
		}

		if (this.options.showCounts && node.kind === 'container') {
			row.createDiv({ cls: 'views-tree-count', text: String(node.noteCount) });
		}

		if (!expanded) return;
		const childrenEl = parentEl.createDiv({ cls: 'views-tree-children' });
		node.children.forEach((child, index) => {
			this.renderNode(child, childrenEl, [...ancestorsHaveMore, index < node.children.length - 1]);
		});
	}

	private openNote(path: string): void {
		const file = this.app.vault.getFileByPath(path);
		if (file) void this.app.workspace.getLeaf(false).openFile(file);
	}
}
