// One runner: validate, convert in a disposable process, preview, then write through the broker.
// Existing notes are preserved unless refresh is explicit. The current engine has no
// create-if-absent guard: creation requires coordination with writers outside this plugin.
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { LIMITS, stemOf, readRaw, hashOf } from './converters/ingest-core.mjs';
import { runConverter } from './converters/run-converter.mjs';

const active = new Set();
const messageOf = (error) => String(error?.message ?? error).slice(0, 2048);
const within = (root, path) => path === root || path.startsWith(root + sep);
const failure = (error, items = []) => ({ content: {
  error: messageOf(error), results: items.map(({ raw }) => ({ raw, status: 'failed', error: messageOf(error) })),
}, isError: true });

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkedPath(entry, value, nestedRoots, { raw = false } = {}) {
  const root = realpathSync(entry);
  const lexical = resolve(entry, value);
  const base = within(root, lexical) ? root : entry;
  if (!within(base, lexical) || lexical === base) throw new Error('path is outside the served repository');
  const parts = relative(base, lexical).split(sep);
  if (parts.some((part) => ['.git', '.arsumbris', '.agents', '.codex', '.claude', 'node_modules'].includes(part.toLowerCase()))) {
    throw new Error('captures and notes must be outside repository metadata and dependency directories');
  }
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = stat(path);
    if (info?.isSymbolicLink()) throw new Error('symlinked capture or destination paths are not supported');
    if (index < parts.length - 1 && info && !info.isDirectory()) throw new Error('path parent is not a directory');
    if (info) path = realpathSync(path); // Canonical casing also matters on case-insensitive filesystems.
    if (info?.isDirectory() && (stat(join(path, '.git')) || stat(join(path, '.arsumbris/repo.yaml')))) {
      throw new Error('path belongs to another repository');
    }
  }
  if (!within(root, path)) throw new Error('path is outside the served repository');
  if (nestedRoots.some((memberRoot) => within(memberRoot, path))) throw new Error('path belongs to another repository');
  const info = stat(path);
  if ((raw && !info) || (info && !info.isFile())) throw new Error('path must name a regular file');
  if (!raw && info?.nlink > 1) throw new Error('destination has hard links; refusing to change other files');
  if (raw && info.size > LIMITS.rawBytes) throw new Error('raw exceeds 64 MiB');
  if (/[\[\]#^|:\\\r\n]/.test(relative(root, path))) throw new Error('path contains Arsumbris reference syntax');
  return path;
}

function inputs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ingest input must be an object');
  if (['raw', 'raws', 'items'].filter((key) => input[key] !== undefined).length !== 1) throw new Error('supply exactly one of raw, raws or items');
  let items;
  if (input.items !== undefined) {
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > LIMITS.batch ||
        input.items.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
          typeof item.raw !== 'string' || !item.raw.trim() ||
          typeof item.destination !== 'string' || !item.destination.trim())) {
      throw new Error('supply between 1 and ' + LIMITS.batch + ' items with non-empty raw and destination paths');
    }
    if (input.items.some((item) => Object.keys(item).some((key) => key !== 'raw' && key !== 'destination'))) {
      throw new Error('items accept only raw and destination; date, converter and refresh belong at the top level');
    }
    items = input.items.map(({ raw, destination }) => ({ raw, destination }));
  } else {
    const raws = input.raw !== undefined ? [input.raw] : input.raws;
    if (!Array.isArray(raws) || !raws.length || raws.length > LIMITS.batch || raws.some((raw) => typeof raw !== 'string' || !raw.trim())) {
      throw new Error('supply between 1 and ' + LIMITS.batch + ' non-empty raw paths');
    }
    items = raws.map((raw) => ({ raw, destination: input.destination }));
  }
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date.startsWith('0000-')) throw new Error('date must be a calendar date, YYYY-MM-DD');
  const date = new Date(input.date + 'T00:00:00Z');
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== input.date) throw new Error('date must be a calendar date, YYYY-MM-DD');
  if (typeof input.converter !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*(?:::[A-Za-z0-9_.-]+)?$/.test(input.converter)) throw new Error('converter must be a type name, optionally qualified as name::repo');
  if (input.refresh !== undefined && typeof input.refresh !== 'boolean') throw new Error('refresh must be a boolean');
  if (input.destination !== undefined && (input.raw === undefined || typeof input.destination !== 'string' || !input.destination.trim())) {
    throw new Error('destination is a non-empty note path supported only with a single raw');
  }
  return items;
}

function frameResult(frame) {
  if (!frame || frame.ready === false || (frame.type !== undefined && frame.type !== 'response') || !Object.hasOwn(frame, 'result')) {
    throw new Error(String(frame?.message ?? 'engine returned no usable result'));
  }
  return frame.result;
}

async function discover(broker, selector, entry) {
  const [typeFrame, memberFrame] = await Promise.all([
    broker.read('subtypes', { base: 'source::au-base-types' }, 30_000),
    broker.read('members', {}, 30_000),
  ]);
  const subtypes = frameResult(typeFrame)?.subtypes;
  const members = frameResult(memberFrame);
  if (!Array.isArray(subtypes) || !Array.isArray(members)) throw new Error('engine type or member enumeration is unavailable');
  const entryMember = members.find((member) => member.root && resolve(member.root) === realpathSync(entry));
  if (!entryMember?.editable || !entryMember.local || entryMember.disabled) throw new Error('the served repository must be a local editable member');
  const [name, repo] = selector.split('::');
  const matches = subtypes.filter((type) => type.name === name && (!repo || type.repo === repo));
  if (!matches.length) throw new Error("no converter '" + selector + "' among mounted source subtypes");
  if (matches.length !== 1) throw new Error("converter '" + name + "' is ambiguous; qualify it with ::repo");
  const type = matches[0];
  const owner = members.find((member) => member.repo === type.repo && !member.disabled);
  if (!owner?.root || !type.source?.file) throw new Error('converter owner is unavailable');
  const root = realpathSync(owner.root);
  if (!within(root, realpathSync(type.source.file))) throw new Error('converter type is outside its owner repository');
  const module = realpathSync(join(root, 'converters', name + '.convert.mjs'));
  if (!within(root, module) || !stat(module)?.isFile()) throw new Error('converter module is outside its owner repository or not a regular file');
  const qualified = name + '::' + type.repo;
  const descendants = frameResult(await broker.read('subtypes', { base: qualified }, 30_000))?.subtypes;
  if (!Array.isArray(descendants)) throw new Error('converter subtype family is unavailable');
  const family = new Set([qualified, ...descendants.map((item) => item.name + '::' + item.repo)]);
  const entryRoot = realpathSync(entry);
  const nestedRoots = members.map((member) => member.root && resolve(member.root))
    .filter((root) => root && root !== entryRoot && within(entryRoot, root));
  return { module, qualified, family, nestedRoots };
}

async function snapshot(broker, path) {
  const value = frameResult(await broker.read('content', { path }, 30_000));
  if (value === null) {
    // The engine also returns null for some failed file reads. Only real absence permits creation.
    if (stat(path)) throw new Error('engine could not read the existing destination; refusing to overwrite');
    return null;
  }
  if (!value || typeof value.hash !== 'string' || !value.hash || typeof value.text !== 'string') throw new Error('engine returned an invalid destination snapshot');
  return value;
}

function preflight(entry, items, nestedRoots) {
  const plans = items.map(({ raw, destination }) => {
    let rawPath;
    try {
      rawPath = checkedPath(entry, raw, nestedRoots, { raw: true });
      const target = destination ?? join(dirname(raw), stemOf(raw) + '.md');
      if (!target.endsWith('.md')) throw new Error('destination must have a .md extension');
      const path = checkedPath(entry, target, nestedRoots);
      const rawRef = relative(realpathSync(entry), rawPath).split(sep).join('/');
      return { raw, rawPath, path, rawRef };
    } catch (error) { return { raw, rawPath, error: messageOf(error) }; }
  });
  // Reserve every destination before any writes, including collisions with another raw.
  const key = (path) => path.normalize('NFC').toLowerCase();
  const captures = new Set();
  for (const { raw } of items) {
    const lexical = resolve(entry, raw);
    captures.add(key(resolve(realpathSync(entry), relative(entry, lexical))));
    try { captures.add(key(realpathSync(lexical))); } catch { /* Reserve missing input names too. */ }
  }
  const counts = new Map();
  for (const plan of plans) if (plan.path) counts.set(key(plan.path), (counts.get(key(plan.path)) ?? 0) + 1);
  for (const plan of plans) {
    if (!plan.path) continue;
    if (captures.has(key(plan.path))) plan.error = 'destination collides with an input capture';
    else if (counts.get(key(plan.path)) > 1) plan.error = 'multiple captures have the same destination';
  }
  return plans;
}

async function preview(broker, path, content, family) {
  const result = frameResult(await broker.read('preview_mutation', { op: 'write_file', path, content }, 30_000));
  if (result?.reject) throw new Error('preview refused: ' + result.reject.message);
  const target = result?.target;
  if (!target || !Array.isArray(target.identities) || !Array.isArray(target.diagnostics) || !Array.isArray(result.blast_radius)) throw new Error('engine returned an invalid mutation preview');
  const diagnostics = [
    ...target.diagnostics.map((diagnostic) => ({ ...diagnostic, path })),
    ...result.blast_radius.flatMap((item) => item.diagnostics.map((diagnostic) => ({ ...diagnostic, path: item.path }))),
  ];
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw Object.assign(new Error('converted note has structural errors; nothing written'), { diagnostics });
  }
  if (!target.identities.some((type) => family.has(type.name + '::' + type.repo))) throw new Error('converted note does not claim a type in the converter family');
  return diagnostics;
}

async function ingest(ctx, input, items) {
  if (!ctx?.workspace || !ctx.broker?.available()) throw new Error('ingest needs a served repository and an available engine broker');
  const entry = resolve(ctx.workspace);
  // Include discovery and engine calls in the budget, below the current adapter's
  // 120-second invocation timeout. The broker owns cancellation of its wire waits.
  const deadline = performance.now() + LIMITS.batchMs;
  const remaining = (requested = 30_000) => {
    const left = Math.floor(deadline - performance.now());
    if (left <= 0) throw new Error('ingest time budget exhausted');
    return Math.min(requested, left);
  };
  const broker = {
    read: (op, args, timeout) => ctx.broker.read(op, args, remaining(timeout)),
    mutate: (op, args, timeout) => ctx.broker.mutate(op, args, remaining(timeout)),
  };
  const converter = await discover(broker, input.converter, entry);
  const plans = preflight(entry, items, converter.nestedRoots);
  const results = [];
  const touched = new Set();
  let lastKnown, stopped = false;
  for (const plan of plans) {
    const item = { raw: plan.raw, ...(plan.path ? { path: plan.path } : {}) };
    results.push(item);
    if (plan.error) { Object.assign(item, { status: 'failed', error: plan.error }); continue; }
    if (stopped || performance.now() >= deadline) {
      Object.assign(item, { status: 'skipped', error: stopped ? 'prior write needs inspection before continuing' : 'batch time budget exhausted' });
      continue;
    }
    try {
      const before = await snapshot(broker, plan.path);
      const derived = await runConverter({
        module: converter.module, converter: converter.qualified, date: input.date,
        rawPath: plan.rawPath, destination: plan.path, rawRef: plan.rawRef,
      }, Math.max(1, Math.min(LIMITS.conversionMs, deadline - performance.now())));
      const content = derived.source;
      if (before && before.text !== content && !input.refresh) {
        Object.assign(item, { status: 'conflict', hash: before.hash, error: 'existing note preserved; use refresh: true to replace its full content' });
        continue;
      }
      item.diagnostics = await preview(broker, plan.path, content, converter.family);
      // Revalidate close to the write. These checks cannot replace an engine absence guard.
      checkedPath(entry, plan.rawPath, converter.nestedRoots, { raw: true });
      checkedPath(entry, plan.path, converter.nestedRoots);
      if (hashOf(readRaw(plan.rawPath)) !== derived.rawHash) throw new Error('raw changed during conversion; nothing written');
      const current = await snapshot(broker, plan.path);
      if (current?.text === content) {
        Object.assign(item, { status: 'unchanged', hash: current.hash, ...(current.commit ? { commit: current.commit } : {}) });
        lastKnown = { path: plan.path, hash: current.hash };
        touched.add(plan.path);
        continue;
      }
      if ((before?.hash ?? null) !== (current?.hash ?? null)) {
        Object.assign(item, { status: 'conflict', error: 'destination changed during conversion; nothing written' });
        continue;
      }
      touched.add(plan.path);
      lastKnown = undefined;
      let saved, writeError;
      try {
        const frame = await broker.mutate('write_file', {
          path: plan.path, content, ...(before ? { expected_hash: before.hash } : {}),
        }, 30_000);
        // An explicit engine refusal is distinct from a lost acknowledgement.
        if (frame?.type === 'error') throw Object.assign(new Error(String(frame.message ?? 'engine write refused')), { refused: true });
        const result = frameResult(frame);
        if (!result || !Array.isArray(result.diagnostics) ||
            (result.reflected !== false && (typeof result.hash !== 'string' || !result.hash))) {
          throw new Error('engine returned an incomplete write result');
        }
        saved = result;
      } catch (error) {
        if (error.refused) throw error;
        writeError = error;
      }
      if (saved) Object.assign(item, { status: before ? 'updated' : 'created', ...(saved.commit ? { commit: saved.commit } : {}) });
      if (!saved || saved.reflected === false) {
        // An unreflected acknowledgement has stale metadata. A lost acknowledgement
        // may have committed. A live read can confirm bytes, but not index validation.
        item.previewDiagnostics = item.diagnostics;
        delete item.diagnostics;
        let observed;
        try { observed = await snapshot(broker, plan.path); } catch { /* Still uncertain. */ }
        if (observed?.text === content) {
          item.hash = observed.hash;
          lastKnown = { path: plan.path, hash: observed.hash };
        }
        if (saved || observed?.text === content) {
          if (!saved) item.status = 'present';
          item.validation = 'pending';
          item.error = (saved ? 'engine acknowledged the write' : 'requested content is present, but the write acknowledgement was lost') +
            '; validation is unconfirmed; inspect destination and diagnostics before continuing';
        } else Object.assign(item, { status: 'unknown', error: messageOf(writeError) + '; inspect destination and git history before retrying' });
        stopped = true;
      } else {
        item.hash = saved.hash;
        item.diagnostics = [
          ...saved.diagnostics.map((diagnostic) => ({ ...diagnostic, path: plan.path })),
          ...item.diagnostics.filter((diagnostic) => diagnostic.path !== plan.path),
        ];
        if (item.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) item.error = 'note was saved with structural errors; inspect diagnostics';
        lastKnown = { path: plan.path, hash: item.hash };
      }
    } catch (error) {
      Object.assign(item, { status: 'failed', error: messageOf(error), ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) });
    }
  }
  // The SDK accepts one set plus many removals. Invalidate earlier batch writes
  // so the session cannot retain their old hashes, and record the last known one.
  const remove = [...touched].filter((path) => path !== lastKnown?.path);
  return {
    content: { converter: converter.qualified, results },
    ...(results.some((item) => item.error) ? { isError: true } : {}),
    ...((lastKnown || remove.length) ? { readViewUpdate: { ...(lastKnown ? { set: lastKnown } : {}), ...(remove.length ? { remove } : {}) } } : {}),
  };
}

export function createPlugin(ctx) {
  return {
    async invoke(input) {
      let key, items;
      try {
        items = inputs(input);
        if (!ctx?.workspace) throw new Error('ingest needs a served repository');
        key = realpathSync(ctx.workspace);
      } catch (error) { return failure(error, items); }
      if (active.has(key)) return failure(new Error('ingest is already running for this repository; retry after it finishes'), items);
      active.add(key);
      try { return await ingest(ctx, input, items); }
      catch (error) { return failure(error, items); }
      finally { active.delete(key); }
    },
  };
}
