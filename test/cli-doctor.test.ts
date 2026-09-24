// This suite isolates doctor rendering; endpoint identity is covered separately.
vi.mock("../src/hub/rig-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/hub/rig-discovery.js")>()),
  resolveCliHubUrl: vi.fn(async (url: string) => url),
  resolveRigRoot: vi.fn(() => "/owning/rig"),
}));

// tut doctor CLI wiring (0.7.0). The doctor module itself is
// exercised in test/doctor.test.ts through its own seams (fetchImpl /
// resolveTarget) against real temp-dir fixtures; these tests cover only the
// cli.ts wiring — command recognition, unknown-argument discipline, the two
// output faces drawing from the SAME DoctorReport, and the exit-code mapping.
// runDoctor is mocked at the module boundary (the hub-client discipline from
// cli.test.ts): production fetches the real hub, and these tests must not
// depend on sandbox loopback. renderDoctorReport stays REAL — the text face
// is asserted through the actual renderer, not a mock of it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/doctor/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/doctor/index.js")>()),
  runDoctor: vi.fn(),
}));

import { resolveCliHubUrl } from "../src/hub/rig-discovery.js";
import { DEFAULT_HUB_URL, USAGE, main, parseArgs } from "../src/cli.js";
import { renderDoctorReport, runDoctor, type DoctorReport } from "../src/doctor/index.js";

function captureIo(): { out: () => string; err: () => string; restore: () => void } {
  let outText = "";
  let errText = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    outText += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errText += String(chunk);
    return true;
  });
  return { out: () => outText, err: () => errText, restore: () => { out.mockRestore(); err.mockRestore(); } };
}

/** The canonical eight checks, in runner order, with a controlled status. */
function fixtureReport(statuses: Partial<Record<string, "ok" | "warn" | "fail">> = {}): DoctorReport {
  const titles: Array<[name: string, title: string]> = [
    ["hub", "hub reachable"],
    ["notifier", "notifier event port"],
    ["config", "config & workspace chain"],
    ["agents", "agent executables"],
    ["storage", "storage health"],
    ["paths", "path safety & probe endpoints"],
    ["platform", "platform info"],
    ["agent-channel", "agent channel network"],
  ];
  const checks = titles.map(([name, title]) => ({
    name,
    title,
    status: statuses[name] ?? "ok",
    summary: `${name} summary`,
    details: [`${name} detail`],
    ...(name === "hub" ? { fix: "tut serve" } : {}),
  }));
  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

// --- parsing (pure parseArgs) ---------------------------------------------------

describe("tut doctor parsing", () => {
  it("recognizes the command with the serve/config root default and the hub url default", () => {
    expect(parseArgs(["doctor"])).toEqual({
      command: "doctor",
      root: ".context-hub",
      url: DEFAULT_HUB_URL,
      json: false,
    });
  });

  it("takes --root/--url in both flag forms plus --json", () => {
    expect(parseArgs(["doctor", "--root", "/tmp/hub-x", "--url", "http://127.0.0.1:3999", "--json"])).toEqual({
      command: "doctor",
      root: "/tmp/hub-x",
      url: "http://127.0.0.1:3999",
      json: true,
    });
    expect(parseArgs(["doctor", "--root=/tmp/hub-y", "--url=http://127.0.0.1:4001"])).toEqual({
      command: "doctor",
      root: "/tmp/hub-y",
      url: "http://127.0.0.1:4001",
      json: false,
    });
  });

  it("rejects undeclared flags as unknown arguments (both flag forms)", () => {
    expect(parseArgs(["doctor", "--port", "3001"])).toEqual({ command: "usage", error: "unknown argument: --port" });
    expect(parseArgs(["doctor", "--interval=5"])).toEqual({ command: "usage", error: "unknown argument: --interval" });
  });

  it("rejects a value-bearing spelling of --json and stray positionals", () => {
    expect(parseArgs(["doctor", "--json=true"])).toEqual({ command: "usage", error: "--json does not take a value" });
    expect(parseArgs(["doctor", "task-id"])).toEqual({ command: "usage", error: "unexpected argument: task-id" });
  });

  it("USAGE documents the command", () => {
    expect(USAGE).toContain("tut doctor [--root <dir>] [--url <u>] [--json]");
  });
});

// --- handler wiring (runDoctor mocked at the module boundary) --------------------

describe("tut doctor handler (runDoctor mocked: wiring + output contract)", () => {
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    vi.mocked(runDoctor).mockReset();
    io = captureIo();
  });

  afterEach(() => {
    io.restore();
  });

  it("passes root/url through and renders the REAL renderer's text with exit 0 when ok", async () => {
    const report = fixtureReport();
    vi.mocked(runDoctor).mockResolvedValue(report);

    const code = await main(["doctor", "--root", "/tmp/hub-x", "--url", "http://127.0.0.1:3999"]);

    expect(code).toBe(0);
    expect(vi.mocked(runDoctor)).toHaveBeenCalledWith({ hubRoot: "/owning/rig", root: "/tmp/hub-x", url: "http://127.0.0.1:3999" });
    expect(io.out()).toBe(`${renderDoctorReport(report)}\n`);
  });

  it("passes the discovered Hub and frozen owning root together", async () => {
    vi.mocked(resolveCliHubUrl).mockResolvedValueOnce("http://127.0.0.1:3003");
    vi.mocked(runDoctor).mockResolvedValue(fixtureReport());
    await main(["doctor"]);
    expect(resolveCliHubUrl).toHaveBeenLastCalledWith(DEFAULT_HUB_URL, false, "/owning/rig");
    expect(runDoctor).toHaveBeenCalledWith({ root: ".context-hub", hubRoot: "/owning/rig", url: "http://127.0.0.1:3003" });
  });

  it("preserves offline reporting when the Hub identity handshake fails", async () => {
    const error = new Error("foreign hub");
    vi.mocked(resolveCliHubUrl).mockRejectedValueOnce(error);
    vi.mocked(runDoctor).mockResolvedValue(fixtureReport({ hub: "fail", notifier: "fail" }));
    expect(await main(["doctor", "--json"])).toBe(1);
    const options = vi.mocked(runDoctor).mock.calls[0]![0]!;
    expect(options.hubRoot).toBe("/owning/rig");
    await expect(options.fetchImpl!("http://127.0.0.1:3001/state")).rejects.toBe(error);
    expect(JSON.parse(io.out()).checks).toHaveLength(8);
  });

  it("defaults to .context-hub and the default hub URL", async () => {
    vi.mocked(runDoctor).mockResolvedValue(fixtureReport());

    await main(["doctor"]);

    expect(vi.mocked(runDoctor)).toHaveBeenCalledWith({ hubRoot: "/owning/rig", root: ".context-hub", url: DEFAULT_HUB_URL });
  });

  it("maps report.ok=false to exit 1 while still rendering the FULL report", async () => {
    const report = fixtureReport({ hub: "fail", notifier: "warn" });
    vi.mocked(runDoctor).mockResolvedValue(report);

    const code = await main(["doctor"]);

    expect(code).toBe(1);
    const out = io.out();
    // every one of the eight checks is still rendered, fail included
    for (const line of renderDoctorReport(report).split("\n")) expect(out).toContain(line);
    expect(out).toContain("result: FAIL");
  });

  it("--json prints the DoctorReport itself (same report the text face draws from)", async () => {
    const report = fixtureReport({ storage: "warn" });
    vi.mocked(runDoctor).mockResolvedValue(report);

    const code = await main(["doctor", "--json"]);

    expect(code).toBe(0); // a warn does not flip the exit code
    expect(JSON.parse(io.out())).toEqual(report);
    // the eight check names, in runner order, are the machine surface
    expect((JSON.parse(io.out()) as DoctorReport).checks.map((c) => c.name)).toEqual([
      "hub", "notifier", "config", "agents", "storage", "paths", "platform", "agent-channel",
    ]);
  });

  it("--json exit follows report.ok, not the json flag", async () => {
    vi.mocked(runDoctor).mockResolvedValue(fixtureReport({ agents: "fail" }));

    const code = await main(["doctor", "--json"]);

    expect(code).toBe(1);
    expect((JSON.parse(io.out()) as DoctorReport).ok).toBe(false);
  });

  it("the text face carries all eight numbered checks with their titles", async () => {
    vi.mocked(runDoctor).mockResolvedValue(fixtureReport());

    await main(["doctor"]);

    const out = io.out();
    for (const title of [
      "hub reachable",
      "notifier event port",
      "config & workspace chain",
      "agent executables",
      "storage health",
      "path safety & probe endpoints",
      "platform info",
      "agent channel network",
    ]) {
      expect(out).toContain(title);
    }
    for (let i = 1; i <= 8; i++) expect(out).toContain(`${i}. `);
    expect(out).toContain("result: ok");
  });
});
