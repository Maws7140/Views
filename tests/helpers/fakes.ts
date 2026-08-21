import type {
	GraphEntryLike,
	GraphFileLike,
	GraphFrontmatterLinkLike,
	GraphMetadataCacheLike,
	GraphReferenceLike,
} from '../../src/logic/graphModel';

/**
 * Shared fixtures for the graph extraction tests. Kept here instead of
 * repeated per test file, since four separate sessions each paid for a
 * version of the same fake vault before this harness existed.
 */

export function fakeFile(path: string, extension = 'md'): GraphFileLike {
	return { path, extension };
}

/** A property store for one fake entry, keyed by the bare property name
 * (without the `note.` prefix `toPropertyId` adds). */
export function fakeEntry(path: string, values: Record<string, unknown> = {}, extension = 'md'): GraphEntryLike {
	return {
		file: fakeFile(path, extension),
		getValue(propertyId) {
			const name = propertyId.startsWith('note.') ? propertyId.slice('note.'.length) : propertyId;
			return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
		},
	};
}

export function fakeFrontmatterLink(key: string, link: string, displayText?: string): GraphFrontmatterLinkLike {
	return { key, link, original: `[[${link}]]`, displayText };
}

export function fakeBodyLink(link: string, displayText?: string): GraphReferenceLike {
	return { link, original: `[[${link}]]`, displayText };
}

/**
 * A metadata cache over a fixed set of files and their frontmatter/body
 * links. `getFirstLinkpathDest` resolves against `resolvable` by exact path
 * or basename, the way Obsidian resolves a short wikilink; anything not
 * listed there is an unresolved link.
 */
export function fakeMetadataCache(
	filesByPath: Map<string, { cache: { frontmatterLinks?: GraphFrontmatterLinkLike[]; links?: GraphReferenceLike[] } }>,
	resolvable: GraphFileLike[],
): GraphMetadataCacheLike {
	const byBasename = new Map<string, GraphFileLike>();
	const byPath = new Map<string, GraphFileLike>();
	for (const file of resolvable) {
		byPath.set(file.path, file);
		const base = file.path.replace(/\.[^./]+$/, '').split('/').pop() ?? file.path;
		byBasename.set(base, file);
	}
	return {
		getFileCache(file) {
			return filesByPath.get(file.path)?.cache ?? null;
		},
		getFirstLinkpathDest(linkpath) {
			return byPath.get(linkpath) ?? byBasename.get(linkpath) ?? null;
		},
	};
}

/** A `Value`-shaped wrapper whose `toString()` does not return its own
 * text, the way Bases' own property values behave. Used to reproduce the
 * bug where a wrapper stringifying to the literal `"null"` passed the old
 * non-empty check. */
export function stringWrapper(text: string): { toString(): string } {
	return { toString: () => text };
}
