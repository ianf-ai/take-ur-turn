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

/** The existing 405 + Allow: POST contract remains; identity is additive. */
export async function probeNotifier(eventUrl: string): Promise<NotifierIdentity | undefined> {
  try {
    const response = await fetch(eventUrl, {
      signal: AbortSignal.timeout(800), headers: { Connection: "close" }, redirect: "manual",
    });
    if (response.status !== 405 || !(response.headers.get("allow") ?? "").toUpperCase().split(/[\s,]+/).includes("POST")) return undefined;
    const body = await response.json().catch(() => null) as { hub_root?: unknown; hub_url?: unknown } | null;
    if (body && typeof body.hub_root === "string" && path.isAbsolute(body.hub_root) && typeof body.hub_url === "string") {
      return { root: canonicalRoot(body.hub_root), hubUrl: body.hub_url };
    }
    return {};
  } catch { return undefined; }
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
