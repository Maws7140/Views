import { spawnSync } from 'node:child_process';
import { glob } from 'fs/promises';

/**
 * `npm test` entry point. Builds tests/**\/*.test.ts to test-build/ (see
 * build-tests.mjs), then hands every compiled *.test.js file to
 * `node --test` explicitly.
 *
 * Passing the output directory itself to `node --test <dir>` does not
 * reliably walk it on every Node version/platform combination this plugin
 * has been developed on: it can fall through to treating the directory as a
 * script path and fail with `Cannot find module`. Listing the compiled files
 * out and passing them by name sidesteps that discovery behavior entirely,
 * which is the point of controlling the build step ourselves rather than
 * depending on the test runner to find things.
 */

const build = spawnSync(process.execPath, ['scripts/build-tests.mjs'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const files = [];
for await (const file of glob('test-build/**/*.test.mjs')) files.push(file);

if (files.length === 0) {
	console.error('No compiled test files found under test-build/**/*.test.mjs');
	process.exit(1);
}

const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status ?? 1);
