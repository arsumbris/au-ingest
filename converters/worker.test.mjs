import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConverter } from './run-converter.mjs';
import { hashOf } from './ingest-core.mjs';

function fixture(t, code) {
  const dir = mkdtempSync(join(tmpdir(), 'au-convert-worker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const module = join(dir, 'probe.convert.mjs');
  const rawPath = join(dir, 'raw.txt');
  writeFileSync(rawPath, 'capture');
  writeFileSync(module, code);
  return { dir, input: { module, rawPath, converter: 'probe', date: '2026-09-09' } };
}

test('a stalled converter is terminated and the next conversion still works', async (t) => {
  const f = fixture(t, 'export const convert = () => { while (true) {} };');
  await assert.rejects(runConverter(f.input, 300), /exceeded 300 ms/);
  writeFileSync(f.input.module, 'export const convert = () => ({source:"recovered"});');
  assert.equal((await runConverter(f.input)).source, 'recovered');
});

test('process death is reported without crashing the caller', async (t) => {
  const f = fixture(t, 'process.kill(process.pid, "SIGKILL");');
  await assert.rejects(runConverter(f.input), /SIGKILL/);
});

test('an inherited stderr pipe cannot keep a dead worker running past its deadline', async (t) => {
  const f = fixture(t, `
    import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {stdio: ['ignore', 'ignore', 2]});
    writeFileSync(new URL('./helper.pid', import.meta.url), String(helper.pid));
    process.kill(process.pid, 'SIGKILL');
  `);
  try { await assert.rejects(runConverter(f.input, 1500), /SIGKILL/); }
  finally {
    try { process.kill(Number(readFileSync(join(f.dir, 'helper.pid'), 'utf8')), 'SIGKILL'); }
    catch (error) { if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error; }
  }
});

test('changes in imported helpers are visible on the next capture', async (t) => {
  const f = fixture(t, 'import {body} from "./helper.mjs"; export const convert = () => ({source:body});');
  writeFileSync(join(f.dir, 'helper.mjs'), 'export const body = "first";');
  assert.equal((await runConverter(f.input)).source, 'first');
  writeFileSync(join(f.dir, 'helper.mjs'), 'export const body = "second";');
  assert.equal((await runConverter(f.input)).source, 'second');
});

test('a converter can mutate its buffer without changing the archived capture hash', async (t) => {
  const f = fixture(t, 'export const convert = ({raw}) => { raw.fill(0); return {source:"converted"}; };');
  const result = await runConverter(f.input);
  assert.equal(result.source, 'converted');
  assert.equal(result.rawHash, hashOf('capture'));
  assert.equal(readFileSync(f.input.rawPath, 'utf8'), 'capture');
});

test('empty, malformed and oversized converter results fail before returning a note', async (t) => {
  const f = fixture(t, 'export const convert = () => ({});');
  await assert.rejects(runConverter(f.input), /no \{ source \}/);
  writeFileSync(f.input.module, 'export const convert = () => ({source:" "});');
  await assert.rejects(runConverter(f.input), /no \{ source \}/);
  writeFileSync(f.input.module, 'export const convert = () => ({source:"x".repeat(8 * 1024 * 1024 + 1)});');
  await assert.rejects(runConverter(f.input), /exceeds 8 MiB/);
});
