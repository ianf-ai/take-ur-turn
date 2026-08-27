import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hubCreate } from "../src/hub-client.js";
import { startServer, type RunningServer } from "../src/server.js";

const CLI = path.resolve(import.meta.dirname, "../dist/cli.js");

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("short-lived HTTP clients", () => {
  let tmp: string | undefined;
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close().catch(() => undefined);
    running = undefined;
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("spawns the built CLI through a real Hub and exits cleanly with Connection: close", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "tut-http-teardown-"));
    running = await startServer({ root: path.join(tmp, ".context-hub"), port: 0 });
    const mcpConnections: string[] = [];
    running.server.on("request", (req) => {
      if (req.url === "/mcp") mcpConnections.push(req.headers.connection ?? "");
    });

    const created = await hubCreate(running.url, {
      title: "Teardown Regression",
      description: "exercise the built CLI over a real Hub",
      creator: "test",
      role: "human",
    });
    const child = await runCli(["list", "--url", running.url, "--json"]);

    expect(child.code).toBe(0);
    expect(child.stderr).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING/u);
    expect(JSON.parse(child.stdout).tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ task_id: created.task_id })]),
    );
    expect(mcpConnections.length).toBeGreaterThan(0);
    expect(mcpConnections.every((connection) => connection === "close")).toBe(true);
  }, 20_000);
});
