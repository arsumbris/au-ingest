// A new process per capture refreshes the entire import graph and isolates native crashes.
import { pathToFileURL } from 'node:url';
import { deriveSource } from './ingest-core.mjs';

process.once('disconnect', () => process.exit(1));
process.once('message', async ({ module, rawPath, date, converter, destination, rawRef }) => {
  try {
    const { convert } = await import(pathToFileURL(module).href);
    if (typeof convert !== 'function') throw new Error("converter '" + converter + "' exports no convert()");
    const result = await deriveSource(rawPath, date, convert, converter, { destination, rawRef });
    process.send({ result }, () => process.exit(0));
  } catch (error) {
    process.send({ error: String(error?.message ?? error).slice(0, 2048) }, () => process.exit(1));
  }
});
