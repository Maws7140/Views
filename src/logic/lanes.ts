import type { BasesEntry, BasesEntryGroup, BasesPropertyId } from 'obsidian';

export interface LaneDefinition {
	key: string;
	label: string;
}

export interface LanePartition<T> {
	lanes: LaneDefinition[];
	/** Column key, then lane key. Every column holds an entry for every lane. */
	cells: Map<string, Map<string, T[]>>;
}

export const NO_LANE_KEY = '__views-no-lane';

/**
 * Splits each native Bases group further by a property of our own, which is the
 * one axis the Bases API does not provide. Native grouping still decides the
 * columns and their entry order; this only partitions inside them.
 *
 * Lane order is global rather than per column, because lanes have to line up
 * horizontally. It follows first appearance in the order Bases handed the
 * entries over, so the user's Sort by decides it.
 */
export function partitionGroupsIntoLanes(
	groups: BasesEntryGroup[],
	laneProperty: BasesPropertyId | null,
	laneName: string,
	columnKeyOf: (group: BasesEntryGroup) => string,
): LanePartition<BasesEntry> {
	const lanes: LaneDefinition[] = [];
	const seenLanes = new Set<string>();
	const cells = new Map<string, Map<string, BasesEntry[]>>();

	if (!laneProperty) {
		lanes.push({ key: NO_LANE_KEY, label: '' });
		seenLanes.add(NO_LANE_KEY);
	}

	for (const group of groups) {
		const columnKey = columnKeyOf(group);
		const byLane = cells.get(columnKey) ?? new Map<string, BasesEntry[]>();
		cells.set(columnKey, byLane);
		for (const entry of group.entries) {
			const laneKey = laneProperty ? laneKeyFor(entry, laneProperty) : NO_LANE_KEY;
			if (!seenLanes.has(laneKey)) {
				seenLanes.add(laneKey);
				lanes.push({
					key: laneKey,
					label: laneKey === NO_LANE_KEY ? `No ${laneName}` : laneKey,
				});
			}
			const bucket = byLane.get(laneKey) ?? [];
			bucket.push(entry);
			byLane.set(laneKey, bucket);
		}
	}

	// Every column needs a cell for every lane, or the grid stops lining up.
	for (const byLane of cells.values()) {
		for (const lane of lanes) {
			if (!byLane.has(lane.key)) byLane.set(lane.key, []);
		}
	}

	return { lanes, cells };
}

/**
 * A list-valued lane property uses its first value, so a card exists exactly
 * once on the board and a drag stays unambiguous.
 */
function laneKeyFor(entry: BasesEntry, property: BasesPropertyId): string {
	const value = entry.getValue(property);
	if (value === null || value === undefined) return NO_LANE_KEY;
	const text = value.toString().trim();
	if (!text) return NO_LANE_KEY;
	const first = text.split(',')[0]?.trim();
	return first || NO_LANE_KEY;
}

/** Applies a persisted manual order, keeping unknown keys in discovered order. */
export function applyManualOrder<T extends { key: string }>(items: T[], order: string[]): T[] {
	if (!order.length) return items;
	const rank = new Map(order.map((key, index) => [key, index]));
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			const rankA = rank.get(a.item.key) ?? Number.MAX_SAFE_INTEGER;
			const rankB = rank.get(b.item.key) ?? Number.MAX_SAFE_INTEGER;
			return rankA === rankB ? a.index - b.index : rankA - rankB;
		})
		.map(({ item }) => item);
}
