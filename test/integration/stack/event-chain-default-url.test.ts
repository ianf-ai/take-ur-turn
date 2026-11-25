import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../../src/hub/server.js";

const CLI = new URL("../../../dist/cli.js", import.meta.url).href;
const ENTRY = fileURLToPath(new URL("../../../scripts/agent-event/on-agent-event.mjs", import.meta.url));
const DEFAULT_URL = "http://127.0.0.1:3002/agent-event";
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "event-chain fixture cleanup failed");
});

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TUT_")));
}

async function waitFor(probe: () => boolean, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error(diagnostic());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function reservePort(port = 0): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`clean-environment fixture needs exclusive port ${port}; stop its owner before running this suite`, { cause: error });
    }
    throw error;
  });
  cleanups.push(() => closeServer(server));
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function portOf(server: Server): number {
  return (server.address() as { port: number }).port;
}

async function startFixture() {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "tut-default-event-chain-")));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const hub = await startServer({ root: path.join(cwd, ".context-hub"), port: 0 });
  cleanups.push(() => hub.close());
  return { cwd, hub };
}

// Drive the real parser -> notify handler -> runNotify daemon in an isolated
// child. Only the Hub URL is supplied, so its temporary ephemeral port does not
// change the parser's event-port default. CLI workspace discovery is covered
// separately; it deliberately derives a paired port for a moved Hub.
const NOTIFIER_CHILD = `
  const { HANDLERS, parseArgs } = await import(process.argv[1]);
  process.send({ tutKeys: Object.keys(process.env).filter(key => key.startsWith('TUT_')) });
  process.on('message', message => { if (message === 'stop') process.emit('SIGTERM'); });
  process.exitCode = await HANDLERS.notify(parseArgs(process.argv.slice(2)));
  process.disconnect();
`;

function startNotifier(cwd: string, hubUrl: string, port?: number, env = cleanEnvironment()) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", NOTIFIER_CHILD, CLI,
    "notify", "--url", hubUrl, ...(port === undefined ? [] : ["--event-port", String(port)])], {
    cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  let tutKeys: string[] | undefined;
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  child.stdout!.resume();
  child.on("message", message => { tutKeys = (message as { tutKeys: string[] }).tutKeys; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) { await done; return; }
    child.send("stop");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { expect(await done, stderr).toEqual({ code: 0, signal: null }); }
    finally { clearTimeout(timer); }
  });
  return {
    done, stderr: () => stderr,
    async environment() {
      await waitFor(() => tutKeys !== undefined, () => `child environment not reported: ${stderr}`);
      return tutKeys;
    },
    async ready(url: string) {
      await waitFor(() => stderr.includes(`listening for agent events on ${url}`) && stderr.includes("baseline"),
        () => `notifier did not start at ${url}: ${stderr}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(await response.json()).toMatchObject({ hub_url: hubUrl, hub_root: cwd });
    },
  };
}

async function sendWorking(cwd: string, pane: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [ENTRY, "working", "codex", pane], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  // Exit 0 alone is insufficient: the entry also exits 0 on transport loss.
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
}

describe("event chain default URL in a clean child environment", () => {
  it.each(["unset", "empty"])("delivers to a real default-port notifier with the producer URL %s", async mode => {
    // Unlike the older transport-only case, a busy default port fails this
    // acceptance test visibly; it must never turn into a skip or another port.
    const reservation = await reservePort(3002);
    await closeServer(reservation);
    const { cwd, hub } = await startFixture();
    const notifier = startNotifier(cwd, hub.url);
    expect(await notifier.environment()).toEqual([]);
    await notifier.ready(DEFAULT_URL);
    const env = cleanEnvironment();
    if (mode === "empty") env.TUT_EVENT_PORT_URL = "";
    const pane = `default-url-${mode}.executor`;
    await sendWorking(cwd, pane, env);
    await waitFor(() => notifier.stderr().includes(`working event pane '${pane}' resolves to no task`), notifier.stderr);
  }, 15000);

  it("fails explicitly on an occupied default port without starting polling or a fallback listener", async () => {
    const blocker = await reservePort(3002);
    const { cwd, hub } = await startFixture();
    const notifier = startNotifier(cwd, hub.url);
    expect(await notifier.environment()).toEqual([]);
    await waitFor(() => notifier.stderr().includes("EADDRINUSE"), notifier.stderr);
    expect(await notifier.done).toEqual({ code: 1, signal: null });
    expect(notifier.stderr()).toContain("tut: notify: cannot listen on 127.0.0.1:3002");
    expect(notifier.stderr()).not.toContain("listening for agent events");
    expect(notifier.stderr()).not.toContain("baseline");
    expect(blocker.listening).toBe(true);
  }, 15000);

  it("preserves explicit event URL and port overrides", async () => {
    const reservation = await reservePort();
    const port = portOf(reservation);
    const url = `http://127.0.0.1:${port}/agent-event`;
    await closeServer(reservation);
    const { cwd, hub } = await startFixture();
    const env = { ...cleanEnvironment(), TUT_EVENT_PORT_URL: url };
    const notifier = startNotifier(cwd, hub.url, port, env);
    expect(await notifier.environment()).toEqual(["TUT_EVENT_PORT_URL"]);
    await notifier.ready(url);
    const pane = "explicit-event-url.executor";
    await sendWorking(cwd, pane, env);
    await waitFor(() => notifier.stderr().includes(`working event pane '${pane}' resolves to no task`), notifier.stderr);
    expect(notifier.stderr()).not.toContain(`listening for agent events on ${DEFAULT_URL}`);
  }, 15000);

  it("also fails explicitly when an overridden event port is occupied", async () => {
    const blocker = await reservePort();
    const port = portOf(blocker);
    const { cwd, hub } = await startFixture();
    const env = { ...cleanEnvironment(), TUT_EVENT_PORT_URL: `http://127.0.0.1:${port}/agent-event` };
    const notifier = startNotifier(cwd, hub.url, port, env);
    await waitFor(() => notifier.stderr().includes("EADDRINUSE"), notifier.stderr);
    expect(await notifier.done).toEqual({ code: 1, signal: null });
    expect(notifier.stderr()).toContain(`cannot listen on 127.0.0.1:${port}`);
    expect(notifier.stderr()).not.toContain("listening for agent events");
    expect(blocker.listening).toBe(true);
  }, 15000);
});
