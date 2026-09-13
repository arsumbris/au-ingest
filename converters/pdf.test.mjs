import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convert } from './pdf.convert.mjs';
import * as note from './note.mjs';

async function run(file, raw = readFileSync(new URL('./fixtures/pdf/' + file, import.meta.url))) {
  return (await convert({ raw, date: '2026-08-02', self: { raw: file }, note })).source;
}

test('text PDF preserves source fields and summarizes extracted text', async () => {
  const source = await run('sample-text.pdf');
  assert.match(source, /^type: pdf::au-ingest$/m);
  assert.doesNotMatch(source, /^pages:/m);
  assert.match(source, /^captured: 2026-08-02$/m);
  assert.match(source, /^tldr: Conversion test document$/m);
  assert.ok(source.includes('original: "[[sample-text.pdf]]"'));
  assert.ok(source.includes('This original sample checks document conversion.'));
  assert.doesNotMatch(source, /\[object \w+\]|�/);
});

for (const [file, raw, error] of [
  ['sample-scanned.pdf', undefined, { code: 'needsOcr', pages: [1], pageCount: 1 }],
  ['sample-mixed.pdf', undefined, { code: 'needsOcr', pages: [2], pageCount: 2 }],
  ['corrupt.pdf', Buffer.from('not a PDF'), { code: 'malformed' }],
]) {
  test(`${file} is rejected`, async () => assert.rejects(run(file, raw), error));
}
