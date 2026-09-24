#!/usr/bin/env node
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

import { runMcpCommand } from "./cli/bridge.js";
import { resolveNotifierPort, resolveRigRoot, resolveCliHubUrl } from "./hub/rig-discovery.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_HUB_URL, DEFAULT_EVENT_PORT, type Handler, failWith } from "./cli/shared.js";
import { USAGE } from "./cli/usage.js";
import { type ParsedArgs, parseArgs } from "./cli/args.js";
import { runServe, runMode, runConfig, runUp, runNotifyCommand } from "./cli/rig.js";
import { runStatus, runDoctor, runRepairMeta, runRecoverRecord, runSkill, runInit } from "./cli/misc.js";
import { runStartNext, runLaunch, runWatch, runCreate, runPublish, runRead, runList, runDecide, runAck, runAssign } from "./cli/task.js";
export * from "./cli/shared.js";
export * from "./cli/usage.js";
export * from "./cli/args.js";
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
  doctor: runDoctor,
  repairMeta: runRepairMeta,
  recoverRecord: runRecoverRecord,
  decide: runDecide,
  ack: runAck,
  assign: runAssign,
  up: runUp,
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
  const hubCommands = new Set(["notify", "mode", "start-next", "watch", "create", "publish", "read", "list", "status", "doctor", "repair-meta", "recover-record", "decide", "ack"]);
  if (hubCommands.has(parsed.command)) {
    const target = parsed as { url?: string; eventPort?: number };
    const hubRoot = resolveRigRoot();
    try {
      const requested = target.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL;
      target.url = await resolveCliHubUrl(requested, argv.some(arg => arg === "--url" || arg.startsWith("--url=")), hubRoot);
      if (parsed.command === "doctor") return runDoctor(parsed, undefined, hubRoot);
      if (parsed.command === "notify" && !argv.some(arg => arg === "--event-port" || arg.startsWith("--event-port="))) {
        target.eventPort = await resolveNotifierPort(target.url, resolveRigRoot(), undefined, target.url === requested ? DEFAULT_EVENT_PORT : Number(new URL(target.url).port) + 1);
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
    case "doctor": return HANDLERS.doctor(parsed);
    case "repair-meta": return HANDLERS.repairMeta(parsed);
    case "recover-record": return HANDLERS.recoverRecord(parsed);
    case "decide": return HANDLERS.decide(parsed);
    case "ack": return HANDLERS.ack(parsed);
    case "assign": return HANDLERS.assign(parsed);
    case "up": return HANDLERS.up(parsed);
    case "skill": return HANDLERS.skill(parsed);
    case "init": return HANDLERS.init(parsed);
  }
}

// Direct-invocation guard (`node dist/cli.js ...`, or the `tut` bin symlink
// created by `npm link`); imports for tests do not run main. Both sides go
// through realpath: the bin symlink must also fire main, and Node's ESM
// loader may or may not realpath import.meta.url depending on
// --preserve-symlinks — comparing realpaths covers every combination.
const scriptPath = process.argv[1];
function invokedAsScript(): boolean {
  if (scriptPath === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(scriptPath);
  } catch {
    return false;
  }
}
if (invokedAsScript()) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`tut: ${(e as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}