import type { BasesPropertyId } from 'obsidian';
import { normalizePropertyId } from '../logic/graphModel';

/**
 * The four property slots behind `Connect by`.
 *
 * These began as "Link properties", a `multitext` option: a stack of free-text
 * boxes a user typed frontmatter names into by hand. That is the one input in
 * this plugin that asked for a property name without offering the property
 * dropdown Bases itself gives you everywhere else, and typing is exactly how
 * it broke: a base naming `class` never matched the extracted `note.class`
 * until `normalizePropertyId` was added, and nothing at all warned when a
 * property was simply misspelled. The graph just came back empty.
 *
 * Obsidian's ViewOption vocabulary has a `property` type (the native dropdown)
 * but no multi-property type, so a list of properties cannot be one control.
 * The option is therefore a fixed set of single-property slots. Four is the
 * number: bases in the wild name one or two link properties, four leaves real
 * headroom, and every empty slot is a permanently visible dropdown in the
 * settings pane, so a larger set costs every user vertical space to serve
 * nobody. A base that genuinely needs more than four keeps working through the
 * legacy array below, which is not capped.
 *
 * `linkProperties` (the legacy array) must keep being read. Real .base files
 * on disk already hold it, and a stored option key is permanent: dropping the
 * read would silently turn "only these properties are links" into "every
 * property is a link" for those bases, which is not a lost setting but a
 * different graph. So the slots and the legacy array are unioned rather than
 * either one winning. A user who migrates by picking their properties in the
 * dropdowns sees no change (same set, deduped); a user who has not touched the
 * option keeps exactly the graph they had.
 *
 * The union is why there is no "the new key wins outright" shortcut like
 * `resolveShowOrphans` has: orphan visibility is a single boolean where the two
 * keys can contradict each other, whereas these are set members, where the two
 * keys can only ever add up.
 */

/** How many property dropdown slots the Link properties option offers. Exported
 * so `GraphView` builds exactly this many options and the tests assert against
 * one number rather than a literal repeated in three places. */
export const LINK_PROPERTY_SLOT_COUNT = 4;

/** The stored key for slot `index` (0-based). These are new keys, never a
 * rename of `linkProperties`: the legacy key holds an array and these hold a
 * single string, so reusing the name would hand `BasesViewConfig.get()` a value
 * of the wrong shape for whichever reader looked at it second. */
export function linkPropertySlotKey(index: number): string {
	return `linkProperty${index + 1}`;
}

/** Every slot key, in the order the options are declared. */
export function linkPropertySlotKeys(): string[] {
	return Array.from({ length: LINK_PROPERTY_SLOT_COUNT }, (_unused, index) => linkPropertySlotKey(index));
}

/** Resolves the link property filter from whatever a base's config store holds
 * for the new per-slot keys and the legacy `linkProperties` array.
 *
 * `unknown` inputs are what `BasesViewConfig.get()` actually returns: a missing
 * key, the expected shape, or anything a hand-edited .base file happens to
 * contain. Non-string entries and blank strings are dropped rather than
 * coerced, because a blank slot (the state every unset dropdown is in) read as
 * a real property would filter every edge out and empty the canvas.
 *
 * An empty result keeps its long-standing meaning of "no filter, every property
 * is a link", which is why callers must not treat empty as an error: that is
 * the default a base with the option untouched has always had. */
export function resolveLinkProperties(slots: readonly unknown[], legacyLinkProperties: unknown): BasesPropertyId[] {
	const resolved: BasesPropertyId[] = [];
	const seen = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value !== 'string') return;
		const trimmed = value.trim();
		if (trimmed.length === 0) return;
		// Bare frontmatter names are what the old free-text boxes collected and
		// what the property dropdowns display, while extraction matches on the
		// full id, so both sources normalize before the dedupe. Otherwise
		// `class` and `note.class` survive as two entries that mean one thing.
		const propertyId = normalizePropertyId(trimmed);
		if (seen.has(propertyId)) return;
		seen.add(propertyId);
		resolved.push(propertyId);
	};

	// Slots first so the order a user sees in the settings pane is the order the
	// filter reads, with legacy entries they never picked trailing behind.
	for (const slot of slots) add(slot);
	if (Array.isArray(legacyLinkProperties)) {
		for (const legacy of legacyLinkProperties) add(legacy);
	}
	return resolved;
}
