/**
 * Plan item 5's "Orphans" toggle. Obsidian's own graph has an "Orphans"
 * filter that is a show toggle: checked means orphans are visible, default
 * unchecked. Ours used to be "Hide unlinked nodes", a hide toggle default
 * checked. Those are the same default outcome (orphans hidden) expressed as
 * opposite polarity checkboxes, which is exactly the kind of swap that
 * silently inverts behaviour if the stored boolean is reused as-is under a
 * new label.
 *
 * So this is a genuinely new stored key (`showOrphans`), not a rename of
 * `hideUnlinked`: renaming the key in place would mean a base file saved
 * with the old `hideUnlinked: false` (the user explicitly asking to see
 * orphans) gets read back, unchanged, as `showOrphans: false` (hide them)
 * under the new polarity, silently reversing what that user configured.
 * `resolveShowOrphans` is the read-time compatibility shim: a base with the
 * new key present just uses it; a base with only the legacy key inverts it
 * once, correctly, matching `GraphRenderer.update`'s old
 * `filterModelForView(model, hideUnlinked, maxLinks)` call for every value
 * that key could hold; a base with neither present gets the new toggle's own
 * default (`false`, orphans hidden), which is what a base with no explicit
 * unlinked-nodes preference already showed under the old default of
 * `hideUnlinked: true`.
 */

/** Resolves whether orphan (degree-0) nodes should be shown, from whatever a
 * base's config store holds for the new key and the legacy one. `unknown`
 * inputs are what `BasesViewConfig.get()` actually returns: a missing key,
 * a boolean, or (defensively) anything else a hand-edited .base file might
 * contain. Anything that is not literally `true`/`false` is treated as
 * absent rather than coerced, so a stray string in the file cannot silently
 * flip the default. */
export function resolveShowOrphans(showOrphans: unknown, legacyHideUnlinked: unknown): boolean {
	if (typeof showOrphans === 'boolean') return showOrphans;
	if (typeof legacyHideUnlinked === 'boolean') return !legacyHideUnlinked;
	return false;
}
