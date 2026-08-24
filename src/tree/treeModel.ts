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
	/**
	 * What this row *is*, as the chain of values leading to it: `Skoo/CS 360`,
	 * or a note's path.
	 *
	 * Distinct from `id`, which encodes level indices so that two levels
	 * sharing a value cannot collide. That makes `id` correct for identity
	 * within one render and useless for anything persisted: reordering the
	 * hierarchy renumbers every level, so every id changes and every saved
	 * key becomes both stale and liable to match the wrong row later. The
	 * chain survives a reorder, and reads as itself in a `.base` file.
	 */
	chain: string;
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

/**
 * One of the base's own groups, as `BasesQueryResult.groupedData` returns
 * them: already grouped, filtered, sorted and limited by Bases. `key` is the
 * stringified group value, or null when the base has no Group by, in which
 * case Bases hands back a single keyless group and the nesting slots below do
 * all the work.
 */
export interface TreeGroup {
	key: string | null;
	entries: TreeEntryLike[];
}

export interface TreeModelOptions {
	/** Nesting levels *inside* each of the base's groups. The base's own Group
	 * by supplies the outermost level, so these start at the second. Empty is
	 * a legitimate answer, not an error state. */
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
	resolveNotePath?: ResolveNotePath;
}

/**
 * Builds the tree from the base's own groups.
 *
 * Grouping, sorting, filtering and the results limit are Bases features and
 * stay Bases features: `groupedData` arrives with all four already applied,
 * and this walks it in the order it is given. Rebuilding any of them as a view
 * option would produce a second answer free to disagree with the Group by and
 * Sort by menus the user already set, which is the bug `CollectionView.ts`
 * documents having shipped once already.
 *
 * So there is no sort here. Containers appear in the order their first note
 * appears, which is the base's sort order, and a level's rows follow it.
 */
export function buildTreeModel(groups: TreeGroup[], options: TreeModelOptions): TreeModel {
	const byId = new Map<string, TreeNode>();
	const roots: TreeNode[] = [];

	const noteIds = new Set<string>();
	let total = 0;
	for (const group of groups) {
		for (const entry of group.entries) {
			noteIds.add(entry.file.path);
			total += 1;
		}
	}

	for (const group of groups) {
		for (const entry of group.entries) {
			// Where this note's chain of containers ends, and therefore where
			// the note itself is attached. Starts at the roots and descends one
			// level per container the group key and the slots produce.
			let siblings = roots;
			let parent: TreeNode | null = null;
			let depth = 0;

			// The base's Group by is the outermost level. It splits on `/` like
			// any other value, which is what makes `groupBy: file.folder`
			// produce a real folder tree rather than one flat row per path.
			for (const segment of valueSegments(group.key, options)) {
				const container = ensureContainer(siblings, byId, segment, depth, 0, parent);
				parent = container;
				siblings = container.children;
				depth += 1;
			}

			for (let level = 0; level < options.nestBy.length; level += 1) {
				const segments = containerSegments(entry, options.nestBy[level], options, noteIds);
				// A note a level cannot place is not dropped and is not an
				// orphan. It stays where it is and the remaining levels still
				// get their turn, so a note missing `status` still nests by
				// `class`.
				for (const segment of segments) {
					const container = ensureContainer(siblings, byId, segment, depth, level + 1, parent);
					parent = container;
					siblings = container.children;
					depth += 1;
				}
			}

			attachNote(entry, siblings, parent, byId, depth, options);
		}
	}

	mergeResolvedNoteRows(roots, byId);

	if (options.parentProperty !== null) {
		applyParentProperty(groups.flatMap((group) => group.entries), roots, byId, options);
	}

	countNotes(roots);
	return { roots, byId, total };
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

	return valueSegments(linkpath ?? raw, options);
}

/**
 * A plain value's containers, splitting on `/` into one level per segment.
 *
 * Shared by the base's group key and by every nesting slot, so `file.folder`
 * behaves the same whether the user reached it through Group by or through a
 * slot. Without the split a path gives one flat row per distinct full value,
 * which is the shape of a table rather than of a tree.
 */
function valueSegments(raw: string | null, options: TreeModelOptions): ContainerSegment[] {
	if (raw === null) return [];
	const text = raw.trim();
	if (!isMeaningfulValue(text)) return [];

	if (!options.splitNestedValues || !text.includes('/')) {
		return [{ key: `value:${text}`, label: text, value: text }];
	}

	// Key each segment by its full prefix rather than by its own text, so
	// `Skoo/Daily` and `Meta/Daily` produce two different `Daily` rows under
	// two different parents instead of colliding into one.
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
		// The label, not the value: a split segment's `value` is already its
		// full prefix (`Skoo/CS 360`), so appending that to the parent's chain
		// would repeat every ancestor. A link-resolved container uses its path
		// instead, since two notes in different folders can share a basename
		// and their chains must not collide.
		chain: chainFor(parent, segment),
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
		// A note's path already identifies it uniquely and survives any
		// reshuffle of the levels above it, so it is its own chain.
		chain: entry.file.path,
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

/** A row's persisted identity: the parent's chain plus this segment's own
 * leaf name. Kept next to `ensureContainer` because the two have to agree. */
function chainFor(parent: TreeNode | null, segment: ContainerSegment): string {
	const own = segment.path ?? segment.label;
	return parent === null ? own : `${parent.chain}/${own}`;
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
