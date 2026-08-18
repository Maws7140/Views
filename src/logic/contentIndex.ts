import { App, CachedMetadata, TFile } from 'obsidian';

/**
 * What a note's body contains, for the Search view's content filter. Nothing
 * here is a Bases filter: there is no hook to register one
 * (`registerBasesView` is the only Bases extension point), so this only ever
 * narrows what this plugin's own views already rendered.
 */
export interface ContentFacts {
	mtime: number;
	/** Lowercased body text, front matter stripped. */
	text: string;
	hasCode: boolean;
	codeLangs: string[];
	hasCallout: boolean;
	calloutTypes: string[];
	tasks: { total: number; done: number };
}

const CODE_FENCE_RE = /^\s*(?:```+|~~~+)\s*([^\s`~]*)/;
const CALLOUT_MARKER_RE = /^\s*>\s*\[!([^\]]+)\]/;

/**
 * Strips a leading YAML front matter block. `metadataCache.frontmatterPosition`
 * already knows where it ends, when the cache has one; falling back to a
 * fence scan covers the gap between a file changing on disk and the cache
 * catching up.
 */
export function stripFrontMatter(raw: string, frontmatterEndLine?: number): string {
	if (frontmatterEndLine !== undefined) {
		const lines = raw.split('\n');
		return lines.slice(frontmatterEndLine + 1).join('\n');
	}
	if (!raw.startsWith('---')) return raw;
	const lines = raw.split('\n');
	if (lines[0].trim() !== '---') return raw;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n');
	}
	return raw;
}

/**
 * The cache's `sections` entry for a fenced code block only says the block is
 * there (`type: 'code'`); the language on the opening fence is not exposed,
 * so this reads it straight off the source line. Returns '' for an
 * unlabelled fence, which still counts toward `hasCode`.
 */
export function extractCodeLanguage(line: string): string {
	const match = CODE_FENCE_RE.exec(line);
	if (!match) return '';
	return match[1].toLowerCase();
}

/**
 * Same story as the code language: the cache says a section is a callout
 * (`type: 'callout'`) but not which kind, so the `[!type]` marker on the
 * block's first line is read directly.
 */
export function extractCalloutType(line: string): string {
	const match = CALLOUT_MARKER_RE.exec(line);
	if (!match) return '';
	// A callout marker can carry a fold hint, e.g. `[!note]+`; only the type
	// name before it is the callout's kind.
	return match[1].trim().toLowerCase();
}

function factsFromCache(rawLines: string[], cache: CachedMetadata | null): Pick<ContentFacts, 'hasCode' | 'codeLangs' | 'hasCallout' | 'calloutTypes' | 'tasks'> {
	const codeLangs = new Set<string>();
	const calloutTypes = new Set<string>();
	let hasCode = false;
	let hasCallout = false;
	for (const section of cache?.sections ?? []) {
		const line = rawLines[section.position.start.line] ?? '';
		if (section.type === 'code') {
			hasCode = true;
			const lang = extractCodeLanguage(line);
			if (lang) codeLangs.add(lang);
		} else if (section.type === 'callout') {
			hasCallout = true;
			const kind = extractCalloutType(line);
			if (kind) calloutTypes.add(kind);
		}
	}
	let total = 0;
	let done = 0;
	for (const item of cache?.listItems ?? []) {
		if (item.task === undefined) continue;
		total += 1;
		if (item.task !== ' ') done += 1;
	}
	return {
		hasCode,
		codeLangs: [...codeLangs],
		hasCallout,
		calloutTypes: [...calloutTypes],
		tasks: { total, done },
	};
}

/**
 * Lazy, bounded, per-file index of note body content. Built only for the
 * files a view is about to show, never swept across the vault. Cached by
 * path keyed on mtime, and invalidated eagerly when the metadata cache
 * reports a file changed so a stale entry is never served after an edit.
 */
export class ContentIndex {
	private readonly cache = new Map<string, ContentFacts>();

	constructor(private readonly app: App) {}

	/** Called from the metadata cache's `changed` event by the owning view. */
	invalidate(path: string): void {
		this.cache.delete(path);
	}

	/**
	 * Resolves facts for exactly the given files, reusing any entry still
	 * valid for the file's current mtime. Returns a map keyed by path; a file
	 * that could not be read is omitted rather than given fabricated facts.
	 */
	async resolve(files: TFile[]): Promise<Map<string, ContentFacts>> {
		const result = new Map<string, ContentFacts>();
		await Promise.all(files.map(async (file) => {
			const existing = this.cache.get(file.path);
			if (existing && existing.mtime === file.stat.mtime) {
				result.set(file.path, existing);
				return;
			}
			try {
				const facts = await this.computeFacts(file);
				this.cache.set(file.path, facts);
				result.set(file.path, facts);
			} catch {
				// A read failure (file deleted mid-resolve, etc.) leaves the file
				// out of the result rather than throwing for every other file in
				// the same batch.
			}
		}));
		return result;
	}

	private async computeFacts(file: TFile): Promise<ContentFacts> {
		const mtime = file.stat.mtime;
		const raw = await this.app.vault.cachedRead(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const body = stripFrontMatter(raw, cache?.frontmatterPosition?.end.line);
		const rawLines = raw.split('\n');
		const structural = factsFromCache(rawLines, cache);
		return {
			mtime,
			text: body.toLowerCase(),
			...structural,
		};
	}
}

/** Whether one file's facts satisfy the `Has` facet. `facts` missing (not
 * yet resolved) only ever matches `any`, so a still-pending file is excluded
 * from a real facet rather than shown as a false positive. */
export function matchesHasFacet(facts: ContentFacts | undefined, facet: string): boolean {
	if (facet === 'any' || !facet) return true;
	if (!facts) return false;
	switch (facet) {
		case 'code': return facts.hasCode;
		case 'callout': return facts.hasCallout;
		case 'tasks': return facts.tasks.total > 0;
		case 'open-tasks': return facts.tasks.total > facts.tasks.done;
		default: return true;
	}
}
