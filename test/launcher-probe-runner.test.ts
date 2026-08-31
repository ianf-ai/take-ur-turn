// Foreground probe relay: the Agent keeps the pane stdin while the probe
// command runs in a separate non-interactive shell with stdin ignored.
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProbeRunner } from "../src/launcher/probe-runner.js";
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
