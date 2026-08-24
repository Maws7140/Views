import type { BasesPropertyId } from 'obsidian';
import { normalizePropertyId } from '../logic/graphModel';

/**
 * Which properties become nesting levels, and in what order.
 *
 * This is the part that broke, so it lives here as a pure function rather than
 * inline in the view: the failure was a rule about how three config keys
 * interact, and a rule is testable in a way that a method reading `this.config`
 * is not.
 *
 * The failure: the tree fell back to the legacy `hierarchyProperty` key
 * whenever no slot was set, without regard for whether the base grouped. A base
 * carrying both `groupBy: file.folder` and `hierarchyProperty: file.folder`
 * therefore got the folder hierarchy twice, once from Bases and once from the
 * view, and rendered `Skoo > CS 360 > Skoo > CS 360 > note`.
 *
 * Two rules fix it, and both come down to the same principle: **a level may
 * only be stated once, and Bases states it first.**
 */

export interface LevelResolutionInput {
	/** The property the base's own Group by names, or null. This already
	 * supplies the outermost level, so nothing below may restate it. */
	groupProperty: BasesPropertyId | null;
	/** The `Then nest by` slots, in order, blanks already dropped by the
	 * caller or not: empty strings are ignored here either way. */
	slots: (BasesPropertyId | null)[];
	/** The retired `hierarchyProperty` key, as saved by the build that shipped
	 * before Group by was wired up. */
	legacyProperty: BasesPropertyId | null;
}

/**
 * The nesting properties beneath the group level, deduplicated and in order.
 *
 * The legacy key applies **only when the base has no Group by**. That is not a
 * blind deletion: a tree configured with `hierarchyProperty` and no grouping is
 * coherent and should keep working. But once Bases has supplied the outermost
 * level, its answer is the one that stands.
 *
 * A slot naming a property already consumed, whether by Group by or by an
 * earlier slot, is skipped rather than producing a second identical level. A
 * user can otherwise reproduce the original bug by hand in the settings pane.
 */
export function resolveNestLevels(input: LevelResolutionInput): BasesPropertyId[] {
	const consumed = new Set<string>();
	if (input.groupProperty !== null) {
		const group = canonical(input.groupProperty);
		if (group !== null) consumed.add(group);
	}

	const levels: BasesPropertyId[] = [];
	for (const slot of input.slots) {
		const key = canonical(slot);
		if (key === null || consumed.has(key)) continue;
		consumed.add(key);
		levels.push(slot as BasesPropertyId);
	}
	if (levels.length > 0) return levels;

	// Nothing in the slots. The legacy key gets its turn only if Bases did not
	// already group, and only if it is not the very property Bases grouped by.
	const legacy = canonical(input.legacyProperty);
	if (legacy === null || input.groupProperty !== null) return [];
	return [input.legacyProperty as BasesPropertyId];
}

/**
 * A property id in one comparable form, or null when there is nothing there.
 *
 * `normalizePropertyId` is what reconciles the two spellings Bases uses for the
 * same property: filters and `groupBy` write a bare `class`, while a view's own
 * config slots write `note.class`. Comparing the raw strings would let
 * `groupBy: class` and a slot holding `note.class` both claim a level, which is
 * the same doubling this module exists to prevent.
 */
function canonical(property: BasesPropertyId | null): string | null {
	if (property === null || property === undefined) return null;
	const text = String(property).trim();
	if (text.length === 0) return null;
	return String(normalizePropertyId(text));
}
