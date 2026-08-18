import { App, BasesEntry, BasesPropertyId, TFile } from 'obsidian';

/**
 * Writes a boolean property through `processFrontMatter`, matching the
 * frontmatter key case-insensitively so it does not create a second key.
 * Shared by every view that renders a live checkbox, so the matching logic
 * only lives in one place.
 */
export async function writeBooleanProperty(
	app: App,
	entry: BasesEntry,
	property: BasesPropertyId,
	checked: boolean,
): Promise<void> {
	if (!property.startsWith('note.')) throw new Error('Only note properties can be edited.');
	const file = app.vault.getAbstractFileByPath(entry.file.path);
	if (!(file instanceof TFile)) throw new Error('The note is no longer available.');
	const propertyName = property.slice('note.'.length);
	if (!propertyName) throw new Error('The property name is empty.');
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		const existingKey = Object.keys(frontmatter)
			.find((key) => key.toLocaleLowerCase() === propertyName.toLocaleLowerCase());
		frontmatter[existingKey ?? propertyName] = checked;
	});
}
