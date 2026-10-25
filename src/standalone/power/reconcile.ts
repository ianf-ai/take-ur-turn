import { randomUUID } from "node:crypto";
import { canonicalRoot, discoverWorkspaceNotifiers, eventEndpoint, notifierMatches, probeHub, probeNotifier, probeNotifierEvidence } from "../../core/hub/rig-discovery.js";
import { processAlive, processPgid, processStartToken, type PowerState, type ServiceFacts } from "./standalone-up.js";
import { listenerPid } from "./listener.js";

export interface PowerDrift {
  service: "hub" | "notifier";
  url: string;
  reason: string;
}

function localEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && !parsed.username && !parsed.password &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && Number(parsed.port) > 0;
  } catch { return false; }
}

export function sameHubEndpoint(a: string, b: string): boolean {
  return eventEndpoint(new URL("/state", a).href) === eventEndpoint(new URL("/state", b).href);
}

async function registrationProblem(facts: ServiceFacts | undefined, url: string): Promise<string | undefined> {
  if (!facts || facts.pid === null) return "no registered PID";
  if (!processAlive(facts.pid)) return `registered PID ${facts.pid} is dead`;
  if (!facts.start_token) return `registered PID ${facts.pid} has no start token`;
  const token = await processStartToken(facts.pid);
  if (token !== null && token !== facts.start_token) return `registered PID ${facts.pid} was recycled`;
  if (process.platform === "win32") {
    if (facts.process_scope !== "windows-tree") return "no Windows service tree registration";
    try { if (await listenerPid(Number(new URL(url).port)) !== facts.pid) return "registered PID is not the TCP listener owner"; }
    catch { return "Windows TCP owner could not be verified"; }
  }
  return undefined; // A transient unreadable token is not evidence of drift.
}

/** Read-only reconciliation: cover startup's discovery range AND recorded/custom
 * endpoints, even when resolveUpHub will later refuse a conflict. */
export async function inspectPowerDrift(root: string, prior: PowerState | undefined, preferredUrl: string, fetchImpl: typeof fetch = fetch, eventUrl?: string): Promise<PowerDrift[]> {
  root = canonicalRoot(root);
  const candidates = [preferredUrl, ...(prior ? [prior.hub.url] : []),
    ...Array.from({ length: 100 }, (_, i) => `http://127.0.0.1:${3001 + 2 * i}`)].filter(localEndpoint);
  const urls = candidates.filter((url, index) => !candidates.slice(0, index).some(other => sameHubEndpoint(url, other)));
  const identities = await Promise.all(urls.map(url => probeHub(url, fetchImpl)));
  const hubs = urls.filter((_, i) => identities[i]?.root === root);
  const drift: PowerDrift[] = [];
  for (const url of hubs) {
    const sameEndpoint = prior && sameHubEndpoint(prior.hub.url, url);
    const problem = await registrationProblem(sameEndpoint ? prior.hub : undefined, url);
    if (problem) drift.push({ service: "hub", url, reason: problem });
  }
  // One scan also covers a recorded notifier on a custom port, including
  // same-root notifiers that have outlived their Hub.
  const { probes } = await discoverWorkspaceNotifiers(hubs[0] ?? preferredUrl, root,
    prior ? `http://127.0.0.1:${prior.notifier.event_port}/agent-event` : undefined, fetchImpl);
  if (eventUrl && localEndpoint(eventUrl) && !probes.some(probe => eventEndpoint(probe.url) === eventEndpoint(eventUrl))) {
    probes.push(await probeNotifierEvidence(eventUrl, fetchImpl));
  }
  for (const probe of probes) {
    // An orphan notifier can outlive its Hub. Its own root declaration is
    // enough to report drift, but adoption additionally requires a live Hub.
    if (probe.identity?.root !== root) continue;
    const samePort = prior?.notifier.event_port === Number(new URL(probe.url).port);
    const problem = await registrationProblem(samePort ? prior.notifier : undefined, probe.url);
    if (problem) drift.push({ service: "notifier", url: probe.url, reason: problem });
  }
  return drift;
}

export function describePowerDrift(drift: PowerDrift): string {
  return `power drift: ${drift.service} ${drift.url}: ${drift.reason}; same-root live service is unregistered; no automatic adoption — use tut up --adopt to explicitly adopt verified services`;
}

/** No signaling or environment mutation. Bracket the ownership handshake with
 * kernel PID/start/group checks; down's existing stop protocol remains intact. */
export async function adoptService(service: "hub" | "notifier", url: string, root: string, hubUrl: string): Promise<ServiceFacts> {
  if (!localEndpoint(url)) throw new Error(`cannot adopt ${service}: expected a local HTTP listener with an explicit port`);
  const verify = async (): Promise<void> => {
    const hubOwned = (await probeHub(service === "hub" ? url : hubUrl))?.root === canonicalRoot(root);
    const owned = hubOwned && (service === "hub" || notifierMatches(await probeNotifier(url), canonicalRoot(root), hubUrl));
    if (!owned) throw new Error(`cannot adopt ${service} at ${url}: hub_root / Hub URL ownership verification failed (expected ${canonicalRoot(root)})`);
  };
  await verify();
  const port = Number(new URL(url).port);
  const pid = await listenerPid(port);
  const token = await processStartToken(pid);
  const pgid = await processPgid(pid);
  if (token === null || !processAlive(pid)) throw new Error(`cannot adopt ${service} PID ${pid}: start identity is unavailable`);
  if (process.platform !== "win32" && pgid !== pid) throw new Error(`cannot adopt ${service} PID ${pid}: not an independent process-group leader (pgid=${pgid}); refusing control of a shared group`);
  await verify();
  if (await listenerPid(port) !== pid || await processStartToken(pid) !== token || await processPgid(pid) !== pgid) {
    throw new Error(`cannot adopt ${service}: listener identity changed during verification`);
  }
  return { pid, pgid, start_token: token, started_at: new Date().toISOString(),
    ...(process.platform === "win32" ? { process_scope: "windows-tree" as const } : {}),
    power_session: randomUUID(), adopted: true, session_inherited: false };
}
