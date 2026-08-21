import esbuild from 'esbuild';
import { glob } from 'fs/promises';

/**
 * Bundles every tests/**\/*.test.ts to plain ESM in test-build/, mirroring
 * the tests/ directory layout so failures point back at a readable path.
 * `obsidian` stays external: the package ships types only (see package.json's
 * "main": ""), and every pure module under test imports it with `import type`
 * only, so nothing here ever needs it resolved at runtime. `node --test` runs
 * the compiled output directly; see package.json's "test" script.
 *
 * The output directory is deliberately not dot-prefixed: node:test's default
 * file discovery skips dot-directories, so a directory named `.test-build`
 * silently finds nothing to run instead of failing loudly.
 */

const entryPoints = [];
for await (const file of glob('tests/**/*.test.ts')) entryPoints.push(file);

if (entryPoints.length === 0) {
	console.error('No test files found under tests/**/*.test.ts');
	process.exit(1);
}

await esbuild.build({
	entryPoints,
	outdir: 'test-build',
	outbase: 'tests',
	bundle: true,
	platform: 'node',
	format: 'esm',
	// .mjs, not .js: package.json has no "type": "module" (the plugin itself
	// builds to CJS for Obsidian), so a bare .js output would make Node sniff
	// each file and reparse it as ESM on every run.
	outExtension: { '.js': '.mjs' },
	target: 'node20',
	external: ['obsidian'],
	sourcemap: 'inline',
	logLevel: 'info',
});
