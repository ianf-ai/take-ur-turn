import * as fs from 'node:fs/promises';
import { requestTimeout } from './hub.mjs';

// Read-only awaits may be abandoned. Mutations must settle before releasing
// the writer lock or starting another pass: a timeout cannot undo a rename.
export async function localIO(phase, options, action, mutation = false) {
  const timeoutMs = options.requestTimeoutMs ?? requestTimeout();
  const controller = new AbortController();
  let timer, expired;
  options.onProgress?.(phase);
  const pending = Promise.resolve().then(() => action(controller.signal));
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = Object.assign(new Error(`LOCAL_IO_TIMEOUT:${phase}: exceeded ${timeoutMs}ms`), { code: 'LOCAL_IO_TIMEOUT' });
        reject(expired);
        controller.abort(expired);
        if (mutation) {
          options.onProgress?.(`${phase}:draining`);
          if (options.onIOTimeout) options.onIOTimeout(expired);
          else process.stderr.write(`usage-audit: ${expired.message}; waiting for submitted mutation before continuing\n`);
        }
      }, timeoutMs);
    });
    return await Promise.race([pending, deadline]);
  } catch (e) {
    if (mutation && expired) await pending.catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function localFs(options = {}) {
  return Object.fromEntries(['readdir', 'stat', 'lstat', 'readFile', 'writeFile', 'rename', 'unlink'].map(method => [method,
    (...args) => localIO(method, options, signal => {
      if (method === 'readFile' || method === 'writeFile') {
        const index = method === 'readFile' ? 1 : 2;
        args[index] = { ...(typeof args[index] === 'string' ? { encoding: args[index] } : args[index]), signal };
      }
      return fs[method](...args);
    }, ['writeFile', 'rename', 'unlink'].includes(method)),
  ]));
}
