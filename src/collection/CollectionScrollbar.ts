export type ScrollbarOrientation = 'vertical' | 'horizontal';

const MIN_THUMB_SIZE = 24;
const OVERFLOW_TOLERANCE = 4;
const SCROLL_VISIBILITY_MS = 800;
const KEYBOARD_SCROLL_STEP = 40;
let nextScrollSurfaceId = 0;

const resizeCallbacks = new WeakMap<Element, Set<() => void>>();
const sharedResizeObserver = new ResizeObserver((entries) => {
	for (const entry of entries) {
		for (const callback of resizeCallbacks.get(entry.target) ?? []) callback();
	}
});

function observeResize(element: Element, callback: () => void): void {
	let callbacks = resizeCallbacks.get(element);
	if (!callbacks) {
		callbacks = new Set();
		resizeCallbacks.set(element, callbacks);
		sharedResizeObserver.observe(element);
	}
	callbacks.add(callback);
}

function unobserveResize(element: Element, callback: () => void): void {
	const callbacks = resizeCallbacks.get(element);
	if (!callbacks) return;
	callbacks.delete(callback);
	if (callbacks.size) return;
	resizeCallbacks.delete(element);
	sharedResizeObserver.unobserve(element);
}

export class CollectionScrollbar {
	private readonly trackEl: HTMLElement;
	private readonly thumbEl: HTMLElement;
	private readonly mutationObserver: MutationObserver | null;
	private readonly generatedTargetId: boolean;
	private frame: number | null = null;
	private scrollVisibilityTimer: number | null = null;
	private geometryDirty = true;
	private viewportSize = 0;
	private maxScroll = 0;
	private thumbTravel = 0;
	private disposed = false;

	constructor(
		private readonly targetEl: HTMLElement,
		private readonly hostEl: HTMLElement,
		private readonly orientation: ScrollbarOrientation,
		observeMutations = false,
	) {
		hostEl.addClass('mbv-scroll-host');
		targetEl.addClass('mbv-scroll-surface');
		this.generatedTargetId = !targetEl.id;
		if (this.generatedTargetId) targetEl.id = `mbv-scroll-surface-${++nextScrollSurfaceId}`;
		this.trackEl = hostEl.createDiv({ cls: `mbv-scrollbar is-${orientation}` });
		this.trackEl.setAttrs({
			role: 'scrollbar',
			tabindex: '-1',
			'aria-label': `${orientation === 'vertical' ? 'Vertical' : 'Horizontal'} scrollbar`,
			'aria-controls': targetEl.id,
			'aria-orientation': orientation,
			'aria-valuemin': '0',
			'aria-valuemax': '0',
			'aria-valuenow': '0',
			'aria-disabled': 'true',
		});
		this.thumbEl = this.trackEl.createDiv({ cls: 'mbv-scrollbar-thumb' });
		this.targetEl.addEventListener('scroll', this.onScroll, { passive: true });
		this.hostEl.addEventListener('pointermove', this.onHostPointerMove, { passive: true });
		this.hostEl.addEventListener('pointerleave', this.onHostPointerLeave, { passive: true });
		this.trackEl.addEventListener('pointerdown', this.onTrackPointerDown);
		this.thumbEl.addEventListener('pointerdown', this.onThumbPointerDown);
		this.trackEl.addEventListener('keydown', this.onKeyDown);
		this.trackEl.addEventListener('focus', this.onFocus);
		this.trackEl.addEventListener('blur', this.onBlur);
		observeResize(targetEl, this.scheduleGeometryUpdate);
		observeResize(hostEl, this.scheduleGeometryUpdate);
		this.mutationObserver = observeMutations ? new MutationObserver(this.scheduleGeometryUpdate) : null;
		this.mutationObserver?.observe(targetEl, { childList: true, subtree: true, characterData: true });
		this.scheduleGeometryUpdate();
	}

	destroy(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		if (this.scrollVisibilityTimer !== null) window.clearTimeout(this.scrollVisibilityTimer);
		this.targetEl.removeEventListener('scroll', this.onScroll);
		this.hostEl.removeEventListener('pointermove', this.onHostPointerMove);
		this.hostEl.removeEventListener('pointerleave', this.onHostPointerLeave);
		this.trackEl.removeEventListener('pointerdown', this.onTrackPointerDown);
		this.thumbEl.removeEventListener('pointerdown', this.onThumbPointerDown);
		this.trackEl.removeEventListener('keydown', this.onKeyDown);
		this.trackEl.removeEventListener('focus', this.onFocus);
		this.trackEl.removeEventListener('blur', this.onBlur);
		unobserveResize(this.targetEl, this.scheduleGeometryUpdate);
		unobserveResize(this.hostEl, this.scheduleGeometryUpdate);
		this.mutationObserver?.disconnect();
		this.trackEl.remove();
		this.targetEl.removeClass('mbv-scroll-surface');
		if (this.generatedTargetId) this.targetEl.removeAttribute('id');
	}

	private readonly onScroll = (): void => {
		this.trackEl.addClass('is-scrolling');
		if (this.scrollVisibilityTimer !== null) window.clearTimeout(this.scrollVisibilityTimer);
		this.scrollVisibilityTimer = window.setTimeout(() => {
			this.scrollVisibilityTimer = null;
			this.trackEl.removeClass('is-scrolling');
		}, SCROLL_VISIBILITY_MS);
		this.scheduleUpdate();
	};

	private readonly onHostPointerMove = (event: PointerEvent): void => {
		this.trackEl.toggleClass('is-hovered', this.findPointerOwner(event.target) === this.hostEl);
	};

	private readonly onHostPointerLeave = (): void => {
		this.trackEl.removeClass('is-hovered');
	};

	private readonly onFocus = (): void => {
		this.trackEl.addClass('is-focused');
	};

	private readonly onBlur = (): void => {
		this.trackEl.removeClass('is-focused');
	};

	private findPointerOwner(target: EventTarget | null): HTMLElement | null {
		let element = target instanceof Element ? target : null;
		while (element && this.hostEl.contains(element)) {
			const host = element.closest<HTMLElement>('.mbv-scroll-host');
			if (!host || !this.hostEl.contains(host)) return null;
			const ownsActiveAxis = Array.from(host.children).some((child) =>
				child.matches(`.mbv-scrollbar.is-${this.orientation}.is-active`),
			);
			if (ownsActiveAxis) return host;
			element = host.parentElement;
		}
		return null;
	}

	private readonly scheduleUpdate = (): void => {
		if (this.disposed || this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.update();
		});
	};

	private readonly scheduleGeometryUpdate = (): void => {
		this.geometryDirty = true;
		this.scheduleUpdate();
	};

	private update(): void {
		if (!this.targetEl.isConnected || !this.hostEl.isConnected) return;
		if (this.geometryDirty) this.updateGeometry();
		if (!this.trackEl.hasClass('is-active')) return;
		const scrollPosition = this.orientation === 'vertical' ? this.targetEl.scrollTop : this.targetEl.scrollLeft;
		const thumbPosition = this.maxScroll > 0 ? this.thumbTravel * (scrollPosition / this.maxScroll) : 0;
		this.trackEl.style.setProperty('--mbv-scroll-thumb-position', `${thumbPosition}px`);
		this.trackEl.setAttr('aria-valuenow', String(Math.round(scrollPosition)));
	}

	private updateGeometry(): void {
		this.geometryDirty = false;
		this.viewportSize = this.orientation === 'vertical' ? this.targetEl.clientHeight : this.targetEl.clientWidth;
		const contentSize = this.orientation === 'vertical' ? this.targetEl.scrollHeight : this.targetEl.scrollWidth;
		this.maxScroll = Math.max(0, contentSize - this.viewportSize);
		const hasMeaningfulOverflow = this.viewportSize > 0 && this.maxScroll > OVERFLOW_TOLERANCE;
		this.trackEl.toggleClass('is-active', hasMeaningfulOverflow);
		if (!hasMeaningfulOverflow) {
			this.thumbTravel = 0;
			this.trackEl.removeClass('is-hovered', 'is-scrolling', 'is-dragging', 'is-focused');
			this.trackEl.setAttrs({ tabindex: '-1', 'aria-disabled': 'true', 'aria-valuemax': '0', 'aria-valuenow': '0' });
			return;
		}
		this.trackEl.setAttrs({
			tabindex: '0',
			'aria-disabled': 'false',
			'aria-valuemax': String(Math.round(this.maxScroll)),
		});
		const trackLength = this.positionTrack();
		const thumbLength = Math.min(trackLength, Math.max(MIN_THUMB_SIZE, trackLength * (this.viewportSize / contentSize)));
		this.thumbTravel = Math.max(0, trackLength - thumbLength);
		this.trackEl.style.setProperty('--mbv-scroll-thumb-size', `${thumbLength}px`);
	}

	private positionTrack(): number {
		const hostRect = this.hostEl.getBoundingClientRect();
		const targetRect = this.targetEl.getBoundingClientRect();
		if (this.orientation === 'vertical') {
			const trackLength = Math.max(0, targetRect.height - 4);
			this.trackEl.style.top = `${Math.max(2, targetRect.top - hostRect.top + 2)}px`;
			this.trackEl.style.height = `${trackLength}px`;
			return trackLength;
		}
		const trackLength = Math.max(0, targetRect.width - 4);
		this.trackEl.style.left = `${Math.max(2, targetRect.left - hostRect.left + 2)}px`;
		this.trackEl.style.width = `${trackLength}px`;
		this.trackEl.style.top = `${Math.max(0, targetRect.bottom - hostRect.top - 8)}px`;
		return trackLength;
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

	private readonly onKeyDown = (event: KeyboardEvent): void => {
		const viewport = this.orientation === 'vertical' ? this.targetEl.clientHeight : this.targetEl.clientWidth;
		const maxScroll = this.orientation === 'vertical'
			? this.targetEl.scrollHeight - viewport
			: this.targetEl.scrollWidth - viewport;
		const current = this.orientation === 'vertical' ? this.targetEl.scrollTop : this.targetEl.scrollLeft;
		let next: number | null = null;
		if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = maxScroll;
		else if (event.key === 'PageUp') next = current - viewport * 0.9;
		else if (event.key === 'PageDown') next = current + viewport * 0.9;
		else if (this.orientation === 'vertical' && event.key === 'ArrowUp') next = current - KEYBOARD_SCROLL_STEP;
		else if (this.orientation === 'vertical' && event.key === 'ArrowDown') next = current + KEYBOARD_SCROLL_STEP;
		else if (this.orientation === 'horizontal' && event.key === 'ArrowLeft') next = current - KEYBOARD_SCROLL_STEP;
		else if (this.orientation === 'horizontal' && event.key === 'ArrowRight') next = current + KEYBOARD_SCROLL_STEP;
		if (next === null) return;
		event.preventDefault();
		this.setScrollPosition(Math.min(maxScroll, Math.max(0, next)));
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
