/**
 * Server assembly: Store + config + HTTP routing,
 * exposed as `tut serve` via cli.ts.
 *
 * Exported shape: `startServer(options) → { server, url, close }`.
 * serve deliberately does NOT spawn the Notifier: the
 * Notifier runs as its own resident process via `tut notify` in a dedicated
 * pane — a crash stays visible there and stdout is its log.
 */

import { type Server, createServer } from "node:http";
import { ensureConfig } from "./config.js";
import { createRequestHandler } from "./http.js";
import { Store } from "./store.js";

export interface StartServerOptions {
  /** Storage root directory (`.context-hub` by default in cli.ts). */
  root: string;
  /** Default 3001 (system-design 6.1); 0 = ephemeral port for tests. */
  port?: number;
  /** Default 127.0.0.1 — localhost only, no auth/CORS (decision 3). */
  host?: string;
}

export interface RunningServer {
  server: Server;
  /** Usable base URL with the ACTUAL port resolved (port 0 case included). */
  url: string;
  /** Closes the listener and drains all live per-request MCP transports. Idempotent. */
  close: () => Promise<void>;
}

function isErrnoException(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}

/** Host as it appears in a URL: bracket IPv6 literals ("::1" → "[::1]"). */
function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const root = options.root;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3001;

  const store = new Store(root);
  await ensureConfig(root); // fail fast on a corrupt config (readFlowMode owns the never-throw side)

  const handler = createRequestHandler({ store, root });
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => {
      if (isErrnoException(e, "EADDRINUSE")) {
        reject(new Error(`port ${port} is already in use on ${host} (EADDRINUSE)`));
      } else {
        reject(e);
      }
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://${urlHost(host)}:${actualPort}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Drain in-flight POST /mcp transports first, then the listener.
    await Promise.allSettled([...handler.transports].map((t) => t.close()));
    handler.transports.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { server, url, close };
}
