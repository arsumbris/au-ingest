// Pure derivation and bounded input loading; the runner owns paths and engine access.
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import * as note from './note.mjs';

export const LIMITS = Object.freeze({
  batch: 32,
  rawBytes: 64 * 1024 * 1024,
  sourceBytes: 8 * 1024 * 1024,
  conversionMs: 30_000,
  batchMs: 90_000,
});

export const stemOf = (name) => basename(name).replace(/(\.raw)?\.[^.]+$/, '') || basename(name);
export const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Read a regular file without following its final symlink or buffering unbounded growth. */
export function readRaw(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('raw must be a regular file');
    if (before.size > LIMITS.rawBytes) throw new Error('raw exceeds ' + LIMITS.rawBytes / 1024 / 1024 + ' MiB');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!read) break;
      offset += read;
    }
    const grew = readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0;
    const after = fstatSync(fd);
    if (offset !== bytes.length || grew || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('raw changed while being read; archive a stable capture first');
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** The converter contract stays { raw, date, self, note } -> { source }. */
export async function deriveSource(rawPath, date, convert, converterName, { destination, rawRef } = {}) {
  const raw = readRaw(rawPath);
  const rawHash = hashOf(raw);
  const self = { raw: rawRef ?? basename(rawPath), note: destination ? basename(destination, '.md') : stemOf(rawPath) };
  const result = await convert({ raw, date, self, note });
  if (typeof result?.source !== 'string' || !result.source.trim()) {
    throw new Error("convert('" + converterName + "') returned no { source } string");
  }
  if (Buffer.byteLength(result.source) > LIMITS.sourceBytes) {
    throw new Error('converted note exceeds ' + LIMITS.sourceBytes / 1024 / 1024 + ' MiB');
  }
  return { source: result.source, rawHash };
}
