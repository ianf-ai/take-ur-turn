/** Local Hub identity handshake. Discovery is read-only; only `up` provisions. */
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

export function canonicalRoot(root: string): string {
  const absolute = path.resolve(root);
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function resolveRigRoot(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  // Workers in task worktrees retain the owning shared Hub via this thread.
  if (env.TUT_HUB_ROOT) return canonicalRoot(env.TUT_HUB_ROOT);
  let candidate = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(candidate, ".context-hub"))) return canonicalRoot(candidate);
    const parent = path.dirname(candidate);
    if (parent === candidate) return canonicalRoot(cwd);
    candidate = parent;
  }
}

export type HubIdentity = { root?: string };
export async function probeHub(url: string): Promise<HubIdentity | undefined> {
  try {
    const response = await fetch(new URL("/state", url), {
      signal: AbortSignal.timeout(800), headers: { Connection: "close" }, redirect: "manual",
    });
    if (!response.ok) return {};
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "hub_root" in body &&
        typeof body.hub_root === "string" && path.isAbsolute(body.hub_root)) {
      return { root: canonicalRoot(body.hub_root) };
    }
    return {};
  } catch (error) {
    // A responder with invalid JSON is not an offline endpoint.
    if (error instanceof SyntaxError) return {};
    return undefined;
  }
}

function mismatch(url: string, root: string, identity: HubIdentity): Error {
  return new Error(`foreign hub / workspace mismatch at ${url}: hub_root=${identity.root ?? "unknown (identity handshake missing)"}, expected ${root}. Run 'tut up' in the intended workspace without --url, or use --url for that workspace's hub; upgrade/restart older hubs to expose hub_root.`);
}

const discoveryUrls = Array.from({ length: 100 }, (_, i) => `http://127.0.0.1:${3001 + i * 2}`);
export async function discoverHub(root: string, urls: readonly string[] = discoveryUrls): Promise<string | undefined> {
  const identities = await Promise.all(urls.map(probeHub));
  return urls.find((_, i) => identities[i]?.root === root);
}

export async function resolveCliHubUrl(url: string, explicit: boolean, root = resolveRigRoot(), urls?: readonly string[]): Promise<string> {
  const identity = await probeHub(url);
  if (identity?.root === root) return url;
  if (explicit) {
    if (identity) throw mismatch(url, root, identity);
    throw new TypeError(`fetch failed: identity handshake unavailable at ${url}/state`);
  }
  const own = await discoverHub(root, urls);
  if (own) return own;
  throw new Error(`No verified hub for workspace ${root}${identity ? ` (foreign hub at ${url})` : ""}. Run 'tut up' in this workspace to start its own serve/notify pair.`);
}

export async function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export interface NotifierIdentity { root?: string; hubUrl?: string }

export interface NotifierProbe {
  url: string;
  outcome: "signature" | "occupied" | "unavailable";
  identity?: NotifierIdentity;
  detail: string;
}

export const DEFAULT_NOTIFIER_EVENT_URL = "http://127.0.0.1:3002/agent-event";

/** Read-only evidence; the timeout covers both headers and the JSON body. */
export async function probeNotifierEvidence(eventUrl: string, fetchImpl: typeof fetch = fetch): Promise<NotifierProbe> {
  try {
    const response = await fetchImpl(eventUrl, {
      method: "GET", signal: AbortSignal.timeout(800), headers: { Connection: "close" }, redirect: "manual",
    });
    if (response.status !== 405 || !(response.headers.get("allow") ?? "").toUpperCase().split(/[\s,]+/).includes("POST")) {
      await response.body?.cancel();
      return { url: eventUrl, outcome: "occupied", detail: `HTTP ${response.status}: not the Notifier's 405 + Allow: POST signature` };
    }
    let body: unknown;
    try { body = await response.json(); }
    catch (error) {
      return { url: eventUrl, outcome: "signature", identity: {}, detail: `405 + Allow: POST; 归属无法确认 (${error instanceof SyntaxError ? "invalid JSON" : `body unreadable/timeout: ${String(error)}`})` };
    }
    const value = body as { hub_root?: unknown; hub_url?: unknown } | null;
    const identity: NotifierIdentity = {};
    if (value && typeof value.hub_root === "string" && path.isAbsolute(value.hub_root)) identity.root = canonicalRoot(value.hub_root);
    if (value && typeof value.hub_url === "string") {
      try {
        const url = new URL(value.hub_url);
        if (["http:", "https:"].includes(url.protocol)) identity.hubUrl = value.hub_url;
      } catch { /* Invalid identity stays unknown. */ }
    }
    return { url: eventUrl, outcome: "signature", identity, detail: "405 + Allow: POST" };
  } catch (error) {
    return { url: eventUrl, outcome: "unavailable", detail: `unreachable/timeout: ${String(error)}` };
  }
}

/** Preserve the startup resolver's signature/unknown/offline contract. */
export async function probeNotifier(eventUrl: string): Promise<NotifierIdentity | undefined> {
  const probe = await probeNotifierEvidence(eventUrl);
  if (probe.outcome !== "signature") return undefined;
  return probe.identity?.root && probe.identity.hubUrl ? probe.identity : {};
}

/** Normalize aliases without discarding the producer's path or query. */
export function eventEndpoint(url: string): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("expected HTTP(S) URL without credentials");
  if (["localhost", "[::1]"].includes(parsed.hostname)) parsed.hostname = "127.0.0.1";
  parsed.hash = "";
  return parsed.href;
}

/** Same bounded local port range as startup discovery; never binds a port. */
export async function discoverNotifierEvidence(hubUrl: string, explicit: string | undefined, fetchImpl: typeof fetch): Promise<NotifierProbe[]> {
  const urls = explicit ? [explicit] : [];
  const ports = [3002, ...Array.from({ length: 200 }, (_, i) => 3001 + i)];
  try { ports.unshift(Number(new URL(hubUrl).port) + 1); } catch { /* Hub check reports invalid URL. */ }
  urls.push(...ports.filter(p => p > 0 && p <= 65535).map(p => `http://127.0.0.1:${p}/agent-event`));
  const candidates = new Map<string, string>();
  for (const url of urls) {
    try { const key = eventEndpoint(url); if (!candidates.has(key)) candidates.set(key, url); } catch { /* Caller reports invalid explicit URL. */ }
  }
  const pending = [...candidates.values()];
  const results: NotifierProbe[] = new Array(pending.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(32, pending.length) }, async () => {
    while (next < pending.length) {
      const index = next++;
      results[index] = await probeNotifierEvidence(pending[index]!, fetchImpl);
    }
  }));
  return results;
}

function hubEndpoint(url: string): string {
  const parsed = new URL("/state", url);
  if (["localhost", "[::1]"].includes(parsed.hostname)) parsed.hostname = "127.0.0.1";
  return parsed.href;
}

export function notifierMatches(identity: NotifierIdentity | undefined, root: string, hubUrl: string): boolean {
  try { return identity?.root === root && identity.hubUrl !== undefined && hubEndpoint(identity.hubUrl) === hubEndpoint(hubUrl); }
  catch { return false; }
}

export type NotifierOwnership = "owned" | "unknown-root" | "foreign-workspace" | "unknown-hub-url" | "hub-url-mismatch";

/** Shared ownership classification for doctor and launch-time endpoint selection. */
export function notifierOwnership(identity: NotifierIdentity | undefined, root: string, hubUrl: string): NotifierOwnership {
  if (!identity?.root) return "unknown-root";
  if (identity.root !== root) return "foreign-workspace";
  if (!identity.hubUrl) return "unknown-hub-url";
  return notifierMatches(identity, root, hubUrl) ? "owned" : "hub-url-mismatch";
}

export interface WorkspaceNotifierDiscovery {
  probes: NotifierProbe[];
  owned: NotifierProbe[];
}

/** One ownership proof shared by doctor and manual launch endpoint derivation. */
export async function discoverWorkspaceNotifiers(
  hubUrl: string,
  root: string,
  explicit: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkspaceNotifierDiscovery> {
  const probes = await discoverNotifierEvidence(hubUrl, explicit, fetchImpl);
  const owned = probes.filter(probe => probe.outcome === "signature" && notifierOwnership(probe.identity, root, hubUrl) === "owned");
  return { probes, owned };
}

/** Resolve the sole verified event endpoint for a workspace. Explicit producer
 *  configuration is intentionally returned unchanged, including a foreign URL. */
export async function resolveNotifierEventEndpoint(
  hubUrl: string,
  root: string,
  explicit?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const { probes, owned } = await discoverWorkspaceNotifiers(hubUrl, root, undefined, fetchImpl);
  if (owned.length === 1) return owned[0]!.url;
  if (owned.length > 1) {
    throw new Error(`multiple verified notifier endpoints belong to workspace ${root}: ${owned.map(probe => probe.url).join(", ")}`);
  }

  const signed = probes.filter(probe => probe.outcome === "signature");
  const stale = signed.find(probe => notifierOwnership(probe.identity, root, hubUrl) === "hub-url-mismatch");
  if (stale) throw new Error(`notifier at ${stale.url} reports a different Hub URL (${stale.identity?.hubUrl ?? "unknown"})`);
  const unknown = signed.find(probe => {
    const ownership = notifierOwnership(probe.identity, root, hubUrl);
    return ownership === "unknown-root" || ownership === "unknown-hub-url";
  });
  if (unknown) throw new Error(`notifier at ${unknown.url} has incomplete workspace identity`);
  const foreign = signed.find(probe => notifierOwnership(probe.identity, root, hubUrl) === "foreign-workspace");
  if (foreign) throw new Error(`reachable notifier at ${foreign.url} belongs to another workspace (${foreign.identity?.root ?? "unknown root"})`);
  const occupied = probes.find(probe => probe.outcome === "occupied");
  if (occupied) throw new Error(`candidate ${occupied.url} is occupied but does not answer as a verified Notifier (${occupied.detail})`);
  throw new Error(`no reachable verified notifier endpoint for workspace ${root} via Hub ${hubUrl}`);
}

/** Reuse needs an ownership proof, never an arithmetic port guess or a pane label. */
export async function resolveNotifierPort(hubUrl: string, root: string, requested?: number, fallback = 3002): Promise<number> {
  let inheritedPort: number | undefined;
  try {
    const inherited = new URL(process.env.TUT_EVENT_PORT_URL ?? "");
    if (["127.0.0.1", "localhost", "[::1]"].includes(inherited.hostname)) inheritedPort = Number(inherited.port);
  } catch { /* No event endpoint inherited by this terminal. */ }
  const ports = [...new Set([requested, inheritedPort, fallback, 3002, Number(new URL(hubUrl).port) + 1,
    ...Array.from({ length: 200 }, (_, i) => 3001 + i)].filter((port): port is number => port !== undefined && port > 0 && port <= 65535))];
  const identities = await Promise.all(ports.map(port => probeNotifier(`http://127.0.0.1:${port}/agent-event`)));
  const owned = ports.filter((_, i) => notifierMatches(identities[i], root, hubUrl));
  if (owned.length > 1) throw new Error(`multiple notifiers belong to workspace ${root} (ports ${owned.join(", ")}); stop the duplicate notifiers before rerunning tut up`);
  const existing = owned[0];
  if (existing !== undefined) {
    if (requested !== undefined && requested !== existing) throw new Error(`workspace notifier already listens on port ${existing}; stop it before moving to --event-port ${requested}, or omit --event-port to reuse it`);
    return existing;
  }
  if (identities.some(identity => identity !== undefined && (identity.root === undefined || identity.root === root))) {
    throw new Error("cannot verify notifier ownership or its Hub address; upgrade/restart the existing notifier with the correct --url and --event-port before rerunning tut up (no second notifier started)");
  }
  const selected = requested ?? fallback;
  if (identities[ports.indexOf(selected)] !== undefined) throw new Error(`foreign notifier on event port ${selected}; choose a free --event-port for workspace ${root}`);
  return selected;
}

export async function resolveUpHub(url: string, explicit: boolean, root: string, eventPort?: number, availability = portFree): Promise<{ url: string; eventPort: number }> {
  const identity = await probeHub(url);
  const port = Number(new URL(url).port);
  const event = eventPort ?? (explicit ? 3002 : port + 1);
  if (identity?.root === root) return { url, eventPort: await resolveNotifierPort(url, root, eventPort, event) };
  if (explicit) {
    if (identity) throw mismatch(url, root, identity);
    return { url, eventPort: await resolveNotifierPort(url, root, eventPort, event) };
  }
  const own = await discoverHub(root);
  if (own) return { url: own, eventPort: await resolveNotifierPort(own, root, eventPort, Number(new URL(own).port) + 1) };
  for (const candidate of discoveryUrls) {
    const hubPort = Number(new URL(candidate).port);
    const notifyPort = eventPort ?? hubPort + 1;
    if (hubPort !== notifyPort && await availability(hubPort) && await availability(notifyPort)) {
      return { url: candidate, eventPort: notifyPort };
    }
  }
  throw new Error("No free hub/notifier port pair in 3001–3200. Free a pair and rerun 'tut up', or specify --url and --event-port.");
}
