import { App, TFile, WorkspaceLeaf } from 'obsidian';

export interface BaseViewTabsHost {
	getFile(): TFile | null;
	getCurrentViewName(): string;
	selectView(name: string): Promise<void>;
}

export class WorkspaceLeafBaseViewTabsHost implements BaseViewTabsHost {
	constructor(
		private readonly app: App,
		private readonly leaf: WorkspaceLeaf,
	) {}

	getFile(): TFile | null {
		const filePath = this.leaf.getViewState().state?.file;
		if (typeof filePath !== 'string') return null;
		const file = this.app.vault.getFileByPath(filePath);
		return file instanceof TFile && file.extension === 'base' ? file : null;
	}

	getCurrentViewName(): string {
		const viewName = this.leaf.getViewState().state?.viewName;
		return typeof viewName === 'string' ? viewName : '';
	}

	async selectView(name: string): Promise<void> {
		const viewState = this.leaf.getViewState();
		await this.leaf.setViewState({
			...viewState,
			state: { ...viewState.state, viewName: name },
		});
	}
}

export interface EmbeddedBasesController {
	viewName?: unknown;
	selectView?: (name: string) => void;
}

export class EmbeddedBaseViewTabsHost implements BaseViewTabsHost {
	constructor(
		private readonly file: TFile,
		private readonly controller: EmbeddedBasesController,
	) {}

	getFile(): TFile {
		return this.file;
	}

	getCurrentViewName(): string {
		return typeof this.controller.viewName === 'string' ? this.controller.viewName : '';
	}

	async selectView(name: string): Promise<void> {
		if (typeof this.controller.selectView !== 'function') {
			throw new Error('Embedded Base controller does not expose view selection.');
		}
		this.controller.selectView(name);
	}
}
