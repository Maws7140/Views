import type { BasesPropertyId } from 'obsidian';
import type { GraphEdge, GraphModel, GraphNode, GraphNodeKind } from '../graph/types';

/**
 * Turns a set of Bases entries into a `GraphModel` (`src/graph/types.ts`).
 * Reads the metadata cache directly; knows nothing about drawing. Everything
 * below is structurally typed against the slice of the real Obsidian API it
 * needs, so it can be exercised with plain objects in a node script with no
 * live workspace. A real `App['metadataCache']`, `TFile` and `BasesEntry`
 * satisfy these shapes without a cast.
 */

export interface GraphFileLike {
	path: string;
	/** File extension without the leading dot, e.g. `md`, `png`, `pdf`. A real
	 * `TFile` already carries this. Used to decide whether a link target is a
	 * note worth drawing or an attachment, per `GraphExtractionOptions.includeAttachments`. */
	extension: string;
}

export interface GraphEntryLike {
	file: GraphFileLike;
	getValue(propertyId: BasesPropertyId): unknown;
}

export interface GraphReferenceLike {
	link: string;
	original: string;
	displayText?: string;
}

export interface GraphFrontmatterLinkLike extends GraphReferenceLike {
	key: string;
}

export interface GraphCachedMetadataLike {
	frontmatterLinks?: GraphFrontmatterLinkLike[];
	links?: GraphReferenceLike[];
}

export interface GraphMetadataCacheLike {
	getFileCache(file: GraphFileLike): GraphCachedMetadataLike | null;
	getFirstLinkpathDest(linkpath: string, sourcePath: string): GraphFileLike | null;
}

export interface GraphExtractionOptions {
	/** Properties to connect notes through, from the `Connect by` slots.
	 *
	 * This is the graph's main connection mechanism, because links are not.
	 * Measured on a real vault of 2032 notes, 21% have a link in frontmatter and
	 * 20% in the body, so a link-first graph leaves three quarters of a vault as
	 * unconnected dust. What notes do have is properties.
	 *
	 * Per value of a chosen property, per entry:
	 *
	 * - A value that names a note (a wikilink, or plain text resolving to a note
	 *   on the canvas) draws an edge to **that real note**, through the same
	 *   dedup key frontmatter link extraction uses. A link-valued property
	 *   therefore produces exactly the edge it already produced, never a second
	 *   parallel one, and never a synthetic twin of a note already drawn.
	 * - Any other value becomes a node of its own, and every note carrying that
	 *   value draws one line to it. This is Obsidian's tag-node model, and it is
	 *   what puts a hub at the centre of a cluster on a vault that writes plain
	 *   text.
	 *
	 * Not pairwise. Connecting every pair of notes sharing a value is quadratic:
	 * on that same vault, `status` alone is 32,317 lines, 28,441 of them from the
	 * 239 notes sharing `unread`, against 442 lines for the same information as
	 * hubs. */
	connectByProperties?: BasesPropertyId[];
	/** Frontmatter properties to turn into edges. Empty or omitted means every
	 * property that carries a frontmatter link. Property ids, e.g. `note.related`.
	 *
	 * No longer settable: the option that wrote it now feeds
	 * `connectByProperties` instead. It stays because a `.base` on disk can still
	 * carry the key, and because dropping the read would change what those bases
	 * draw. */
	linkProperties?: BasesPropertyId[];
	/** Body links from `CachedMetadata.links`, as unlabelled edges. Off by default. */
	includeBodyLinks?: boolean;
	/** Groups from the base's own Group by, one `value` node each.
	 *
	 * This is where value nodes come from now. Obsidian's Group by menu is
	 * available on every Bases view including this one, and
	 * `BasesQueryResult.groupedData` is the authoritative grouped projection,
	 * so a second property picker of our own would be a worse copy of a control
	 * the user already has.
	 *
	 * Carries the group's value but not the property it grouped by, because the
	 * Bases API does not expose that (`KanbanView` recovers it by parsing the
	 * `.base` YAML). The graph does not need it: a group's node is labelled with
	 * the value, so nothing on screen is missing it, and group edges are left
	 * unlabelled rather than printing the same property name over every edge in
	 * the graph. */
	/** Icon spec for every Connect-by value node, resolved through the same
	 * `iconRaster` chain a note's icon is, so emoji, Lucide names and Notebook
	 * Navigator icons all work here too. Null leaves the value kind's own default
	 * glyph in place. */
	connectByIcon?: string | null;
	valueGroups?: { label: string; paths: string[] }[];
	/** Properties whose distinct values become `value` nodes, e.g. `note.status`.
	 *
	 * Superseded by `valueGroups`: the option that set this is gone from the
	 * settings UI, and `GraphView` only reads the stored key when the base has
	 * no grouping configured, so a base saved before the move keeps the value
	 * nodes it had. */
	valueNodeProperties?: BasesPropertyId[];
	/** Whether a link to a non-markdown file (an image behind a `cover`
	 * property, a PDF, an attachment of any other kind) becomes a node. Off by
	 * default: most bases link attachments incidentally, and a base with a
	 * `cover` property otherwise fills the canvas with note-shaped tiles for
	 * files that are not notes. */
	includeAttachments?: boolean;
	/** Whether a link that points somewhere the base did not return becomes a
	 * node: a note the base's filters excluded, or a link to a note that does
	 * not exist at all.
	 *
	 * Off by default, which is what makes a filter mean something here. The
	 * entries handed in are the base's results, already filtered, but a link
	 * out of one of them resolves against the vault rather than against the
	 * base, so drawing every link target put filtered-out notes back on the
	 * canvas and a filter appeared to do nothing. With this off the canvas
	 * shows the base's own notes (plus any value nodes, which are derived from
	 * those same notes) and nothing else.
	 *
	 * Attachments are governed by `includeAttachments` above rather than by
	 * this: an attachment is never a base result, so folding the two together
	 * would make that option unreachable. */
	includeExternalLinks?: boolean;
	/** The view's type property. Fills `GraphNode.typeValue` on note nodes that
	 * have a matching entry. */
	typeProperty?: BasesPropertyId | null;
	/** The plugin's shared icon resolver, bound to the view's config by the
	 * caller. Passed in rather than read here so this module stays free of
	 * Obsidian at runtime: resolution needs the app, the metadata cache and the
	 * Notebook Navigator plugin, none of which belong in graph extraction. */
	resolveIcons?: (entry: GraphEntryLike) => string[];
	/** Maximum number of nodes to keep. Undefined or non-positive means no cap. */
	nodeCap?: number;
}

const ARRAY_INDEX_SUFFIX = /\.\d+$/;

/**
 * `frontmatterLinks` keys an array property's elements as `related.0`,
 * `related.1`. Stripping the trailing numeric segment collapses them onto one
 * property name, which is also the edge label.
 */
function stripArrayIndex(key: string): string {
	return key.replace(ARRAY_INDEX_SUFFIX, '');
}

/** A property id from whatever the caller has: a full id (`note.related`,
 * `file.tags`, `formula.Progress`) is kept, and a bare frontmatter name
 * (`related`) is prefixed, since frontmatter is where a bare name can only
 * have come from.
 *
 * Exported because `GraphView` has to normalize the same way before handing
 * over a user-typed property list. It did not, and the mismatch silently
 * emptied the graph: a `Link properties` entry of `class` was compared against
 * the `note.class` this produces, matched nothing, and filtered out every edge
 * in the base. */
export function normalizePropertyId(fieldName: string): BasesPropertyId {
	return (/^(?:note|file|formula)\./.test(fieldName) ? fieldName : `note.${fieldName}`) as BasesPropertyId;
}

function toPropertyId(fieldName: string): BasesPropertyId {
	return normalizePropertyId(fieldName);
}

function displayPropertyName(propertyId: BasesPropertyId): string {
	return propertyId.startsWith('note.') ? propertyId.slice('note.'.length) : propertyId;
}

function basenameFromPath(path: string): string {
	const withoutFolder = path.slice(path.lastIndexOf('/') + 1);
	const dot = withoutFolder.lastIndexOf('.');
	return dot > 0 ? withoutFolder.slice(0, dot) : withoutFolder;
}

function linkDisplayText(ref: GraphReferenceLike): string {
	return ref.displayText || ref.link;
}

/** An empty or whitespace-only property has no value, and neither does one
 * whose `Value` wrapper stringifies to the literal text `null` or `undefined`
 * because the underlying property is empty. None of these are a value worth
 * putting on the canvas as a node, only an artifact of stringifying nothing. */
/** Strips the `[[...]]` wrapper (and any `|alias` or `#heading`) off a value
 * that was written as a wikilink, so `"[[CS 221]]"` and `CS 221` are asked
 * about the vault in exactly the same way. Returns null for a value that was
 * not written as a link, which is then tried as a plain note name anyway.
 *
 * Module scope and exported because `src/tree/treeModel.ts` asks the same
 * question of the same values, and a second implementation there would be
 * free to disagree with this one about what counts as a link. */
export function unwrapWikilink(value: string): string | null {
	const match = /^\[\[([^\]]+)\]\]$/.exec(value.trim());
	if (!match) return null;
	return match[1].split('|')[0].split('#')[0].trim();
}

export function isMeaningfulValue(text: string): boolean {
	if (text.length === 0) return false;
	const lower = text.toLowerCase();
	return lower !== 'null' && lower !== 'undefined';
}

export function stringifyValue(raw: unknown): string {
	if (raw === null || raw === undefined) return '';
	const text = typeof raw === 'string'
		? raw.trim()
		: typeof raw === 'object' && typeof (raw as { toString?: () => string }).toString === 'function'
			? (raw as { toString: () => string }).toString().trim()
			: String(raw).trim();
	if (text === '[object Object]') return '';
	return isMeaningfulValue(text) ? text : '';
}

/** Frontmatter arrays surface as array-like `Value` objects. Handles a real
 * array, an iterable, or a single scalar uniformly. */
export function stringifyValues(raw: unknown): string[] {
	if (raw === null || raw === undefined) return [];
	if (Array.isArray(raw)) {
		return raw.map(stringifyValue).filter((value) => value.length > 0);
	}
	const single = stringifyValue(raw);
	return single.length > 0 ? [single] : [];
}

interface DirectedLinkEdge {
	from: string;
	to: string;
	label: string | null;
	property: BasesPropertyId | null;
}

interface WorkingNode {
	node: GraphNode;
	degree: number;
}

/**
 * Builds the graph model for a set of Bases entries.
 *
 * Reciprocal collapse rule: an unordered pair of note nodes collapses to one
 * `reciprocal: true` edge only when that pair has exactly one directed edge
 * each way. A pair with more than one edge in either direction (two distinct
 * properties both pointing the same way, for instance) is left as separate
 * directed edges, since there is no non-arbitrary way to decide which pair of
 * edges is "the" reciprocal one.
 */
export function buildGraphModel(
	entries: GraphEntryLike[],
	metadataCache: GraphMetadataCacheLike,
	options: GraphExtractionOptions = {},
): GraphModel {
	const linkPropertyFilter = options.linkProperties && options.linkProperties.length > 0
		? new Set(options.linkProperties)
		: null;
	const valueNodeProperties = options.valueNodeProperties ?? [];
	const valueGroups = options.valueGroups ?? [];
	const includeBodyLinks = options.includeBodyLinks ?? false;
	const includeAttachments = options.includeAttachments ?? false;
	const includeExternalLinks = options.includeExternalLinks ?? false;
	const connectByProperties = options.connectByProperties ?? [];
	const connectByIcon = options.connectByIcon ?? null;
	const typeProperty = options.typeProperty ?? null;
	const resolveIcons = options.resolveIcons ?? null;

	const entryByPath = new Map<string, GraphEntryLike>();
	for (const entry of entries) entryByPath.set(entry.file.path, entry);

	const nodes = new Map<string, GraphNode>();

	function noteTypeValue(entry: GraphEntryLike | undefined): string | null {
		if (!entry || !typeProperty) return null;
		const value = stringifyValue(entry.getValue(typeProperty));
		return value.length > 0 ? value : null;
	}

	function noteIcons(entry: GraphEntryLike | undefined): string[] {
		if (!entry || !resolveIcons) return [];
		return resolveIcons(entry);
	}

	function ensureNoteNode(path: string): GraphNode {
		const existing = nodes.get(path);
		if (existing) return existing;
		const entry = entryByPath.get(path);
		const node: GraphNode = {
			id: path,
			kind: 'note',
			label: basenameFromPath(path),
			path,
			icons: noteIcons(entry),
			typeValue: noteTypeValue(entry),
			degree: 0,
		};
		nodes.set(path, node);
		return node;
	}

	function ensureUnresolvedNode(linkText: string): GraphNode | null {
		if (!isMeaningfulValue(linkText.trim())) return null;
		const id = `unresolved:${linkText}`;
		const existing = nodes.get(id);
		if (existing) return existing;
		const node: GraphNode = {
			id,
			kind: 'unresolved',
			label: linkText,
			icons: [],
			typeValue: null,
			degree: 0,
		};
		nodes.set(id, node);
		return node;
	}

	/** A group's node. Keyed separately from `ensureValueNode`'s
	 * `property:value` ids so a base carrying both (a legacy value property and
	 * a Group by that happens to name the same values) cannot collide them into
	 * one node. */
	function ensureGroupNode(label: string): GraphNode {
		const id = `group:${label}`;
		const existing = nodes.get(id);
		if (existing) return existing;
		const node: GraphNode = {
			id,
			kind: 'value',
			label,
			icons: [],
			typeValue: null,
			degree: 0,
		};
		nodes.set(id, node);
		return node;
	}

	/** A node standing for one value of one Connect-by property.
	 *
	 * Keyed per property as well as per value, so `status: done` and
	 * `class: done` are two different things rather than one node every note in
	 * the base hangs off.
	 *
	 * `typeValue` is the value's own text, and that is what stops these being the
	 * grey blanks they used to be: the renderer colours a node from its
	 * `typeValue` through the shared palette and the property value colour
	 * overrides, so `unread` gets a colour of its own and the same colour it has
	 * everywhere else in the plugin. `icons` is whatever the caller configured for
	 * this property, falling back to the value kind's own glyph. */
	function ensureConnectValueNode(propertyId: BasesPropertyId, value: string, icon: string | null): GraphNode {
		const id = `value:${propertyId}:${value}`;
		const existing = nodes.get(id);
		if (existing) return existing;
		const node: GraphNode = {
			id,
			kind: 'value',
			label: value,
			icons: icon ? [icon] : [],
			typeValue: value,
			degree: 0,
		};
		nodes.set(id, node);
		return node;
	}

	function ensureValueNode(propertyId: BasesPropertyId, value: string): GraphNode {
		const id = `${propertyId}:${value}`;
		const existing = nodes.get(id);
		if (existing) return existing;
		const node: GraphNode = {
			id,
			kind: 'value',
			label: value,
			icons: [],
			typeValue: null,
			degree: 0,
		};
		nodes.set(id, node);
		return node;
	}

	/** Null means "no node for this link", and there are four reasons for it:
	 * the link text itself carried no real value (an empty or literal-null
	 * reference, the link-path half of bug 2); it resolved to a non-markdown
	 * file and `includeAttachments` is off (bug 1: a `cover` property pointing
	 * at an image should not put an image tile on the canvas by default); it
	 * resolved to a note the base did not return, with `includeExternalLinks`
	 * off; or it resolved to nothing at all, which is equally not a base
	 * result. The last two are what make the base's filters mean something on
	 * the canvas. */
	function resolveLinkTarget(ref: GraphReferenceLike, sourcePath: string): GraphNode | null {
		if (!isMeaningfulValue(ref.link.trim())) return null;
		const dest = metadataCache.getFirstLinkpathDest(ref.link, sourcePath);
		if (dest) {
			if (dest.extension !== 'md') return includeAttachments ? ensureNoteNode(dest.path) : null;
			if (!entryByPath.has(dest.path) && !includeExternalLinks) return null;
			return ensureNoteNode(dest.path);
		}
		if (!includeExternalLinks) return null;
		return ensureUnresolvedNode(linkDisplayText(ref));
	}

	/** What a Connect-by value points at: a real note when the value names one,
	 * and a node standing for the value itself otherwise.
	 *
	 * Preferring the real note is the whole point. A base grouping by `class`
	 * where every note writes `class: "[[CS 221]]"` should strengthen the CS 221
	 * note that is already on the canvas, not stand a synthetic `CS 221` beside
	 * it and split its edges between the two. */
	function resolveConnectTarget(
		value: string,
		sourcePath: string,
		propertyId: BasesPropertyId,
		icon: string | null,
	): GraphNode | null {
		const text = value.trim();
		if (!isMeaningfulValue(text)) return null;
		const linkpath = unwrapWikilink(text) ?? text;
		const dest = metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		if (dest && dest.extension === 'md' && (entryByPath.has(dest.path) || includeExternalLinks)) {
			return ensureNoteNode(dest.path);
		}
		// A value that was explicitly written as a link and resolves to nothing is
		// a broken link, and says so, rather than quietly becoming a category.
		if (unwrapWikilink(text) && !dest) return ensureUnresolvedNode(linkpath);
		return ensureConnectValueNode(propertyId, text, icon);
	}

	// Every entry passed in is part of the graph regardless of whether it has
	// any resolvable links.
	for (const entry of entries) ensureNoteNode(entry.file.path);

	const dedupedLinkEdges = new Map<string, DirectedLinkEdge>();

	function addLinkEdge(from: string, to: string, label: string | null, property: BasesPropertyId | null): void {
		const key = `${from} ${to} ${property ?? ''}`;
		if (dedupedLinkEdges.has(key)) return;
		dedupedLinkEdges.set(key, { from, to, label, property });
	}

	for (const entry of entries) {
		const sourcePath = entry.file.path;
		const cache = metadataCache.getFileCache(entry.file);
		if (!cache) continue;

		for (const link of cache.frontmatterLinks ?? []) {
			const propertyName = stripArrayIndex(link.key);
			const propertyId = toPropertyId(propertyName);
			if (linkPropertyFilter && !linkPropertyFilter.has(propertyId)) continue;
			const target = resolveLinkTarget(link, sourcePath);
			if (!target || target.id === sourcePath) continue;
			addLinkEdge(sourcePath, target.id, propertyName, propertyId);
		}

		if (includeBodyLinks) {
			for (const link of cache.links ?? []) {
				const target = resolveLinkTarget(link, sourcePath);
				if (!target || target.id === sourcePath) continue;
				addLinkEdge(sourcePath, target.id, null, null);
			}
		}
	}

	// Connect by: the property values that tie notes together.
	//
	// Runs after link extraction and through the same `addLinkEdge` dedup key, so
	// a property whose values are wikilinks resolves to the edge that extraction
	// already made rather than a second one lying on top of it.
	for (const propertyId of connectByProperties) {
		const propertyName = displayPropertyName(propertyId);
		const icon = connectByIcon;
		for (const entry of entries) {
			const sourcePath = entry.file.path;
			for (const value of stringifyValues(entry.getValue(propertyId))) {
				const target = resolveConnectTarget(value, sourcePath, propertyId, icon);
				if (!target || target.id === sourcePath) continue;
				addLinkEdge(sourcePath, target.id, propertyName, propertyId);
			}
		}
	}

	// Group directed edges by the unordered node pair so reciprocal pairs can
	// be found without an O(n^2) scan.
	const byPair = new Map<string, DirectedLinkEdge[]>();
	for (const edge of dedupedLinkEdges.values()) {
		const pairKey = edge.from < edge.to ? `${edge.from} ${edge.to}` : `${edge.to} ${edge.from}`;
		const bucket = byPair.get(pairKey);
		if (bucket) bucket.push(edge);
		else byPair.set(pairKey, [edge]);
	}

	const edges: GraphEdge[] = [];
	for (const bucket of byPair.values()) {
		if (bucket.length === 2 && bucket[0].from === bucket[1].to && bucket[0].to === bucket[1].from) {
			const [outbound, inbound] = bucket;
			edges.push({
				from: outbound.from,
				to: outbound.to,
				label: outbound.label,
				property: outbound.property,
				reciprocal: true,
				reciprocalLabel: inbound.label,
			});
			continue;
		}
		for (const edge of bucket) {
			edges.push({
				from: edge.from,
				to: edge.to,
				label: edge.label,
				property: edge.property,
				reciprocal: false,
			});
		}
	}

	// Group nodes, like the value nodes below, are additive and never
	// participate in reciprocal collapse: the edge always points from the note
	// to the value it was grouped under.
	for (const group of valueGroups) {
		if (!isMeaningfulValue(group.label.trim())) continue;
		const groupNode = ensureGroupNode(group.label);
		const seen = new Set<string>();
		for (const path of group.paths) {
			// An entry the graph did not build a node for (the node cap dropped
			// it, or it is not in this result at all) gets no edge, rather than
			// an edge to a node that is not there.
			if (!entryByPath.has(path) || seen.has(path)) continue;
			seen.add(path);
			edges.push({
				from: path,
				to: groupNode.id,
				label: null,
				property: null,
				reciprocal: false,
			});
		}
	}

	// Value nodes are additive and never participate in reciprocal collapse:
	// the edge always points from the note to the value.
	if (valueNodeProperties.length > 0) {
		const dedupedValueEdges = new Set<string>();
		for (const entry of entries) {
			const sourcePath = entry.file.path;
			for (const propertyId of valueNodeProperties) {
				const values = stringifyValues(entry.getValue(propertyId));
				for (const value of values) {
					const valueNode = ensureValueNode(propertyId, value);
					const key = `${sourcePath} ${valueNode.id}`;
					if (dedupedValueEdges.has(key)) continue;
					dedupedValueEdges.add(key);
					edges.push({
						from: sourcePath,
						to: valueNode.id,
						label: displayPropertyName(propertyId),
						property: propertyId,
						reciprocal: false,
					});
				}
			}
		}
	}

	for (const edge of edges) {
		const fromNode = nodes.get(edge.from);
		const toNode = nodes.get(edge.to);
		if (fromNode) fromNode.degree += 1;
		if (toNode) toNode.degree += 1;
	}

	const allNodes = Array.from(nodes.values());
	const cap = options.nodeCap ?? 0;
	if (cap > 0 && allNodes.length > cap) {
		const ranked = [...allNodes].sort((a, b) => (b.degree - a.degree) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const kept = new Set(ranked.slice(0, cap).map((node) => node.id));
		const finalNodes = allNodes.filter((node) => kept.has(node.id));
		const finalEdges = edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
		// Degree is recounted against the edges that survived the cap. Left at
		// its pre-cap value it describes a graph the renderer is not drawing: a
		// node would claim eight neighbours while two lines touch it, and
		// anything sizing or ranking a node by degree would be reading a number
		// with nothing on screen to back it up.
		for (const node of finalNodes) node.degree = 0;
		const byId = new Map(finalNodes.map((node) => [node.id, node]));
		for (const edge of finalEdges) {
			const fromNode = byId.get(edge.from);
			const toNode = byId.get(edge.to);
			if (fromNode) fromNode.degree += 1;
			if (toNode) toNode.degree += 1;
		}
		return {
			nodes: finalNodes,
			edges: finalEdges,
			truncated: { shown: finalNodes.length, total: allNodes.length },
		};
	}

	return { nodes: allNodes, edges, truncated: null };
}
