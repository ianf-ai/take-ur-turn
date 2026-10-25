import { discoverHub, resolveNotifierPort, resolveUpHub } from "../../core/hub/rig-discovery.js";
import { acquireRigStartLock } from "../../core/hub/rig-lock.js";
import { rigLabel, rigEnvironment, unscopedLabel } from "../../core/hub/rig.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPaneCommand, resolvePaneShellDialect, type PaneCommand, type ShellDialect } from "../launcher/shell-renderer.js";
import { HerdrClient, type HerdrPane as HerdrClientPane } from "../launcher/legacy-herdr-client.js";
import { defaultUserConfigDir } from "../../core/common/workspace.js";
import { provisionUsageWatcher } from "../../core/common/usage-watcher.js";
import { DEFAULT_HUB_URL, DEFAULT_EVENT_PORT, DEFAULT_HUB_PORT } from "../../core/cli/shared.js";
import type { ParsedArgs } from "../../core/cli/args.js";
import { UP_EVENT_URL, UP_POLL_INTERVAL_MS, eventPortUrl, hubWaitMs, notifyWaitMs, pollUntil, hubHealthy, notifyHealthy, projectInvariantsState, printInvariantsHint, upHubPort, upUrlError, printActivationHint } from "../../core/cli/rig-support.js";

// --- tut up ---------------------------------------------------------------------
// Herdr integration. Real CLI syntax verified live:
//   herdr pane list
//     → {"id":"cli:pane:list","result":{"panes":[{"pane_id","label",...}],...}}
//   herdr pane split --current --direction right --no-focus --cwd <dir>
//     → {"result":{"pane":{"pane_id":"w9:p2",...}}} — the NEW pane, no title arg
//   herdr pane rename <pane_id> <label>   → ok JSON (label via positional)
//   herdr pane run <pane_id> <command...> → types the command into the pane's
//     shell (single arg with && chains works, launch.sh's convention)
//   herdr tab create --label <t> --no-focus [--cwd <dir>]
//     → {"result":{"tab":{"tab_id",...},"root_pane":{"pane_id",...},"type":"tab_created"}}
//     — ships an EMPTY root pane (live-verified on herdr 0.8): close it
//     after moving panes in
//   herdr pane move <id> --tab <t> --split down --ratio 0.5 [--target-pane <id>] --no-focus
//   herdr pane close <id> → {"result":{"type":"ok"}}

/**
 * The dedicated tab hosting the two system panes,
 * and the pane labels that make them idempotently discoverable. Sys panes
 * are exempt from role→pane routing — these labels are
 * NOT agent names, so agent-keyed lookup never hits them.
 */
const SYS_TAB_LABEL = "tut-sys";

const herdrClient = new HerdrClient();

type HerdrPane = HerdrClientPane;

/**
 * `herdr pane list` → pane snapshot. A missing binary or failing call returns
 * { error } — that is the degradation trigger: without pane control tut up
 * prints manual commands instead of ever spawning hidden background processes.
 */
export async function herdrPaneList(): Promise<{ panes: HerdrPane[] } | { error: string }> {
  try {
    return await herdrClient.paneList();
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** `herdr pane split` off the current pane (no-focus, same window) → new pane id. */
async function herdrSplit(cwd: string, environment: Readonly<Record<string, string>> = {}): Promise<string | { error: string }> {
  try {
    return (await herdrClient.paneSplit({ current: true, direction: "right", noFocus: true, cwd, env: environment })).paneId;
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * `herdr tab create --label tut-sys --no-focus` → the new tab's id plus the
 * EMPTY root pane it ships (live-verified shape on herdr 0.8). The root
 * pane id is optional in the return: a shape drift that omits it only costs
 * the cosmetic cleanup close, not the provisioning itself.
 */
async function herdrTabCreate(cwd: string, workspaceId?: string): Promise<{ tabId: string; rootPaneId?: string } | { error: string }> {
  try {
    return await herdrClient.tabCreate({ label: SYS_TAB_LABEL, noFocus: true, cwd, ...(workspaceId !== undefined ? { workspaceId } : {}) });
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Rename/run panes ops: exit-code check, herdr's stderr forwarded on failure. */
async function herdrOk(args: string[]): Promise<boolean> {
  const run = await herdrClient.command(args);
  if (run.error !== undefined) {
    process.stderr.write(`tut: up: herdr ${args[1] ?? ""} failed to spawn: ${run.error.message}\n`);
    return false;
  }
  if (run.code !== 0 && run.stderr.length > 0) {
    process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);
  }
  return run.code === 0;
}

/**
 * Explain the common headless-up failure: Herdr's `--current` split needs
 * either an interactive pane context or an explicit, valid pane id.
 * Include the configured value when present so an invalid id is actionable.
 */
function printHerdrAnchorHint(): void {
  const configured = process.env.HERDR_PANE_ID?.trim();
  const state = configured === undefined || configured.length === 0
    ? "unset/empty"
    : `'${configured}' (verify that it is valid)`;
  process.stderr.write(
    `tut: up: Herdr anchor unavailable — run up inside an interactive Herdr pane, or set HERDR_PANE_ID to a valid pane id (currently ${state})\n`,
  );
  process.stderr.write(
    "tut: up: to run the rig without herdr at all: tut config set power.mode standalone (up then raises detached services; tut down stops them)\n",
  );
}

/**
 * The pane id to REPORT for a system pane, resolved fresh by label at
 * report time. Pane ids are window-scoped — a pane moved into the sys
 * tab's window is re-addressed (w1G:p2 → w1H:p2), so both the entry
 * snapshot and the split-time id can be stale by the moment we print
 * them. The label (set moments earlier by pane rename, or discovered by
 * the snapshot in the reuse path) is the stable addressing key; a fresh
 * pane list resolves it to the CURRENT id. Falls back to the
 * provisioning-time id when the fresh list is unusable or misses — the
 * report must never fail the provisioning.
 */
async function reportedPaneId(label: string, fallback: string): Promise<string> {
  const listing = await herdrPaneList();
  if ("panes" in listing) {
    const hit = listing.panes.find((p) => p.label === label);
    if (hit !== undefined) return hit.pane_id;
  }
  return fallback;
}

/**
 * tut up [--dry-run]: idempotent
 * provisioning of the power switch ONLY — hub + notify panes, raised into a
 * dedicated tut-sys tab (two log-style panes sharing one tab, split even via
 * explicit --ratio 0.5) instead of tiling the user's current tab. Role/agent
 * panes are raised on demand by launch.sh at hand-off.
 * 0. dev-layout guard: running from src/ means the pane commands would embed a
 *    non-runnable `node src/cli.ts` — build first (no tsx dependency);
 * 0b. cwd guardrail (package.json or .context-hub/ required);
 * 0c. event-port pre-flight: both event-port probes (moved-port
 *     coexistence + the provisioning target) run BEFORE any provisioning,
 *     memoized for step 2; the known-occupied reuse shape (moved port down,
 *     live default-port notifier, labelled tut-notify pane) refuses up
 *     front — exit 1 without touching any pane;
 * 1. hub: /state root handshake → skip, or provision and WAIT for /state to turn
 *    healthy (spawn success ≠ serving);
 * 1b. project hint: empty scope → one startup explanation; existing records
 *     without an invariants seed → publish hint (reads only, dry-run included);
 * 2. notify: /agent-event 405+Allow:POST probe (pre-flighted) → skip, or
 *     provision and WAIT for the event port to answer (pane run into an
 *     occupied pane is a silent no-op — spawn success ≠ listening, the
 *     same discipline as the hub's /state wait);
 * Per-pane idempotency ladder: healthy skip (upstream probe) → dead-pane
 * reuse (labelled pane in the snapshot: rerun the command in place, never a
 * second split) → full provisioning (split → ensure tut-sys tab → move
 * --ratio 0.5 → close the tab's empty root when we created it → rename →
 * run). --dry-run prints the full plan (reads still happen: probes + pane
 * list). No usable Herdr → manual command list for whatever is down, roles
 * skipped, exit 0 — never a hidden background process.
 */

export async function runHerdrUp(parsed: Extract<ParsedArgs, { command: "up" }>, cwd: string, self: string): Promise<number> {
  const dryRun = parsed.dryRun;
  process.stdout.write(`up: expected host relay label: ${rigLabel("tut-host", cwd)} (host_pane_label)\n`);
  const SYS_HUB_PANE_LABEL = rigLabel("tut-hub", cwd);
  const SYS_NOTIFY_PANE_LABEL = rigLabel("tut-notify", cwd);

  // --url selects the hub to provision. up provisions a LOCAL hub — the
  // host must be loopback and the port explicit (serve needs a concrete port
  // to bind). Validated before any probe, spawn, or pane read.
  let hubUrl = parsed.url ?? process.env.TUT_HUB_URL ?? DEFAULT_HUB_URL;
  let hubPort: number;
  try {
    hubPort = upHubPort(hubUrl);
  } catch {
    process.stderr.write(upUrlError(hubUrl));
    return 1;
  }

  // --event-port moves the notifier's event listener; probe, provisioning,
  // and the rendered notify command all use this one value.
  let eventPort = parsed.eventPort ?? DEFAULT_EVENT_PORT;
  let eventUrl = eventPortUrl(eventPort);

  // Port-conflict pre-check: the hub and the notifier's event
  // listener cannot share a port — serve would bind it and the provisioned
  // notify would die with EADDRINUSE while up still reported success
  // (`up --url :3002` used to be up's OWN error example). Refused before any
  // probe, spawn, or pane read, with non-colliding examples.
  if (hubPort === eventPort) {
    process.stderr.write(
      `tut: up: the hub port and the notifier event port are both ${eventPort} — they cannot share one port (the hub binds it; notify would die with EADDRINUSE); use a different hub port (e.g. --url http://127.0.0.1:3011) or move the event port (e.g. --event-port 3005)\n`,
    );
    return 1;
  }

  // Dev-layout fix: a src-layout self would provision panes running
  // `node src/cli.ts …` (TypeScript — not directly runnable). Fail BEFORE any
  // probe, spawn, or side effect; building is the user's one-step remedy.
  // Judge by the self file's PARENT directory (dist layout ⇒ "dist"), not by
  // any path segment — a repo checked out under ~/src/TUT must not trip this.
  if (path.basename(path.dirname(self)) === "src") {
    process.stderr.write(
      "tut up: running from src layout — run `npm run build` first (dist/cli.js is the provision target); " +
        "or set TUT_UP_CLI_SELF to a dist-style path\n",
    );
    return 1;
  }

  if (!existsSync(path.join(cwd, "package.json")) && !existsSync(path.join(cwd, ".context-hub"))) {
    process.stderr.write(
      `tut: up: no package.json or .context-hub/ in ${cwd} — not a TUT project yet: run 'tut init' here to onboard (creates .context-hub/ and the AGENTS.md block), or cd to the project root and run tut up there\n`,
    );
    return 1;
  }

  let releaseLock: (() => void) | undefined;
  try {
    if (!dryRun && parsed.url === undefined) releaseLock = acquireRigStartLock(cwd);
    try {
      let selected = await resolveUpHub(hubUrl, parsed.url !== undefined, cwd, parsed.eventPort);
      if (parsed.url === undefined) {
        const own = await discoverHub(cwd);
        if (own) {
          selected = { url: own, eventPort: await resolveNotifierPort(own, cwd, parsed.eventPort, Number(new URL(own).port) + 1) };
          process.stdout.write(`up: ownership check found hub for workspace ${cwd} at ${own}; reusing existing rig\n`);
        }
      }
      hubUrl = selected.url;
      hubPort = Number(new URL(hubUrl).port);
      eventPort = selected.eventPort;
      eventUrl = eventPortUrl(eventPort);
      if (hubPort === eventPort) {
        throw new Error(`hub port and notifier event port are both ${eventPort}; choose a different --event-port and rerun tut up`);
      }
    } catch (error) {
      process.stderr.write(`tut: up: ${(error as Error).message}\n`);
      return 1;
    }

    // Workspace-lineup hint (a PROMPT, never a write — configs are human
    // declarations, the same discipline as the invariants seed hint): both
    // the project-level and user-level workspace configs missing → the
    // built-in defaults are in effect; print the migration pointer once.
    if (
      !existsSync(path.join(cwd, ".context-hub", "workspace.json")) &&
      !existsSync(path.join(defaultUserConfigDir(), "workspace.json"))
    ) {
      process.stdout.write(
        "up: no workspace lineup config found — using built-in defaults (architect=codex, executor=pi, reviewer=codex)\n",
      );
      process.stdout.write(
        "up:   to customize: tut assign <role> <agent>   (the light path — e.g. tut assign executor pi; rewrites one seat)\n",
      );
      process.stdout.write(
        `up:   full control: see README.md → Configuration → Workspace lineup (https://github.com/ianf-ai/take-ur-turn#configuration); save your config to ${path.join(cwd, ".context-hub", "workspace.json")} (project-level; or ${path.join(defaultUserConfigDir(), "workspace.json")} for all projects)\n`,
      );
    }

    // The selected endpoints must reach both provisioned panes: serve binds
    // the parsed port, notify polls it, and descendants inherit the rig.
    //
    // The service commands are PaneCommands now, rendered by the same dialect
    // renderer the agent panes use: POSIX exports one-shot assignments;
    // PowerShell and cmd carry the environment in a runner payload. The dialect resolves
    // BEFORE any probe so a bad TUT_PANE_SHELL fails the whole up run.
    let dialect: ShellDialect;
    try {
      dialect = resolvePaneShellDialect(process.env);
    } catch (error) {
      process.stderr.write(`tut: up: ${(error as Error).message}\n`);
      return 1;
    }
    // Windows carries the absolute node.exe the cmd/PowerShell forms quote;
    // POSIX keeps the bare PATH-resolved `node` word of the legacy bytes.
    const nodeWord = process.platform === "win32" ? process.execPath : "node";
    const renderServiceCommand = (args: readonly string[], env: Readonly<Record<string, string>> = {}): string =>
      renderPaneCommand({
        cwd,
        executable: nodeWord,
        args: [...args],
        env: { ...rigEnvironment(cwd, hubUrl, eventUrl), ...env },
        dialect,
        purpose: "service",
      } as PaneCommand).command_text;
    let serveCmd: string;
    let notifyCmd: string;
    try {
      serveCmd = renderServiceCommand([self, "serve", ...(hubPort === DEFAULT_HUB_PORT ? [] : ["--port", String(hubPort)])]);
      // Full-chain pass-through: a non-default event port rides the
      // rendered notify command explicitly (the provisioned notifier cannot
      // drift back to the default), and TUT_EVENT_PORT_URL is exported into the
      // pane so every launcher the notifier spawns (auto mode) escalates
      // give-up events to the port that notifier actually listens on. Defaults
      // use the same explicit rig environment (only the redundant flag is omitted).
      notifyCmd =
        eventPort === DEFAULT_EVENT_PORT
          ? renderServiceCommand([self, "notify", ...(hubPort === DEFAULT_HUB_PORT ? [] : ["--url", hubUrl])])
          : renderServiceCommand(
              [self, "notify", ...(hubPort === DEFAULT_HUB_PORT ? [] : ["--url", hubUrl]), "--event-port", String(eventPort)],
              { TUT_EVENT_PORT_URL: eventUrl },
            );
    } catch (error) {
      process.stderr.write(`tut: up: cannot render the service pane command: ${(error as Error).message}\n`);
      return 1;
    }
    const manual: string[] = [];

    // Herdr usability + the role-step pane snapshot in one read.
    const listing = await herdrPaneList();
    const panes = "panes" in listing ? listing.panes : null;
    const herdrError = "error" in listing ? listing.error : "";

    // Event-port pre-flight: both event-port probes run
    // BEFORE any provisioning and their results are memoized for step 2 — no
    // URL is probed twice. The known-occupied shape refuses up front: a moved
    // event port that is down while the default-port notifier is still alive
    // AND a labelled tut-notify pane exists. provisionSysPane would take that
    // pane for dead and `pane run` into it — but a pane still hosting the
    // running notifier cannot start a second process; herdr reports ok and up
    // would print "notify running" over a dead provisioning (false success).
    // Refuse WITHOUT touching any pane (fail fast, before even the hub step):
    // non-zero exit + actionable stop-first remedy. A target that already
    // answers never reaches this refusal; the shapes the pre-flight cannot
    // see (occupant on a non-default port) are caught by step 2's probe gate.
    const oldNotifierAlive = eventPort !== DEFAULT_EVENT_PORT && (await notifyHealthy(UP_EVENT_URL, cwd, hubUrl));
    const targetListening = await notifyHealthy(eventUrl, cwd, hubUrl);
    if (oldNotifierAlive && !targetListening) {
      const occupied = panes?.find((p) => p.label === SYS_NOTIFY_PANE_LABEL);
      if (occupied !== undefined) {
        process.stderr.write(
          `tut: up: cannot start the notifier on ${eventUrl} — another notifier is still listening on ${UP_EVENT_URL} and the ${SYS_NOTIFY_PANE_LABEL} pane (${occupied.pane_id}) is the reuse candidate; pane run into a still-occupied pane cannot start a second process. Stop the old pane first (herdr pane close ${occupied.pane_id}), or drop --event-port to keep the existing notifier, then rerun tut up\n`,
        );
        return 1;
      }
    }

    // C-layout sys-tab state, shared across the two provisioning steps: the
    // discovered/created tut-sys tab plus its anchor pane (the move --target).
    // Discovery rides the same pane-list snapshot — a labelled sys pane carries
    // its tab_id, so no `herdr tab list` (unobserved shape) is ever needed.
    let sysTab: { tabId: string; anchorPane?: string; rootPaneId?: string; fresh: boolean } | null = null;
    if (panes !== null) {
      const anchor =
        panes.find((p) => p.label === SYS_HUB_PANE_LABEL) ?? panes.find((p) => p.label === SYS_NOTIFY_PANE_LABEL);
      if (anchor !== undefined && anchor.tab_id !== undefined) {
        sysTab = { tabId: anchor.tab_id, anchorPane: anchor.pane_id, fresh: false };
      }
    }

    /**
     * Provision one system pane (hub/notify) into the tut-sys tab. Ladder:
     * labelled pane in the snapshot = dead pane → rerun in place (no split, no
     * tab work); otherwise split → ensure the tab → move (--split down
     * --ratio 0.5, even halves) → close the tab's empty root (only when we
     * created the tab this run) → rename → run. Returns the running pane id,
     * or null with the failure already printed.
     *
     * The label⇒dead assumption is guarded, not blind: a snapshot cannot tell
     * an occupied pane from a dead one. For notify, the up pre-flight refuses
     * the known-occupied shape outright and the post-run event-port probe
     * gates the success report — a `pane run` that lands in a live foreground
     * process is swallowed while herdr still reports ok.
     */
    const provisionSysPane = async (
      label: string,
      name: string,
      cmd: string,
    ): Promise<{ paneId: string; reused: boolean } | null> => {
      const dead = panes?.find((p) => p.label === label);
      if (dead !== undefined) {
        if (dryRun) {
          process.stdout.write(`up: [dry-run] would reuse pane ${dead.pane_id} (label ${label}) and run: ${cmd}\n`);
          return { paneId: dead.pane_id, reused: true };
        }
        if (!(await herdrOk(["pane", "run", dead.pane_id, cmd]))) {
          process.stderr.write(`tut: up: could not start ${name} in pane ${dead.pane_id}\n`);
          return null;
        }
        return { paneId: dead.pane_id, reused: true };
      }
      if (dryRun) {
        const freshTab = sysTab === null;
        const tabId = sysTab === null ? "<new-tab>" : sysTab.tabId;
        process.stdout.write(`up: [dry-run] would provision the ${label} pane into tab ${SYS_TAB_LABEL}:\n`);
        process.stdout.write(`up: [dry-run]   pane split --current --direction right --no-focus --cwd ${cwd}\n`);
        if (freshTab) {
          process.stdout.write(`up: [dry-run]   tab create --label ${SYS_TAB_LABEL} --no-focus --cwd ${cwd}\n`);
        }
        const move = `up: [dry-run]   pane move <new-pane> --tab ${tabId} --split down --ratio 0.5 --no-focus`;
        process.stdout.write(
          sysTab?.anchorPane !== undefined ? `${move} --target-pane ${sysTab.anchorPane}\n` : `${move}\n`,
        );
        if (freshTab) {
          process.stdout.write(`up: [dry-run]   pane close <root-pane>   (tab create ships an empty root pane)\n`);
        }
        process.stdout.write(`up: [dry-run]   pane rename <new-pane> ${label}\n`);
        process.stdout.write(`up: [dry-run]   pane run <new-pane> ${cmd}\n`);
        // Plan-level state so the notify plan targets the (planned) hub pane
        // and omits its own tab create/close lines.
        if (sysTab === null) {
          sysTab = { tabId, ...(label === SYS_HUB_PANE_LABEL ? { anchorPane: "<tut-hub-pane>" } : {}), fresh: true };
        } else if (sysTab.anchorPane === undefined && label === SYS_HUB_PANE_LABEL) {
          sysTab.anchorPane = "<tut-hub-pane>";
        }
        return { paneId: "<new-pane>", reused: false };
      }
      const pane = await herdrSplit(cwd, rigEnvironment(cwd, hubUrl, eventUrl));
      if (typeof pane !== "string") {
        process.stderr.write(`tut: up: ${pane.error}\n`);
        printHerdrAnchorHint();
        return null;
      }
      if (sysTab === null) {
        const anchorWorkspace = panes?.find((p) => p.pane_id === (process.env.HERDR_PANE_ID ?? "").trim())?.workspace_id?.trim() || undefined;
        if (anchorWorkspace === undefined) {
          process.stderr.write("tut: up: tut-sys workspace pinning unavailable (HERDR_PANE_ID missing or unresolved); tab creation falls back to the focused workspace\n");
        }
        const tab = await herdrTabCreate(cwd, anchorWorkspace);
        if ("error" in tab) {
          process.stderr.write(`tut: up: ${tab.error}\n`);
          return null;
        }
        sysTab = { tabId: tab.tabId, ...(tab.rootPaneId !== undefined ? { rootPaneId: tab.rootPaneId } : {}), fresh: true };
      }
      const moveArgs = ["pane", "move", pane, "--tab", sysTab.tabId, "--split", "down", "--ratio", "0.5", "--no-focus"];
      if (sysTab.anchorPane !== undefined) moveArgs.push("--target-pane", sysTab.anchorPane);
      if (!(await herdrOk(moveArgs))) {
        process.stderr.write(
          `tut: up: could not move pane ${pane} into tab ${SYS_TAB_LABEL} — orphan pane left in the current tab; clean up manually: herdr pane close ${pane}\n`,
        );
        printHerdrAnchorHint();
        return null;
      }
      sysTab.anchorPane = pane; // the next sys pane splits THIS pane (--ratio 0.5 → even halves)
      if (sysTab.fresh && sysTab.rootPaneId !== undefined) {
        // Empty-root cleanup, only for a tab created this run. Non-fatal: a
        // leftover empty pane is cosmetic (herdr's stderr is forwarded by herdrOk).
        await herdrOk(["pane", "close", sysTab.rootPaneId]);
        sysTab.fresh = false;
      }
      if (!(await herdrOk(["pane", "rename", pane, label]))) {
        process.stderr.write(`tut: up: could not label pane ${pane} as ${label} — rediscovery depends on it\n`);
        return null;
      }
      if (!(await herdrOk(["pane", "run", pane, cmd]))) {
        process.stderr.write(`tut: up: could not start ${name} in pane ${pane}\n`);
        return null;
      }
      return { paneId: pane, reused: false };
    };

    // Step 1 — hub.
    let hubUp = false;
    if (await hubHealthy(hubUrl, cwd)) {
      hubUp = true;
      process.stdout.write(`up: hub already running (${hubUrl}/state)\n`);
    } else if (panes === null) {
      manual.push(serveCmd);
    } else {
      const provisioned = await provisionSysPane(SYS_HUB_PANE_LABEL, "serve", serveCmd);
      if (provisioned === null) return 1;
      if (!dryRun) {
        const startedAt = Date.now();
        const waitMs = hubWaitMs();
        if (!(await pollUntil(() => hubHealthy(hubUrl, cwd), waitMs, UP_POLL_INTERVAL_MS))) {
          process.stderr.write(
            `tut: up: serve pane ${provisioned.paneId} started but ${hubUrl}/state stayed unhealthy for ${waitMs}ms — check the pane\n`,
          );
          return 1;
        }
        hubUp = true;
        process.stdout.write(
          `up: hub serving on ${hubUrl} (pane ${await reportedPaneId(SYS_HUB_PANE_LABEL, provisioned.paneId)}, tab ${SYS_TAB_LABEL}${provisioned.reused ? ", reused" : ""}, waited ${Date.now() - startedAt}ms)\n`,
        );
      }
    }

    // Step 1b — seed hint (hub reachable only; the read is allowed in dry-run).
    if (hubUp) {
      const projectState = await projectInvariantsState(hubUrl);
      if (projectState === "empty" && !targetListening) {
        // The existing notifier probe bounds this explanation to startup.
        // Repeated up calls during subsequent rounds stay silent, including
        // across CLI processes; no synthetic project record is needed.
        process.stdout.write("up: project scope is empty — this is normal; executors can start from the task description.\n");
      } else if (projectState === "unseeded") {
        printInvariantsHint(hubUrl);
      }
    }

    // Step 2 — notifier. The probes already ran in the pre-flight (memoized):
    // the double-notifier warning rides oldNotifierAlive, the skip rides
    // targetListening. Fresh-pane provisioning may continue past the warning
    // — the stale notifier is the user's to stop; up never kills panes it does
    // not own (the reuse-on-top-of-it shape was refused up front instead).
    if (oldNotifierAlive && panes?.some((p) => p.label === SYS_NOTIFY_PANE_LABEL)) {
      process.stderr.write(
        `tut: up: another notifier is already listening on ${UP_EVENT_URL} — provisioning ${eventUrl} would leave two notifiers running; stop the old pane (label ${SYS_NOTIFY_PANE_LABEL}) or drop --event-port to reuse it\n`,
      );
    }
    if (targetListening) {
      process.stdout.write(`up: notify already listening (${eventUrl})\n`);
    } else if (panes === null) {
      manual.push(notifyCmd);
    } else {
      const provisioned = await provisionSysPane(SYS_NOTIFY_PANE_LABEL, "notify", notifyCmd);
      if (provisioned === null) return 1;
      if (!dryRun) {
        // Occupancy gate: spawn ok ≠ listening. A pane run
        // into a pane still hosting a live foreground process is swallowed
        // while herdr reports ok, so the success report waits for the event
        // port to actually answer — the same discipline as the hub's /state
        // wait. On timeout up fails loud instead of printing "notify running"
        // over a dead provisioning.
        const waitMs = notifyWaitMs();
        if (!(await pollUntil(() => notifyHealthy(eventUrl, cwd, hubUrl), waitMs, UP_POLL_INTERVAL_MS))) {
          process.stderr.write(
            `tut: up: notify pane ${provisioned.paneId} ran but ${eventUrl} never answered — the pane may still be occupied by a live process (pane run cannot start a second one); stop it (herdr pane close ${provisioned.paneId} or exit the process in the pane) and rerun tut up\n`,
          );
          return 1;
        }
        process.stdout.write(
          `up: notify running (pane ${await reportedPaneId(SYS_NOTIFY_PANE_LABEL, provisioned.paneId)}, tab ${SYS_TAB_LABEL}${provisioned.reused ? ", reused" : ""})\n`,
        );
      }
    }

    // Step 2b — usage watcher: opt-in via usage_audit = "on".
    // Measurement is a user-run tool, never product runtime: this only STARTS
    // the shipped script (scripts/usage-audit/run.mjs), which reads agent
    // session files and maintains tasks/<id>/usage.json. Everything here is
    // non-fatal — measurement must never fail the rig — and off/default
    // provisions nothing, so nothing reads agent data unless enabled.
    // (Shared with the standalone power path — power/standalone-up.ts.)
    try {
      await provisionUsageWatcher(cwd, hubUrl, dryRun);
    } catch {
      process.stderr.write("tut: up: usage watcher step failed (non-fatal) — measurement not started\n");
    }

    // Degradation: no usable Herdr → manual commands for whatever is down,
    // idempotent exit 0 — never a hidden background process.
    if (panes === null) {
      process.stdout.write(`up: herdr unusable (${herdrError}) — panes cannot be managed; start manually:\n`);
      for (const cmd of manual) process.stdout.write(`up:   ${cmd}\n`);
      process.stdout.write("up: agent panes are on-demand — launchers raise them at hand-off\n");
      printActivationHint();
      return 0;
    }
    // No role-pane provisioning here — panes are agent-keyed and
    // raised on demand by the launcher at hand-off time. up is the power
    // switch (hub + notify).
    // Re-read before the success report: concurrent up can pass service
    // probes through another invocation's winner while leaving duplicate
    // labelled panes behind. Inside the lock window, this read-only check
    // deliberately exits 1 on any error, including listing failure, even
    // though provisioning succeeded. Rerunning up is idempotent.
    if (!dryRun) {
      const finalListing = await herdrPaneList();
      if ("error" in finalListing) {
        process.stderr.write(`tut: up: cannot verify final pane label uniqueness: ${finalListing.error}\n`);
        return 1;
      }
      const labels = new Map<string, string[]>();
      for (const pane of finalListing.panes) {
        if (pane.label === undefined) continue;
        const label = unscopedLabel(pane.label, cwd);
        if (label === undefined || !/^(?:tut-(?:hub|notify)|.+\.(?:architect|executor|reviewer))$/.test(label)) continue;
        const ids = labels.get(pane.label) ?? [];
        ids.push(pane.pane_id);
        labels.set(pane.label, ids);
      }
      const duplicates = [...labels].filter(([, ids]) => ids.length > 1);
      if (duplicates.length > 0) {
        for (const [label, ids] of duplicates) {
          process.stderr.write(`tut: up: duplicate pane label ${label}: ${ids.join(", ")} — inspect and close the redundant panes, then rerun tut up\n`);
        }
        return 1;
      }
    }
    process.stdout.write("up: agent panes are on-demand — launchers raise them at hand-off\n");
    printActivationHint();
    return 0;
  } catch (error) {
    process.stderr.write(`tut: up: ${(error as Error).message}\n`);
    return 1;
  } finally {
    releaseLock?.();
  }
}
