import { getIcon, type App } from 'obsidian';
import { classifyIconSpec, lookupExternalIconChar, type ExternalIconDescriptor } from '../collection/appearance';
import type { GraphNodeKind } from './types';

/**
 * Paints the plugin's icons onto a canvas without a DOM element per node.
 *
 * Which tier a spec belongs to is not decided here. `classifyIconSpec` in
 * `src/collection/appearance.ts` is the single answer to that question, shared
 * with the DOM renderer, so a string cannot mean one thing on a card and
 * another on a node. This module only knows how to paint each tier:
 *
 *   1. Emoji, drawn as text.
 *   2. A Lucide glyph, rasterized once into an offscreen canvas and cached.
 *   3. A Notebook Navigator icon-font glyph, drawn as text in that provider's
 *      font once its codepoint has been read out of Notebook Navigator's own
 *      store.
 *
 * The caller hands over the whole candidate chain rather than one spec, so a
 * candidate that cannot be painted (an icon font that is not installed) falls
 * through to the next one the user configured instead of straight to a
 * generic glyph.
 */

export type IconGlyph =
	| { kind: 'text'; text: string; fontFamily?: string }
	| { kind: 'bitmap'; bitmap: HTMLCanvasElement };

/** One glyph per node kind when a node has no icon of its own, or none of its
 * icon specs could be resolved. */
export function defaultIconName(kind: GraphNodeKind): string {
	if (kind === 'value') return 'lucide-tag';
	if (kind === 'unresolved') return 'lucide-file-question';
	return 'lucide-file-text';
}

/** Bitmaps are square; this is the source resolution multiplier over the
 * requested display size, fixed rather than tied to `devicePixelRatio` so the
 * cache key stays small and a mid-session DPR change just costs a little
 * softness rather than a full re-rasterize. */
const OVERSAMPLE = 2;

type CacheEntry = HTMLCanvasElement | 'pending' | 'failed';
/** A resolved codepoint, `null` for a provider whose metadata is not
 * installed, `'pending'` while the lookup is in flight. */
type FontEntry = string | null | 'pending';

export class IconRaster {
	private readonly bitmaps = new Map<string, CacheEntry>();
	private readonly fontChars = new Map<string, FontEntry>();
	private rafScheduled = false;

	constructor(private readonly app: App) {}

	/**
	 * Returns a paintable glyph for the first candidate in `rawIcons` that
	 * resolves, and otherwise kicks off resolution in the background and
	 * returns null for this frame. `onReady` fires once, coalesced across an
	 * animation frame, after one or more glyphs this call (or a sibling call)
	 * triggered become available, so a burst of icon completions costs one
	 * repaint rather than one per icon.
	 */
	request(rawIcons: string[], kind: GraphNodeKind, sizePx: number, color: string, onReady: () => void): IconGlyph | null {
		let pending = false;
		for (const rawIcon of rawIcons) {
			const spec = classifyIconSpec(rawIcon);
			if (!spec) continue;
			if (spec.kind === 'emoji') return { kind: 'text', text: spec.text };
			if (spec.kind === 'lucide') {
				const glyph = this.requestBitmap(spec.name, sizePx, color, onReady);
				if (glyph) return glyph;
				// A Lucide name always rasterizes eventually, so this is a frame
				// of latency rather than a failure. Waiting for it beats showing
				// a folder icon in its place and then swapping.
				pending = true;
				continue;
			}
			const char = this.requestFontChar(spec.descriptor, onReady);
			if (char === 'pending') {
				pending = true;
				continue;
			}
			if (char) return { kind: 'text', text: char, fontFamily: spec.descriptor.fontFamily };
		}
		// Nothing resolved. While a candidate is still in flight, draw nothing
		// rather than a default glyph that would be replaced a frame later.
		if (pending) return null;
		return this.requestBitmap(defaultIconName(kind), sizePx, color, onReady);
	}

	private requestBitmap(name: string, sizePx: number, color: string, onReady: () => void): IconGlyph | null {
		const key = `${name}|${Math.round(sizePx)}|${color}`;
		const cached = this.bitmaps.get(key);
		if (cached === 'pending' || cached === 'failed') return null;
		if (cached) return { kind: 'bitmap', bitmap: cached };

		const svg = getIcon(name);
		if (!svg) {
			this.bitmaps.set(key, 'failed');
			return null;
		}
		this.bitmaps.set(key, 'pending');
		rasterize(svg, sizePx, color).then((bitmap) => {
			this.bitmaps.set(key, bitmap);
			this.scheduleReady(onReady);
		}).catch(() => {
			this.bitmaps.set(key, 'failed');
		});
		return null;
	}

	private requestFontChar(descriptor: ExternalIconDescriptor, onReady: () => void): FontEntry {
		const key = `${descriptor.provider}|${descriptor.identifier}`;
		const cached = this.fontChars.get(key);
		if (cached !== undefined) return cached;

		this.fontChars.set(key, 'pending');
		lookupExternalIconChar(this.app, descriptor).then((char) => {
			this.fontChars.set(key, char);
			if (char) this.scheduleReady(onReady);
		}).catch(() => {
			this.fontChars.set(key, null);
		});
		return 'pending';
	}

	private scheduleReady(onReady: () => void): void {
		if (this.rafScheduled) return;
		this.rafScheduled = true;
		requestAnimationFrame(() => {
			this.rafScheduled = false;
			onReady();
		});
	}
}

function rasterize(svg: SVGSVGElement, sizePx: number, color: string): Promise<HTMLCanvasElement> {
	const clone = svg.cloneNode(true) as SVGSVGElement;
	const side = Math.max(1, Math.round(sizePx * OVERSAMPLE));
	clone.setAttribute('width', String(side));
	clone.setAttribute('height', String(side));
	// Lucide icons draw with `stroke="currentColor"` on the root and let
	// children inherit it, so overriding the root attributes is enough to
	// recolor the whole glyph without walking the tree.
	clone.setAttribute('stroke', color);
	clone.setAttribute('color', color);

	const serialized = new XMLSerializer().serializeToString(clone);
	const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => {
			const canvas = document.createElement('canvas');
			canvas.width = side;
			canvas.height = side;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				reject(new Error('canvas 2d context unavailable'));
				return;
			}
			ctx.drawImage(image, 0, 0, side, side);
			resolve(canvas);
		};
		image.onerror = () => reject(new Error(`icon decode failed`));
		image.src = dataUri;
	});
}
