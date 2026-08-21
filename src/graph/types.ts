import type { BasesPropertyId } from 'obsidian';

/**
 * The contract between graph extraction (`src/logic/graphModel.ts`, which reads
 * the metadata cache and knows nothing about drawing) and the renderer
 * (`src/graph/GraphRenderer.ts`, which draws and knows nothing about Obsidian's
 * cache). Both sides are built against this file and neither imports the other.
 */

/**
 * A note node is a real file and opens on click. A value node is a property
 * value that has been promoted to a node (a date, a status, an author), which
 * is what puts `January 29, 2023` on the canvas in the Capacities reference. An
 * unresolved node is a link with no file behind it yet.
 */
export type GraphNodeKind = 'note' | 'value' | 'unresolved';

export interface GraphNode {
	/** Stable across renders and unique within a model. A note node uses its
	 * vault path; a value node uses `${propertyId}:${value}`, which is what
	 * makes every note sharing a value converge on one node. */
	id: string;
	kind: GraphNodeKind;
	label: string;
	/** Present only for `note` nodes, and the only field the renderer needs to
	 * open something. */
	path?: string;
	/** Ordered icon candidates from the plugin's one resolver
	 * (`resolveEntryIcons`), most specific first: the note's icon property,
	 * then Notebook Navigator's file and folder icons, then its root icon. The
	 * renderer paints the first one it can and falls back to a default glyph
	 * for `kind` when none of them resolve. Empty for a node with no icon. */
	icons: string[];
	/** The value of the view's type property, before colour resolution. The
	 * renderer maps this through the existing ColorAssigner and per-value
	 * overrides, so a colour set on a table or a Kanban board is the same
	 * colour here. Null means the neutral tile. */
	typeValue: string | null;
	/** Count of edges touching this node, so the renderer can size or rank
	 * without walking the edge list. */
	degree: number;
}

export interface GraphEdge {
	/** `from` and `to` are `GraphNode.id`. Direction is meaningful: it is the
	 * direction the property points. */
	from: string;
	to: string;
	/** The display label, which is the frontmatter property the link came from
	 * (`Criticised by`, `School of thought`). Null for a body link, which has
	 * no property to name it. */
	label: string | null;
	/** The property this edge came from, for filtering and for optionally
	 * colouring an edge by its property. Null for a body link. */
	property: BasesPropertyId | null;
	/** True when the two notes link each other and the pair has been collapsed
	 * into one edge. The renderer draws an arrowhead at both ends rather than
	 * two overlapping lines. `label` then holds the outbound property and
	 * `reciprocalLabel` the inbound one, which are usually different words for
	 * the same relationship (`Criticised by` against `Criticises`). */
	reciprocal: boolean;
	reciprocalLabel?: string | null;
}

export interface GraphModel {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** Set when a cap was applied, so the view can say so. A silent truncation
	 * reads as a bug, so this is never left null when nodes were dropped. */
	truncated: { shown: number; total: number } | null;
}

export const EMPTY_GRAPH_MODEL: GraphModel = { nodes: [], edges: [], truncated: null };
