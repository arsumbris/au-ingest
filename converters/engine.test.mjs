// Opt-in integration with an installed engine and read-only framework checkouts.
// All repository mutations and commits occur in disposable fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const { AU_ENGINE_BIN, AU_MCP_ROOT, AU_BASE_TYPES_ROOT } = process.env;
if (!AU_ENGINE_BIN || !AU_MCP_ROOT || !AU_BASE_TYPES_ROOT) throw new Error('test:engine needs AU_ENGINE_BIN, AU_MCP_ROOT and AU_BASE_TYPES_ROOT');
const { createEngineBroker } = await import(pathToFileURL(join(AU_MCP_ROOT, 'src/daemon/broker.ts')));
const { discoverTools } = await import(pathToFileURL(join(AU_MCP_ROOT, 'src/daemon/discovery.ts')));
const sdkRoot = resolve(dirname(createRequire(join(AU_MCP_ROOT, 'package.json')).resolve('@arsumbris/au-mcp-sdk')), '..');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

test('real broker and engine: preview, history, no-op, refresh, literal text, and batches', { timeout: 60_000 }, async (t) => {
  const holder = realpathSync(mkdtempSync(join(tmpdir(), 'au-ingest-engine-')));
  let broker, child;
  t.after(async () => {
    broker?.close?.();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGINT');
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(kill);
    }
    if (broker) rmSync(broker.socketPath, { force: true });
    rmSync(holder, { recursive: true, force: true });
  });
  const entry = join(holder, 'consumer');
  const repo = (name, deps = []) => {
    const root = join(holder, name);
    mkdirSync(join(root, '.arsumbris'), { recursive: true });
    mkdirSync(join(root, 'type'));
    writeFileSync(join(root, '.arsumbris/repo.yaml'), 'name: ' + name + '\n' + (deps.length ? 'deps:\n' + deps.map((dep) => '  - name: ' + dep + '\n').join('') : ''));
    return root;
  };
  const base = repo('au-base-types');
  for (const file of ['source', 'node']) copyFileSync(join(AU_BASE_TYPES_ROOT, 'type', file + '.type.yaml'), join(base, 'type', file + '.type.yaml'));
  const sdk = repo('au-mcp-sdk');
  cpSync(join(sdkRoot, 'type'), join(sdk, 'type'), { recursive: true });
  const ingestRoot = repo('au-ingest', ['au-base-types', 'au-mcp-sdk']);
  for (const file of ['pdf', 'document', 'ingest-item', 'mcp.tool.ingest']) copyFileSync(join(ROOT, 'type', file + '.type.yaml'), join(ingestRoot, 'type', file + '.type.yaml'));
  copyFileSync(join(ROOT, 'ingest.mjs'), join(ingestRoot, 'ingest.mjs'));
  mkdirSync(join(ingestRoot, 'converters'));
  for (const file of ['pdf.convert.mjs', 'document.convert.mjs', 'ingest-core.mjs', 'run-converter.mjs', 'worker.mjs', 'note.mjs']) copyFileSync(join(HERE, file), join(ingestRoot, 'converters', file));
  symlinkSync(join(HERE, 'node_modules'), join(ingestRoot, 'converters/node_modules'), 'dir');
  const domain = repo('xrepo-fixture', ['au-base-types']);
  cpSync(join(HERE, 'fixtures/xrepo/converters'), join(domain, 'converters'), { recursive: true });
  copyFileSync(join(HERE, 'fixtures/xrepo/type/probe.type.yaml'), join(domain, 'type/probe.type.yaml'));
  // An abstract converter can emit a concrete subtype.
  writeFileSync(join(domain, 'type/capture.type.yaml'), 'extends: source::au-base-types\nabstract: true\n');
  writeFileSync(join(domain, 'type/probe.type.yaml'), readFileSync(join(domain, 'type/probe.type.yaml'), 'utf8').replace('extends: source::au-base-types', 'extends: capture'));
  copyFileSync(join(domain, 'converters/probe.convert.mjs'), join(domain, 'converters/capture.convert.mjs'));
  repo('consumer', ['au-ingest', 'xrepo-fixture']);
  mkdirSync(join(entry, 'nested/.arsumbris'), { recursive: true });
  writeFileSync(join(entry, 'nested/.arsumbris/repo.yaml'), 'name: nested\n');
  writeFileSync(join(entry, '.arsumbris/workspace.yaml'), 'edit:\n  - consumer\n  - nested\n');
  copyFileSync(join(HERE, 'fixtures/pdf/sample-text.pdf'), join(entry, 'nested/paper.pdf'));
  mkdirSync(join(entry, 'content'));
  for (const name of ['paper', 'paper2']) copyFileSync(join(HERE, 'fixtures/pdf/sample-text.pdf'), join(entry, 'content', name + '.pdf'));
  writeFileSync(join(entry, 'content/probe.raw.json'), JSON.stringify({ id: 'test', text: 'Literal examples\n[[unwanted:field]]\n`[:field] value`\n```yaml [:field]\ntype: unintended\n```\n^unwanted-anchor' }));
  const git = (...args) => execFileSync('git', ['-C', entry, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Ingest Test');
  git('config', 'user.email', 'ingest-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-qm', 'seed');
  const rawBefore = readFileSync(join(entry, 'content/paper.pdf'));
  broker = createEngineBroker(entry);
  let log = '';
  let spawnError;
  child = spawn(AU_ENGINE_BIN, ['daemon', 'start', entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', (error) => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { if (log.length < 8000) log += chunk.toString().slice(0, 8000 - log.length); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('engine exited: ' + log);
    try { ready = (await broker.read('members', {}, 1000)).ready === true; } catch { /* Socket may not exist yet. */ }
    if (ready) break;
    await delay(50);
  }
  assert.ok(ready, 'engine did not become ready: ' + log);
  const discovery = await discoverTools(broker, { workspace: entry }, () => false);
  const plugin = discovery.loaded.find((plugin) => plugin.manifest.id === 'mcp.ingest');
  assert.ok(plugin?.invoke, 'ingest must load through real tool discovery');
  const schema = discovery.inputSchemas.get('mcp.ingest');
  assert.equal(schema.properties.items.type, 'array');
  assert.equal(schema.properties.raw.type, 'string');
  assert.equal(schema.properties.raws.type, 'array');
  assert.deepEqual(schema.required, ['date', 'converter']);
  assert.match(discovery.descriptions.get('mcp.ingest'), /items: \[\{"raw":/);
  assert.equal(discovery.unmetRequiredMeta.has('mcp.ingest'), false);
  for (const name of ['ingest-item', 'mcp.tool.ingest']) {
    const diagnostics = await broker.read('diagnostics', { path: join(ingestRoot, 'type', name + '.type.yaml'), severity: 'error' });
    assert.deepEqual(diagnostics.result, [], JSON.stringify(diagnostics));
  }
  const call = (extra = {}) => plugin.invoke({ raw: 'content/paper.pdf', converter: 'pdf', date: '2026-09-09', ...extra });
  const members = (await broker.read('members', {})).result;
  assert.ok(members.some((member) => member.repo === 'nested' && member.editable));
  for (const input of [{ raw: 'nested/paper.pdf' }, { destination: 'nested/notes/paper.md' }]) {
    const result = await call(input);
    assert.equal(result.isError, true);
    assert.match(result.content.results[0].error, /another repository/);
  }
  const created = await call();
  assert.equal(created.content.results[0]?.status, 'created', JSON.stringify(created.content));
  assert.equal(created.isError, undefined, JSON.stringify(created.content));
  assert.ok(created.content.results[0].commit);
  const count = git('rev-list', '--count', 'HEAD');
  assert.equal((await call()).content.results[0].status, 'unchanged');
  assert.equal(git('rev-list', '--count', 'HEAD'), count);
  const destination = join(entry, 'content/paper.md');
  writeFileSync(destination, readFileSync(destination, 'utf8') + '\nHuman annotation.\n');
  assert.equal((await call()).content.results[0].status, 'conflict');
  assert.equal((await call({ refresh: true })).isError, true, 'dirty tracked notes must not be overwritten');
  assert.match(readFileSync(destination, 'utf8'), /Human annotation/);
  git('add', 'content/paper.md');
  git('commit', '-qm', 'annotation');
  const updated = await call({ refresh: true });
  assert.equal(updated.content.results[0].status, 'updated', JSON.stringify(updated.content));
  assert.equal(updated.isError, undefined);
  const prior = (await broker.read('content', { path: destination })).result;
  await broker.mutate('write_file', { path: destination, content: prior.text + '\nNewer committed content.\n', expected_hash: prior.hash });
  const rejected = await broker.mutate('write_file', { path: destination, content: prior.text, expected_hash: prior.hash });
  assert.equal(rejected.type, 'error');
  assert.match(readFileSync(destination, 'utf8'), /Newer committed content/);
  const literal = await call({ raw: 'content/probe.raw.json', converter: 'capture::xrepo-fixture' });
  assert.equal(literal.content.results[0]?.status, 'created', JSON.stringify(literal.content));
  assert.equal(literal.isError, undefined, JSON.stringify(literal.content));
  assert.deepEqual(literal.content.results[0].diagnostics, []);
  const outgoing = (await broker.read('references_out', { path: join(entry, 'content/probe.md') })).result;
  assert.equal(outgoing.length, 1, JSON.stringify(outgoing));
  assert.ok(JSON.stringify(outgoing).includes('probe.raw.json'));
  assert.ok(!JSON.stringify(outgoing).includes('unwanted'));
  const batch = await call({ raw: undefined, raws: ['content/paper2.pdf', 'content/missing.pdf'] });
  assert.deepEqual(batch.content.results.map((item) => item.status), ['created', 'failed']);
  assert.equal(batch.isError, true);
  assert.deepEqual(readFileSync(join(entry, 'content/paper.pdf')), rawBefore);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
});
