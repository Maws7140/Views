/**
 * Degree-to-size scaling (plan item 2: "node size by degree"). Pure and
 * headless-testable, the same reasoning `graphFilters.ts` and
 * `forceLayout.ts` follow: this file touches nothing from the DOM or
 * `obsidian`, so `GraphRenderer` is the only thing that turns the multiplier
 * this returns into an actual pixel size.
 *
 * A node with more edges reads as more important, so it should look bigger
 * without the viewer having to hover it. Scaling by the square root of
 * degree (rather than degree itself) is what keeps one very connected hub
 * from dwarfing everything else on the canvas: linear growth on a real base
 * (where one note can carry a couple hundred links and most carry one or
 * two) would make every other tile look like a rounding error next to it.
 */

/** Multiplier applied to a node with no edges at all. Below 1 so an orphan
 * (on the rare occasion "Orphans" is toggled on) reads as smaller than the
 * connected majority, without shrinking so far the tile stops being a
 * legible target. */
export const DEGREE_SCALE_FLOOR = 0.7;

/** Multiplier applied once degree growth saturates. This is the ceiling that
 * keeps a single dominant hub from dwarfing the rest of the graph: without
 * it, `Math.sqrt` still grows without bound, just more slowly than degree
 * itself. */
export const DEGREE_SCALE_CEILING = 2.2;

const DEGREE_SCALE_GROWTH = 0.18;

/** Returns the multiplier `GraphRenderer` applies to a node's tile size (or
 * dot radius) for the given degree. Degree 0 and negative/`NaN` input alike
 * clamp to `DEGREE_SCALE_FLOOR`, since a malformed degree should read as "no
 * edges" rather than throw or produce `NaN` pixels. */
export function degreeScale(degree: number): number {
	const safeDegree = Number.isFinite(degree) && degree > 0 ? degree : 0;
	const raw = DEGREE_SCALE_FLOOR + Math.sqrt(safeDegree) * DEGREE_SCALE_GROWTH;
	return Math.min(DEGREE_SCALE_CEILING, Math.max(DEGREE_SCALE_FLOOR, raw));
}
