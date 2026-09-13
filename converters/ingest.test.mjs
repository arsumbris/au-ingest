import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, linkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin } from '../ingest.mjs';
import { hashOf, LIMITS } from './ingest-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const XREPO = join(HERE, 'fixtures/xrepo');
const types = ['pdf', 'document'].map((name) => ({ name, repo: 'au-ingest', source: { file: join(ROOT, 'type', name + '.type.yaml') } }));
types.push({ name: 'probe', repo: 'xrepo-fixture', source: { file: join(XREPO, 'type/probe.type.yaml') } });

function fixture(t, options = {}) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'au-ingest-test-')));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, 'content'));
  for (const name of ['paper', 'paper2', 'dup', 'dup.raw']) copyFileSync(join(HERE, 'fixtures/pdf/sample-text.pdf'), join(workspace, 'content', name + '.pdf'));
  copyFileSync(join(HERE, 'fixtures/document/report.docx'), join(workspace, 'content/doc.docx'));
  copyFileSync(join(XREPO, 'probe.raw.json'), join(workspace, 'content/probe.raw.json'));
  const writes = [], reads = [];
  const get = (path) => {
    try {
      const text = readFileSync(path, 'utf8');
      return { text, hash: hashOf(text), commit: 'c0' };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const broker = {
    available: () => true,
    async read(op, args) {
      reads.push({ op, args });
      const custom = await options.read?.(op, args, { get, reads, workspace });
      if (custom !== undefined) return custom;
      let result;
      if (op === 'members') result = [
        { repo: 'consumer', root: workspace, editable: true, local: true, role: 'entry' },
        { repo: 'au-ingest', root: ROOT }, { repo: 'xrepo-fixture', root: XREPO },
        ...(options.members ?? []),
      ];
      else if (op === 'subtypes') result = { subtypes: args.base === 'source::au-base-types' ? [...types, ...(options.types ?? [])] : [] };
      else if (op === 'content') result = get(args.path);
      else if (op === 'preview_mutation') {
        const [name, repo] = /^type: (.+)::(.+)$/m.exec(args.content)?.slice(1) ?? [];
        result = options.preview ?? { target: { path: args.path, hash: hashOf(args.content), identities: [{ name, repo }], diagnostics: [] }, blast_radius: [] };
      } else throw new Error('unexpected read: ' + op);
      return { type: 'response', ready: true, result };
    },
    async mutate(op, args) {
      assert.equal(op, 'write_file');
      const save = () => {
        const current = get(args.path);
        if (args.expected_hash !== undefined && current?.hash !== args.expected_hash) return { type: 'error', message: 'expected_hash mismatch' };
        mkdirSync(dirname(args.path), { recursive: true });
        writeFileSync(args.path, args.content);
        writes.push(args);
        return { ready: true, result: { hash: hashOf(args.content), commit: 'commit-' + writes.length, diagnostics: options.diagnostics ?? [] } };
      };
      return options.mutate ? options.mutate(args, { save, workspace }) : save();
    },
  };
  const plugin = createPlugin({ workspace, broker });
  const call = (input = {}) => plugin.invoke({ raw: 'content/paper.pdf', converter: 'pdf', date: '2026-09-09', ...input });
  return { workspace, broker, writes, reads, call };
}

test('PDF and document conversion write typed notes and preserve archived bytes', async (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.workspace, 'content/paper.pdf'));
  for (const [raw, converter] of [['content/paper.pdf', 'pdf'], ['content/doc.docx', 'document']]) {
    const result = await f.call({ raw, converter });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(result.content.results[0].status, 'created');
    assert.ok(result.content.results[0].hash);
    assert.ok(result.content.results[0].commit);
  }
  assert.deepEqual(readFileSync(join(f.workspace, 'content/paper.pdf')), before);
  assert.match(f.writes[0].content, /original: "\[\[content\/paper\.pdf\]\]"/);
  assert.equal(f.writes[0].expected_hash, undefined);
});

test('identical re-ingestion is a no-op; changed notes need explicit refresh', async (t) => {
  const f = fixture(t);
  await f.call();
  const initial = f.writes[0].content;
  const unchanged = await f.call();
  assert.equal(unchanged.content.results[0].status, 'unchanged');
  assert.equal(f.writes.length, 1);
  writeFileSync(join(f.workspace, 'content/paper.md'), initial + '\nHuman annotation.\n');
  const preserve = await f.call();
  assert.equal(preserve.content.results[0].status, 'conflict');
  assert.equal(preserve.isError, true);
  assert.equal(f.writes.length, 1);
  const previousHash = hashOf(readFileSync(join(f.workspace, 'content/paper.md')));
  const refreshed = await f.call({ refresh: true });
  assert.equal(refreshed.content.results[0].status, 'updated');
  assert.equal(f.writes[1].expected_hash, previousHash);
});

test('immutable captures can share an explicit stable destination', async (t) => {
  const f = fixture(t);
  const first = await f.call({ destination: 'notes/report.md' });
  assert.equal(first.content.results[0].status, 'created');
  const next = await f.call({ raw: 'content/paper2.pdf', destination: 'notes/report.md', refresh: true });
  assert.equal(next.content.results[0].status, 'updated');
  assert.equal(f.writes[0].path, f.writes[1].path);
  assert.match(f.writes[1].content, /original: "\[\[content\/paper2\.pdf\]\]"/);
});

test('invalid input is rejected before discovery or writes', async (t) => {
  const f = fixture(t);
  const invalid = [
    { date: '2026-02-30' }, { date: '2025-02-29' }, { date: '0000-01-01' }, { date: '2026/09/09' },
    { raws: ['content/paper.pdf'] }, { raw: undefined, raws: [] },
    { raw: undefined, raws: Array(LIMITS.batch + 1).fill('content/paper.pdf') },
    { refresh: 'true' }, { converter: '../outside' },
    { raw: undefined, raws: ['content/paper.pdf'], destination: 'notes/paper.md' },
  ];
  for (const input of invalid) assert.equal((await f.call(input)).isError, true, JSON.stringify(input));
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.call({ date: '2024-02-29' })).content.results[0].status, 'created');
});

test('explicit batches match single imports, preserve edits, and refresh with hash guards', async (t) => {
  const single = fixture(t), batch = fixture(t);
  const items = [
    { raw: 'content/paper.pdf', destination: 'notes/first.md' },
    { raw: 'content/paper2.pdf', destination: 'notes/second.md' },
  ];
  const before = items.map(({ raw }) => readFileSync(join(batch.workspace, raw)));
  for (const item of items) assert.equal((await single.call(item)).isError, undefined);
  const input = { raw: undefined, items };
  const result = await batch.call(input);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content.results.map((item) => item.status), ['created', 'created']);
  assert.deepEqual(batch.writes.map((write) => write.content), single.writes.map((write) => write.content));
  assert.deepEqual(batch.writes.map((write) => write.path), items.map((item) => join(batch.workspace, item.destination)));
  assert.equal(batch.reads.filter((read) => read.op === 'members').length, 1);
  assert.deepEqual((await batch.call(input)).content.results.map((item) => item.status), ['unchanged', 'unchanged']);
  const path = join(batch.workspace, items[0].destination);
  const edited = readFileSync(path, 'utf8') + '\nHuman annotation.\n';
  writeFileSync(path, edited);
  assert.deepEqual((await batch.call(input)).content.results.map((item) => item.status), ['conflict', 'unchanged']);
  assert.equal(readFileSync(path, 'utf8'), edited);
  assert.equal(batch.writes.length, 2);
  assert.deepEqual((await batch.call({ ...input, refresh: true })).content.results.map((item) => item.status), ['updated', 'unchanged']);
  assert.equal(batch.writes[2].expected_hash, hashOf(edited));
  for (const [index, { raw }] of items.entries()) assert.deepEqual(readFileSync(join(batch.workspace, raw)), before[index]);
});

test('explicit batches reject malformed or mixed inputs before discovery', async (t) => {
  const f = fixture(t);
  const item = { raw: 'content/paper.pdf', destination: 'notes/paper.md' };
  for (const items of [null, {}, [], Array(33).fill(item), [null], [[]], ['raw'],
    [{ raw: item.raw }], [{ destination: item.destination }],
    [{ ...item, raw: 123 }], [{ ...item, raw: ' ' }],
    [{ ...item, destination: null }], [{ ...item, destination: 123 }], [{ ...item, destination: ' ' }]]) {
    assert.equal((await f.call({ raw: undefined, items })).isError, true, JSON.stringify(items));
  }
  for (const extra of [{ raw: item.raw }, { raws: [item.raw] }, { destination: item.destination }]) {
    assert.equal((await f.call({ raw: undefined, items: [item], ...extra })).isError, true);
  }
  for (const extra of [{ date: '2026-09-10' }, { converter: 'document' }, { refresh: false }]) {
    const result = await f.call({ raw: undefined, items: [{ ...item, ...extra }] });
    assert.equal(result.isError, true);
    assert.match(result.content.error, /items accept only raw and destination/);
  }
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
});

test('a misplaced per-item refresh cannot silently overwrite an edited note', async (t) => {
  const f = fixture(t);
  const item = { raw: 'content/paper.pdf', destination: 'notes/paper.md' };
  assert.equal((await f.call(item)).isError, undefined);
  const path = join(f.workspace, item.destination);
  const edited = readFileSync(path, 'utf8') + '\nHuman annotation.\n';
  writeFileSync(path, edited);
  const reads = f.reads.length;
  const result = await f.call({ raw: undefined, refresh: true, items: [{ ...item, refresh: false }] });
  assert.equal(result.isError, true);
  assert.equal(f.reads.length, reads);
  assert.equal(f.writes.length, 1);
  assert.equal(readFileSync(path, 'utf8'), edited);
});

test('explicit batches accept 32 items and account for every raw on discovery failure', async (t) => {
  const f = fixture(t);
  const items = Array.from({ length: 32 }, (_, i) => ({ raw: 'content/probe.raw.json', destination: `notes/probe-${i}.md` }));
  const input = { raw: undefined, items, converter: 'probe::xrepo-fixture' };
  const rejected = await f.call({ ...input, converter: 'missing' });
  assert.equal(rejected.isError, true);
  assert.deepEqual(rejected.content.results.map((item) => item.raw), items.map((item) => item.raw));
  assert.equal(f.writes.length, 0);
  const result = await f.call(input);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.equal(f.writes.length, 32);
});

test('explicit batch collisions protect every input and destination before writes', async (t) => {
  for (const destinations of [
    ['notes/same.md', 'notes/same.md'],
    ['notes/same.md', 'notes/SAME.md'],
    ['notes/caf\u00e9.md', 'notes/cafe\u0301.md'],
    ['content/missing.md', 'notes/other.md'],
  ]) {
    const f = fixture(t);
    const result = await f.call({ raw: undefined, items: [
      { raw: 'content/paper.pdf', destination: destinations[0] },
      { raw: destinations[0] === 'content/missing.md' ? 'content/missing.md' : 'content/paper2.pdf', destination: destinations[1] },
    ] });
    assert.deepEqual(result.content.results.map((item) => item.status), ['failed', 'failed']);
    assert.equal(f.writes.length, 0);
  }
});

test('paths, symlinks, hard links and input/destination collisions refuse before a write', async (t) => {
  const f = fixture(t);
  symlinkSync(join(f.workspace, 'content/paper.pdf'), join(f.workspace, 'content/link.pdf'));
  symlinkSync(join(f.workspace, 'content'), join(f.workspace, 'alias'));
  symlinkSync(join(f.workspace, 'content/missing.md'), join(f.workspace, 'content/dangling.md'));
  writeFileSync(join(f.workspace, 'content/linked.md'), 'keep');
  linkSync(join(f.workspace, 'content/linked.md'), join(f.workspace, 'content/also-linked.md'));
  for (const input of [
    { raw: '../escape.pdf' }, { raw: 'content' }, { raw: '.git/config' },
    { destination: '.GIT/capture.md' }, { destination: '.Arsumbris/capture.md' },
    { raw: 'content/link.pdf' }, { raw: 'alias/paper.pdf' },
    { destination: 'content/dangling.md' }, { destination: 'content/linked.md', refresh: true },
    { destination: '../escape.md' }, { destination: 'notes/no.txt' },
    { raw: 'content/linked.md' },
  ]) {
    const result = await f.call(input);
    assert.equal(result.isError, true, JSON.stringify(input));
  }
  assert.equal(f.writes.length, 0);
});

test('captures and destinations cannot cross into mounted or undeclared nested repositories', async (t) => {
  const members = [];
  const f = fixture(t, { members });
  const root = join(f.workspace, 'nested');
  mkdirSync(root);
  copyFileSync(join(f.workspace, 'content/paper.pdf'), join(root, 'paper.pdf'));
  members.push({ repo: 'another-repo', root, editable: true, local: true });
  mkdirSync(join(f.workspace, 'undeclared/.arsumbris'), { recursive: true });
  writeFileSync(join(f.workspace, 'undeclared/.arsumbris/repo.yaml'), 'name: undeclared\n');
  copyFileSync(join(f.workspace, 'content/paper.pdf'), join(f.workspace, 'undeclared/paper.pdf'));
  for (const input of [
    { raw: 'nested/paper.pdf' }, { destination: 'nested/notes/paper.md' },
    { raw: 'undeclared/paper.pdf' }, { destination: 'undeclared/notes/paper.md' },
  ]) {
    const result = await f.call(input);
    assert.equal(result.isError, true);
    assert.match(result.content.results[0].error, /another repository/);
  }
  assert.equal(f.writes.length, 0);
});

test('all colliding batch destinations are refused before the first write', async (t) => {
  const f = fixture(t);
  const result = await f.call({ raw: undefined, raws: ['content/dup.pdf', 'content/dup.raw.pdf'] });
  assert.deepEqual(result.content.results.map((r) => r.status), ['failed', 'failed']);
  assert.equal(f.writes.length, 0);
  assert.match(JSON.stringify(result.content), /same destination/);
  writeFileSync(join(f.workspace, 'content/paper.md'), 'oversized capture');
  truncateSync(join(f.workspace, 'content/paper.md'), LIMITS.rawBytes + 1);
  const collision = await f.call({ raw: undefined, raws: ['content/paper.pdf', 'content/paper.md'], refresh: true });
  assert.deepEqual(collision.content.results.map((r) => r.status), ['failed', 'failed']);
  assert.equal(f.writes.length, 0, 'even a rejected input capture must be protected from another item');
});

test('batches retain every result and mark partial failure', async (t) => {
  const f = fixture(t);
  const result = await f.call({ raw: undefined, raws: ['content/paper.pdf', 'content/missing.pdf', 'content/paper2.pdf'] });
  assert.deepEqual(result.content.results.map((r) => r.status), ['created', 'failed', 'created']);
  assert.equal(result.isError, true);
  assert.deepEqual(result.readViewUpdate.remove, [f.writes[0].path]);
  assert.equal(result.readViewUpdate.set.path, f.writes[1].path);
  assert.equal(result.readViewUpdate.set.hash, hashOf(f.writes[1].content));
});

test('engine read errors and malformed snapshots never become unconditional writes', async (t) => {
  for (const frame of [
    { type: 'error', message: 'read failed' }, { ready: false }, {}, { result: {} }, { result: { hash: 'x' } },
    { type: 'ok', ready: true, result: { hash: 'x', text: 'unexpected response type' } },
  ]) {
    const f = fixture(t, { read: (op) => op === 'content' ? frame : undefined });
    assert.equal((await f.call()).isError, true);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture(t, { read: (op) => op === 'content' ? { ready: true, result: null } : undefined });
  writeFileSync(join(f.workspace, 'content/paper.md'), 'engine cannot read me');
  assert.equal((await f.call()).isError, true);
  assert.equal(f.writes.length, 0);
});

test('preview rejects wrong output identity, structural errors, and unavailable validation', async (t) => {
  for (const preview of [
    { reject: { message: 'invalid path' } }, {},
    { target: { identities: [{ name: 'source', repo: 'au-base-types' }], diagnostics: [] }, blast_radius: [] },
    { target: { identities: [{ name: 'pdf', repo: 'au-ingest' }], diagnostics: [{ severity: 'error', code: 'missing-required-field' }] }, blast_radius: [] },
    { target: { identities: [{ name: 'pdf', repo: 'au-ingest' }], diagnostics: [] }, blast_radius: [{ path: 'referrer.md', diagnostics: [{ severity: 'error', code: 'wrong-target-type' }] }] },
  ]) {
    const f = fixture(t, { preview });
    assert.equal((await f.call()).isError, true, JSON.stringify(preview));
    assert.equal(f.writes.length, 0);
  }
});

test('saved warnings and structural errors remain visible', async (t) => {
  for (const severity of ['warning', 'error']) {
    const f = fixture(t, { diagnostics: [{ severity, code: 'review-output' }] });
    const result = await f.call();
    assert.equal(result.content.results[0].status, 'created');
    assert.equal(result.content.results[0].diagnostics[0].code, 'review-output');
    assert.equal(result.isError, severity === 'error' ? true : undefined);
  }
});

test('successful writes retain preview warnings about affected notes', async (t) => {
  const f = fixture(t, { preview: {
    target: { identities: [{ name: 'pdf', repo: 'au-ingest' }], diagnostics: [] },
    blast_radius: [{ path: 'referrer.md', diagnostics: [{ severity: 'warning', code: 'affected-referrer' }] }],
  } });
  const result = await f.call();
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content.results[0].diagnostics, [{ path: 'referrer.md', severity: 'warning', code: 'affected-referrer' }]);
});

test('unreflected writes preserve acknowledgement but stop with validation pending', async (t) => {
  for (const readable of [true, false]) {
    let saved = false;
    const f = fixture(t, {
      read(op) {
        if (saved && !readable && op === 'content') throw new Error('content unavailable');
      },
      mutate(args, { save }) {
        const frame = save();
        saved = true;
        return { result: { ...frame.result, hash: null, reflected: false,
          diagnostics: [{ severity: 'error', code: 'stale-index' }] } };
      },
    });
    const result = await f.call({ raw: undefined, raws: ['content/paper.pdf', 'content/paper2.pdf'] });
    const item = result.content.results[0];
    assert.deepEqual(result.content.results.map((r) => r.status), ['created', 'skipped']);
    assert.equal(result.isError, true);
    assert.equal(item.commit, 'commit-1');
    assert.equal(item.validation, 'pending');
    assert.equal(item.diagnostics, undefined, 'old index diagnostics must not describe the new note');
    assert.deepEqual(item.previewDiagnostics, []);
    assert.equal(Boolean(item.hash), readable);
    assert.equal(f.writes.length, 1);
  }
});

test('concurrent changes before creation or during refresh are preserved', async (t) => {
  const f = fixture(t, { read(op, args) {
    if (op === 'preview_mutation') writeFileSync(args.path, 'another writer won');
  } });
  const result = await f.call();
  assert.equal(result.content.results[0].status, 'conflict');
  assert.equal(f.writes.length, 0);
  assert.equal(readFileSync(join(f.workspace, 'content/paper.md'), 'utf8'), 'another writer won');

  const g = fixture(t, { mutate(args, { save }) {
    writeFileSync(args.path, 'newer version after last read');
    return save();
  } });
  writeFileSync(join(g.workspace, 'content/paper.md'), 'old note');
  const stale = await g.call({ refresh: true });
  assert.equal(stale.isError, true);
  assert.equal(g.writes.length, 0);
  assert.equal(readFileSync(join(g.workspace, 'content/paper.md'), 'utf8'), 'newer version after last read');
});

test('a capture changed during conversion is refused', async (t) => {
  const f = fixture(t, { read(op, args, { workspace }) {
    if (op === 'preview_mutation') writeFileSync(join(workspace, 'content/paper.pdf'), 'changed raw');
  } });
  const result = await f.call();
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /raw changed/);
  assert.equal(f.writes.length, 0);
});

test('lost acknowledgement reconciles present content, without a second mutation', async (t) => {
  let mutations = 0;
  const f = fixture(t, { mutate(args, { save }) { mutations++; save(); throw new Error('timeout after commit'); } });
  const result = await f.call();
  assert.equal(result.content.results[0].status, 'present');
  assert.equal(result.content.results[0].validation, 'pending');
  assert.equal(result.isError, true);
  assert.equal(mutations, 1);
  assert.ok(result.readViewUpdate.set.hash);
});

test('unknown mutation outcome stops the remaining batch and never retries', async (t) => {
  let mutations = 0;
  const f = fixture(t, { mutate() { mutations++; throw new Error('connection lost'); } });
  const result = await f.call({ raw: undefined, raws: ['content/paper.pdf', 'content/paper2.pdf'] });
  assert.deepEqual(result.content.results.map((r) => r.status), ['unknown', 'skipped']);
  assert.equal(result.isError, true);
  assert.equal(mutations, 1);
  assert.equal(result.content.results[0].hash, undefined);
});

test('malformed mutation acknowledgement is reconciled rather than counted as success', async (t) => {
  for (const frame of [null, {}, { ready: false }, { ready: true, result: {} }, { result: { hash: '', diagnostics: [] } }]) {
    const f = fixture(t, { mutate: () => frame });
    const result = await f.call();
    assert.equal(result.content.results[0].status, 'unknown');
    assert.equal(result.isError, true);
  }
});

test('mounted conversion uses member ownership and qualified names', async (t) => {
  const f = fixture(t, { types: [{ name: 'probe', repo: 'another-owner', source: { file: '/unused' } }] });
  const ambiguous = await f.call({ raw: 'content/probe.raw.json', converter: 'probe' });
  assert.equal(ambiguous.isError, true);
  assert.match(JSON.stringify(ambiguous.content), /ambiguous/);
  assert.equal(ambiguous.content.results.length, 1, 'shared preflight failures still account for every raw');
  const qualified = await f.call({ raw: 'content/probe.raw.json', converter: 'probe::xrepo-fixture' });
  assert.equal(qualified.content.results[0].status, 'created');
  assert.match(f.writes[0].content, /^type: probe::xrepo-fixture$/m);
});

test('nested type directories use their member root, not the type parent directory', async (t) => {
  const f = fixture(t);
  const root = join(f.workspace, 'mounted');
  mkdirSync(join(root, 'types/nested'), { recursive: true });
  mkdirSync(join(root, 'converters'));
  writeFileSync(join(root, 'types/nested/nested.type.yaml'), 'extends: source::au-base-types\n');
  writeFileSync(join(root, 'converters/nested.convert.mjs'), 'export const convert = ({note}) => ({source: note.sourceNote("nested::nested-owner", {tldr:"nested"}, "body")});\n');
  const originalRead = f.broker.read;
  f.broker.read = async (op, args) => {
    const frame = await originalRead(op, args);
    if (op === 'members') frame.result.push({ repo: 'nested-owner', root });
    if (op === 'subtypes' && args.base === 'source::au-base-types') frame.result.subtypes.push({ name: 'nested', repo: 'nested-owner', source: { file: join(root, 'types/nested/nested.type.yaml') } });
    return frame;
  };
  const result = await f.call({ converter: 'nested' });
  assert.equal(result.content.results[0].status, 'created', JSON.stringify(result.content));
});

test('this plugin refuses overlapping invocations for the same repository', async (t) => {
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const ready = new Promise((r) => { entered = r; });
  const f = fixture(t, { async read(op) { if (op === 'members') { entered(); await gate; } } });
  const running = f.call();
  await ready;
  const blocked = await createPlugin({ workspace: f.workspace, broker: f.broker }).invoke({ raw: 'content/paper2.pdf', date: '2026-09-09', converter: 'pdf' });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked.content), /already running/);
  release();
  assert.equal((await running).content.results[0].status, 'created');
});

test('oversized raw is refused before conversion', async (t) => {
  const f = fixture(t);
  truncateSync(join(f.workspace, 'content/paper.pdf'), LIMITS.rawBytes + 1);
  const result = await f.call();
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /64 MiB/);
  assert.equal(f.writes.length, 0);
});

test('the total call budget also covers engine reads and prevents further writes', async (t) => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const f = fixture(t, { read(op) { if (op === 'preview_mutation') elapsed = LIMITS.batchMs + 1; } });
  const result = await f.call({ raw: undefined, raws: ['content/paper.pdf', 'content/paper2.pdf'] });
  assert.deepEqual(result.content.results.map((item) => item.status), ['failed', 'skipped']);
  assert.equal(result.isError, true);
  assert.equal(f.writes.length, 0);
  assert.match(JSON.stringify(result.content), /time budget exhausted/);
});
