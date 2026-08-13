export type ScrollbarOrientation = 'vertical' | 'horizontal';

const MIN_THUMB_SIZE = 24;

export class CollectionScrollbar {
	private readonly trackEl: HTMLElement;
	private readonly thumbEl: HTMLElement;
	private readonly resizeObserver: ResizeObserver;
	private readonly mutationObserver: MutationObserver;
	private frame: number | null = null;
	private disposed = false;

	constructor(
		private readonly targetEl: HTMLElement,
		private readonly hostEl: HTMLElement,
		private readonly orientation: ScrollbarOrientation,
	) {
		hostEl.addClass('mbv-scroll-host');
		targetEl.addClass('mbv-scroll-surface');
		this.trackEl = hostEl.createDiv({ cls: `mbv-scrollbar is-${orientation}` });
		this.trackEl.setAttr('aria-hidden', 'true');
		this.thumbEl = this.trackEl.createDiv({ cls: 'mbv-scrollbar-thumb' });
		this.targetEl.addEventListener('scroll', this.scheduleUpdate, { passive: true });
		this.trackEl.addEventListener('pointerdown', this.onTrackPointerDown);
		this.thumbEl.addEventListener('pointerdown', this.onThumbPointerDown);
		this.resizeObserver = new ResizeObserver(this.scheduleUpdate);
		this.resizeObserver.observe(targetEl);
		this.resizeObserver.observe(hostEl);
		this.mutationObserver = new MutationObserver(this.scheduleUpdate);
		this.mutationObserver.observe(targetEl, { childList: true, subtree: true, characterData: true });
		this.scheduleUpdate();
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.targetEl.removeEventListener('scroll', this.scheduleUpdate);
		this.trackEl.removeEventListener('pointerdown', this.onTrackPointerDown);
		this.thumbEl.removeEventListener('pointerdown', this.onThumbPointerDown);
		this.resizeObserver.disconnect();
		this.mutationObserver.disconnect();
		this.trackEl.remove();
		this.targetEl.removeClass('mbv-scroll-surface');
	}

	private readonly scheduleUpdate = (): void => {
		if (this.disposed || this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.update();
		});
	};

	private update(): void {
		if (!this.targetEl.isConnected || !this.hostEl.isConnected) return;
		const viewport = this.orientation === 'vertical' ? this.targetEl.clientHeight : this.targetEl.clientWidth;
		const content = this.orientation === 'vertical' ? this.targetEl.scrollHeight : this.targetEl.scrollWidth;
		const scrollPosition = this.orientation === 'vertical' ? this.targetEl.scrollTop : this.targetEl.scrollLeft;
		const maxScroll = Math.max(0, content - viewport);
		this.trackEl.toggleClass('is-active', viewport > 0 && maxScroll > 1);
		if (viewport <= 0 || maxScroll <= 1) return;
		this.positionTrack();
		const trackLength = this.orientation === 'vertical' ? this.trackEl.clientHeight : this.trackEl.clientWidth;
		const thumbLength = Math.max(MIN_THUMB_SIZE, trackLength * (viewport / content));
		const thumbTravel = Math.max(0, trackLength - thumbLength);
		const thumbPosition = maxScroll > 0 ? thumbTravel * (scrollPosition / maxScroll) : 0;
		this.trackEl.style.setProperty('--mbv-scroll-thumb-size', `${thumbLength}px`);
		this.trackEl.style.setProperty('--mbv-scroll-thumb-position', `${thumbPosition}px`);
	}

	private positionTrack(): void {
		const hostRect = this.hostEl.getBoundingClientRect();
		const targetRect = this.targetEl.getBoundingClientRect();
		if (this.orientation === 'vertical') {
			this.trackEl.style.top = `${Math.max(2, targetRect.top - hostRect.top + 2)}px`;
			this.trackEl.style.height = `${Math.max(0, targetRect.height - 4)}px`;
			return;
		}
		this.trackEl.style.left = `${Math.max(2, targetRect.left - hostRect.left + 2)}px`;
		this.trackEl.style.width = `${Math.max(0, targetRect.width - 4)}px`;
		this.trackEl.style.top = `${Math.max(0, targetRect.bottom - hostRect.top - 8)}px`;
	}

	private readonly onTrackPointerDown = (event: PointerEvent): void => {
		if (event.target === this.thumbEl || event.button !== 0) return;
		event.preventDefault();
		const trackRect = this.trackEl.getBoundingClientRect();
		const thumbRect = this.thumbEl.getBoundingClientRect();
		const coordinate = this.orientation === 'vertical' ? event.clientY : event.clientX;
		const trackStart = this.orientation === 'vertical' ? trackRect.top : trackRect.left;
		const trackLength = this.orientation === 'vertical' ? trackRect.height : trackRect.width;
		const thumbLength = this.orientation === 'vertical' ? thumbRect.height : thumbRect.width;
		const ratio = Math.min(1, Math.max(0, (coordinate - trackStart - thumbLength / 2) / Math.max(1, trackLength - thumbLength)));
		this.setScrollRatio(ratio, 'smooth');
	};

	private readonly onThumbPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const startCoordinate = this.orientation === 'vertical' ? event.clientY : event.clientX;
		const startScroll = this.orientation === 'vertical' ? this.targetEl.scrollTop : this.targetEl.scrollLeft;
		const trackLength = this.orientation === 'vertical' ? this.trackEl.clientHeight : this.trackEl.clientWidth;
		const thumbLength = this.orientation === 'vertical' ? this.thumbEl.offsetHeight : this.thumbEl.offsetWidth;
		const maxScroll = this.orientation === 'vertical'
			? this.targetEl.scrollHeight - this.targetEl.clientHeight
			: this.targetEl.scrollWidth - this.targetEl.clientWidth;
		const pixelsToScroll = maxScroll / Math.max(1, trackLength - thumbLength);
		this.thumbEl.setPointerCapture(event.pointerId);
		this.trackEl.addClass('is-dragging');
		const move = (moveEvent: PointerEvent): void => {
			const coordinate = this.orientation === 'vertical' ? moveEvent.clientY : moveEvent.clientX;
			this.setScrollPosition(startScroll + (coordinate - startCoordinate) * pixelsToScroll);
		};
		const end = (): void => {
			this.thumbEl.removeEventListener('pointermove', move);
			this.thumbEl.removeEventListener('pointerup', end);
			this.thumbEl.removeEventListener('pointercancel', end);
			this.trackEl.removeClass('is-dragging');
		};
		this.thumbEl.addEventListener('pointermove', move);
		this.thumbEl.addEventListener('pointerup', end);
		this.thumbEl.addEventListener('pointercancel', end);
	};

	private setScrollRatio(ratio: number, behavior: ScrollBehavior): void {
		const maxScroll = this.orientation === 'vertical'
			? this.targetEl.scrollHeight - this.targetEl.clientHeight
			: this.targetEl.scrollWidth - this.targetEl.clientWidth;
		const value = maxScroll * ratio;
		if (this.orientation === 'vertical') this.targetEl.scrollTo({ top: value, behavior });
		else this.targetEl.scrollTo({ left: value, behavior });
	}

	private setScrollPosition(value: number): void {
		if (this.orientation === 'vertical') this.targetEl.scrollTop = value;
		else this.targetEl.scrollLeft = value;
	}
}
