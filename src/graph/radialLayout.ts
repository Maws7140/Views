import type { GraphModel } from './types';
import { computeDepthsFromRoot } from './graphDepth';

/**
 * Radial layout by depth ring: the root at the centre, its neighbours on a
 * ring around it, their neighbours on a wider ring, and so on. Radius is
 * fixed by depth alone, so this can never produce a hairball the way an
 * emergent force layout can; the only thing left to decide is angle, and
 * that is decided by recursively giving each node an angular slice of its
 * parent's own slice.
 *
 * A depth-1 node's slice is `1 / (number of depth-1 nodes)` of the full
 * circle; a depth-2 node's slice is a further subdivision of its parent's
 * slice among its own siblings. That is what keeps a child near its
 * parent's angle "where possible" (it can never leave its parent's slice)
 * while still spreading siblings evenly within whatever room they have.
 *
 * Pure and DOM-free, like `graphDepth.ts` this builds on: `GraphRenderer`
 * uses the result both as the seed position for a node entering focus mode
 * and as the per-tick ring-radius constraint target, but neither of those
 * concerns belongs in this file.
 */

export interface RadialPosition {
	x: number;
	y: number;
	/** Depth (equivalently, which ring). 0 for the root. */
	ring: number;
}

/**
 * `ringSpacing` is world units per depth level, so ring radius is simply
 * `ring * ringSpacing`. `GraphRenderer` passes the live "Link distance"
 * slider value, reusing the one spacing control a user already has rather
 * than adding a second knob that means almost the same thing.
 *
 * Returns an empty map if `rootId` is not part of `model` at all (mirrors
 * `computeDepthsFromRoot`'s empty result for the same case); a node
 * unreachable from the root is simply absent, matching how depth itself
 * excludes it.
 */
export function computeRadialLayout(model: GraphModel, rootId: string, ringSpacing: number): Map<string, RadialPosition> {
	const { depths, children } = computeDepthsFromRoot(model, rootId);
	const positions = new Map<string, RadialPosition>();
	if (!depths.has(rootId)) return positions;

	positions.set(rootId, { x: 0, y: 0, ring: 0 });
	assignSlice(rootId, 0, Math.PI * 2, children, depths, ringSpacing, positions);
	return positions;
}

function assignSlice(
	nodeId: string,
	startAngle: number,
	endAngle: number,
	children: Map<string, string[]>,
	depths: Map<string, number>,
	ringSpacing: number,
	positions: Map<string, RadialPosition>,
): void {
	const kids = children.get(nodeId);
	if (!kids || kids.length === 0) return;

	const span = (endAngle - startAngle) / kids.length;
	kids.forEach((childId, index) => {
		const childStart = startAngle + span * index;
		const childEnd = childStart + span;
		const angle = (childStart + childEnd) / 2;
		const ring = depths.get(childId) as number;
		const radius = ring * ringSpacing;
		positions.set(childId, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, ring });
		assignSlice(childId, childStart, childEnd, children, depths, ringSpacing, positions);
	});
}
