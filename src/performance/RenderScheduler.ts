/** Coalesce repeated invalidations into one animation-frame callback. */
export class RenderScheduler {
	private frame: number | null = null;

	constructor(private readonly run: () => void) {}

	schedule(): void {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.run();
		});
	}

	cancel(): void {
		if (this.frame === null) return;
		window.cancelAnimationFrame(this.frame);
		this.frame = null;
	}
}
