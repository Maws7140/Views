const DEBUG_KEY = 'views.debug.performance';

export function performanceMetricsEnabled(): boolean {
	try {
		return window.localStorage.getItem(DEBUG_KEY) === 'true';
	} catch {
		return false;
	}
}

export function reportPerformance(name: string, startedAt: number, fields: Record<string, number>): void {
	if (!performanceMetricsEnabled()) return;
	const durationMs = performance.now() - startedAt;
	console.info(`[Views performance] ${name}`, { durationMs: Number(durationMs.toFixed(2)), ...fields });
}
