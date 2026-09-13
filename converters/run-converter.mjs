import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMITS } from './ingest-core.mjs';

/** This bounds runtime and JS heap, not native memory or permissions. Converters are trusted code. */
export function runConverter(input, timeoutMs = LIMITS.conversionMs) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
      execArgv: ['--max-old-space-size=256'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
    });
    let message, failure, stderr = '';
    const timer = setTimeout(() => {
      failure = new Error('conversion exceeded ' + timeoutMs + ' ms');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { if (stderr.length < 2048) stderr += chunk.toString().slice(0, 2048 - stderr.length); });
    child.once('message', (value) => { message = value; });
    child.once('error', (error) => { failure = error; });
    // A helper inheriting stderr must not keep an exited worker's pipe open.
    child.once('exit', () => child.stderr.destroy());
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (message?.error) reject(new Error(message.error));
      else if (code !== 0 || !message?.result) reject(new Error('converter exited ' + (signal ?? code) + (stderr ? ': ' + stderr : '')));
      else resolve(message.result);
    });
    child.send(input, (error) => { if (error) { failure = error; child.kill('SIGKILL'); } });
  });
}
