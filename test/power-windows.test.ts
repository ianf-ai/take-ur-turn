import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";

const { execute, runList, runRead } = vi.hoisted(() => ({ execute: vi.fn(), runList: vi.fn(() => [] as string[]), runRead: vi.fn() }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
vi.mock("../src/core/run/store.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/core/run/store.js")>(),
  RunStore: class { list = runList; read = runRead; },
}));

import { stopWindowsService, terminateWindowsProcess, windowsListenerPid, windowsProcesses, windowsServiceTree, windowsStartToken, type WindowsProcess } from "../src/standalone/power/windows.js";
import { processPgid, processStartToken, readPowerState, writePowerState } from "../src/standalone/power/standalone-up.js";
import { listenerPid } from "../src/standalone/power/listener.js";
import { adoptService, inspectPowerDrift } from "../src/standalone/power/reconcile.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const root: WindowsProcess = { pid: 700, parent: 1, token: "windows:100", command: "node cli.js notify" };
const child = (pid: number, parent = 700, ticks = 200, command = "helper.exe"): WindowsProcess => ({ pid, parent, token: `windows:${ticks}`, command });
const scripts: string[] = [];

beforeEach(() => { vi.resetAllMocks(); runList.mockReturnValue([]); scripts.length = 0; });
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function respond(fn: (script: string) => unknown): void {
  execute.mockImplementation(async (file: string, args: string[], options: { timeout: number; windowsHide: boolean }) => {
    expect(file).toBe("powershell.exe");
    expect(args).toContain("-NonInteractive");
    expect(options.timeout).toBe(15_000);
    expect(options.windowsHide).toBe(true);
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    scripts.push(script);
    const result = fn(script);
    return { stdout: typeof result === "string" ? result : JSON.stringify(result), stderr: "" };
  });
}

describe("Windows power OS boundary", () => {
  it("routes creation tokens and listener ownership to bounded Windows queries, with no fake PGID", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    respond(script => script.includes("Get-NetTCPConnection") ? [700] : "638000000000000001");
    expect(await processStartToken(700)).toBe("windows:638000000000000001");
    expect(await listenerPid(3001)).toBe(700);
    expect(await processPgid(700)).toBeNull();
    expect(scripts).toHaveLength(2);
  });

  it("fails closed for absent/ambiguous TCP owners and unavailable creation identity", async () => {
    respond(() => []);
    await expect(windowsListenerPid(3001)).rejects.toThrow("unique listener");
    respond(() => [700, 701]);
    await expect(windowsListenerPid(3001)).rejects.toThrow("unique listener");
    execute.mockRejectedValue(new Error("provider access denied"));
    expect(await windowsStartToken(700)).toBeNull();
    await expect(windowsListenerPid(3001)).rejects.toThrow("access denied");
    await expect(windowsStartToken(-1)).rejects.toThrow("invalid Windows PID");
  });

  it("rejects malformed snapshots and anchors kill to a handle's creation time", async () => {
    respond(() => [{ pid: 700 }]);
    await expect(windowsProcesses()).rejects.toThrow("snapshot");
    respond(() => "1000");
    await terminateWindowsProcess(root);
    expect(scripts.at(-1)).toContain("GetProcessTimes(h");
    expect(scripts.at(-1)).toContain("TerminateProcess(h,1)");
    expect(scripts.at(-1)).not.toContain("taskkill");
    await expect(terminateWindowsProcess({ ...root, token: "windows:1'; bad" })).rejects.toThrow("unverified");
  });

  it("round trips nullable Windows PGID, tree scope and partial-stop evidence", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tut-windows-facts-"));
    const facts = { pid: 700, pgid: null, start_token: root.token, started_at: new Date().toISOString(), stopped_at: new Date().toISOString(), process_scope: "windows-tree" as const };
    try {
      const state = { mode: "standalone" as const, started_at: facts.started_at, hub: { ...facts, url: "http://127.0.0.1:3001", port: 3001 }, notifier: { ...facts, event_port: 3002 }, watcher: facts };
      await writePowerState(dir, state);
      expect(await readPowerState(dir)).toEqual(state);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("Windows tree scope and run survival", () => {
  it("excludes run roots, startup supervisors and entire subtrees; ignores older children of recycled parents", () => {
    const rows = [root, child(701), child(702, 701), child(703), child(704, 703),
      child(705, 700, 200, 'node "C:\\TUT folder\\dist\\core\\run\\supervisor.js" --supervise'), child(706, 705), child(707, 700, 50)];
    expect(windowsServiceTree(rows, root, new Set([703])).map(row => row.pid)).toEqual([700, 701, 702]);
  });

  it("refuses unreadable descendants instead of guessing run ownership", () => {
    expect(() => windowsServiceTree([root, { ...child(701), command: null }], root, new Set())).toThrow("cannot attribute");
  });

  it("stops parents first, reaps a newly observed child, and preserves registered and in-flight runs", async () => {
    runList.mockReturnValue(["run"]);
    runRead.mockReturnValue({ pid: 800, supervisor_pid: 801 });
    const run = child(800);
    const startup = child(802, 700, 200, "node C:\\pkg\\core\\run\\supervisor.js --supervise");
    const snapshots = [[root, child(701), run, startup], [child(702, 701), run, startup], [run, startup]];
    respond(script => script.includes("Get-CimInstance") ? snapshots.shift()! : "1000");
    await stopWindowsService("C:\\rig", 700, root.token);
    const kills = scripts.filter(script => script.includes("[TutPowerProcess]::Stop"));
    expect(kills.map(script => script.match(/::Stop\((\d+),/)![1])).toEqual(["700", "701", "702"]);
  });

  it("never terminates missing, recycled or unobservable leaders, or unreadable run metadata", async () => {
    for (const rows of [[], [{ ...root, token: "windows:999" }], [{ ...root, token: null }]]) {
      respond(() => rows);
      await expect(stopWindowsService("C:\\rig", 700, root.token)).rejects.toThrow();
    }
    expect(scripts.some(script => script.includes("[TutPowerProcess]::Stop"))).toBe(false);
    runList.mockReturnValue(["broken"]);
    runRead.mockImplementation(() => { throw new Error("corrupt run metadata"); });
    await expect(stopWindowsService("C:\\rig", 700, root.token)).rejects.toThrow("corrupt");
  });

  it("does not adopt descendants of a parent PID reused after its verified handle was closed", async () => {
    const snapshots = [[root], [child(701, 700, 2000)]];
    respond(script => script.includes("Get-CimInstance") ? snapshots.shift()! : "1000");
    await stopWindowsService("C:\\rig", 700, root.token);
    expect(scripts.filter(script => script.includes("[TutPowerProcess]::Stop"))).toHaveLength(1);
  });

  it("does not let completed run history reserve a recycled service PID", async () => {
    runList.mockReturnValue(["completed"]);
    runRead.mockReturnValue({ pid: 700, supervisor_pid: 701, ended_at: new Date().toISOString() });
    const snapshots = [[root], []];
    respond(script => script.includes("Get-CimInstance") ? snapshots.shift()! : "1000");
    await stopWindowsService("C:\\rig", 700, root.token);
    expect(scripts.filter(script => script.includes("[TutPowerProcess]::Stop"))).toHaveLength(1);
  });
});

describe("Windows adoption and drift", () => {
  const rig = path.resolve("/test/windows-rig");
  const url = "http://127.0.0.1:23151";
  function endpoints(): void {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
      if (new URL(input).port === "23151") return new Response(JSON.stringify({ hub_root: rig }));
      throw new Error("offline");
    }));
  }

  it("adopts only after bracketing HTTP identity with stable TCP owner and creation token", async () => {
    endpoints();
    respond(script => script.includes("Get-NetTCPConnection") ? [700] : "100");
    const facts = await adoptService("hub", url, rig, url);
    expect(facts).toMatchObject({ pid: 700, pgid: null, start_token: "windows:100", process_scope: "windows-tree", adopted: true, session_inherited: false });
    expect(scripts.filter(script => script.includes("Get-NetTCPConnection"))).toHaveLength(2);
    let queries = 0;
    respond(script => script.includes("Get-NetTCPConnection") ? [++queries === 1 ? 700 : 701] : "100");
    await expect(adoptService("hub", url, rig, url)).rejects.toThrow("identity changed");
  });

  it("reports an unregistered listener and a registered live PID that no longer owns the port", async () => {
    endpoints();
    expect(await inspectPowerDrift(rig, undefined, url)).toMatchObject([{ service: "hub", reason: "no registered PID" }]);
    respond(script => script.includes("Get-NetTCPConnection") ? [701] : "100");
    const facts = { pid: 700, pgid: null, start_token: "windows:100", process_scope: "windows-tree" as const, started_at: new Date().toISOString() };
    const prior = { mode: "standalone" as const, started_at: facts.started_at, hub: { ...facts, url, port: 23151 }, notifier: { ...facts, event_port: 23152 } };
    expect(await inspectPowerDrift(rig, prior, url)).toMatchObject([{ service: "hub", reason: "registered PID is not the TCP listener owner" }]);
  });
});
