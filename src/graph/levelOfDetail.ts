/**
 * Text fade threshold (plan item 4): the slider `GraphView` exposes as
 * "Text fade threshold" scales the existing level-of-detail ladder instead
 * of replacing it. Pure and headless-testable like `nodeSizing.ts`.
 *
 * The ladder itself does not change: edge labels need the most room to read
 * (a line plus a word), so they are the first thing dropped as the view
 * zooms out; node labels (one word under a tile) survive a bit further out;
 * tiles themselves collapse to dots last. `edgeLabelMinScale >
 * labelMinScale > dotMinScale` always holds here because every threshold is
 * the same base value times one shared `factor`: multiplying three already
 * ordered positive numbers by the same positive factor can never reorder
 * them.
 */

/** The three base thresholds this file scales, equal to what the ladder
 * used before the slider existed. A slider at `DEFAULT_FADE_THRESHOLD`
 * reproduces these exactly, so the default behaviour is unchanged by this
 * feature landing. */
const BASE_EDGE_LABEL_MIN_SCALE = 0.85;
const BASE_LABEL_MIN_SCALE = 0.5;
const BASE_DOT_MIN_SCALE = 0.28;

/** The slider's own range, matching the 0-100 convention `GraphView`'s other
 * sliders (Repel force, Link distance) already use. */
export const FADE_THRESHOLD_MIN = 0;
export const FADE_THRESHOLD_MAX = 100;
export const DEFAULT_FADE_THRESHOLD = 50;

const FADE_FACTOR_MIN = 0.4;
const FADE_FACTOR_MAX = 1.6;

export interface LevelOfDetailThresholds {
	/** Scale below which edge labels stop drawing. */
	edgeLabelMinScale: number;
	/** Scale below which node labels stop drawing. */
	labelMinScale: number;
	/** Scale below which a tile collapses to a dot. */
	dotMinScale: number;
}

/** Maps the 0-100 slider onto the three LOD thresholds, all scaled by the
 * same factor so their relative order (and therefore the drop-off sequence)
 * never changes. A lower slider value fades text out sooner (at a higher
 * zoomed-out scale still counting as "zoomed out enough to fade"); a higher
 * value keeps text around longer, all the way out to the same close-to-1
 * scale a fully zoomed out Obsidian graph would still show tags at. */
export function fadeThresholdToLevelOfDetail(sliderValue: number): LevelOfDetailThresholds {
	const clamped = Math.min(FADE_THRESHOLD_MAX, Math.max(FADE_THRESHOLD_MIN, sliderValue));
	const span = FADE_THRESHOLD_MAX - FADE_THRESHOLD_MIN;
	const factor = FADE_FACTOR_MIN + (clamped / span) * (FADE_FACTOR_MAX - FADE_FACTOR_MIN);
	return {
		edgeLabelMinScale: BASE_EDGE_LABEL_MIN_SCALE * factor,
		labelMinScale: BASE_LABEL_MIN_SCALE * factor,
		dotMinScale: BASE_DOT_MIN_SCALE * factor,
	};
}
