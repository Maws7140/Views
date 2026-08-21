import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

/**
 * The whole harness depends on the `obsidian` package never being resolved
 * at runtime: it ships types only (`"main": ""` in node_modules/obsidian's
 * package.json), so a value import of it crashes the moment Node tries to
 * load the module. Every module this harness exercises headless is exercised
 * on that promise, and it has already broken silently once (`contentIndex.ts`
 * imported `App, TFile` as values, both used only as types).
 *
 * This test reads each pure module's source text directly and fails if any
 * `from 'obsidian'` import line is not `import type`. It is source-level on
 * purpose: the point is to catch the mistake at the moment someone writes
 * `import {` instead of `import type {`, not to wait for a bundler to decide
 * whether it can elide the now-unused binding.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const PURE_MODULES = [
	'src/logic/graphModel.ts',
	'src/logic/lanes.ts',
	'src/logic/dateScale.ts',
	'src/logic/dateValue.ts',
	'src/logic/virtualize.ts',
	'src/logic/calendarGrid.ts',
	'src/logic/heatBuckets.ts',
	'src/logic/contentIndex.ts',
	'src/graph/forceLayout.ts',
	'src/graph/graphFilters.ts',
	'src/graph/graphDepth.ts',
	'src/graph/radialLayout.ts',
	'src/graph/rootSelection.ts',
	'src/graph/linkProperties.ts',
	'src/graph/types.ts',
	'src/settings/settings.ts',
	'src/table-colors/palettes.ts',
];

const OBSIDIAN_IMPORT_LINE_RE = /^\s*import\s+([^;]*?)\s+from\s+['"]obsidian['"]\s*;?\s*$/gm;

test('pure modules import obsidian with import type only', () => {
	assert.ok(PURE_MODULES.length >= 10, 'expected to find most of the known pure modules on disk');

	for (const relativePath of PURE_MODULES) {
		const source = readFileSync(join(repoRoot, relativePath), 'utf8');
		const matches = [...source.matchAll(OBSIDIAN_IMPORT_LINE_RE)];
		for (const match of matches) {
			const importClause = match[1];
			assert.match(
				importClause,
				/^type\s/,
				`${relativePath} imports from 'obsidian' without 'import type': "${match[0].trim()}". `
				+ `A value import of 'obsidian' crashes at runtime in Node since the package ships no JS.`,
			);
		}
	}
});

test('at least one pure module imports nothing from obsidian at all', () => {
	// forceLayout.ts is the plan's example of a module that needs no shape from
	// obsidian whatsoever. Confirms the list above is not accidentally checking
	// nothing (a regex that never matches would pass trivially).
	const source = readFileSync(join(repoRoot, 'src/graph/forceLayout.ts'), 'utf8');
	assert.doesNotMatch(source, /from ['"]obsidian['"]/);
});
