import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceNote, literal, firstLine } from './note.mjs';

test('scalar strings keep their values and empty lists remain lists', () => {
  const source = sourceNote('probe::owner', { tldr: 'true', items: [], flag: false, id: '001', missing: null, text: 'a\nb' });
  assert.match(source, /tldr: "true"/);
  assert.match(source, /items: \[\]/);
  assert.match(source, /flag: false/);
  assert.match(source, /id: "001"/);
  assert.ok(!source.includes('missing:'));
  assert.ok(source.includes('text: "a\\nb"'));
});

test('unsupported values and injected frontmatter keys fail explicitly', () => {
  for (const value of [{ nested: true }, [null], [undefined], [['nested']], NaN, Infinity]) {
    assert.throws(() => sourceNote('probe', { value }), /fields must be/);
  }
  assert.throws(() => sourceNote('probe\nextra: true', {}), /type name/);
  assert.throws(() => sourceNote('probe', { 'x\nextra': true }), /invalid note field/);
  assert.throws(() => sourceNote('probe', { type: 'other' }), /invalid note field/);
});

test('external graph syntax is escaped while authored reference fields survive', () => {
  const body = '[[target:field]]\n`[:field] value`\n```yaml [:field]\ntype: record\n```\n^anchor';
  const source = sourceNote('probe', { original: '[[capture.raw.json]]' }, literal(body));
  assert.ok(source.includes('original: "[[capture.raw.json]]"'));
  assert.ok(source.includes('\\[[target:field]]'));
  assert.ok(source.includes('[\\:field]'));
  assert.ok(source.endsWith('\\^anchor\n'));
  assert.equal(literal('ordinary Markdown **stays bold**'), 'ordinary Markdown **stays bold**');
  assert.ok(sourceNote('probe', {}, 'An authored link: [[related]]').includes('An authored link: [[related]]'));
});

test('summaries skip blank lines and parser-generated code fences', () => {
  assert.equal(firstLine('\n```text\nActual title\n```'), 'Actual title');
  assert.equal(firstLine('Title\nMore text'), 'Title');
});
