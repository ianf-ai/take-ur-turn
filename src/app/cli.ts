#!/usr/bin/env node
import './agents.js';
/**
 * `tut` CLI entry — command handlers per subcommand group: the context
 * commands (create/publish/read/list/decide via hub-client over /mcp, plus
 * ack — a thin human wrapper over the same publish path — and status, a human
 * overview over the same hubList); notify wires the Notifier loop.
 *
 * Parser conventions (frozen): every value flag accepts BOTH `--flag value` and
 * `--flag=value`; boolean flags (`--json`) take no value. Flags not declared
 * for the command are "unknown argument" errors. `--url` is the Hub BASE url
 * (default http://127.0.0.1:3001); consumers append their own path. Every
 * hub-client command carries it (optional flag, default
 * DEFAULT_HUB_URL applied in the handler). No deps.
 */

import path from 'node:path';
import { installServiceLog } from '../core/logging/service-log.js';
import { runMcpCommand } from "../core/cli/bridge.js";
import { runAgentAdd, runAgentProbe } from "./cli/agent.js";
import { runAgentSetup } from "./cli/agent-setup.js";
import { runProcessCommand, runResumeCommand } from "../core/cli/run.js";
import { runLiveViewCommand } from "../core/cli/live-view.js";
import { runStats } from "../core/cli/stats.js";
import { resolveNotifierPort, resolveRigRoot, resolveCliHubUrl } from "../hub/rig-discovery.js";
import { DEFAULT_HUB_URL, DEFAULT_EVENT_PORT, type Handler, failWith } from "../core/cli/shared.js";
import { USAGE } from "../core/cli/usage.js";
import { type ParsedArgs, parseArgs } from "../core/cli/args.js";
import { runServe, runMode, runConfig, runUp, runNotifyCommand, runDown } from "./cli/rig.js";
import { runStatus, runRepairMeta, runRecoverRecord, runPrune, runSkill, runInit } from "../core/cli/misc-handlers.js";
import { runDoctor } from "./cli/doctor.js";
import { runStartNext, runLaunch, runWatch, runCreate, runPublish, runRead, runList, runDecide, runAck, runAssign } from "./cli/task.js";
export * from "../core/cli/shared.js";
export * from "../core/cli/usage.js";
export * from "../core/cli/args.js";
export * from "./cli/rig.js";


export const HANDLERS = {
  serve: runServe as Handler<Extract<ParsedArgs, { command: "serve" }>>,
  notify: runNotifyCommand,
  mode: runMode,
  config: runConfig,
  startNext: runStartNext,
  launch: runLaunch,
  watch: runWatch,
  create: runCreate,
  publish: runPublish,
  read: runRead,
  list: runList,
  status: runStatus,
  stats: runStats,
  doctor: runDoctor,
  repairMeta: runRepairMeta,
  recoverRecord: runRecoverRecord,
  prune: runPrune,
  decide: runDecide,
  ack: runAck,
  assign: runAssign,
  up: runUp,
  down: runDown as Handler<Extract<ParsedArgs, { command: "down" }>>,
  skill: runSkill as Handler<Extract<ParsedArgs, { command: "skill" }>>,
  init: runInit as Handler<Extract<ParsedArgs, { command: "init" }>>,
};

/** Runs a parsed invocation; returns the process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "usage") {
    if (parsed.error !== undefined) process.stderr.write(`tut: ${parsed.error}\n`);
    process.stderr.write(USAGE);
    return 1;
  }
  // Resolve before any Hub-consuming handler (including mutations) runs.
  const hubCommands = new Set(["notify", "mode", "start-next", "watch", "create", "publish", "read", "list", "status", "doctor", "repair-meta", "recover-record", "prune", "decide", "ack"]);
  if (hubCommands.has(parsed.command)) {
    const target = parsed as { url?: string; eventPort?: number };
    const hubRoot = resolveRigRoot();
    try {
      const requested = target.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL;
      target.url = await resolveCliHubUrl(requested, argv.some(arg => arg === "--url" || arg.startsWith("--url=")), hubRoot);
      if (parsed.command === "doctor") return runDoctor(parsed, undefined, hubRoot);
      if (parsed.command === "notify" && !argv.some(arg => arg === "--event-port" || arg.startsWith("--event-port="))) {
        target.eventPort = await resolveNotifierPort(target.url, resolveRigRoot(), undefined, target.url === DEFAULT_HUB_URL ? DEFAULT_EVENT_PORT : Number(new URL(target.url).port) + 1);
      }
    } catch (error) {
      if (parsed.command === "doctor") {
        process.stderr.write(`tut: ${(error as Error).message}\n`);
        return runDoctor(parsed, error, hubRoot);
      }
      return failWith(error, target.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL);
    }
  }
  switch (parsed.command) {
    case "agent": return parsed.action === 'add' ? runAgentAdd(parsed.id, 'from' in parsed ? {from:parsed.from} : parsed.binding) : parsed.action === 'setup' ? runAgentSetup(parsed.id, parsed.from) : runAgentProbe(parsed.id);
    case "run": case "ps": case "attach": case "stop": case "repair-run": return runProcessCommand(parsed);
    case "resume": return runResumeCommand(parsed);
    case "live-view": return runLiveViewCommand(parsed);
    case "mcp": return runMcpCommand(DEFAULT_HUB_URL);
    case "serve": return HANDLERS.serve(parsed);
    case "notify": return HANDLERS.notify(parsed);
    case "mode": return HANDLERS.mode(parsed);
    case "config": return HANDLERS.config(parsed);
    case "start-next": return HANDLERS.startNext(parsed);
    case "launch": return HANDLERS.launch(parsed);
    case "watch": return HANDLERS.watch(parsed);
    case "create": return HANDLERS.create(parsed);
    case "publish": return HANDLERS.publish(parsed);
    case "read": return HANDLERS.read(parsed);
    case "list": return HANDLERS.list(parsed);
    case "status": return HANDLERS.status(parsed);
    case "stats": return HANDLERS.stats(parsed);
    case "doctor": return HANDLERS.doctor(parsed);
    case "repair-meta": return HANDLERS.repairMeta(parsed);
    case "recover-record": return HANDLERS.recoverRecord(parsed);
    case "prune": return HANDLERS.prune(parsed);
    case "decide": return HANDLERS.decide(parsed);
    case "ack": return HANDLERS.ack(parsed);
    case "assign": return HANDLERS.assign(parsed);
    case "up": return HANDLERS.up(parsed);
    case "down": return HANDLERS.down(parsed);
    case "skill": return HANDLERS.skill(parsed);
    case "init": return HANDLERS.init(parsed);
  }
}

/** Executable service composition, shared by both supported bin entries. */
export function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  const mirror = !process.env.TUT_POWER_SESSION;
  if (parsed.command === 'serve') installServiceLog(path.resolve(parsed.root), 'power-hub.log', { mirror });
  if (parsed.command === 'notify') installServiceLog(path.join(resolveRigRoot(), '.context-hub'), 'power-notify.log', { mirror });
  return main(argv);
}
