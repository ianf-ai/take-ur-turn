/**
 * Birth-time relay that keeps shell-level delivery probes out of an Agent TUI.
 *
 * The pane runs this process as its foreground command.  The relay starts the
 * real Agent with inherited terminal stdio, but does not read stdin itself.
 * Probe requests arrive over a local socket/named pipe; each request launches
 * a non-interactive shell with stdin ignored and inherited stdout/stderr.  The
 * marker therefore comes from shell command output, never from bytes injected
 * into the foreground Agent's input stream.
 */

import type { ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodePaneRunnerPayload,
  type PaneRunnerPayload,
  spawnPlanFor,
} from "./pane-runner.js";
import { deliveryProbeCommand } from "./delivery.js";
import { ENDPOINT_PATH_MAX, endpointPathBytes } from "./probe-channel.js";
import type { ShellDialect } from "./shell-renderer.js";
import { spawnDirect, type DirectSpawn } from "./process.js";

const MARKER = /^TUT-DELIVERY-PROBE-[0-9A-F]{8}$/u;
const DIALECTS: ReadonlySet<string> = new Set(["posix", "powershell5", "pwsh", "cmd"]);
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const SHIELD_SUFFIX = ".tut-close-shield";

export interface ProbeRunnerArgs {
  endpoint: string;
  dialect: ShellDialect;
  payload: PaneRunnerPayload;
}

export interface ProbeRunnerDeps {
  /** Injectable process boundary; production uses shell:false spawn. */
  spawnFn?: DirectSpawn;
  /** Injectable server factory for protocol tests. */
  createServerFn?: typeof createServer;
}

/** Restore a shielded peer endpoint only while the public name is vacant.
 * A third relay may bind after the shield rename but before the old server
 * finishes closing; replacing that live endpoint would strand the newcomer. */
export async function restoreShieldedEndpoint(endpoint: string): Promise<void> {
  try {
    await stat(endpoint);
    return; // occupied by a newer relay: leave the shielded peer where it is
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    await rename(`${endpoint}${SHIELD_SUFFIX}`, endpoint);
  } catch {
    // Missing shield or a concurrent restore/bind: keep the live name intact.
  }
}

function usage(): string {
  return "probe-runner: usage: probe-runner.js --socket <endpoint> --dialect <posix|powershell5|pwsh|cmd> --payload <base64url payload>";
}

function nonEmpty(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0 || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`${field} must be a non-empty string without NUL/CR/LF`);
  }
  return value;
}

/** Parse the fixed, shell-neutral relay argv. */
export function parseProbeRunnerArgs(argv: readonly string[]): ProbeRunnerArgs {
  if (argv.length !== 6 || argv[0] !== "--socket" || argv[2] !== "--dialect" || argv[4] !== "--payload") {
    throw new Error(usage());
  }
  const endpoint = nonEmpty(argv[1], "socket endpoint");
  const dialectValue = nonEmpty(argv[3], "dialect");
  if (!DIALECTS.has(dialectValue)) throw new Error(`unknown probe dialect '${dialectValue}'`);
  const token = nonEmpty(argv[5], "payload");
  const payload = decodePaneRunnerPayload(token);
  if (payload.purpose !== "agent") throw new Error("probe relay payload purpose must be agent");
  return { endpoint, dialect: dialectValue as ShellDialect, payload };
}

function isWindowsPipe(endpoint: string): boolean {
  return endpoint.startsWith(WINDOWS_PIPE_PREFIX);
}

/** Handshake marker for the pre-listen liveness probe: a regular marker
 *  line, so the request reuses the relay's frozen single-line protocol. */
const HANDSHAKE_MARKER = "TUT-DELIVERY-PROBE-00000000";
const HANDSHAKE_TIMEOUT_MS = 500;

/** Pre-listen liveness probe: ask whoever currently serves the
 *  endpoint, reusing the marker protocol.  A reply line (ok/failed — either
 *  proves a live peer) means a previous relay never died; the caller steals
 *  the endpoint LOUDLY.  No listener, a timeout, or an empty line resolves
 *  undefined — the common stale-socket-file case costs one refused connect. */
async function probeLivePeer(endpoint: string): Promise<string | undefined> {
  return await new Promise((resolve) => {
    let socket: Socket;
    try {
      socket = createConnection(endpoint);
    } catch {
      resolve(undefined);
      return;
    }
    let reply = "";
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => finish(undefined));
    socket.once("connect", () => {
      socket.write(`${HANDSHAKE_MARKER}\n`);
    });
    socket.on("data", (chunk: string | Buffer) => {
      reply += chunk.toString();
      const newline = reply.indexOf("\n");
      if (newline >= 0) finish(reply.slice(0, newline).trim() || undefined);
    });
    socket.once("error", () => finish(undefined));
    socket.once("end", () => finish(undefined));
    socket.once("close", () => {
      if (!settled) finish(undefined);
    });
  });
}

async function prepareEndpoint(endpoint: string): Promise<void> {
  const pipe = isWindowsPipe(endpoint);
  if (!pipe && endpointPathBytes(endpoint) > ENDPOINT_PATH_MAX) {
    // An over-long endpoint used to fail listen() INSIDE the pane —
    // a dead pane burning the whole delivery budget before the misaligned
    // alert. Refuse loudly at startup instead.  The limit counts UTF-8
    // bytes (sun_path is a raw byte array), matching the planner's guard.
    throw new Error(
      `socket endpoint exceeds the AF_UNIX sun_path limit (${ENDPOINT_PATH_MAX} bytes): ${endpoint}`,
    );
  }
  const peer = await probeLivePeer(endpoint);
  if (peer !== undefined) {
    process.stderr.write(
      `probe-runner: endpoint '${endpoint}' is still served by a live peer relay (handshake reply: ${peer}) — stealing the endpoint for this pane; the stale peer keeps its orphaned socket\n`,
    );
  }
  if (pipe) return;
  await mkdir(path.dirname(endpoint), { recursive: true });
  try {
    await unlink(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function shellInvocation(marker: string, dialect: ShellDialect, environment: NodeJS.ProcessEnv): { file: string; args: string[] } {
  const command = deliveryProbeCommand(marker, dialect);
  switch (dialect) {
    case "posix":
      return { file: environment.SHELL !== undefined && environment.SHELL.length > 0 ? environment.SHELL : "/bin/sh", args: ["-c", command] };
    case "powershell5":
      return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
    case "pwsh":
      return { file: "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
    case "cmd":
      return { file: environment.ComSpec !== undefined && environment.ComSpec.length > 0 ? environment.ComSpec : "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
}

function exitCode(error: unknown): number {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return 127;
  if (code === "EACCES" || code === "EPERM") return 126;
  return 1;
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("error", (error: NodeJS.ErrnoException) => finish(exitCode(error)));
    child.once("close", (code, signal) => {
      if (signal !== null) return finish(1);
      finish(code ?? 1);
    });
  });
}

/** Execute one marker in a non-interactive shell with no stdin. */
async function runShellProbe(
  marker: string,
  dialect: ShellDialect,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  spawnFn: DirectSpawn,
): Promise<boolean> {
  if (!MARKER.test(marker)) return false;
  const invocation = shellInvocation(marker, dialect, environment);
  let child: ChildProcess;
  try {
    child = spawnFn(invocation.file, invocation.args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    return false;
  }
  return (await waitForChild(child)) === 0;
}

function reply(socket: Socket, value: "ok" | "failed"): void {
  socket.end(`${value}\n`);
}

/** Attach the single-line marker protocol to one client connection. */
function handleProbeConnection(
  socket: Socket,
  request: (marker: string) => Promise<boolean>,
): void {
  let buffer = "";
  let handled = false;
  let closed = false;
  socket.setEncoding("utf8");
  const fail = (): void => {
    if (handled || closed) return;
    handled = true;
    reply(socket, "failed");
  };
  socket.once("close", () => { closed = true; });
  socket.once("error", () => { closed = true; });
  socket.on("data", (chunk: string | Buffer) => {
    if (handled || closed) return;
    buffer += chunk.toString();
    if (buffer.length > 128) return fail();
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    if (buffer.slice(newline + 1).length > 0 || !MARKER.test(line)) return fail();
    handled = true;
    request(line).then((ok) => {
      if (!closed) reply(socket, ok ? "ok" : "failed");
    }).catch(() => {
      if (!closed) reply(socket, "failed");
    });
  });
}

function spawnTarget(
  payload: PaneRunnerPayload,
  dialect: ShellDialect,
  spawnFn: DirectSpawn,
): ChildProcess {
  // POSIX routes intentionally retain the existing bare executable contract;
  // Windows routes have already been resolved to native/Node targets and keep
  // pane-runner's fail-closed shim check.
  const plan = dialect === "posix"
    ? { file: payload.executable, args: [...payload.args] }
    : spawnPlanFor(payload);
  return spawnFn(plan.file, plan.args, {
    cwd: payload.cwd,
    env: { ...process.env, ...payload.env },
    shell: false,
    stdio: "inherit",
  });
}

/** Run the relay until the foreground Agent exits. */
export async function runProbeRunner(
  argv: readonly string[],
  deps: ProbeRunnerDeps = {},
): Promise<number> {
  let parsed: ProbeRunnerArgs;
  try {
    parsed = parseProbeRunnerArgs(argv);
    await prepareEndpoint(parsed.endpoint);
  } catch (error) {
    process.stderr.write(`probe-runner: ${(error as Error).message}\n`);
    return 64;
  }

  const spawnFn = deps.spawnFn ?? spawnDirect;
  const createServerFn = deps.createServerFn ?? createServer;
  const environment = { ...process.env };
  let server: Server | undefined;
  let target: ChildProcess | undefined;
  let listening = false;
  let settled = false;
  /** Ownership token of this relay's socket file: the inode captured right
   *  after listen().  A newer relay that STEALS the endpoint unlinks this
   *  file and binds its own — cleanup must never delete that newer file
   *  (it would kill the live relay's endpoint and future probes would read
   *  as unavailable).  undefined = never captured: cleanup skips the unlink
   *  (the next relay's pre-listen sweep tolerates a stale file). */
  let ownedInode: number | undefined;
  const activeProbes = new Set<Promise<void>>();
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  const removeEndpoint = async (): Promise<void> => {
    if (isWindowsPipe(parsed.endpoint)) return;
    if (ownedInode === undefined) return; // cannot prove ownership: never unlink
    try {
      const current = await stat(parsed.endpoint);
      // Only remove the file THIS relay bound: a stolen endpoint now belongs
      // to the newer relay (different inode), and its socket must survive us.
      if (current.ino !== ownedInode) return;
    } catch {
      return; // gone or uninspectable: nothing safe to unlink
    }
    try {
      await unlink(parsed.endpoint);
    } catch {
      // best-effort: a leftover stale file is cleaned by the next relay
    }
  };

  /** Recent Node releases (observed on Node 26; the shield is a no-op on
   *  versions without the behavior) remove the listen PATH from the
   *  filesystem on server.close()
   *  — by path, with no ownership check.  After a steal that path is the
   *  NEWER relay's socket file, and a plain close would delete it out from
   *  under the live relay (every later probe reads unavailable).  When the
   *  path no longer carries our inode, shield it across the close under a
   *  fixed stale name and restore it after; the fixed name bounds the
   *  damage of a crash between the two renames to one file, which the next
   *  relay's pre-listen sweep eventually overwrites anyway. */
  const closeServerShielded = async (): Promise<void> => {
    if (server === undefined || !listening) return;
    let shielded = false;
    if (!isWindowsPipe(parsed.endpoint) && ownedInode !== undefined) {
      try {
        const current = await stat(parsed.endpoint);
        if (current.ino !== ownedInode) {
          await rename(parsed.endpoint, `${parsed.endpoint}${SHIELD_SUFFIX}`);
          shielded = true;
        }
      } catch {
        // path gone or uninspectable: close's path removal finds nothing
      }
    }
    try {
      await new Promise<void>((done) => server?.close(() => done()));
    } finally {
      if (shielded) {
        await restoreShieldedEndpoint(parsed.endpoint);
      }
    }
  };

  const cleanupSignals = (): void => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  };

  return await new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      cleanupSignals();
      const closeServer = async (): Promise<void> => {
        await closeServerShielded();
        await removeEndpoint();
        resolve(code);
      };
      void Promise.all([...activeProbes]).then(closeServer, closeServer);
    };

    const request = async (marker: string): Promise<boolean> =>
      await runShellProbe(marker, parsed.dialect, parsed.payload.cwd, environment, spawnFn);

    try {
      // Explicit request-response frames: the client writes its one marker
      // line and keeps the socket open for the `ok` acknowledgement. The
      // protocol never depends on half-close semantics (Windows named pipes
      // do not honour AF_UNIX half-close: once the client ends its write
      // side, the pipe is gone and the reply would be lost). allowHalfOpen
      // stays on defensively so a peer that does end() early can still
      // receive the single-line reply.
      server = createServerFn({ allowHalfOpen: true }, (socket) => handleProbeConnection(socket, (marker) => {
        const probe = request(marker);
        const task = probe.then(() => undefined, () => undefined);
        activeProbes.add(task);
        void task.finally(() => activeProbes.delete(task));
        return probe;
      }));
      server.once("error", () => finish(1));
      server.listen(parsed.endpoint, () => {
        listening = true;
        if (!isWindowsPipe(parsed.endpoint)) {
          try {
            ownedInode = statSync(parsed.endpoint).ino;
          } catch {
            // No ownership token: cleanup will skip the unlink (see above).
          }
        }
        try {
          target = spawnTarget(parsed.payload, parsed.dialect, spawnFn);
        } catch (error) {
          process.stderr.write(`probe-runner: target spawn failed (${(error as Error).message})\n`);
          finish(exitCode(error));
          return;
        }
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
          const handler = (): void => { target?.kill(signal); };
          signalHandlers.set(signal, handler);
          process.once(signal, handler);
        }
        target.once("error", (error: NodeJS.ErrnoException) => {
          process.stderr.write(`probe-runner: target spawn failed (${error.message})\n`);
          finish(exitCode(error));
        });
        target.once("close", (code, signal) => finish(signal === null ? code ?? 1 : 1));
      });
    } catch (error) {
      process.stderr.write(`probe-runner: relay server failed (${(error as Error).message})\n`);
      finish(exitCode(error));
    }
  });
}

function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const real = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };
  return real(entry) === real(self) || pathToFileURL(real(entry)).href === pathToFileURL(real(self)).href;
}

if (invokedAsMain()) {
  runProbeRunner(process.argv.slice(2)).then((code) => process.exit(code));
}
