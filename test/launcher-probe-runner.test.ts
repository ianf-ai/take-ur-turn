// Foreground probe relay: the Agent keeps the pane stdin while the probe
// command runs in a separate non-interactive shell with stdin ignored.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreShieldedEndpoint, runProbeRunner } from "../src/launcher/probe-runner.js";
import { createDeliveryProbeChannel } from "../src/launcher/probe-channel.js";
import { encodePaneRunnerPayload } from "../src/launcher/shell-renderer.js";
import type { DirectSpawn, DirectSpawnOptions } from "../src/launcher/process.js";
import type { ChildProcess } from "node:child_process";

const trash: string[] = [];

afterEach(() => {
  for (const directory of trash.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tut-probe-runner-"));
  trash.push(directory);
  return realpathSync(directory);
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
  child.kill = () => true;
  return child as unknown as ChildProcess;
}


describe("relay endpoint hardening", () => {
  it("does not rename a shield back over an endpoint occupied by a newer relay", async () => {
    if (process.platform === "win32") return;
    const directory = temporaryDirectory();
    const endpoint = path.join(directory, "probe.sock");
    const shield = `${endpoint}.tut-close-shield`;
    writeFileSync(shield, "older relay", "utf8");
    writeFileSync(endpoint, "newer relay", "utf8");

    await restoreShieldedEndpoint(endpoint);

    expect(readFileSync(endpoint, "utf8")).toBe("newer relay");
    expect(readFileSync(shield, "utf8")).toBe("older relay");
  });

  it("refuses an over-long POSIX socket loudly (exit 64) instead of dying inside the pane at listen()", async () => {
    if (process.platform === "win32") return;
    const payload = encodePaneRunnerPayload({
      cwd: temporaryDirectory(),
      executable: "foreground-agent",
      args: [],
      env: {},
      dialect: "posix",
      purpose: "agent",
    });
    const tooLong = `/${"x".repeat(110)}/probe.sock`;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await runProbeRunner(["--socket", tooLong, "--dialect", "posix", "--payload", payload], {});
      expect(code).toBe(64);
      expect(stderr.mock.calls.flat().join("")).toContain("sun_path limit");
    } finally {
      stderr.mockRestore();
    }
  });

  it("exit-64 counts UTF-8 BYTES: a multi-byte endpoint inside the CHAR limit is still over sun_path", async () => {
    if (process.platform === "win32") return;
    const payload = encodePaneRunnerPayload({
      cwd: temporaryDirectory(),
      executable: "foreground-agent",
      args: [],
      env: {},
      dialect: "posix",
      purpose: "agent",
    });
    // 49 characters (under 104) but 117 bytes (over 104) — the planner's
    // byte guard and the runner's must agree on the unit.
    const chars = `/tmp/${"あ".repeat(34)}/probe.sock`;
    expect(chars.length).toBeLessThanOrEqual(104);
    expect(Buffer.byteLength(chars, "utf8")).toBeGreaterThan(104);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await runProbeRunner(["--socket", chars, "--dialect", "posix", "--payload", payload], {});
      expect(code).toBe(64);
      expect(stderr.mock.calls.flat().join("")).toContain("sun_path limit");
    } finally {
      stderr.mockRestore();
    }
  });

  it("pre-listen liveness handshake: a live peer on the endpoint is detected and loudly stolen", async () => {
    if (process.platform === "win32") return;
    const cwd = temporaryDirectory();
    const endpoint = path.join(cwd, "probe.sock");
    // A stale-but-alive peer relay: serves the marker protocol on the endpoint.
    const peer = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => socket.end("ok\n"));
    });
    await new Promise<void>((resolve) => peer.listen(endpoint, () => resolve()));
    const payload = encodePaneRunnerPayload({
      cwd,
      executable: "foreground-agent",
      args: ["--interactive"],
      env: {},
      dialect: "posix",
      purpose: "agent",
    });
    let foreground: ChildProcess | undefined;
    const spawnFn: DirectSpawn = (_file, _args, _options = {}) => {
      const child = fakeChild();
      if (foreground === undefined) foreground = child;
      else queueMicrotask(() => child.emit("close", 0, null));
      return child;
    };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let running: Promise<number> | undefined;
    try {
      running = runProbeRunner(["--socket", endpoint, "--dialect", "posix", "--payload", payload], { spawnFn });
      // The steal is loud, and the new relay ends up serving the endpoint.
      await vi.waitUntil(() => stderr.mock.calls.flat().join("").includes("live peer relay"), { timeout: 5000 });
      const channel = createDeliveryProbeChannel({ endpoint, timeoutMs: 5000 });
      let dispatch: string = "unavailable";
      for (let attempt = 0; attempt < 100 && dispatch !== "sent"; attempt += 1) {
        dispatch = await channel.send("TUT-DELIVERY-PROBE-2B3C4D5E");
        if (dispatch !== "sent") await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(dispatch).toBe("sent");
      foreground?.emit("close", 0, null);
      await expect(running).resolves.toBe(0);
    } finally {
      stderr.mockRestore();
      await new Promise<void>((done) => peer.close(() => done()));
    }
  });
  it("a stolen endpoint survives the OLD relay's exit cleanup — ownership guard", async () => {
    if (process.platform === "win32") return;
    const cwd = temporaryDirectory();
    const endpoint = path.join(cwd, "probe.sock");
    const payload = encodePaneRunnerPayload({
      cwd,
      executable: "foreground-agent",
      args: [],
      env: {},
      dialect: "posix",
      purpose: "agent",
    });
    // Each relay's spawn seam: the first child is its persistent foreground
    // Agent, every later child (probe shells) exits 0 immediately.
    const relaySpawns = (): { spawnFn: DirectSpawn; stop: () => void } => {
      let foreground: ChildProcess | undefined;
      const spawnFn: DirectSpawn = () => {
        const child = fakeChild();
        if (foreground === undefined) foreground = child;
        else queueMicrotask(() => child.emit("close", 0, null));
        return child;
      };
      return { spawnFn, stop: () => { foreground?.emit("close", 0, null); } };
    };
    const oldRelay = relaySpawns();
    const newRelay = relaySpawns();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const channel = createDeliveryProbeChannel({ endpoint, timeoutMs: 5000 });
    const sendUntilSent = async (): Promise<string> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const dispatch = await channel.send("TUT-DELIVERY-PROBE-3D4E5F60");
        if (dispatch === "sent") return dispatch;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return "unavailable";
    };
    try {
      const oldRunning = runProbeRunner(["--socket", endpoint, "--dialect", "posix", "--payload", payload], { spawnFn: oldRelay.spawnFn });
      expect(await sendUntilSent()).toBe("sent"); // the old relay owns the endpoint

      const newRunning = runProbeRunner(["--socket", endpoint, "--dialect", "posix", "--payload", payload], { spawnFn: newRelay.spawnFn });
      // The new relay's pre-listen handshake finds the old peer alive and steals loudly.
      await vi.waitUntil(() => stderr.mock.calls.flat().join("").includes("live peer relay"), { timeout: 5000 });
      expect(await sendUntilSent()).toBe("sent"); // the NEW relay now serves the endpoint

      // The old relay's round ends AFTER the steal: its exit cleanup used to
      // unlink the endpoint unconditionally — deleting the NEW relay's socket
      // and turning every later probe unavailable.  The ownership guard must
      // keep the stolen file intact and the endpoint serving.
      oldRelay.stop();
      await expect(oldRunning).resolves.toBe(0);
      expect(existsSync(endpoint)).toBe(true); // the new relay's socket survived
      expect(await sendUntilSent()).toBe("sent"); // ...and still serves markers

      newRelay.stop();
      await expect(newRunning).resolves.toBe(0); // the owner's cleanup removes it
    } finally {
      stderr.mockRestore();
    }
  });
});
describe("foreground delivery probe relay", () => {
  it("runs the marker in a separate shell without injecting it into Agent stdin", async () => {
    const cwd = temporaryDirectory();
    const endpoint = path.join(cwd, "probe.sock");
    const marker = "TUT-DELIVERY-PROBE-08B1D8C0";
    const payload = encodePaneRunnerPayload({
      cwd,
      executable: "foreground-agent",
      args: ["--interactive"],
      env: { AGENT_FIXTURE: "1" },
      dialect: "posix",
      purpose: "agent",
    });
    const calls: Array<{ file: string; args: string[]; options: DirectSpawnOptions }> = [];
    let foreground: ChildProcess | undefined;
    const spawnFn: DirectSpawn = (file, args, options = {}) => {
      const child = fakeChild();
      calls.push({ file, args: [...args], options });
      if (calls.length === 1) {
        foreground = child;
      } else {
        queueMicrotask(() => child.emit("close", 0, null));
      }
      return child;
    };

    let connectionHandler: ((socket: Socket) => void) | undefined;
    const server = new EventEmitter() as unknown as Server;
    Object.assign(server, {
      listen: (_address: string, callback: () => void) => {
        callback();
        return server;
      },
      close: (callback: () => void) => {
        callback();
        return server;
      },
    });
    const createServerFn = ((_options: { allowHalfOpen: boolean }, handler: (socket: Socket) => void) => {
      connectionHandler = handler;
      return server;
    }) as typeof createServer;

    const running = runProbeRunner(
      ["--socket", endpoint, "--dialect", "posix", "--payload", payload],
      { spawnFn, createServerFn },
    );

    for (let attempt = 0; attempt < 100 && connectionHandler === undefined; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    expect(connectionHandler).toBeDefined();
    let reply = "";
    const socket = new EventEmitter() as unknown as Socket;
    Object.assign(socket, {
      setEncoding: () => socket,
      end: (chunk?: string) => {
        if (chunk !== undefined) reply += chunk;
        return socket;
      },
      destroy: () => socket,
    });
    connectionHandler?.(socket);
    socket.emit("data", `${marker}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reply).toBe("ok\n");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.file).toBe("foreground-agent");
    expect(calls[0]?.args).toEqual(["--interactive"]);
    expect(calls[0]?.options).toMatchObject({ cwd, shell: false, stdio: "inherit" });
    expect(calls[1]?.file).toBe(process.env.SHELL ?? "/bin/sh");
    expect(calls[1]?.args).toEqual(["-c", `printf '${marker}'\n`]);
    expect(calls[1]?.options).toMatchObject({ cwd, shell: false, stdio: ["ignore", "inherit", "inherit"] });
    expect(foreground).toBeDefined();

    foreground?.emit("close", 0, null);
    await expect(running).resolves.toBe(0);
  });
});
