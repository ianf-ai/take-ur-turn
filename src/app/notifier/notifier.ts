import '../agents.js';
/** Stable Notifier API; compose one engine/cache and the two host lanes. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readLaunchMode, readLaunchCatchup } from '../../core/common/config.js';
import { canonicalRoot, resolveRigRoot } from '../../hub/rig-discovery.js';
import { hubRead } from '../../hub/hub-client.js';
import { createChannels } from '../../core/common/channels.js';
import { markLaunched as appendLaunchMarker } from '../../core/launcher/launch.js';
import { HeadlessRuntime, DetachedLane } from '../../standalone/host-entry.js';
import { TuiLane, spawnLaunch, spawnLaunchInvocation, spawnCleanupPanes, relayHostStatus, type Remediator, type DeliveryDiagnostics } from '../../herdr/host-entry.js';
import { NotifierEngine, defaultFetchState, stateUrlOf } from '../../core/notifier/engine.js';
import { NotifierLogCache } from '../../core/notifier/log-cache.js';
import { NotifierNotifications } from '../../core/notifier/notifications.js';
import { createHeadlessRevalidate } from '../../core/notifier/launch-revalidate.js';
import type { NotifyOptions, NotifierLaneContext, AgentEventEndpoint, InteractiveLanePort } from '../../core/notifier/shared-contracts.js';
import type { AgentEvent, HerdrLaneContext, HerdrNotifierDeps } from '../../herdr/notifier/contracts.js';
import type { StandaloneLaneContext, StandaloneNotifierDeps } from '../../standalone/notifier/contracts.js';
import type { LegacyNotifierDeps } from './compat-contracts.js';
import { createInteractiveLanePort } from '../../herdr/notifier/interactive-port.js';
import { createAgentEventEndpoint } from '../../herdr/notifier/agent-event-endpoint.js';
export type { NotifyOptions, StateTask, StateAuto, StateResponse } from '../../core/notifier/shared-contracts.js';
export type { AgentEvent, PaneSnapshot, RoutingMaps } from '../../herdr/notifier/contracts.js';
export { createHeadlessRevalidate } from '../../core/notifier/launch-revalidate.js';
export { spawnLaunch, spawnLaunchInvocation, spawnCleanupPanes, defaultLoadRouting } from '../../herdr/host-entry.js';
export interface NotifierDeps extends LegacyNotifierDeps<HeadlessRuntime, Remediator, DeliveryDiagnostics> { }

function defaultLog(line: string): void {
  process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
}

// --- loopback Host guard (mirrors src/http.ts) -------------------------------------
// Duplicated rather than imported: http.ts is a Hub-side module and the
// notifier must stay an independent consumer.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostHostname(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
    return host.slice(0, colon);
  }
  return host;
}

function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (host === undefined) return true; // HTTP/1.0-style clients tolerated (same as http.ts)
  return LOOPBACK_HOSTS.has(hostHostname(host.toLowerCase()));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const EVENT_BODY_LIMIT = 64 * 1024;

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error(`body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export class Notifier {
  private readonly rigRoot = resolveRigRoot();
  private readonly stateUrl: string;
  private readonly eventPort: number;
  private server: Server | null = null;
  private readonly engine: NotifierEngine;
  private readonly logs: NotifierLogCache;
  private readonly notifications: NotifierNotifications;
  private readonly tui: TuiLane;
  private readonly detached: DetachedLane;
  private readonly interactive: InteractiveLanePort;
  private readonly agentEvents: AgentEventEndpoint;

  constructor(options: NotifyOptions, deps: Partial<NotifierDeps> = {}) {
    // Freeze constructor inputs just as the original scalar fields did.
    options = { ...options };
    this.stateUrl = stateUrlOf(options.url);
    this.eventPort = options.eventPort;
    const launchModeReader = deps.readLaunchMode ?? readLaunchMode;
    const fetchState = deps.fetchState ?? defaultFetchState;
    const now = deps.now ?? (() => Date.now());
    const log = deps.log ?? defaultLog;
    this.logs = new NotifierLogCache(options.url, deps);
    this.notifications = new NotifierNotifications(Math.max(0, options.stallTimeoutMin) * 60_000,
      { now, log: line => log(`tut: notify: ${line}`), channelsFor: deps.channelsFor ?? createChannels });
    const facade = this;
    const context: NotifierLaneContext = {
      get snapshot() { return facade.engine.snapshot; },
      log: line => this.log(line), sendAll: msg => this.notifications.sendAll(msg),
      fullLog: (taskId, entry) => this.logs.fullLog(taskId, entry),
      signals: {
        refresh: () => this.requestCompare(),
        progress: signal => this.notifications.markProgress(signal.task_id, signal.observed_at),
      },
      autoLaunchFailed: (task, role, error) => this.engine.autoLaunchFailed(task, role, error),
      autoLaunchSkipped: (task, role, version) => this.engine.autoLaunchSkipped(task, role, version),
      deferNoteWake: (task, wake, reason) => this.engine.deferNoteWake(task, wake, reason),
      awaitTaskArchive: taskId => this.interactive.awaitTaskArchive(taskId),
      autoGateReason: task => this.engine.autoGateReason(task),
      autoLaunch: (task, role, wake) => this.engine.autoLaunch(task, role, wake),
    };
    const canonicalLaunch = deps.launchInvocation ?? (deps.launch === undefined ? spawnLaunchInvocation : undefined);
    const herdrContext: HerdrLaneContext = {
      get snapshot() { return context.snapshot; },
      log: context.log, sendAll: context.sendAll, fullLog: context.fullLog,
      requestCompare: () => context.signals.refresh({ kind: 'refresh' }),
      markProgress: (task_id, observed_at) => context.signals.progress({ kind: 'progress', task_id, observed_at }),
      autoLaunchFailed: context.autoLaunchFailed, autoLaunchSkipped: context.autoLaunchSkipped,
      deferNoteWake: context.deferNoteWake,
    };
    const standaloneContext: StandaloneLaneContext = {
      log: context.log, fullLog: context.fullLog,
      awaitSweepBarrier: taskId => context.awaitTaskArchive(taskId),
      autoLaunchFailed: context.autoLaunchFailed, autoLaunchSkipped: context.autoLaunchSkipped,
      autoGateReason: context.autoGateReason, autoLaunch: context.autoLaunch,
    };
    const resolvedReadLog = (taskId: string) => this.logs.readLog(taskId);
    const herdrDeps = {
      fetchState, now,
      ...(deps.resolveTarget === undefined ? {} : { resolveTarget: deps.resolveTarget }),
      ...(deps.resolveTargetWithSource === undefined ? {} : { resolveTargetWithSource: deps.resolveTargetWithSource }),
      ...(deps.loadRouting === undefined ? {} : { loadRouting: deps.loadRouting }),
      ...(deps.listPanes === undefined ? {} : { listPanes: deps.listPanes }),
      ...(deps.listAnchorPanes === undefined ? {} : { listAnchorPanes: deps.listAnchorPanes }),
      ...(deps.readPane === undefined ? {} : { readPane: deps.readPane }),
      ...(deps.remediator === undefined ? {} : { remediator: deps.remediator }),
      ...(deps.remediationAudit === undefined ? {} : { remediationAudit: deps.remediationAudit }),
      launch: deps.launch ?? spawnLaunch,
      cleanupPanes: deps.cleanupPanes ?? (taskId => spawnCleanupPanes(taskId, { ...process.env, TUT_HUB_ROOT: this.rigRoot })),
      relayHostStatus: deps.relayHostStatus ?? relayHostStatus,
      ...(canonicalLaunch === undefined ? {} : { launchInvocation: canonicalLaunch }),
      markLaunched: deps.markLaunched ?? ((taskId, role, baseVersion, via, projection) => appendLaunchMarker(options.url, taskId, role, baseVersion, via, projection)),
    } satisfies HerdrNotifierDeps<Remediator, DeliveryDiagnostics> & Pick<NotifierDeps, 'fetchState' | 'now' | 'markLaunched'>;
    this.tui = new TuiLane(options, this.rigRoot, herdrContext, herdrDeps, launchModeReader);
    this.interactive = createInteractiveLanePort(this.tui);
    this.agentEvents = createAgentEventEndpoint(event => this.receiveEvent(event), line => this.log(line));
    const standaloneDeps: StandaloneNotifierDeps<HeadlessRuntime> = deps;
    const runtime = standaloneDeps.headlessRuntime ?? new HeadlessRuntime(this.rigRoot, {
      send: msg => this.notifications.sendAll(msg), log: line => this.log(line), read: task => this.logs.readLog(task),
      hubUrl: options.url, now,
      revalidate: createHeadlessRevalidate({ stateUrl: this.stateUrl, fetchState, readLog: taskId => this.logs.fullLog(taskId) }),
    });
    this.detached = new DetachedLane(options, this.rigRoot, standaloneContext, { now, readLog: resolvedReadLog }, runtime, launchModeReader,
      standaloneDeps.readLaunchCatchup ?? readLaunchCatchup,
      standaloneDeps.readTaskDescription ?? (async taskId => (await hubRead(options.url, taskId)).description));
    this.engine = new NotifierEngine(options, this.rigRoot, { fetchState, now, log }, launchModeReader, this.logs, this.notifications, this.interactive, this.detached);
  }
  private log(line: string): void { this.engine.log(line); }
  requestCompare(): Promise<void> { return this.engine.requestCompare(); }
  receiveEvent(evt: AgentEvent): void { this.tui.receiveEvent(evt); }
  startPolling(): void { this.engine.startPolling(); }
  async close(): Promise<void> {
    this.engine.close(); this.tui.close(); this.detached.close(); this.notifications.close();
    await this.logs.close();
    const server = this.server; this.server = null;
    if (server !== null) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  // --- event HTTP listener (loopback Host guard mirrors src/http.ts) ---------------

  async startEventServer(): Promise<void> {
    if (this.server !== null) return;
    const server = createServer((req, res) => {
      void this.handleEventRequest(req, res).catch((e: unknown) => {
        this.log(`event request failed: ${(e as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        if (!res.writableEnded) res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onListenError = (e: Error): void => {
        const code = (e as NodeJS.ErrnoException).code;
        // Listener conflicts are fatal and surfaced in service diagnostics.
        reject(new Error(`cannot listen on 127.0.0.1:${this.eventPort}: ${code !== undefined ? `${code} — ` : ""}${e.message}`));
      };
      server.once("error", onListenError);
      server.listen(this.eventPort, "127.0.0.1", () => {
        server.off("error", onListenError);
        server.on("error", (e) => this.log(`event listener error: ${(e as Error).message}`));
        resolve();
      });
    });
    this.server = server;
    this.log(`listening for agent events on http://127.0.0.1:${this.eventPort}/agent-event`);
  }

  private async handleEventRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackHost(req)) {
      sendJson(res, 403, { error: "forbidden: Host header must be a loopback host" });
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/agent-event") {
      sendJson(res, 404, { error: `not found: ${req.method} ${pathname}` });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed: use POST /agent-event", hub_root: canonicalRoot(this.rigRoot), hub_url: this.stateUrl.replace(/\/state$/, "") }));
      return;
    }
    const raw = await readBody(req, EVENT_BODY_LIMIT);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log("ignoring event with invalid JSON body");
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }
    const result = this.agentEvents.accept(parsed);
    sendJson(res, result.status, result.body);
  }
}

// --- daemon entry -------------------------------------------------------------------

/**
 * `tut notify` daemon: starts the event listener first (EADDRINUSE rejects —
 * caller reports the failure on stderr and exits non-zero), then the
 * poll loop, then parks until SIGINT/SIGTERM.
 */
export async function runNotify(options: NotifyOptions): Promise<void> {
  const notifier = new Notifier(options);
  await notifier.startEventServer();
  notifier.startPolling();
  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      void notifier.close().then(
        () => resolve(),
        () => resolve(),
      );
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
