import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildSections,
	contentSelectorLabel,
	extractCalloutType,
	extractCodeLanguage,
	extractContentValue,
	extractSectionText,
	formatContentDisplay,
	parseContentSelector,
	type ContentCacheLike,
} from '../../src/logic/contentIndex';

// --- parseContentSelector: one case per row of the selector syntax table ---

test('parseContentSelector: heading selectors', () => {
	assert.deepEqual(parseContentSelector('# Overview'), { kind: 'heading', level: 1, text: 'Overview' });
	assert.deepEqual(parseContentSelector('### Deep dive'), { kind: 'heading', level: 3, text: 'Deep dive' });
	assert.deepEqual(parseContentSelector('## *'), { kind: 'heading', level: 2, text: null });
});

test('parseContentSelector: callout selectors', () => {
	assert.deepEqual(parseContentSelector('[!note]'), { kind: 'callout', type: 'note' });
	assert.deepEqual(parseContentSelector('[!WARNING]'), { kind: 'callout', type: 'warning' });
	assert.deepEqual(parseContentSelector('[!*]'), { kind: 'callout', type: null });
});

test('parseContentSelector: code selectors', () => {
	assert.deepEqual(parseContentSelector('```ts'), { kind: 'code', lang: 'ts' });
	assert.deepEqual(parseContentSelector('```TS'), { kind: 'code', lang: 'ts' });
	assert.deepEqual(parseContentSelector('```'), { kind: 'code', lang: null });
});

test('parseContentSelector: task selectors', () => {
	assert.deepEqual(parseContentSelector('- [?]'), { kind: 'tasks', mode: 'all' });
	assert.deepEqual(parseContentSelector('- [x]'), { kind: 'tasks', mode: 'done' });
	assert.deepEqual(parseContentSelector('- [X]'), { kind: 'tasks', mode: 'done' });
	assert.deepEqual(parseContentSelector('- [ ]'), { kind: 'tasks', mode: 'open' });
});

test('parseContentSelector: malformed entries become invalid, carrying the raw text', () => {
	for (const raw of ['', 'not a selector', '#NoSpace', '[!]', '- [z]', '````lang']) {
		const result = parseContentSelector(raw);
		assert.equal(result.kind, 'invalid');
		if (result.kind === 'invalid') assert.equal(result.raw, raw);
	}
});

test('contentSelectorLabel derives a label straight from each selector kind', () => {
	assert.equal(contentSelectorLabel({ kind: 'heading', level: 2, text: 'Notes' }), 'Notes');
	assert.equal(contentSelectorLabel({ kind: 'heading', level: 2, text: null }), 'Level 2 heading');
	assert.equal(contentSelectorLabel({ kind: 'callout', type: 'warning' }), 'warning callouts');
	assert.equal(contentSelectorLabel({ kind: 'callout', type: null }), 'Callouts');
	assert.equal(contentSelectorLabel({ kind: 'code', lang: 'ts' }), 'ts');
	assert.equal(contentSelectorLabel({ kind: 'code', lang: null }), 'Code');
	assert.equal(contentSelectorLabel({ kind: 'tasks', mode: 'open' }), 'Open tasks');
	assert.equal(contentSelectorLabel({ kind: 'tasks', mode: 'done' }), 'Completed tasks');
	assert.equal(contentSelectorLabel({ kind: 'tasks', mode: 'all' }), 'Tasks');
	assert.equal(contentSelectorLabel({ kind: 'invalid', raw: 'garbage' }), 'garbage');
});

// --- extractCodeLanguage / extractCalloutType: read straight off the source line ---

test('extractCodeLanguage reads the fence language, case-folded, empty for unlabelled', () => {
	assert.equal(extractCodeLanguage('```TypeScript'), 'typescript');
	assert.equal(extractCodeLanguage('~~~python'), 'python');
	assert.equal(extractCodeLanguage('```'), '');
});

test('extractCalloutType reads the marker type and drops a fold hint', () => {
	assert.equal(extractCalloutType('> [!note]'), 'note');
	assert.equal(extractCalloutType('> [!WARNING]+'), 'warning');
	assert.equal(extractCalloutType('not a callout'), '');
});

// --- buildSections: the heading/callout/code/task slicer over a fake cache ---

function lines(...content: string[]): string[] {
	return content;
}

test('a heading section ends at the next heading of the same or higher level', () => {
	const rawLines = lines(
		'## Overview',      // 0
		'body line',        // 1
		'### Detail',       // 2
		'nested body',      // 3
		'## Next',          // 4
		'other body',       // 5
	);
	const cache: ContentCacheLike = {
		headings: [
			{ heading: 'Overview', level: 2, position: { start: { line: 0 }, end: { line: 0 } } },
			{ heading: 'Detail', level: 3, position: { start: { line: 2 }, end: { line: 2 } } },
			{ heading: 'Next', level: 2, position: { start: { line: 4 }, end: { line: 4 } } },
		],
	};
	const sections = buildSections(rawLines, cache);
	const overview = sections.find((s) => s.key === 'Overview');
	assert.ok(overview);
	// Overview's own section ends where the next heading at level <= 2 starts,
	// so it swallows the level-3 Detail subsection that belongs to it.
	assert.equal(overview?.startLine, 1);
	assert.equal(overview?.endLine, 3);

	const detail = sections.find((s) => s.key === 'Detail');
	assert.equal(detail?.startLine, 3);
	assert.equal(detail?.endLine, 3);

	const next = sections.find((s) => s.key === 'Next');
	assert.equal(next?.startLine, 5);
	assert.equal(next?.endLine, 5);
});

test('a heading with nothing after it runs to end of file', () => {
	const rawLines = lines('# Only', 'a', 'b');
	const cache: ContentCacheLike = {
		headings: [{ heading: 'Only', level: 1, position: { start: { line: 0 }, end: { line: 0 } } }],
	};
	const sections = buildSections(rawLines, cache);
	assert.equal(sections[0].startLine, 1);
	assert.equal(sections[0].endLine, 2);
});

test('a code section excludes both fence lines and reads its language off the opening one', () => {
	const rawLines = lines('```ts', 'const x = 1;', '```');
	const cache: ContentCacheLike = {
		sections: [{ type: 'code', position: { start: { line: 0 }, end: { line: 2 } } }],
	};
	const sections = buildSections(rawLines, cache);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].kind, 'code');
	assert.equal(sections[0].key, 'ts');
	assert.equal(sections[0].startLine, 1);
	assert.equal(sections[0].endLine, 1);
});

test('a callout section keeps its marker line so the callout marker stripping has something to strip', () => {
	const rawLines = lines('> [!warning] Careful', '> body line');
	const cache: ContentCacheLike = {
		sections: [{ type: 'callout', position: { start: { line: 0 }, end: { line: 1 } } }],
	};
	const sections = buildSections(rawLines, cache);
	assert.equal(sections[0].kind, 'callout');
	assert.equal(sections[0].key, 'warning');
	assert.equal(sections[0].startLine, 1);
	assert.equal(sections[0].endLine, 1);
	assert.equal(extractSectionText(rawLines, sections[0]), 'body line');
});

test('task list items become their own one-line sections, keyed by checked state', () => {
	const rawLines = lines('- [ ] open task', '- [x] done task');
	const cache: ContentCacheLike = {
		listItems: [
			{ task: ' ', position: { start: { line: 0 }, end: { line: 0 } } },
			{ task: 'x', position: { start: { line: 1 }, end: { line: 1 } } },
			{ position: { start: { line: 0 }, end: { line: 0 } } }, // not a task at all
		],
	};
	const sections = buildSections(rawLines, cache);
	assert.equal(sections.length, 2);
	assert.equal(sections[0].checked, false);
	assert.equal(sections[1].checked, true);
});

test('a code selector resolves to the fenced content with the fence marker lines excluded', () => {
	const rawLines = lines(
		'# Notes',
		'text before',
		'```js',
		'code();',
		'```',
		'text after',
	);
	const cache: ContentCacheLike = {
		headings: [{ heading: 'Notes', level: 1, position: { start: { line: 0 }, end: { line: 0 } } }],
		sections: [{ type: 'code', position: { start: { line: 2 }, end: { line: 4 } } }],
	};
	const sections = buildSections(rawLines, cache);
	const codeOnly = extractContentValue(sections, rawLines, { kind: 'code', lang: null });
	assert.equal(codeOnly.full, 'code();');
	assert.ok(!codeOnly.full.includes('```'));
});

// --- formatContentDisplay ---

test('formatContentDisplay trims trailing whitespace per line and collapses blank runs', () => {
	const input = 'first line   \n\n\n\nsecond line\t\n';
	assert.equal(formatContentDisplay(input), 'first line\n\nsecond line');
});

test('formatContentDisplay drops leading and trailing blank lines but keeps interior single breaks', () => {
	const input = '\n\nkeep\nthis\n\n';
	assert.equal(formatContentDisplay(input), 'keep\nthis');
});

test('formatContentDisplay on an empty string is empty', () => {
	assert.equal(formatContentDisplay(''), '');
});
