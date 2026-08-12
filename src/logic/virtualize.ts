import type { DateScale } from './dateScale';
import type { TimelineItem } from '../types';

export function virtualizeItems(
	items: TimelineItem[],
	scale: DateScale,
	scrollLeft: number,
	viewportWidth: number
): TimelineItem[] {
	if (!items.length) return [];

	const buffer = viewportWidth * 0.5;
	const windowStart = Math.max(0, scrollLeft - buffer);
	const windowEnd = scrollLeft + viewportWidth + buffer;

	return items.filter((item) => {
		if (item.startTs == null) return false;
		const startPx = scale.toX(item.startTs);
		const spanEnd = item.endTs ?? item.startTs;
		const endPx = scale.toX(spanEnd);
		return endPx >= windowStart && startPx <= windowEnd;
	});
}
