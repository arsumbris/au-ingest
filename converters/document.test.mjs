import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from './document.convert.mjs';
import * as note from './note.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'document');
const GARBAGE = [/\[object \w+\]/, /�/]; // [object Object] / mojibake replacement char

async function run(file, rawBytes) {
  const raw = rawBytes ?? readFileSync(join(FIX, file));
  const { source } = await convert({ raw, date: '2026-08-06', self: { raw: file, note: file.replace(/\.[^.]+$/, '') }, note });
  return source;
}

const cases = [
  { file: 'report.docx', want: (s) => /^format: docx$/m.test(s) && s.includes('# Conversion test document') && s.includes('](https://example.com/test)') && s.includes('[^1]: Original test footnote.') && /^1\. /m.test(s) && s.includes('| Square | 7 |') },
  { file: 'budget.xlsx', want: (s) => /^format: xlsx$/m.test(s) && s.includes('## Summary') && s.includes('## Details') && s.includes('| Circle | 8 | 6 | 2 |') },
  { file: 'deck.pptx', want: (s) => /^format: pptx$/m.test(s) && s.includes('Conversion test document') && s.includes('> Original test speaker notes.') },
  { file: 'sample.odt', want: (s) => /^format: odt$/m.test(s) && s.includes('Conversion test document') },
  { file: 'sample.rtf', want: (s) => /^format: rtf$/m.test(s) && s.includes('Conversion test document') },
  { file: 'sample.epub', want: (s) => /^format: epub$/m.test(s) && s.includes('Conversion test document') && s.includes('inline code') },
  { file: 'sample.csv', want: (s) => /^format: csv$/m.test(s) && s.includes('| quoted, with comma | 7 | edge-case |') },
];

for (const { file, want } of cases) {
  test(`${file} preserves expected content and source fields`, async () => {
    const source = await run(file);
    assert.match(source, /^type: document::au-ingest$/m);
    assert.ok(source.includes(`original: "[[${file}]]"`));
    for (const pattern of GARBAGE) assert.doesNotMatch(source, pattern);
    assert.ok(want(source), source);
  });
}

for (const [file, bytes, error] of [
  ['sample-text.pdf', readFileSync(join(FIX, '..', 'pdf', 'sample-text.pdf')), /PDF routes to the 'pdf' converter/],
  ['broken.docx', Buffer.from('this is not a real docx zip'), /anydoc could not convert this docx \(malformed\)/],
  ['mystery.xyz', Buffer.from('plain text, no signature'), /unknown document format/],
]) {
  test(`${file} is rejected`, async () => {
    await assert.rejects(run(file, bytes), error);
  });
}
