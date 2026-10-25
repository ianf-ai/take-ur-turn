import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeHub, probeNotifier, notifierMatches } from "../hub/rig-discovery.js";
import { hubRead, HubError, type HubReadResult } from "../hub/hub-client.js";
import { DEFAULT_EVENT_PORT, DEFAULT_HUB_URL, cliFetchInit, sleepMs } from "./shared.js";

/** Event-port probe target — the Notifier answers 405 on non-POST. Derived from the single-source default. */
export const UP_EVENT_URL = `http://127.0.0.1:${DEFAULT_EVENT_PORT}/agent-event`;
const UP_WAIT_DEFAULT_MS = 10_000;
export const UP_POLL_INTERVAL_MS = 250;

/** The event-port probe URL for a given port — up's rendering and probing are the same source. */
export function eventPortUrl(port: number): string {
  return `http://127.0.0.1:${port}/agent-event`;
}

/**
 * How long tut up waits for a freshly provisioned hub to answer /state.
 * TUT_UP_HUB_WAIT_MS (read per call) shortens the wait — test/ops knob.
 */
export function hubWaitMs(): number {
  const parsed = Number(process.env.TUT_UP_HUB_WAIT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : UP_WAIT_DEFAULT_MS;
}

/**
 * How long tut up waits for a freshly provisioned notifier to answer the
 * event port — the notify twin of hubWaitMs. Spawn ok ≠ listening: a pane
 * run into a pane still occupied by a live foreground process swallows the
 * command while herdr still reports ok, so the notify success report is
 * gated on this probe. TUT_UP_NOTIFY_WAIT_MS (read per call) shortens the
 * wait — test/ops knob, the same discipline as TUT_UP_HUB_WAIT_MS.
 */
export function notifyWaitMs(): number {
  const parsed = Number(process.env.TUT_UP_NOTIFY_WAIT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : UP_WAIT_DEFAULT_MS;
}

/**
 * Absolute path of this CLI itself — dev runs src/cli.ts, installs run
 * dist/cli.js. TUT_UP_CLI_SELF (read per call) overrides the resolution —
 * test/ops knob, the same discipline as TUT_UP_HUB_WAIT_MS.
 */
export function upCliSelf(): string {
  return process.env.TUT_UP_CLI_SELF ?? fileURLToPath(new URL(`../../cli${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));
}

/** Retry `check` until true or the deadline; sleepMs between attempts. */
export async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleepMs(intervalMs);
  }
}

/**
 * A serving Hub must prove it belongs to the selected root. Recheck after
 * provisioning so a port race cannot turn a foreign service into success.
 */
export async function hubHealthy(baseUrl: string, root: string): Promise<boolean> {
  return (await probeHub(baseUrl))?.root === root;
}

/**
 * GET /agent-event: the Notifier's documented non-POST answer is 405 WITH an
 * Allow header naming POST (notifier.ts sends `Allow: POST` — verified).
 * Tightened: a bare 405 from an unrelated service on the port no longer counts
 * as "notifier present" — provisioning proceeds instead of silently skipping.
 */
export async function notifyHealthy(url: string = UP_EVENT_URL, root?: string, hubUrl?: string): Promise<boolean> {
  if (root !== undefined && hubUrl !== undefined) return notifierMatches(await probeNotifier(url), root, hubUrl);
  try {
    const res = await fetch(url, cliFetchInit());
    if (res.status !== 405) return false;
    const allow = (res.headers.get("allow") ?? "").toUpperCase();
    return allow.split(/[\s,]+/).includes("POST");
  } catch {
    return false;
  }
}

/** Distinguish a normal empty scope from records missing an invariants seed.
 * Read failures stay unknown, never masquerading as an empty scope.
 */
export async function projectInvariantsState(url: string): Promise<"empty" | "seeded" | "unseeded" | "unknown"> {
  let versions: HubReadResult["versions"];
  try {
    versions = (await hubRead(url, "project")).versions;
  } catch (e) {
    return e instanceof HubError && e.code === "TASK_NOT_FOUND" ? "empty" : "unknown";
  }
  if (versions.length === 0) return "empty";
  return versions.some(
    (r) => r.payload.summary.includes(INVARIANTS_MARKER) || r.payload.body.includes(INVARIANTS_MARKER),
  ) ? "seeded" : "unseeded";
}

/** Marker for an invariants seed note in the project scope (seed-hint check). */
const INVARIANTS_MARKER = "不变量";
const INVARIANTS_HINT_SUMMARY = "不变量种子：记录永不删除；写入永不拒绝≠许可；预写答案的评测材料不入库";
/** The three hard rules, AGENTS.md 不变量 wording condensed to one shell-safe line. */
const INVARIANTS_HINT_BODY =
  "记录永不删除：.context-hub/ 落盘的记录是不可变的审计材料，处置误写的正确动作是 tut decide close 或补一条说明 note，绝不是删文件。" +
  "写入永不拒绝≠许可：Hub 不做流程执法是信任设计，任何 Agent 不得利用写入自由绕过人工审批门。" +
  "预写答案的评测材料存放纪律：预先写明答案或预期结果的材料不得放入本仓库（存于仓库外），实现计划正常入库。";

/** Print the exact publish command as a HINT — seeds are human declarations, tut never auto-publishes. */
export function printInvariantsHint(url: string): void {
  process.stdout.write(
    `up: project scope has no invariants seed (no note mentioning ${INVARIANTS_MARKER}) — hard rules belong where agents read them; declare them (seeds are human declarations, never auto-published):\n`,
  );
  process.stdout.write(
    `up:   tut publish project --role human --content-type note --summary '${INVARIANTS_HINT_SUMMARY}' --body '${INVARIANTS_HINT_BODY}'${url !== DEFAULT_HUB_URL ? ` --url ${url}` : ""}\n`,
  );
}

/** Validate the local service URL before any host probe or provisioning. */
export function upHubPort(url: string): number {
  const u = new URL(url);
  const loopback = u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  if (!loopback || u.port.length === 0) throw new Error("not a loopback http URL with an explicit port");
  return Number(u.port);
}

/** Guard message: up provisions a LOCAL hub, so --url must be loopback http with an explicit port (the example deliberately avoids the event port). */
export function upUrlError(url: string): string {
  return `tut: up: --url must be an http loopback URL with an explicit port (e.g. http://127.0.0.1:3003), got: ${url}\n`;
}

/**
 * The tail activation hint (final wording, human ruling 2026-08-25): pure
 * intent — no paths, no how-to-read-rules instructions. The mechanism
 * lives in the AGENTS.md block `tut init` maintains; printed on every up
 * exit path, --dry-run included.
 */
export function printActivationHint(): void {
  process.stdout.write("up: activate a Host — tell any coding-agent session in this repo:\n");
  process.stdout.write("up:   「担任 TUT Host，全程驱动这个任务：<你的需求>」\n");
  process.stdout.write('up:   ("Act as TUT Host and drive this task end to end: <request>" — works via the AGENTS.md block from `tut init`)\n');
}
