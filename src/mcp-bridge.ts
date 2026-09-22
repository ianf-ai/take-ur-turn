/** Workspace-bound MCP stdio bridge. No tool schemas or storage live here. */
import { setTimeout as delay } from "node:timers/promises";
import type { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError, ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { HUB_FETCH_TIMEOUT_MS, timeoutFetch } from "./hub-client.js";
import { canonicalRoot, probeHub, resolveCliHubUrl, resolveRigRoot } from "./rig-discovery.js";

export interface BridgeOptions {
  url: string;
  root: string;
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
  diagnostic?: (message: string) => void;
  /** Test seams: never read port or retry overrides from a worker's env. */
  discoveryUrls?: readonly string[];
  retryDelays?: readonly number[];
  heartbeatMs?: number;
}

function localUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MCP_LOCAL_URL_REQUIRED: use a loopback HTTP Hub base URL (no /mcp path)");
  }
  return url.origin;
}

export async function runMcpBridge(options: BridgeOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.diagnostic ?? ((message: string) => process.stderr.write(`tut mcp: ${message}\n`));
  const root = canonicalRoot(options.root);
  const stop = new AbortController();
  let finish!: (code: number) => void;
  const finished = new Promise<number>(resolve => { finish = resolve; });
  let done = false;
  const end = (code: number) => {
    if (done) return;
    done = true;
    stop.abort();
    finish(code);
  };
  const eof = () => end(0);
  const abort = () => end(0);
  input.once("end", eof);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted || input.readableEnded) end(0);
  let upstream: Client | undefined;
  let connecting: Client | undefined;
  let endpoint: string | undefined;
  let server: Server | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let recovery: Promise<void> | undefined;
  let checking = false;
  let requested: string;

  async function connect(): Promise<void> {
    const url = localUrl(await resolveCliHubUrl(requested, false, root, options.discoveryUrls));
    if (done) return;
    const client = new Client({ name: "tut-mcp-bridge", version: "0.1.0" });
    connecting = client;
    const boundedFetch = timeoutFetch(HUB_FETCH_TIMEOUT_MS);
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", url), {
      fetch: async (target, init) => {
        // Recheck even on an existing connection: a restarted port may now be foreign.
        if (done || (await probeHub(url))?.root !== root) {
          throw new Error(`MCP_HUB_IDENTITY: no verified hub_root=${root} at ${url}`);
        }
        return boundedFetch(target, { ...init, redirect: "error", signal: init?.signal
          ? AbortSignal.any([init.signal, stop.signal]) : stop.signal });
      },
    });
    try {
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      if (done) { await client.close(); return; }
      upstream = client;
      endpoint = url;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      if (connecting === client) connecting = undefined;
    }
  }

  function recover(): Promise<void> {
    if (recovery) return recovery;
    if (done) return Promise.resolve();
    recovery = (async () => {
      const old = upstream;
      upstream = undefined;
      endpoint = undefined;
      await old?.close().catch(() => undefined);
      const retries = options.retryDelays ?? [250, 500, 1000, 2000, 4000];
      for (const [i, ms] of retries.entries()) {
        if (done) return;
        log(`MCP_RECONNECT: attempt ${i + 1}/${retries.length} after ${ms}ms; workspace ${root}`);
        try {
          await delay(ms, undefined, { signal: stop.signal });
          await connect();
          if (!done) log(`MCP_RECONNECTED: ${endpoint}`);
          return;
        } catch (error) {
          if (done) return;
          log(String(error));
        }
      }
      log(`MCP_RECONNECT_EXHAUSTED: workspace ${root}; run 'tut up' in that workspace, then restart the MCP client`);
      end(3);
    })().finally(() => { recovery = undefined; });
    return recovery;
  }

  try {
    requested = localUrl(options.url);
    // Validate injected candidates too; production discovery only supplies loopback URLs.
    options.discoveryUrls?.forEach(localUrl);
    try { await connect(); }
    catch (error) {
      if (!done) { log(`MCP_INITIAL_CONNECTION: ${String(error)}`); end(2); }
    }
    if (!done && upstream) {
      // Report the verified connection, never the untrusted discovery candidate.
      const serverInfo = {
        ...(upstream.getServerVersion() ?? { name: "tut-mcp-bridge", version: "0.1.0" }),
        hubUrl: endpoint,
        hubRoot: root,
      };
      server = new Server(serverInfo, {
        capabilities: upstream.getServerCapabilities() ?? {},
        ...(upstream.getInstructions() ? { instructions: upstream.getInstructions()! } : {}),
      });
      server.fallbackRequestHandler = async (request, extra) => {
        await recovery;
        const client = upstream;
        if (!client || done) throw new McpError(-32603, "MCP bridge unavailable");
        try {
          return await client.request({ method: request.method, ...(request.params ? { params: request.params } : {}) },
            ResultSchema, { signal: extra.signal });
        } catch (error) {
          // Application/protocol errors are preserved; never replay a business request.
          if (!extra.signal.aborted && (!(error instanceof McpError) ||
              error.code === ErrorCode.RequestTimeout || error.code === ErrorCode.ConnectionClosed)) {
            log(`MCP_REQUEST_INTERRUPTED: ${request.method}; request not replayed; read task state before retrying a write`);
            void recover();
          }
          throw error;
        }
      };
      server.fallbackNotificationHandler = async notification => {
        await recovery;
        try { await upstream?.notification(notification); }
        catch (error) { log(`MCP_NOTIFICATION_FAILED: ${String(error)}`); void recover(); }
      };
      server.onerror = error => log(`MCP_STDIO: ${error.message}`);
      server.onclose = eof;
      await server.connect(new StdioServerTransport(input, output));
      timer = setInterval(() => {
        if (checking || recovery || done || !endpoint) return;
        checking = true;
        const observed = endpoint;
        void probeHub(observed).then(identity => {
          if (!done && endpoint === observed && identity?.root !== root) return recover();
        }).finally(() => { checking = false; });
      }, options.heartbeatMs ?? 2000);
    }
    return await finished;
  } catch (error) {
    log(`MCP_BRIDGE_ERROR: ${String(error)}`);
    return server ? 1 : 2;
  } finally {
    done = true;
    stop.abort();
    if (timer) clearInterval(timer);
    input.off("end", eof);
    options.signal?.removeEventListener("abort", abort);
    await Promise.allSettled([server?.close(), upstream?.close(), connecting?.close()]);
    await recovery;
  }
}

export async function runMcpCommand(defaultUrl: string): Promise<number> {
  const controller = new AbortController();
  let signalCode = 0;
  const interrupt = () => { signalCode = 130; controller.abort(); };
  const terminate = () => { signalCode = 143; controller.abort(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const code = await runMcpBridge({ url: process.env.TUT_HUB_URL ?? defaultUrl,
      root: resolveRigRoot(), signal: controller.signal });
    return signalCode || code;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
