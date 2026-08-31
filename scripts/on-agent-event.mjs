#!/usr/bin/env node
/**
 * Canonical agent-event entry — system-design 7.2 signal-source contract.
 *
 * Usage: on-agent-event.mjs <event> <agent> <pane>   event ∈ working | blocked | done | delivery_giveup
 *
 * Node-native transport: the body is JSON.stringify({event, agent, pane})
 * delivered via fetch with an AbortController (2s). The notifier is a latency
 * optimization, never a dependency: URL/connection failures, timeouts and
 * non-2xx replies only diagnose to stderr and exit 0 — a lost event is
 * acceptable because polling is the primary channel (system-design 6.1).
 * argv contract violations (wrong arity, event outside
 * working|blocked|done|delivery_giveup) exit 1.
 *
 * TUT_EVENT_PORT_URL (non-empty) overrides the local default URL and is
 * inherited from the Herdr plugin environment. scripts/on-agent-event.sh is a
 * POSIX thin shim over this file; the Windows Herdr manifest points at this
 * file directly (absolute node + absolute script, no shell).
 *
 * delivery_giveup (7.2.1) is emitted by the LAUNCHER (not Herdr) when its
 * bounded submit-retry window exhausts; the entry accepts it so every
 * emitter shares one event vocabulary and one endpoint resolution rule.
 */

const USAGE = "usage: on-agent-event.mjs <working|blocked|done|delivery_giveup> <agent> <pane>";
const EVENTS = new Set(["working", "blocked", "done", "delivery_giveup"]);
const DEFAULT_URL = "http://127.0.0.1:3002/agent-event";
const TIMEOUT_MS = 2000;

const argv = process.argv.slice(2);
if (argv.length !== 3 || !EVENTS.has(argv[0])) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(1);
}
const [event, agent, pane] = argv;

const configuredUrl = process.env.TUT_EVENT_PORT_URL;
const url = configuredUrl !== undefined && configuredUrl.length > 0 ? configuredUrl : DEFAULT_URL;

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
try {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, agent, pane }),
    signal: controller.signal,
  });
  if (!response.ok) {
    process.stderr.write(
      `on-agent-event: ${url} responded ${response.status}; event dropped (polling is the primary channel)\n`,
    );
  }
} catch (error) {
  const reason =
    error !== null && typeof error === "object" && error.name === "AbortError"
      ? `timed out after ${TIMEOUT_MS}ms`
      : String(error?.message ?? error);
  process.stderr.write(
    `on-agent-event: cannot reach ${url} (${reason}); event dropped (polling is the primary channel)\n`,
  );
} finally {
  clearTimeout(timer);
}
process.exit(0);
