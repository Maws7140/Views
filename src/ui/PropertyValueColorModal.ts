import { App, Modal } from 'obsidian';

export interface PropertyValueColorCallbacks {
	onChoose: (hex: string) => void;
	onReset: () => void;
}

/**
 * Obsidian's own `Menu` cannot hold a swatch grid, so the swatch picker
 * behind "Set color..." is a small modal instead: the active pack's swatches
 * plus a hex field, and a Reset action for clearing back to automatic.
 */
export class PropertyValueColorModal extends Modal {
	constructor(
		app: App,
		private readonly displayName: string,
		private readonly valueLabel: string,
		private readonly swatches: string[],
		private readonly currentColor: string | undefined,
		private readonly callbacks: PropertyValueColorCallbacks,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('mbv-value-color-modal');
		this.setTitle(`Color for "${this.valueLabel}"`);
		contentEl.createEl('p', {
			cls: 'mbv-value-color-hint',
			text: `Applies everywhere ${this.displayName} shows a colored pill.`,
		});

		const swatchesEl = contentEl.createDiv({ cls: 'mbv-value-color-swatches' });
		for (const hex of this.swatches) {
			const swatchEl = swatchesEl.createDiv({ cls: 'mbv-value-color-swatch' });
			swatchEl.style.setProperty('--mbv-swatch-color', hex);
			swatchEl.toggleClass('is-selected', hex.toLowerCase() === this.currentColor?.toLowerCase());
			swatchEl.setAttr('role', 'button');
			swatchEl.setAttr('aria-label', hex);
			swatchEl.addEventListener('click', () => {
				this.callbacks.onChoose(hex);
				this.close();
			});
		}

		const hexRowEl = contentEl.createDiv({ cls: 'mbv-value-color-hex-row' });
		const hexInputEl = hexRowEl.createEl('input', {
			cls: 'mbv-value-color-hex-input',
			attr: { type: 'text', placeholder: '#rrggbb', maxlength: '7' },
		});
		hexInputEl.value = this.currentColor ?? '';
		const applyBtn = hexRowEl.createEl('button', { text: 'Apply', cls: 'mod-cta' });
		const applyHex = () => {
			const hex = hexInputEl.value.trim();
			if (!/^#[0-9a-f]{6}$/i.test(hex)) {
				hexInputEl.addClass('is-invalid');
				return;
			}
			this.callbacks.onChoose(hex.toLowerCase());
			this.close();
		};
		applyBtn.addEventListener('click', applyHex);
		hexInputEl.addEventListener('input', () => hexInputEl.removeClass('is-invalid'));
		hexInputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') applyHex();
		});

		if (this.currentColor) {
			const resetBtn = contentEl.createEl('button', { text: 'Reset to automatic', cls: 'mbv-value-color-reset' });
			resetBtn.addEventListener('click', () => {
				this.callbacks.onReset();
				this.close();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
