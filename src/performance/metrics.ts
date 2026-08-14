const DEBUG_KEY = 'views.debug.performance';

export function performanceMetricsEnabled(): boolean {
	try {
		return window.localStorage.getItem(DEBUG_KEY) !== null;
	} catch {
		return false;
	}
}

/**
 * Aggregated samples, readable from the console as `window.__viewsPerf`. Frame
 * timings are useless one line at a time, so they are summarised instead.
 */
interface PerformanceSummary {
	count: number;
	totalMs: number;
	maxMs: number;
	last: Record<string, number>;
}

function sink(): Record<string, PerformanceSummary> {
	const scope = window as unknown as { __viewsPerf?: Record<string, PerformanceSummary> };
	if (!scope.__viewsPerf) scope.__viewsPerf = {};
	return scope.__viewsPerf;
}

export function reportPerformance(name: string, startedAt: number, fields: Record<string, number>): void {
	if (!performanceMetricsEnabled()) return;
	const durationMs = performance.now() - startedAt;
	const store = sink();
	const summary = store[name] ?? { count: 0, totalMs: 0, maxMs: 0, last: {} };
	summary.count += 1;
	summary.totalMs = Number((summary.totalMs + durationMs).toFixed(2));
	summary.maxMs = Math.max(summary.maxMs, Number(durationMs.toFixed(2)));
	summary.last = { durationMs: Number(durationMs.toFixed(2)), ...fields };
	store[name] = summary;
	if (window.localStorage.getItem(DEBUG_KEY) === 'verbose') {
		console.info(`[Views performance] ${name}`, { durationMs: Number(durationMs.toFixed(2)), ...fields });
	}
}
