// Wire-level protocol tests for the birth-time delivery probe relay.
//
// The smoke failure pinned here (2026-08-30, Win11 VM, herdr 0.8.2): the
// relay's downstream echo worked over a Windows named pipe (13 markers
// observed in the pane), but every upstream acknowledgement timed out —
// AF_UNIX half-close semantics do not transfer to named pipes, where a
// client-side end() tears down the whole pipe before the reply can be
// written. The protocol is therefore an explicit request-response frame
// delimited by newlines, and these tests make the "never depend on
// half-close" property fail-provable: a pipe-faithful peer refuses to reply
// to any client that ends its write side before the acknowledgement.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDeliveryProbeChannel,
  deliveryProbeEndpoint,
} from "../src/launcher/probe-channel.js";
import { runProbeRunner } from "../src/launcher/probe-runner.js";
import { encodePaneRunnerPayload } from "../src/launcher/shell-renderer.js";
import type { DirectSpawn } from "../src/launcher/process.js";
import type { ChildProcess } from "node:child_process";

const MARKER = "TUT-DELIVERY-PROBE-1A2B3C4D";
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const trash: string[] = [];

afterEach(() => {
  for (const directory of trash.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tut-probe-channel-"));
  trash.push(directory);
  return directory;
}

/**
 * Cross-platform IPC endpoint for tests that really listen or really
 * connect: a unique named pipe under the \\.\pipe\ namespace on win32
 * (the only path form Node accepts for Windows IPC), a unique Unix socket
 * under the given directory elsewhere. Distinct seeds never collide.
 */
function ipcEndpoint(directory: string, seed: string): string {
  return deliveryProbeEndpoint(seed, "executor", { TUT_DELIVERY_PROBE_DIR: directory }, process.platform);
}

async function listenOn(server: Server, endpoint: string): Promise<void> {
  // Named pipes need no unlink-style prepare; socket paths need the same
  // stale-endpoint cleanup probe-runner performs before listen().
  if (!endpoint.startsWith(WINDOWS_PIPE_PREFIX)) {
    rmSync(endpoint, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((done) => server.close(() => done()));
}

/**
 * Trusted simulation of the Windows named pipe failure mode: a client
 * half-close tears down the pipe, silently dropping any pending reply. The
 * simulation runs on the same transport types as production (a real named
 * pipe on win32, a real Unix socket elsewhere) and only injects the
 * teardown-on-FIN behaviour plus a short shell-probe window before replying.
 */
function pipeSimulatingRelay(): { server: Server; tornDown: () => number } {
  let tornDownClients = 0;
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let dead = false;
    socket.setEncoding("utf8");
    socket.once("end", () => {
      // The pipe-faithful part: once the client ends its write side, nothing
      // can be delivered back — not even an already-pending reply.
      dead = true;
      tornDownClients += 1;
      socket.destroy();
    });
    socket.once("error", () => { dead = true; });
    socket.on("data", (chunk: string | Buffer) => {
      if (dead) return;
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      // The reply lands only after the window in which an AF_UNIX-style
      // client would have half-closed already.
      setTimeout(() => {
        if (dead) return;
        socket.end(line === MARKER ? "ok\n" : "failed\n");
      }, 10);
    });
  });
  return { server, tornDown: () => tornDownClients };
}

describe("delivery probe wire protocol", () => {
  it("replies to clients that keep the write side open and tears down half-closing clients", async () => {
    const endpoint = ipcEndpoint(temporaryDirectory(), "win-probe-sim");
    const { server, tornDown } = pipeSimulatingRelay();
    await listenOn(server, endpoint);
    try {
      // Control: the old AF_UNIX-style frame (write + end) must NOT get a
      // reply from a named-pipe-faithful peer — the smoke failure itself.
      const rawReply = await new Promise<string>((resolve) => {
        let reply = "";
        const raw = createConnection(endpoint, () => {
          raw.setEncoding("utf8");
          raw.end(`${MARKER}\n`);
        });
        raw.on("data", (chunk: string | Buffer) => { reply += chunk.toString(); });
        raw.once("close", () => resolve(reply));
        raw.once("error", () => resolve(reply));
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(rawReply).toBe("");
      expect(tornDown()).toBe(1);

      // The production channel frames the request without half-closing, so
      // the same peer can deliver the acknowledgement.
      const channel = createDeliveryProbeChannel({ endpoint });
      await expect(channel.send(MARKER)).resolves.toBe("sent");
    } finally {
      await closeServer(server);
    }
  });

  it("completes the frame round trip through the real relay server", async () => {
    const directory = temporaryDirectory();
    const endpoint = ipcEndpoint(directory, "win-probe-relay");
    const payload = encodePaneRunnerPayload({
      cwd: directory,
      executable: "foreground-agent",
      args: ["--interactive"],
      env: {},
      dialect: "posix",
      purpose: "agent",
    });
    let spawns = 0;
    let foreground: ChildProcess | undefined;
    const spawnFn: DirectSpawn = (_file, _args, _options = {}) => {
      spawns += 1;
      if (spawns === 1) {
        // The foreground Agent stays alive until the round ends.
        const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
        child.kill = () => true;
        foreground = child as unknown as ChildProcess;
        return foreground;
      }
      // Probe children are injected as deterministic successes: the wire
      // protocol is what is under test, and native Windows has no /bin/sh
      // for a real POSIX probe to run in. Everything else — server listen,
      // connection handling, frame parse, reply — is the real relay.
      const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child as unknown as ChildProcess;
    };

    const running = runProbeRunner(
      ["--socket", endpoint, "--dialect", "posix", "--payload", payload],
      { spawnFn },
    );
    const channel = createDeliveryProbeChannel({ endpoint, timeoutMs: 5000 });
    let dispatch: "sent" | "failed" | "unavailable" = "unavailable";
    for (let attempt = 0; attempt < 100 && dispatch !== "sent"; attempt += 1) {
      dispatch = await channel.send(MARKER);
      if (dispatch !== "sent") await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(dispatch).toBe("sent");
    foreground?.emit("close", 0, null);
    await expect(running).resolves.toBe(0);
    expect(spawns).toBe(2);
  });

  it("maps socket outcomes to unavailable/failed on the native IPC path", async () => {
    const directory = temporaryDirectory();
    const channel = (endpoint: string, timeoutMs?: number) =>
      createDeliveryProbeChannel(
        timeoutMs === undefined ? { endpoint } : { endpoint, timeoutMs },
      );

    // Nothing listens: a connection error is unavailability, not failure.
    await expect(channel(ipcEndpoint(directory, "win-probe-absent")).send(MARKER))
      .resolves.toBe("unavailable");

    // A peer answering with a non-ok line fails the dispatch.
    const denying = createServer((socket: Socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string | Buffer) => {
        const line = chunk.toString().split("\n")[0] ?? "";
        socket.end(line === MARKER ? "nope\n" : "failed\n");
      });
    });
    const denyEndpoint = ipcEndpoint(directory, "win-probe-deny");
    await listenOn(denying, denyEndpoint);
    try {
      await expect(channel(denyEndpoint).send(MARKER)).resolves.toBe("failed");
    } finally {
      await closeServer(denying);
    }

    // A peer that accepts and never replies exhausts the socket timeout.
    // The connection still consumes bytes (resume) — an unread request
    // would keep the server-side socket from ever observing the client's
    // teardown and hang server.close().
    const silent = createServer((socket: Socket) => { socket.resume(); });
    const silentEndpoint = ipcEndpoint(directory, "win-probe-silent");
    await listenOn(silent, silentEndpoint);
    try {
      await expect(channel(silentEndpoint, 50).send(MARKER)).resolves.toBe("failed");
    } finally {
      await closeServer(silent);
    }

    // Malformed markers never reach the wire (no live endpoint needed).
    await expect(channel(ipcEndpoint(directory, "win-probe-unused")).send("TUT-DELIVERY-PROBE-NOPE"))
      .resolves.toBe("failed");
  });
});
