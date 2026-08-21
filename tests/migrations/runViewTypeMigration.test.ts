import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigratableFile, MigrationVault } from '../../src/migrations/runViewTypeMigration';
import { runViewTypeMigration } from '../../src/migrations/runViewTypeMigration';

class FakeVault implements MigrationVault {
	private readonly written = new Map<string, string>();
	private readonly unreadable = new Set<string>();

	constructor(private readonly files: Map<string, string>) {}

	static withUnreadable(files: Map<string, string>, unreadablePaths: string[]): FakeVault {
		const vault = new FakeVault(files);
		for (const path of unreadablePaths) vault.unreadable.add(path);
		return vault;
	}

	getFiles(): MigratableFile[] {
		return [...this.files.keys()].map((path) => ({ path, extension: path.split('.').pop() ?? '' }));
	}

	async read(file: MigratableFile): Promise<string> {
		if (this.unreadable.has(file.path)) throw new Error(`cannot read ${file.path}`);
		const content = this.files.get(file.path);
		if (content === undefined) throw new Error(`no such file ${file.path}`);
		return content;
	}

	async modify(file: MigratableFile, content: string): Promise<void> {
		this.files.set(file.path, content);
		this.written.set(file.path, content);
	}

	contentOf(path: string): string | undefined {
		return this.files.get(path);
	}

	wasWritten(path: string): boolean {
		return this.written.has(path);
	}
}

function silentLog(): void {
	// Tests assert on the returned summary, not on log output.
}

test('runViewTypeMigration rewrites legacy ids and reports the migrated count', async () => {
	const vault = new FakeVault(new Map([
		['Bases/Articles.base', 'views:\n  - type: more-bases-raycast\n    name: Table\n'],
		['Bases/Board.base', 'views:\n  - type: more-bases-kanban\n    name: Board\n'],
		['notes/note.md', 'not a base file'],
	]));

	const notices: string[] = [];
	const summary = await runViewTypeMigration(vault, (message) => notices.push(message), silentLog);

	assert.deepEqual(summary, { migrated: 2, skipped: 0, unchanged: 0 });
	assert.match(vault.contentOf('Bases/Articles.base') ?? '', /type: views-search/);
	assert.match(vault.contentOf('Bases/Board.base') ?? '', /type: views-kanban/);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /updated 2 base files/);
});

test('runViewTypeMigration is idempotent: an already-migrated file is left untouched and not written', async () => {
	const vault = new FakeVault(new Map([
		['Bases/Articles.base', 'views:\n  - type: views-search\n    name: Table\n'],
	]));

	const notices: string[] = [];
	const summary = await runViewTypeMigration(vault, (message) => notices.push(message), silentLog);

	assert.deepEqual(summary, { migrated: 0, skipped: 0, unchanged: 1 });
	assert.equal(vault.wasWritten('Bases/Articles.base'), false);
	assert.equal(notices.length, 0);
});

test('runViewTypeMigration skips a file it cannot read instead of writing anything', async () => {
	const files = new Map([
		['Bases/Broken.base', 'views:\n  - type: more-bases-graph\n    name: Graph\n'],
	]);
	const vault = FakeVault.withUnreadable(files, ['Bases/Broken.base']);

	const notices: string[] = [];
	const summary = await runViewTypeMigration(vault, (message) => notices.push(message), silentLog);

	assert.deepEqual(summary, { migrated: 0, skipped: 1, unchanged: 0 });
	assert.equal(vault.wasWritten('Bases/Broken.base'), false);
	assert.equal(notices.length, 1);
	assert.match(notices[0], /updated 0 base files/);
	assert.match(notices[0], /1 base file could not be checked/);
});

test('runViewTypeMigration skips an empty file rather than writing an empty file back', async () => {
	const vault = new FakeVault(new Map([
		['Bases/Empty.base', ''],
	]));

	const summary = await runViewTypeMigration(vault, () => {}, silentLog);

	assert.deepEqual(summary, { migrated: 0, skipped: 1, unchanged: 0 });
	assert.equal(vault.wasWritten('Bases/Empty.base'), false);
});

test('runViewTypeMigration says nothing when there is nothing to migrate', async () => {
	const vault = new FakeVault(new Map([
		['Bases/Clean.base', 'views:\n  - type: views-search\n    name: Table\n'],
		['notes/note.md', 'irrelevant'],
	]));

	const notices: string[] = [];
	await runViewTypeMigration(vault, (message) => notices.push(message), silentLog);

	assert.deepEqual(notices, []);
});

test('runViewTypeMigration ignores non-.base files entirely', async () => {
	const vault = new FakeVault(new Map([
		['notes/note.md', 'type: more-bases-kanban'],
	]));

	const summary = await runViewTypeMigration(vault, () => {}, silentLog);

	assert.deepEqual(summary, { migrated: 0, skipped: 0, unchanged: 0 });
});
