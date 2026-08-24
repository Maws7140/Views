import type { BasesPropertyId } from 'obsidian';
import { isMeaningfulValue, stringifyValue, stringifyValues, unwrapWikilink } from '../logic/graphModel';

/**
 * The tree's own hierarchy, built from entries rather than from graph edges.
 *
 * The previous cut of this view derived parenthood from `GraphModel.edges`,
 * which is why `file.folder` drew nothing: a folder is not an edge, and no
 * amount of reading the edge list harder was going to make it one. Most real
 * hierarchies in a vault are not edges. A folder path is a prefix chain, a
 * nested tag is a prefix chain, a status is a flat facet, and only a property
 * whose value names another note is edge-shaped at all.
 *
 * So this module asks entries directly, and it composes rather than choosing.
 * Each `nestBy` slot contributes one level of containers, in order, and notes
 * sit at the innermost level. `status` then `class` then note is a legal tree;
 * so is `file.folder` on its own. That is the same idiom the graph's four
 * Connect by slots already use (`../graph/linkProperties.ts`), for the same
 * reason: the plugin does not get to decide which hierarchy a vault has.
 *
 * How a value becomes a level is decided by the value, not by a mode setting
 * the user has to find:
 *
 * - A value containing `/` splits into segments and nests them, which is what
 *   turns `Skoo/CS 360` into `Skoo` > `CS 360` rather than one flat row per
 *   distinct full path. Covers folders and nested tags with one rule.
 * - A value written as a link resolves to the note it names, and when that
 *   note is in the base the container *is* that note's row. A base grouping by
 *   `class` where every note writes `class: "[[CS 360]]"` should nest under
 *   the real CS 360 note, not stand a synthetic twin beside it. This mirrors
 *   `resolveConnectTarget` in `../logic/graphModel.ts` deliberately.
 * - Anything else groups by the value as text.
 *
 * Pure and DOM-free. `TreeOutline.ts` renders what this returns and knows
 * nothing about properties; this file knows nothing about rows.
 */

export type TreeNodeKind = 'note' | 'container';

export interface TreeNode {
	/** Unique within a model. A note uses its vault path. A container uses its
	 * level index and value, so two levels nesting by different properties
	 * that happen to share a value ("done" under both `status` and `Progress`)
	 * cannot collide into one row. */
	id: string;
	kind: TreeNodeKind;
	label: string;
	/** Present for a note, and for a container that resolved onto a real note
	 * (a folder note, or a `class` hub). The only field the outline needs to
	 * open something. */
	path?: string;
	/** The raw value this container was built from, before splitting. Null for
	 * a note. Carried so the renderer can colour a row through the same
	 * property-value palette the rest of the plugin uses. */
	value: string | null;
	children: TreeNode[];
	/** Notes at or under this node. A note counts 1, so a container's count is
	 * the number of real notes it contains rather than its number of rows. */
	noteCount: number;
	/** Which `nestBy` slot produced this container, or the nesting depth a note
	 * landed at. Used by the renderer for indent guides. */
	depth: number;
}

export interface TreeModel {
	roots: TreeNode[];
	byId: Map<string, TreeNode>;
	/** Every note the base returned, whether or not a level could place it. */
	total: number;
}

/** The structural subset of a Bases entry this needs, matching
 * `GraphEntryLike` in `../logic/graphModel.ts` and widened with `basename`,
 * which folder-note merging compares against its folder name. Structural so
 * the tests can build entries without `obsidian`. */
export interface TreeEntryLike {
	file: {
		path: string;
		basename: string;
	};
	getValue(propertyId: BasesPropertyId): unknown;
}

/** Resolves a link value to a real note path, or null. Supplied by the view,
 * which has the metadata cache; keeping it a parameter is what lets this file
 * stay free of `obsidian`. */
export type ResolveNotePath = (linkpath: string, sourcePath: string) => string | null;

export type TreeSortOrder = 'name' | 'count' | 'modified';

export interface TreeModelOptions {
	/** The ordered nesting slots. Empty means a flat list of notes, which is a
	 * legitimate answer rather than an error state. */
	nestBy: BasesPropertyId[];
	/** Optional self-referencing note-to-note property (`parent`, `up`), which
	 * builds a genuine recursive chain inside the innermost nesting level.
	 * Null when unset, which is the common case. */
	parentProperty: BasesPropertyId | null;
	/** Split values containing `/` into nested levels. Default on: it is what
	 * makes `file.folder` and nested tags produce a hierarchy rather than a
	 * flat row per distinct full value. */
	splitNestedValues: boolean;
	/** A note whose basename equals the container it would sit in becomes that
	 * container's own row instead of a child of it. Default on: most vaults
	 * that use folder notes have one for nearly every folder, and without this
	 * every folder shows a same-named child inside itself. */
	mergeFolderNotes: boolean;
	sortOrder: TreeSortOrder;
	/** `file.mtime` per path, for `sortOrder: 'modified'`. Missing entries sort
	 * last rather than throwing. */
	modifiedTimes?: Map<string, number>;
	resolveNotePath?: ResolveNotePath;
}

export function buildTreeModel(entries: TreeEntryLike[], options: TreeModelOptions): TreeModel {
	const byId = new Map<string, TreeNode>();
	const roots: TreeNode[] = [];

	const noteIds = new Set(entries.map((entry) => entry.file.path));

	for (const entry of entries) {
		// Where this note's chain of containers ends, and therefore where the
		// note itself is attached. Starts at the roots, descends one level per
		// nesting slot that produced a value.
		let siblings = roots;
		let parent: TreeNode | null = null;
		let depth = 0;

		for (let level = 0; level < options.nestBy.length; level += 1) {
			const segments = containerSegments(entry, options.nestBy[level], options, noteIds);
			// A note the level cannot place is not dropped and is not an
			// orphan. It stays where it is and the remaining levels still get
			// their turn, so a note missing `status` still nests by `class`.
			for (const segment of segments) {
				const container = ensureContainer(siblings, byId, segment, depth, level, parent);
				parent = container;
				siblings = container.children;
				depth += 1;
			}
		}

		attachNote(entry, siblings, parent, byId, depth, options);
	}

	mergeResolvedNoteRows(roots, byId);

	if (options.parentProperty !== null) {
		applyParentProperty(entries, roots, byId, options);
	}

	countNotes(roots);
	sortTree(roots, options);
	return { roots, byId, total: entries.length };
}

interface ContainerSegment {
	/** Distinguishes containers built from different values at the same level. */
	key: string;
	label: string;
	value: string;
	/** Set when the value resolved onto a note the base returned. */
	path?: string;
}

/**
 * The containers one nesting slot contributes for one entry, outermost first.
 * Usually zero (no value) or one; more than one only when a value split on
 * `/`, which is the folder and nested-tag case.
 *
 * Only the first value of a multi-valued property is used. A note with
 * `tags: [a, b]` genuinely belongs in two places, and putting it in both would
 * make the note counts stop summing and turn "how many notes are under this"
 * into a question with no answer. First value, stably.
 */
function containerSegments(
	entry: TreeEntryLike,
	propertyId: BasesPropertyId,
	options: TreeModelOptions,
	noteIds: Set<string>,
): ContainerSegment[] {
	const values = stringifyValues(entry.getValue(propertyId));
	if (values.length === 0) return [];
	const raw = values[0];
	if (!isMeaningfulValue(raw)) return [];

	// A link is asked about the vault before it is treated as text, so a
	// `class: "[[CS 360]]"` nests under the real CS 360 note when the base
	// returned it. `resolveConnectTarget` in graphModel.ts makes the same call
	// for the same reason.
	const linkpath = unwrapWikilink(raw);
	if (linkpath !== null && options.resolveNotePath) {
		const resolved = options.resolveNotePath(linkpath, entry.file.path);
		if (resolved !== null && noteIds.has(resolved)) {
			return [{ key: `path:${resolved}`, label: basename(resolved), value: raw, path: resolved }];
		}
		// A value written as a link that resolves to nothing in the base is
		// still a category worth nesting under; it just uses its own text.
		return [{ key: `value:${linkpath}`, label: linkpath, value: raw }];
	}

	const text = linkpath ?? raw;
	if (!options.splitNestedValues || !text.includes('/')) {
		return [{ key: `value:${text}`, label: text, value: text }];
	}

	// Split, and key each segment by its full prefix rather than by its own
	// text, so `Skoo/Daily` and `Meta/Daily` produce two different `Daily`
	// rows under two different parents instead of colliding into one.
	const parts = text.split('/').map((part) => part.trim()).filter((part) => part.length > 0);
	const segments: ContainerSegment[] = [];
	let prefix = '';
	for (const part of parts) {
		prefix = prefix.length > 0 ? `${prefix}/${part}` : part;
		segments.push({ key: `value:${prefix}`, label: part, value: prefix });
	}
	return segments;
}

/**
 * Finds this level's container for a value among `siblings`, or creates it.
 *
 * The key is scoped to the parent, not just to the level. Two different
 * parents holding the same value are two different rows: `CS 360` under
 * `open` and `CS 360` under `done` are not the same bucket, and keying on
 * level and value alone made the second one resolve to the first, so it
 * collected every sibling's notes while its own parent was left childless.
 * The level stays in the key as well, so a value appearing at two depths
 * cannot merge either.
 */
function ensureContainer(
	siblings: TreeNode[],
	byId: Map<string, TreeNode>,
	segment: ContainerSegment,
	depth: number,
	level: number,
	parent: TreeNode | null,
): TreeNode {
	const id = `${parent?.id ?? ''}>c${level}:${segment.key}`;
	const existing = byId.get(id);
	if (existing) return existing;

	const container: TreeNode = {
		id,
		kind: 'container',
		label: segment.label,
		value: segment.value,
		children: [],
		noteCount: 0,
		depth,
	};
	if (segment.path !== undefined) container.path = segment.path;
	byId.set(id, container);
	siblings.push(container);
	return container;
}

/**
 * Attaches a note under the containers its values chose.
 *
 * Folder-note merging happens here rather than in a pass of its own: a note
 * whose basename matches the container it is about to enter *becomes* that
 * container's row, taking its path and label, instead of being pushed inside
 * it. Without it a vault that keeps `Skoo/CS 360/CS 360.md` shows a `CS 360`
 * row nested inside a `CS 360` row for every folder that has one.
 *
 * A container that already resolved onto a note (a `class` hub) is left alone,
 * because it is already that note's row and a second note cannot also be it.
 */
function attachNote(
	entry: TreeEntryLike,
	siblings: TreeNode[],
	parent: TreeNode | null,
	byId: Map<string, TreeNode>,
	depth: number,
	options: TreeModelOptions,
): void {
	if (
		options.mergeFolderNotes
		&& parent !== null
		&& parent.path === undefined
		&& parent.label === entry.file.basename
	) {
		parent.path = entry.file.path;
		byId.set(entry.file.path, parent);
		return;
	}

	const node: TreeNode = {
		id: entry.file.path,
		kind: 'note',
		label: entry.file.basename,
		path: entry.file.path,
		value: null,
		children: [],
		noteCount: 1,
		depth,
	};
	byId.set(node.id, node);
	siblings.push(node);
}

/**
 * Re-parents notes under the note their `parentProperty` names, producing the
 * genuine recursive chain that nesting slots cannot express (`A` under `B`
 * under `C`, all three notes).
 *
 * Runs after nesting so the two compose: slots build the outer containers,
 * this rearranges notes within whichever container they landed in. A parent in
 * a different container is honoured anyway, because a hierarchy the user wrote
 * down outranks one the view inferred.
 *
 * Cycles are broken by walking up from each candidate child and refusing the
 * link if the proposed parent is already below it. Self-parents (a hub whose
 * property points at itself, which is how this vault's `class` hubs are
 * written) are refused by the same check.
 */
function applyParentProperty(
	entries: TreeEntryLike[],
	roots: TreeNode[],
	byId: Map<string, TreeNode>,
	options: TreeModelOptions,
): void {
	const property = options.parentProperty as BasesPropertyId;
	const wanted = new Map<string, string>();

	for (const entry of entries) {
		const raw = stringifyValue(entry.getValue(property));
		if (!isMeaningfulValue(raw)) continue;
		const linkpath = unwrapWikilink(raw) ?? raw;
		const resolved = options.resolveNotePath?.(linkpath, entry.file.path) ?? null;
		if (resolved === null || resolved === entry.file.path) continue;
		if (byId.has(resolved) && byId.has(entry.file.path)) wanted.set(entry.file.path, resolved);
	}

	// Sorted so a cycle is broken at the same link every time rather than at
	// whichever one the entry order happened to reach first.
	for (const childPath of [...wanted.keys()].sort()) {
		const parentPath = wanted.get(childPath) as string;
		const child = byId.get(childPath) as TreeNode;
		const parent = byId.get(parentPath) as TreeNode;
		if (child === parent || isDescendant(parent, child)) continue;
		detach(child, roots, byId);
		parent.children.push(child);
	}
}

function isDescendant(candidate: TreeNode, ancestor: TreeNode): boolean {
	if (candidate === ancestor) return true;
	for (const child of ancestor.children) {
		if (isDescendant(candidate, child)) return true;
	}
	return false;
}

/**
 * Removes a node from wherever it currently sits, which is either the root
 * array or some node's `children`.
 *
 * The root array has to be checked explicitly and first. A top-level node is
 * in no other node's `children`, so a search that only walked `byId` would
 * find nothing, report success, and leave the node in place while it was also
 * pushed onto its new parent: one node, two rows, which is exactly what the
 * first cut of this did.
 */
function detach(node: TreeNode, roots: TreeNode[], byId: Map<string, TreeNode>): void {
	const atRoot = roots.indexOf(node);
	if (atRoot >= 0) {
		roots.splice(atRoot, 1);
		return;
	}
	for (const candidate of byId.values()) {
		const index = candidate.children.indexOf(node);
		if (index >= 0) {
			candidate.children.splice(index, 1);
			return;
		}
	}
}

/**
 * Folds a note's own row into the container that resolved onto it.
 *
 * A container built from `class: "[[CS 360]]"` carries the CS 360 note's path,
 * and the CS 360 note is usually in the base too, where it has no `class` of
 * its own and so lands as a plain row somewhere else. Left alone that is one
 * note drawn twice: once as the hub every sibling nests under, once as a loose
 * row beside it. The count on the hub would also be wrong, since the note
 * would be counted in whichever branch held the loose copy.
 *
 * Runs as a pass rather than inline because the two can be created in either
 * order: the note may be attached before any container resolves to it, or
 * after. Deferring until every entry has been placed removes the ordering
 * question entirely.
 */
function mergeResolvedNoteRows(roots: TreeNode[], byId: Map<string, TreeNode>): void {
	for (const container of [...byId.values()]) {
		if (container.kind !== 'container' || container.path === undefined) continue;
		const note = byId.get(container.path);
		if (note === undefined || note === container || note.kind !== 'note') continue;

		detach(note, roots, byId);
		// Anything already nested under the loose copy follows it into the
		// container, so a merge never drops a subtree.
		for (const child of note.children) container.children.push(child);
		byId.set(container.path, container);
	}
}

/** Notes at or under each node, bottom up. A container that resolved onto a
 * real note counts itself, because that row is a note. */
function countNotes(nodes: TreeNode[]): number {
	let total = 0;
	for (const node of nodes) {
		const own = node.kind === 'note' || node.path !== undefined ? 1 : 0;
		node.noteCount = own + countNotes(node.children);
		total += node.noteCount;
	}
	return total;
}

function sortTree(nodes: TreeNode[], options: TreeModelOptions): void {
	nodes.sort((a, b) => compareNodes(a, b, options));
	for (const node of nodes) sortTree(node.children, options);
}

/** Containers before notes at the same level, so a folder's subfolders are not
 * buried among its files, then by the chosen order, then by label so the same
 * input always produces the same tree. */
function compareNodes(a: TreeNode, b: TreeNode, options: TreeModelOptions): number {
	const aContainer = a.children.length > 0 ? 0 : 1;
	const bContainer = b.children.length > 0 ? 0 : 1;
	if (aContainer !== bContainer) return aContainer - bContainer;

	if (options.sortOrder === 'count' && a.noteCount !== b.noteCount) {
		return b.noteCount - a.noteCount;
	}
	if (options.sortOrder === 'modified') {
		const aTime = timeOf(a, options);
		const bTime = timeOf(b, options);
		if (aTime !== bTime) return bTime - aTime;
	}
	return a.label.localeCompare(b.label);
}

function timeOf(node: TreeNode, options: TreeModelOptions): number {
	if (node.path === undefined || !options.modifiedTimes) return 0;
	return options.modifiedTimes.get(node.path) ?? 0;
}

function basename(path: string): string {
	const withoutFolder = path.slice(path.lastIndexOf('/') + 1);
	const dot = withoutFolder.lastIndexOf('.');
	return dot > 0 ? withoutFolder.slice(0, dot) : withoutFolder;
}

/**
 * Keeps every node matching `query` and every ancestor of a match, so a hit
 * three levels down stays reachable instead of appearing at the root without
 * its context. Returns a new tree; the model is not mutated, because the
 * filter box is live and the unfiltered tree has to survive backspace.
 */
export function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return nodes;

	const keep: TreeNode[] = [];
	for (const node of nodes) {
		const children = filterTree(node.children, query);
		const hit = node.label.toLowerCase().includes(needle);
		if (hit || children.length > 0) keep.push({ ...node, children });
	}
	return keep;
}
