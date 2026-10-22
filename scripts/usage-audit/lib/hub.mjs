import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { canonicalRoot } from '../../../dist/core/hub/rig-discovery.js';

export function requestTimeout(env = process.env) {
  const ms = Number(env.TUT_USAGE_AUDIT_TIMEOUT_MS ?? 30_000);
  // Node timers overflow to 1ms above the signed 32-bit limit.
  if (!Number.isInteger(ms) || ms < 1 || ms > 2_147_483_647) {
    throw new Error('invalid TUT_USAGE_AUDIT_TIMEOUT_MS: expected integer milliseconds in 1..2147483647');
  }
  return ms;
}

// Bound the entire read, not just fetch's response headers. In particular an
// MCP stream can stall after headers, or swallow a body-read error while its
// caller still awaits an RPC reply. Abort the actual I/O as well as the await.
async function boundedRead(endpoint, options, action) {
  const controller = new AbortController();
  const timeoutMs = options.requestTimeoutMs ?? requestTimeout();
  let timer;
  options.onRequest?.(true);
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`HUB_TIMEOUT:${endpoint}: read exceeded ${timeoutMs}ms`);
        reject(error);
        controller.abort(error);
      }, timeoutMs);
    });
    return await Promise.race([action(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.onRequest?.(false);
  }
}

async function readTool(url, name, args, options) {
  const endpoint = new URL(`${url.replace(/\/+$/, '')}/mcp`);
  const client = new Client({ name: 'tut-usage-audit', version: '1' });
  try {
    return await boundedRead(endpoint, options, async signal => {
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Connection: 'close' } },
        fetch: (input, init) => fetch(input, {
          ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      });
      await client.connect(transport, { timeout: options.requestTimeoutMs });
      // The enclosing deadline includes initialization and response parsing;
      // extend the SDK's default deadline when the user asks for a longer one.
      const result = await client.callTool({ name, arguments: args }, undefined,
        { timeout: options.requestTimeoutMs });
      const text = result.content?.find(block => block.type === 'text')?.text ?? '';
      if (result.isError) throw new Error(text.split('\n')[0]);
      return JSON.parse(text);
    });
  } finally {
    // Close outside the raced action: even a lost RPC reply must immediately
    // release SDK response timers and transport state when our deadline wins.
    await client.close().catch(() => {});
  }
}

export async function source(url, root, options = {}) {
  options = { ...options, requestTimeoutMs: options.requestTimeoutMs ?? requestTimeout() };
  const endpoint = new URL('/state', url);
  const body = await boundedRead(endpoint, options, async signal => {
    const response = await fetch(endpoint, { signal, headers: { Connection: 'close' }, redirect: 'manual' });
    if (!response.ok) throw new Error(`hub_root_mismatch:${url}`);
    return response.json();
  });
  if (typeof body?.hub_root !== 'string' || !path.isAbsolute(body.hub_root)
      || canonicalRoot(body.hub_root) !== root) throw new Error(`hub_root_mismatch:${url}`);
  return {
    list: async () => (await readTool(url, 'context.list', {}, options)).tasks,
    read: id => readTool(url, 'context.read', { task_id: id }, options),
  };
}
