import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// execFile is mocked for the whole file: desktop's chain is driven by making
// individual commands succeed/fail (ENOENT etc. is just an Error to the chain).
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { createChannels, type Channel } from "../src/channels.js";

const execFileMock = execFile as unknown as Mock;

function first(channels: Channel[]): Channel {
  const ch = channels[0];
  if (ch === undefined) throw new Error("expected at least one channel");
  return ch;
}

function names(channels: Channel[]): string[] {
  return channels.map((c) => c.name);
}

/** Outcome per command name (null = success); commands not listed fail with a generic error. */
function mockExec(outcomes: Record<string, Error | null>): void {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cmd = args[0] as string;
    const cb = args[args.length - 1] as (err: Error | null) => void;
    cb(Object.hasOwn(outcomes, cmd) ? (outcomes[cmd] ?? null) : new Error(`spawn ${cmd} ENOENT`));
  });
}

function callsTo(cmd: string): unknown[][] {
  return execFileMock.mock.calls.filter((c) => c[0] === cmd);
}

let stderrLines: string[] = [];

beforeEach(() => {
  execFileMock.mockReset();
  stderrLines = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- desktop degradation chain ---------------------------------------------------

describe("desktop channel", () => {
  // The frozen osascript invocation shape: constant script source,
  // message text only in argv after "--" (body first, title second).
  const NOTIFY_SCRIPT = 'on run argv\n  display notification (item 1 of argv) with title (item 2 of argv)\nend run';

  it("uses osascript on success and skips the rest of the chain", async () => {
    mockExec({ osascript: null });
    await first(createChannels(undefined)).send({ title: "TUT t1: hi", body: "body text" });
    const osa = callsTo("osascript");
    expect(osa).toHaveLength(1);
    expect(osa[0]?.[1]).toEqual(["-e", NOTIFY_SCRIPT, "--", "body text", "TUT t1: hi"]);
    expect(callsTo("notify-send")).toHaveLength(0);
    expect(stderrLines).toEqual([]);
  });

  it("falls back to notify-send when osascript is unavailable (e.g. Linux)", async () => {
    mockExec({ "notify-send": null });
    await first(createChannels(undefined)).send({ title: "a title", body: "a body" });
    expect(callsTo("osascript")).toHaveLength(1); // attempted first
    const ns = callsTo("notify-send");
    expect(ns).toHaveLength(1);
    expect(ns[0]?.[1]).toEqual(["a title", "a body"]);
    expect(stderrLines).toEqual([]);
  });

  it("ends at the terminal bell when both commands fail, and never throws", async () => {
    mockExec({});
    const desktop = first(createChannels({ channels: ["desktop"] }));
    await expect(desktop.send({ title: "t", body: "b" })).resolves.toBeUndefined();
    expect(callsTo("osascript")).toHaveLength(1);
    expect(callsTo("notify-send")).toHaveLength(1);
    expect(stderrLines).toContain("\u0007");
  });

  it("message text never enters AppleScript source: the -e script is a constant, text rides in argv", async () => {
    mockExec({ osascript: null });
    await first(createChannels(undefined)).send({ title: 'title "injection" $(rm -rf /)', body: 'bod"y' });
    const args = (callsTo("osascript")[0]?.[1] as string[]) ?? [];
    expect(args[0]).toBe("-e");
    expect(args[1]).toBe(NOTIFY_SCRIPT); // constant — no interpolation whatsoever
    expect(args[2]).toBe("--");
    expect(args.slice(3)).toEqual(['bod"y', 'title "injection" $(rm -rf /)']);
  });

  it("a title carrying quotes and a do-shell-script payload stays plain argv data (cannot inject)", async () => {
    mockExec({ osascript: null });
    const title = 'x" & (do shell script "touch /tmp/pwned") & "y';
    await first(createChannels(undefined)).send({ title, body: "plain" });
    const args = (callsTo("osascript")[0]?.[1] as string[]) ?? [];
    expect(args[1]).toBe(NOTIFY_SCRIPT); // script source unchanged by the payload
    expect(args[4]).toBe(title); // payload arrives verbatim as argv — never executed
    expect(args.filter((a, i) => i !== 4 && a.includes("do shell script"))).toEqual([]);
  });
});

// --- webhook ------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  contentType: string;
  body: string;
}

async function startCapture(): Promise<{ port: number; requests: CapturedRequest[]; close(): Promise<void> }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: String(req.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("webhook channel", () => {
  it("POSTs {title, body, task_id} JSON to webhook_url", async () => {
    const cap = await startCapture();
    try {
      const cfg = { channels: ["webhook"], webhook_url: `http://127.0.0.1:${cap.port}/hook` };
      const webhook = first(createChannels(cfg).filter((c) => c.name === "webhook"));
      await webhook.send({ title: "TUT t1: up", body: "do something", task_id: "t1" });
      expect(cap.requests).toHaveLength(1);
      const req = cap.requests[0]!;
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/hook");
      expect(req.contentType).toContain("application/json");
      expect(JSON.parse(req.body)).toEqual({ title: "TUT t1: up", body: "do something", task_id: "t1" });
    } finally {
      await cap.close();
    }
  });

  it("omits task_id from the payload when absent", async () => {
    const cap = await startCapture();
    try {
      const cfg = { channels: ["webhook"], webhook_url: `http://127.0.0.1:${cap.port}/h` };
      const webhook = first(createChannels(cfg).filter((c) => c.name === "webhook"));
      await webhook.send({ title: "t", body: "b" });
      expect(JSON.parse(cap.requests[0]!.body)).toEqual({ title: "t", body: "b" });
    } finally {
      await cap.close();
    }
  });

  it("logs failures instead of throwing (unreachable webhook_url)", async () => {
    const cap = await startCapture();
    const deadPort = cap.port;
    await cap.close();
    const cfg = { channels: ["webhook"], webhook_url: `http://127.0.0.1:${deadPort}/hook` };
    const webhook = first(createChannels(cfg).filter((c) => c.name === "webhook"));
    await expect(webhook.send({ title: "t", body: "b", task_id: "x" })).resolves.toBeUndefined();
    expect(stderrLines.some((l) => l.includes("webhook channel: POST") && l.includes("failed"))).toBe(true);
  });
});

// --- createChannels config handling ----------------------------------------------

describe("createChannels config", () => {
  it("missing config → [\"desktop\"] without a warning", () => {
    expect(names(createChannels(undefined))).toEqual(["desktop"]);
    expect(stderrLines).toEqual([]);
  });

  it("corrupt config → warning + [\"desktop\"]", () => {
    expect(names(createChannels({ channels: "desktop" }))).toEqual(["desktop"]);
    expect(names(createChannels("nonsense"))).toEqual(["desktop"]);
    expect(names(createChannels({ channels: [42] }))).toEqual(["desktop"]);
    expect(stderrLines.filter((l) => l.includes("notify config is corrupt"))).toHaveLength(3);
  });

  it("corrupt config warns ONCE per distinct content (the notifier rebuilds channels every poll)", () => {
    // Distinct contents from the test above — its fingerprints already warned.
    expect(names(createChannels({ channels: 7 }))).toEqual(["desktop"]);
    expect(names(createChannels({ channels: 7 }))).toEqual(["desktop"]); // same content — silent now
    expect(names(createChannels("other-nonsense"))).toEqual(["desktop"]); // different content — warns again
    expect(stderrLines.filter((l) => l.includes("notify config is corrupt"))).toHaveLength(2);
  });

  it("dedupes repeated channel names (one channel instance per name)", () => {
    expect(names(createChannels({ channels: ["desktop", "desktop"] }))).toEqual(["desktop"]);
    expect(names(createChannels({ channels: ["webhook", "desktop", "webhook"], webhook_url: "http://127.0.0.1:9/hook" }))).toEqual([
      "webhook",
      "desktop",
    ]);
    expect(stderrLines).toEqual([]);
  });

  it("webhook without a usable URL is skipped; empty result falls back to desktop", () => {
    expect(names(createChannels({ channels: ["webhook"] }))).toEqual(["desktop"]);
    expect(names(createChannels({ channels: ["webhook"], webhook_url: "ftp://nope" }))).toEqual(["desktop"]);
    expect(names(createChannels({ channels: [] }))).toEqual(["desktop"]);
    expect(names(createChannels({ channels: ["bogus"] }))).toEqual(["desktop"]);
    expect(stderrLines.some((l) => l.includes("webhook_url is missing"))).toBe(true);
    expect(stderrLines.some((l) => l.includes("unknown channel"))).toBe(true);
  });

  it("builds desktop + webhook when the config is complete", () => {
    const cfg = { channels: ["desktop", "webhook"], webhook_url: "http://127.0.0.1:9/hook" };
    expect(names(createChannels(cfg))).toEqual(["desktop", "webhook"]);
    expect(stderrLines).toEqual([]);
  });
});
