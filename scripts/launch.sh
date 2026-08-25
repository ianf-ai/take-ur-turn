#!/bin/sh
# Launcher contract (system-design 7.2, same-role-continuity edition). Usage:
#   launch.sh [--fresh] <task_id> <role> [<agent> [<arg>...]]
#                        # round hand-off (start-next / auto; the first round
#                        # after tut create is an ordinary round hand-off too)
#   launch.sh --cleanup <task_id>
#                        # reap a closed task's panes (decide hook)
#
# SESSION POLICY: a ROLE CHANGE always
# births a BRAND-NEW pane — unrecorded context must never leak across roles,
# the Hub is the only memory. A SAME-TASK SAME-ROLE consecutive round
# (executor→revision, reviewer→re-review) CONTINUES the live existing pane
# instead: the checklist author re-checks their own list, the code author
# fixes their own bug — no full re-read tax, no cross-role boundary crossed.
# An outside perspective on the same role is an EXPLICIT choice: --fresh
# force-closes the role's panes (working included) and births anew.
#
# Pane labels / namespace ownership (system-design 4.4) — two fields, two
# jobs: the TAB label is human-facing (rendered from the naming.tab_label
# template, default "TUT {role}"; placeholders {role}/{task}/{agent}); the PANE
# label is the machine addressing key and is NEVER templated:
#   <task_id>.<role>   round panes — birthed and reaped by this launcher
#   tut-hub/tut-notify system panes (tut up) — read as anchors, never touched
#   unlabeled          the human's — never touched
# task_id slugs cannot contain dots (store slugify alphabet [a-z0-9-]), so
# the first "." in a label is unambiguously the task/role separator. The
# notifier's reverse lookup consumes pane labels only — a tab template never
# enters it (the reverse lookup stays a direct hit under any custom template).
#
# Birth anchoring (system-design 7.2) is resolved ONCE at each entry
# (before any lifecycle hook or agent resolution — the chain needs the
# anchor's cwd as its L1 root), then reused for the whole run. The anchor
# is the tut-hub pane's (workspace_id, cwd) — the hub process IS
# the ground truth of "TUT's workspace and cwd". Fallback chain: tut-hub →
# tut-notify → $TUT_SPLIT_BASE pane → loud error. Never "first pane in the
# list" (pane list is GLOBAL: the first pane can live in another project's
# workspace) and never a bare `tab create` (defaults into the FOCUSED
# workspace and `pane move` squeezes into its existing tabs).
#
# Birth sequence (adopt-root): `herdr tab create --workspace W --cwd C
# --label L --no-focus` ships an empty root pane — we ADOPT it as the work
# seat (rename + run the agent). No split, no base-pane dependency, and the
# root-pane noise is consumed by construction. Root discovery is
# two-channel: the response's root_pane, else the sole pane of the new tab
# in `pane list`. Fallback (rename/run failure): close the root, then the
# anchored legacy sequence — split the anchor pane (--cwd C) → move into
# the (existing or newly created) tab → close that tab's root → rename →
# run. The fallback keeps both anchors and the hygiene.
#
# Lifecycle hooks (system-design 4.4 — three-branch round hand-off):
#   continuation     pane list holds a LIVE pane labeled exactly `<T>.<role>`
#                    and the role is a continuity seat → deliver ONLY
#                    (send-text + Enter, no readiness gate — the seat's UI
#                    is already up): no reap, no birth, a stderr note keeps
#                    the choice visible. Live = agent_status idle (round
#                    over, TUI awaiting — the main scene) / working /
#                    blocked (busy: the prompt queues in the TUI input loop
#                    like a human typing mid-generation); done or a missing
#                    field = dead → birth branch (the corpse is reaped).
#   birth            role change / first round / dead pane (or --fresh):
#                    narrowed reap, then anchor a fresh `<T>.<role>` pane.
#                    Reap condition: `<T>.*` ∧ non-working ∧ ¬(continuity
#                    role ∧ live) — live continuity work seats survive
#                    mid-task (they are the reuse base); dead panes of any
#                    role and non-continuity roles (architect keeps the
#                    original always-fresh) are reaped; working panes are still
#                    skipped with a warning. A live `<T>.<role>` survivor
#                    then trips the addressing-key guard: loud abort, never
#                    a second pane under the same label (the reverse lookup
#                    depends on the key's uniqueness).
#   --fresh          explicit outside perspective: force-close ALL
#                    `<T>.<role>` panes (working included), then birth.
#   --cleanup        decide-close hook: close `<T>.*` unconditionally.
#                    Best-effort: warnings on stderr, exit 0 — approval
#                    must never be blocked by the terminal container.
#
# Routing: the round entry resolves the agent for
# <role> via task cast (GET /state, TUT_HUB_URL env, default
# http://127.0.0.1:3001) → the three-level workspace chain, delegated to
# scripts/tut-resolve.mjs (plain node, zero-build): L1 project
# <root>/.context-hub/workspace.json → L2 user (~/.config/tut, or
# $TUT_USER_CONFIG_DIR) → built-in DEFAULT_ROLES — mirroring
# src/workspace.ts resolveAgent; parity is pinned by test. The L1 root is
# $TUT_PROJECT_ROOT ?? the anchor pane's cwd (resolved ONCE at entry, see
# below); anchor unreachable and no TUT_PROJECT_ROOT → the chain degrades
# to L2/L3 with a stderr note. Callers that already resolved the agent
# (tut start-next, Notifier) pass it as the 3rd arg and the script skips
# its own /state read. Hub unreachable → file chain (default lineup) with
# a stderr note.
#
# Delivery tail (7.2.1, closed-loop edition): the
# BORN branch gates on the receiver painting its UI, then the submit step is
# a CLOSED LOOP: land-confirm the text, Enter, VERIFY the receiver's input
# box let go of it, then a LONG BOUNDED loop of Enter resends. The
# CONTINUATION branch skips only the birth gate (the seat's UI has long
# since painted) and runs the SAME land-confirm + verified-submit loop —
# one delivery code path, no drift:
#   ready-probe: poll `herdr pane read <pane> --source visible --lines 40`
#     until the output differs from the post-echo baseline AND is stable for
#     two consecutive polls AND the floor wait has elapsed (TUT_READY_FLOOR_MS
#     default 1500; poll TUT_READY_POLL_MS default 250; cap
#     TUT_READY_TIMEOUT_MS default 15000 — on timeout deliver anyway with a
#     stderr note, never worse than before).
#   herdr pane send-text <pane> "<prompt>"   literal text, no paste markers
#   land-confirm: poll the screen against the pre-send snapshot until it
#     changes — the text rendered in the receiver's input box (cap
#     TUT_TEXT_LAND_TIMEOUT_MS default 5000; timeout → stderr note, submit
#     anyway). Produces the with-text snapshot the submit step verifies
#     against (and incidentally outlasts the codex first-frame init window).
#   verified submit: `herdr pane send-keys <pane> Enter`, then verify within
#     TUT_SUBMIT_TIMEOUT_MS default 3000 by the INPUT-BOX-CLEARED criterion:
#     submitted ⟺ a non-empty screen whose BOTTOM REGION (the last 3
#     non-empty lines — the composer and its chrome; live-calibrated: codex's
#     "› …" composer line reverts to its placeholder, pi's bottom status
#     rows start ticking when the round begins) no longer matches the
#     with-text snapshot's bottom region. A repaint ABOVE the region no
#     longer counts — the tightened criterion (the live sentinel: the
#     swallow window can OUTLIVE the idle readiness signal, so "any change"
#     could call a swallowed Enter a success and strand the prompt
#     silently). Box still holds the text → a bounded resend loop: one
#     Enter per TUT_SUBMIT_RETRY_MS default 1500 (the TEXT is never re-sent)
#     for up to TUT_SUBMIT_RETRY_TIMEOUT_MS default 30000, verifying every
#     poll; window exhaustion → manual-fallback note + STILL EXIT 0 (the
#     prompt sits in the input box, a failure exit would re-trigger
#     duplicate delivery). TUT_SUBMIT_RETRIES and TUT_SUBMIT_READY_TIMEOUT_MS
#     are inert legacy knobs (kept so old launch environments carrying them
#     do not fail); the agent_status readiness boundary is retired from the
#     submit decision — the sentinel disproved its predictive power.
#   diagnostics (decoupled observer): every delivery step emits one
#     `tut-delivery t=<epoch-ms> …` stderr line — gate polls/release/
#     timeout, send-text, land polls/observed/timeout, every Enter (with
#     attempt number), every loop read, submit-confirmed, give-up. Pure
#     observation, never a gate: TUT_DELIVERY_DIAG=0 silences the lines and
#     NOTHING else changes. The timestamps exist to reconstruct the timeline
#     of the NEXT swallowed-Enter incident (timing lottery; trigger
#     still unidentified) by aligning them with the notify-pane log (the
#     Notifier tees this script's stderr there).
# Why the loop (7.2.1 root cause): the gate signal is "UI painted", which on
# pi coincides with submit-readiness but on codex SPLITS from it — the first
# frame is the shell (the composer renders send-text's text) while the async
# init (session/model/credentials) finishes later and swallows Enters
# arriving inside the window. Correctness therefore must not depend on
# guessing that timing: observe the box, resend on the clock until it lets
# go, report honestly when the bounded window runs out.
#
# Birth/provisioning failures exit 1 AFTER the caller's launch marker —
# recover with start-next --force. TUT_DRY_RUN=1 prints the sequence
# instead of running it (placeholders when Herdr/anchor is unreachable).
#
# Callers pass the absolute path to this script (module-relative resolution
# on the tut side); the script itself never depends on cwd.

set -u
# Route tokens are validated before this expansion is used. Disable pathname
# expansion as a second guard before the final herdr argv boundary.
set -f

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TUT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TUT_RESOLVE="$SCRIPT_DIR/tut-resolve.mjs"
HUB_URL="${TUT_HUB_URL:-http://127.0.0.1:3001}"
CHAIN_ROOT=""   # L1 root for the workspace chain: anchor cwd (set at entry)

# Self-update suppression at launch (supply hardening): agent CLIs that
# check for updates at startup race the delivery loop — the registered
# incident is a codex npm self-update that held the pane for six minutes
# and swallowed the delivered prompt. `herdr pane run` TYPES its argv into
# the pane's shell, so every suppression form below must be PLAIN WORDS —
# no quoting, no shell metacharacters (verified live). Per-agent forms:
#   codex   `-c check_for_update_on_startup=false` — config override flag,
#           kills the startup update check (the npm self-update trigger)
#   pi      `env PI_SKIP_VERSION_CHECK=1` — documented update-check opt-out
# Unknown agents pass through unchanged. TUT_SUPPRESS_AGENT_UPDATE=0
# restores the raw agent command (escape knob, same spirit as
# TUT_CONTINUITY_ROLES). The agent-presence check (command -v) always
# probes the BARE agent name.
# `AGENT_ARGS` is a space-separated list produced only by tut-resolve.mjs's
# shell-neutral parser. It is expanded at the final herdr argv boundary after
# pathname expansion has been disabled above.
build_run_cmd() {
  BRC_CMD="$AGENT"
  if [ -n "${AGENT_ARGS:-}" ]; then BRC_CMD="$BRC_CMD $AGENT_ARGS"; fi
  if [ "${TUT_SUPPRESS_AGENT_UPDATE:-1}" = "0" ]; then
    printf '%s' "$BRC_CMD"
    return 0
  fi
  case "$AGENT" in
    codex) printf '%s' "$BRC_CMD -c check_for_update_on_startup=false" ;;
    pi) printf '%s' "env PI_SKIP_VERSION_CHECK=1 $BRC_CMD" ;;
    *) printf '%s' "$BRC_CMD" ;;
  esac
}

# Continuity work seats (system-design 4.4): roles whose LIVE `<T>.<role>`
# pane is continued into (deliver-only) rather than reaped and reborn at a
# round hand-off — the two same-role consecutive pairs (executor→revision,
# reviewer→re-review). Space-
# separated; TUT_CONTINUITY_ROLES overrides; an EMPTY value disables
# continuity entirely (the original full-reap behavior — escape/test knob).
# Unset → executor + reviewer (architect keeps always-fresh).
CONTINUITY_ROLES="${TUT_CONTINUITY_ROLES-executor reviewer}"
FRESH=0   # --fresh round entry sets 1; close_task_panes consults it (init
          # here: the --cleanup entry calls it before the round entry runs)
ROLE=""   # launched role, same lifetime note as FRESH

# --- helpers ---------------------------------------------------------------------

pane_list_json() {
  herdr pane list 2>/dev/null || true
}

# Live work seat (system-design 4.4): the agent TUI is up. idle = round
# over, awaiting input (the main continuation scene); working / blocked =
# busy — a delivered prompt queues in the TUI input loop and is picked up
# next turn, same shape as a human typing mid-generation. done (the run
# command has exited) or a missing field = dead.
pane_alive() {
  case "$1" in idle|working|blocked) return 0 ;; *) return 1 ;; esac
}

# $1 ∈ CONTINUITY_ROLES (see the CONTINUITY_ROLES block above).
is_continuity_role() {
  case " ${CONTINUITY_ROLES} " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# pane_id of the LIVE pane labeled exactly $1 (the addressing key), empty
# when absent or dead. Consumed by the continuation branch (discovery) and
# the addressing-key guard (post-reap check).
find_live_pane() {
  pane_list_json | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const list = JSON.parse(raw);
    const panes = list?.result?.panes ?? list?.panes ?? [];
    const hit = panes.find((p) => p.label === process.argv[1] && ["idle", "working", "blocked"].includes(p.agent_status ?? ""));
    if (hit) process.stdout.write(hit.pane_id ?? "");
  } catch {}
});
' "$1" 2>/dev/null || true
}

# Agent for $1 (role) from the file chain (L1/L2/L3), delegated to
# tut-resolve.mjs — the launch.sh half of the parity-pinned chain. The L1
# root comes from $TUT_PROJECT_ROOT, else CHAIN_ROOT (the anchor pane's
# cwd, resolved at entry); empty → the module skips L1.
agent_from_files() {
  node "$TUT_RESOLVE" resolve "$1" "${CHAIN_ROOT:-}" </dev/null
}

# Render the tab label for ($1 role, $2 task id, $3 agent) from the
# naming.tab_label template (same chain root).
tab_label_for() {
  node "$TUT_RESOLVE" tab-label "$1" "$2" "$3" "${CHAIN_ROOT:-}" </dev/null
}

# Resolve the full agent chain for ($1 task_id, $2 role): cast via /state,
# then files. Prints a route display; on hub failure falls back to files with a
# stderr note (cast tasks may route to the default lineup until the hub is
# back — accepted degradation, system-design 7.2).
resolve_agent() {
  TASK="$1"; ROLE="$2"
  CAST_AGENT=$(curl -sf "$HUB_URL/state" 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const state = JSON.parse(raw);
    const entry = (state?.tasks ?? []).find((t) => t.task_id === process.argv[1]);
    const route = entry?.cast?.[process.argv[2]];
    if (typeof route === "string" && route.length > 0) process.stdout.write(route);
    else if (route && typeof route === "object" && typeof route.agent === "string" && Array.isArray(route.args)) {
      process.stdout.write([route.agent, ...route.args].join(" "));
    }
  } catch {}
});
' "$TASK" "$ROLE" 2>/dev/null || true)
  if [ -n "$CAST_AGENT" ]; then
    echo "$CAST_AGENT"
    return 0
  fi
  if ! curl -sf "$HUB_URL/state" >/dev/null 2>&1; then
    echo "launch: hub unreachable at $HUB_URL — cast not readable, using the default lineup" >&2
  fi
  agent_from_files "$ROLE"
}

# Parse a route at the launcher boundary. A single value is the legacy raw
# command string; multiple values are already argv tokens from start-next or
# Notifier. The node helper validates both forms and prints one token per line.
set_route_from_invocation() {
  ROUTE_WORDS=$(node "$TUT_RESOLVE" parse-invocation "$@" 2>"${TMPDIR:-/tmp}/tut-route-error.$$") || {
    ROUTE_ERROR=$(cat "${TMPDIR:-/tmp}/tut-route-error.$$" 2>/dev/null || true)
    rm -f "${TMPDIR:-/tmp}/tut-route-error.$$"
    echo "launch: invalid agent command${ROUTE_ERROR:+: $ROUTE_ERROR}" >&2
    return 1
  }
  rm -f "${TMPDIR:-/tmp}/tut-route-error.$$"
  AGENT=$(printf '%s\n' "$ROUTE_WORDS" | sed -n '1p')
  AGENT_ARGS=$(printf '%s\n' "$ROUTE_WORDS" | sed -n '2,$p' | awk 'NR == 1 { printf "%s", $0; next } { printf " %s", $0 }')
  [ -n "$AGENT" ] || {
    echo "launch: invalid agent command: missing executable" >&2
    return 1
  }
  return 0
}

# --- anchor resolution (system-design 7.2) -----------------------------------------

# Sets ANCHOR_WS / ANCHOR_CWD / ANCHOR_PANE from the tut-hub pane's
# (workspace_id, cwd); fallback tut-notify → $TUT_SPLIT_BASE pane → error.
# Dry-run without a reachable anchor degrades to placeholders (preview must
# not require a live Herdr). "soft" mode ($1) skips the loud error — the
# entry points use it to fill CHAIN_ROOT best-effort (an unavailable anchor
# only degrades the workspace chain to L2/L3, with a stderr note); the
# birth path re-runs the strict form for its loud failure.
resolve_anchor() {
  ANCHOR_SOFT="${1:-}"
  ANCHOR_WS=""; ANCHOR_CWD=""; ANCHOR_PANE=""
  ANCHOR_ROW=$(pane_list_json | TUT_SPLIT_BASE="${TUT_SPLIT_BASE:-}" node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const list = JSON.parse(raw);
    const panes = list?.result?.panes ?? list?.panes ?? [];
    const esc = process.env.TUT_SPLIT_BASE ?? "";
    const winner =
      panes.find((p) => p.label === "tut-hub") ??
      panes.find((p) => p.label === "tut-notify") ??
      (esc ? panes.find((p) => p.pane_id === esc) : undefined);
    if (winner) process.stdout.write([winner.workspace_id ?? "", winner.cwd ?? "", winner.pane_id ?? ""].join("\t"));
  } catch {}
});
' 2>/dev/null || true)
  if [ -n "$ANCHOR_ROW" ]; then
    ANCHOR_WS=$(printf '%s' "$ANCHOR_ROW" | cut -f1)
    ANCHOR_CWD=$(printf '%s' "$ANCHOR_ROW" | cut -f2)
    ANCHOR_PANE=$(printf '%s' "$ANCHOR_ROW" | cut -f3)
    return 0
  fi
  if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
    ANCHOR_WS="<workspace>"; ANCHOR_CWD="<cwd>"; ANCHOR_PANE="<anchor>"
    return 0
  fi
  if [ "$ANCHOR_SOFT" != "soft" ]; then
    echo "launch: no anchor pane found (tut-hub / tut-notify / \$TUT_SPLIT_BASE) — run tut up, or set TUT_SPLIT_BASE to a pane id" >&2
  fi
  return 1
}

# Entry-time anchor + chain-root resolution: resolve the
# anchor ONCE (soft — failure is not fatal this early), set CHAIN_ROOT (the
# workspace chain's L1 root) from the anchor's cwd when it is a real
# directory, and declare the degradation on stderr when the chain must fall
# back to L2/L3. $TUT_PROJECT_ROOT (read by tut-resolve.mjs) always wins.
resolve_chain_root() {
  CHAIN_ROOT=""
  if resolve_anchor soft && [ -d "$ANCHOR_CWD" ]; then
    CHAIN_ROOT="$ANCHOR_CWD"
  fi
  if [ -z "${TUT_PROJECT_ROOT:-}" ] && [ -z "$CHAIN_ROOT" ]; then
    echo "launch: no project root for the workspace chain (anchor unavailable) — resolving via user-level/built-in defaults" >&2
  fi
}

# --- lifecycle helpers --------------------------------------------------------------

# Close every pane whose label starts with "$1." — that task's round
# panes. Modes: "" = round hand-off reap, NARROWED per the continuity
# design: close ⟺ non-working ∧ ¬(continuity role ∧ live) — live
# executor/reviewer seats survive for same-role continuation; dead panes
# of any role, and non-continuity roles when not working, keep the
# original shape; working panes are skipped with a warning. "force" =
# unconditional (--cleanup); with $3 set, force applies ONLY to
# `<task>.$3` panes (the --fresh hard close of the role's own seats,
# working included — the explicit choice authorizes killing a live
# session).
close_task_panes() {
  CT_TASK="$1"; CT_MODE="${2:-}"; CT_ONLY="${3:-}"
  pane_list_json | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const list = JSON.parse(raw);
    const panes = list?.result?.panes ?? list?.panes ?? [];
    for (const p of panes) {
      if (typeof p.label === "string" && p.label.startsWith(process.argv[1] + ".")) {
        process.stdout.write([p.pane_id ?? "", p.agent_status ?? "", p.label].join("\t") + "\n");
      }
    }
  } catch {}
});
' "$CT_TASK" 2>/dev/null | while IFS="$(printf '\t')" read -r CT_ID CT_ST CT_LBL; do
    [ -n "$CT_ID" ] || continue
    # --fresh already disposed of the launched role's panes above (live:
    # they are gone from the list; dry-run: the force-close preview covered
    # them) — the narrowed REAP must never re-judge them: no duplicate
    # preview line, no working/continuity notes contradicting the fresh
    # choice. (Force mode — the --fresh hard close itself, and --cleanup —
    # is exempt from this exemption.)
    if [ "$CT_MODE" != "force" ] && [ "$FRESH" -eq 1 ] && [ "$CT_LBL" = "${CT_TASK}.${ROLE}" ]; then
      continue
    fi
    if [ -n "$CT_ONLY" ] && [ "$CT_LBL" != "${CT_TASK}.${CT_ONLY}" ]; then
      continue
    fi
    if [ "$CT_ST" = "working" ] && [ "$CT_MODE" != "force" ]; then
      echo "launch: pane '$CT_LBL' ($CT_ID) still working — left open for the next lifecycle hook" >&2
      continue
    fi
    if [ "$CT_MODE" != "force" ] && pane_alive "$CT_ST" && is_continuity_role "${CT_LBL#"${CT_TASK}."}"; then
      echo "launch: pane '$CT_LBL' ($CT_ID) is a live continuity work seat — kept for same-role continuation" >&2
      continue
    fi
    if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
      echo "DRY-RUN: cleanup: herdr pane close $CT_ID (label '$CT_LBL')"
      continue
    fi
    herdr pane close "$CT_ID" >/dev/null 2>&1 || echo "launch: pane close $CT_ID (label '$CT_LBL') failed — continuing" >&2
  done
}

# --- birth (adopt-root, anchored) ---------------------------------------------------
#
# Birth a fresh pane with DUAL labels: $1 tab label (human-facing — the
# naming.tab_label template rendered by the caller), $2 pane label (the
# machine addressing key, caller-fixed: <task_id>.<role> — NEVER templated),
# $3 agent executable (must be on PATH); `AGENT_ARGS` carries the ordered tail.
# Prints the new pane_id (empty in dry-run). Exit 1 when the agent is
# missing, the anchor cannot be resolved, or herdr fails at every step.
#
# tab-create edge: exit 0 but unparseable output → recover
# the tab_id via `herdr tab list --workspace W` matched by label — never a
# blind second create (the first tab exists; a second one would orphan it).
# A second create runs ONLY after a provable first failure (non-zero exit).
#
# Root hygiene: the fallback tab ships an empty root pane;
# `pane list` can lag a freshly created tab — discovery is a bounded retry
# (TUT_ROOT_SWEEP_RETRIES, default 3; TUT_ROOT_SWEEP_RETRY_MS, default 200)
# and a post-run sweep re-lists the tab and closes everything except the
# new pane (retry + sweep, double cover).
birth_pane() {
  BP_TAB_LABEL="$1"; BP_LABEL="$2"; BP_AGENT="$3"
  if ! command -v "$BP_AGENT" >/dev/null 2>&1; then
    if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
      echo "DRY-RUN: birth skipped: agent '$BP_AGENT' not on PATH"
      return 0
    fi
    echo "launch: agent '$BP_AGENT' not on PATH — cannot birth a pane for it" >&2
    return 1
  fi
  if [ -z "${ANCHOR_PANE:-}" ]; then
    resolve_anchor || return 1
  fi
  if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
    echo "DRY-RUN: birth: herdr tab create --workspace $ANCHOR_WS --cwd $ANCHOR_CWD --label $BP_TAB_LABEL --no-focus"
    echo "DRY-RUN: birth: adopt the tab's root pane (response root_pane, else pane list by tab_id)"
    echo "DRY-RUN: birth: herdr pane rename <root> $BP_LABEL"
    echo "DRY-RUN: birth: herdr pane run <root> $(build_run_cmd)"
    return 0
  fi

  BP_RUN_CMD=$(build_run_cmd)

  # Primary: adopt the root pane the tab create ships.
  BP_RAW=$(herdr tab create --workspace "$ANCHOR_WS" --cwd "$ANCHOR_CWD" --label "$BP_TAB_LABEL" --no-focus 2>/dev/null)
  BP_CREATE_RC=$?
  BP_TAB=""; BP_ROOT=""; BP_CREATE_FAILED=0
  if [ "$BP_CREATE_RC" -eq 0 ]; then
    BP_PARSED=$(printf '%s' "$BP_RAW" | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const out = JSON.parse(raw);
    const r = out?.result ?? {};
    const tabId = r?.tab?.tab_id ?? r?.tab?.id ?? out?.tab?.tab_id ?? "";
    const rootId = r?.root_pane?.pane_id ?? r?.root_pane?.id ?? "";
    process.stdout.write([tabId, rootId].join("\t"));
  } catch {}
});
' 2>/dev/null || true)
    BP_TAB=$(printf '%s' "$BP_PARSED" | cut -f1)
    BP_ROOT=$(printf '%s' "$BP_PARSED" | cut -f2)
    if [ -z "$BP_TAB" ]; then
      # exit 0 but unparseable — the tab exists; recover its id by
      # label via tab list instead of creating a second one.
      BP_TAB=$(herdr tab list --workspace "$ANCHOR_WS" 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const out = JSON.parse(raw);
    const tabs = out?.result?.tabs ?? out?.tabs ?? [];
    const hit = tabs.find((t) => t.label === process.argv[1]);
    if (hit) process.stdout.write(hit.tab_id ?? hit.id ?? "");
  } catch {}
});
' "$BP_TAB_LABEL" 2>/dev/null || true)
      if [ -n "$BP_TAB" ]; then
        echo "launch: tab create output unparseable — tab id recovered via tab list ('$BP_TAB')" >&2
      fi
    fi
  else
    BP_CREATE_FAILED=1
  fi
  # Root discovery channel 2: the sole pane of the new tab in pane list.
  if [ -n "$BP_TAB" ] && [ -z "$BP_ROOT" ]; then
    BP_ROOT=$(pane_list_json | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const list = JSON.parse(raw);
    const panes = list?.result?.panes ?? list?.panes ?? [];
    const hit = panes.find((p) => p.tab_id === process.argv[1]);
    if (hit) process.stdout.write(hit.pane_id ?? "");
  } catch {}
});
' "$BP_TAB" 2>/dev/null || true)
  fi
  if [ -n "$BP_ROOT" ]; then
    if herdr pane rename "$BP_ROOT" "$BP_LABEL" >/dev/null 2>&1 && herdr pane run "$BP_ROOT" $BP_RUN_CMD >/dev/null 2>&1; then
      echo "$BP_ROOT"
      return 0
    fi
    # Adoption failed — remove the failed root, keep the tab for the fallback.
    herdr pane close "$BP_ROOT" >/dev/null 2>&1 || true
  fi

  # Fallback: anchored legacy sequence (split the anchor pane, move into the
  # tab, close whatever root that tab still ships, rename, run).
  echo "launch: adopt-root birth failed — falling back to the anchored split sequence" >&2
  BP_NEW=$(herdr pane split "$ANCHOR_PANE" --direction right --no-focus --cwd "$ANCHOR_CWD" 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const out = JSON.parse(raw);
    const id = out?.result?.pane?.pane_id ?? out?.pane?.pane_id ?? out?.result?.pane_id;
    if (typeof id === "string" && id.length > 0) process.stdout.write(id);
  } catch {}
});
' 2>/dev/null || true)
  [ -n "$BP_NEW" ] || { echo "launch: herdr pane split returned no pane_id" >&2; return 1; }
  if [ -z "$BP_TAB" ]; then
    if [ "$BP_CREATE_FAILED" -ne 1 ]; then
      # the first create exited 0 — a tab exists but is unaddressable
      # (unparseable output AND tab-list recovery missed). A second create
      # would orphan it; refuse and surface the manual fix instead.
      echo "launch: tab create succeeded but its id is unrecoverable (output unparseable, tab list miss) — refusing a second create; inspect the tab manually" >&2
      return 1
    fi
    BP_TAB=$(herdr tab create --workspace "$ANCHOR_WS" --label "$BP_TAB_LABEL" 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const out = JSON.parse(raw);
    const id = out?.result?.tab?.tab_id ?? out?.tab?.tab_id ?? out?.result?.tab?.id;
    if (typeof id === "string" && id.length > 0) process.stdout.write(id);
  } catch {}
});
' 2>/dev/null || true)
    [ -n "$BP_TAB" ] || { echo "launch: herdr tab create returned no tab id" >&2; return 1; }
  fi
  herdr pane move "$BP_NEW" --tab "$BP_TAB" --split down >/dev/null 2>&1 || {
    echo "launch: herdr pane move $BP_NEW --tab $BP_TAB failed" >&2
    return 1
  }
  # Hygiene: the fallback tab still ships an empty root pane — and
  # pane list may lag the fresh tab. Bounded re-list retry, then the
  # post-run sweep below re-checks regardless (double cover).
  sweep_tab_roots "$BP_TAB" "$BP_NEW" retry
  herdr pane rename "$BP_NEW" "$BP_LABEL" >/dev/null 2>&1 || {
    echo "launch: herdr pane rename $BP_NEW $BP_LABEL failed" >&2
    return 1
  }
  herdr pane run "$BP_NEW" $BP_RUN_CMD >/dev/null 2>&1 || {
    echo "launch: herdr pane run $BP_NEW $BP_AGENT failed" >&2
    return 1
  }
  sweep_tab_roots "$BP_TAB" "$BP_NEW" sweep
  echo "$BP_NEW"
}

# Close every pane of tab $1 except $2. $3 "retry": bounded re-list attempts
# (TUT_ROOT_SWEEP_RETRIES × TUT_ROOT_SWEEP_RETRY_MS) — pane list can lag a
# freshly created tab; $3 "sweep": one final pass after a successful run.
sweep_tab_roots() {
  SW_TAB="$1"; SW_KEEP="$2"; SW_MODE="$3"
  SW_MAX=1
  if [ "$SW_MODE" = "retry" ]; then SW_MAX=$(( ${TUT_ROOT_SWEEP_RETRIES:-3} )); fi
  SW_I=0
  while [ "$SW_I" -lt "$SW_MAX" ]; do
    SW_HIT=$(pane_list_json | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const list = JSON.parse(raw);
    const panes = list?.result?.panes ?? list?.panes ?? [];
    const inTab = panes.filter((p) => p.tab_id === process.argv[1] && p.pane_id !== process.argv[2]);
    process.stdout.write(inTab.map((p) => p.pane_id ?? "").filter((id) => id.length > 0).join("\n"));
  } catch {}
});
' "$SW_TAB" "$SW_KEEP" 2>/dev/null || true)
    if [ -n "$SW_HIT" ]; then
      for SW_ID in $SW_HIT; do
        herdr pane close "$SW_ID" >/dev/null 2>&1 || true
      done
      return 0
    fi
    SW_I=$(( SW_I + 1 ))
    if [ "$SW_I" -lt "$SW_MAX" ]; then
      SW_SLEEP=$(awk "BEGIN{printf \"%.3f\", ${TUT_ROOT_SWEEP_RETRY_MS:-200}/1000}")
      sleep "$SW_SLEEP"
    fi
  done
  return 0
}

# --- readiness-gated delivery ----------------------------------------------------

# --- delivery diagnostics (7.2.1, decoupled observer) ------------------------------

# One `tut-delivery t=<epoch-ms> …` stderr line per delivery step. Pure
# observation — never a gate, never a branch: TUT_DELIVERY_DIAG=0 silences
# the lines and nothing else changes (decoupling pinned by test). node is
# already a hard dependency of this script (all JSON parsing runs through
# it); ~25ms per call sits well inside the 250ms poll grid, and every
# timeout below is counted in polls, so the observation cannot change the
# loop's decisions. `date +%s`000 is the no-node fallback (second
# resolution is still a reconstructable timeline). Purpose: the
# swallowed-Enter lottery is unreproducible under control — the next
# organic hit gets its timeline from these lines, aligned against the
# notify-pane log (the Notifier tees this script's stderr there).
diag_clock() {
  node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || true
}

# $@ = the event's fields (e.g. "read pane=X step=gate idx=3 …").
diag() {
  [ "${TUT_DELIVERY_DIAG:-1}" = "1" ] || return 0
  DIAG_NOW=$(diag_clock)
  [ -n "${DIAG_NOW:-}" ] || DIAG_NOW="$(date +%s)000"
  echo "tut-delivery t=${DIAG_NOW} $*" >&2
}

# Last non-empty line of screen $1, trailing whitespace trimmed, capped at
# 40 chars, single quotes stripped — rides inside the quoted tail='…'
# field of a read diag line (bounded, safe to log).
diag_tail() {
  printf '%s' "$1" | awk 'NF { l = $0 } END { if (l != "") { sub(/[ \t\r]+$/, "", l); print substr(l, 1, 40) } }' | tr -d "'"
}

# Bottom region of screen $1: its last $2 (default 3) non-empty lines,
# trailing whitespace trimmed, newline-joined — where the receiver's
# composer and its chrome live. Live-calibrated on both TUIs: codex's
# "› …" composer line + status row sit in the last non-empty lines (the
# placeholder reverts when the box empties); pi's separator/cwd/token-stat
# rows do (they start ticking the moment the round begins). This is the
# submit criterion's whole field of view.
screen_bottom() {
  printf '%s' "$1" | awk -v n="${2:-3}" '
    NF { sub(/[ \t\r]+$/, ""); ring[c % n] = $0; c++ }
    END {
      start = (c > n) ? c - n : 0;
      for (j = start; j < c; j++) printf "%s%s", (j > start ? "\n" : ""), ring[j % n];
    }'
}

# Submit-confirmed predicate (the tightened criterion): the receiver's
# input box let go of the text ⟺ a NON-EMPTY screen whose bottom region no
# longer matches the with-text snapshot's region ($2, precomputed via
# screen_bottom). Repaints above the region do not count; an empty read is
# a glitch and never confirms. Degraded note: when land-confirm timed out
# with an unpainted screen, the region baseline is empty and any non-empty
# screen confirms — the old open-loop looseness, kept only on that path.
box_cleared() {
  [ -n "$1" ] || return 1
  [ "$(screen_bottom "$1" 3)" != "$2" ]
}

# Terminal text of pane $1 (probe input). --source visible: the rendered
# screen — available on every pane from birth (herdr 0.8's "recent"
# snapshots proved UNRELIABLE on freshly born panes, see 7.2.1).
pane_output() {
  herdr pane read "$1" --source visible --lines 40 2>/dev/null || true
}

# Wait until the freshly born pane $1 shows its receiver: the output must
# have CHANGED from the baseline captured right after `pane run <agent>`
# (the shell echo of the agent command — the change is the agent's first
# paint) and be STABLE for two consecutive polls, no earlier than the floor
# wait. On timeout: deliver anyway (stderr note) — never worse than before.
# Prints the gate-release screen (the land-confirm baseline) on stdout.
wait_born_ready() {
  WBR_PANE="$1"
  WBR_POLL_MS="${TUT_READY_POLL_MS:-250}"
  WBR_FLOOR_POLLS=$(( ${TUT_READY_FLOOR_MS:-1500} / WBR_POLL_MS ))
  WBR_MAX_POLLS=$(( ${TUT_READY_TIMEOUT_MS:-15000} / WBR_POLL_MS ))
  WBR_SLEEP=$(awk "BEGIN{printf \"%.3f\", $WBR_POLL_MS/1000}")
  diag "gate-start pane=$WBR_PANE floor_ms=${TUT_READY_FLOOR_MS:-1500} timeout_ms=${TUT_READY_TIMEOUT_MS:-15000}"
  WBR_BASE=$(pane_output "$WBR_PANE")
  WBR_PREV="$WBR_BASE"
  WBR_I=0
  while [ "$WBR_I" -lt "$WBR_MAX_POLLS" ]; do
    sleep "$WBR_SLEEP"
    WBR_OUT=$(pane_output "$WBR_PANE")
    if [ -n "$WBR_OUT" ] && [ "$WBR_OUT" != "$WBR_BASE" ] && [ "$WBR_OUT" = "$WBR_PREV" ] && [ "$WBR_I" -ge "$WBR_FLOOR_POLLS" ]; then
      diag "gate-release pane=$WBR_PANE idx=$WBR_I len=${#WBR_OUT} tail='$(diag_tail "$WBR_OUT")'"
      printf '%s' "$WBR_OUT"
      return 0
    fi
    diag "read pane=$WBR_PANE step=gate idx=$WBR_I len=${#WBR_OUT} tail='$(diag_tail "$WBR_OUT")'"
    WBR_PREV="$WBR_OUT"
    WBR_I=$(( WBR_I + 1 ))
  done
  echo "launch: born pane $WBR_PANE not observed ready within $(( WBR_MAX_POLLS * WBR_POLL_MS ))ms — delivering anyway (if the text idles in the input box, press Enter there)" >&2
  diag "gate-timeout pane=$WBR_PANE idx=$WBR_I len=${#WBR_OUT}"
  printf '%s' "$WBR_OUT"
  return 0
}

# Land-confirm (7.2.1 closed loop): after send-text, poll the screen of
# pane $1 against the pre-send snapshot $2 until it CHANGES — the text has
# rendered in the receiver's input box. Prints the with-text snapshot (the
# baseline the submit step verifies against). Timeout → stderr note, print
# the last screen and proceed anyway (never worse than the open loop: the
# submit step still runs; the wait itself outlasts part of the codex init).
confirm_text_landed() {
  TL_PANE="$1"; TL_BASE="$2"
  TL_POLL_MS="${TUT_READY_POLL_MS:-250}"
  TL_MAX_POLLS=$(( ${TUT_TEXT_LAND_TIMEOUT_MS:-5000} / TL_POLL_MS ))
  TL_SLEEP=$(awk "BEGIN{printf \"%.3f\", $TL_POLL_MS/1000}")
  diag "land-start pane=$TL_PANE timeout_ms=${TUT_TEXT_LAND_TIMEOUT_MS:-5000}"
  TL_I=0
  TL_OUT="$TL_BASE"
  while [ "$TL_I" -lt "$TL_MAX_POLLS" ]; do
    sleep "$TL_SLEEP"
    TL_OUT=$(pane_output "$TL_PANE")
    if [ -n "$TL_OUT" ] && [ "$TL_OUT" != "$TL_BASE" ]; then
      diag "land-observed pane=$TL_PANE idx=$TL_I len=${#TL_OUT} tail='$(diag_tail "$TL_OUT")'"
      printf '%s' "$TL_OUT"
      return 0
    fi
    diag "read pane=$TL_PANE step=land idx=$TL_I len=${#TL_OUT} tail='$(diag_tail "$TL_OUT")'"
    TL_I=$(( TL_I + 1 ))
  done
  echo "launch: text landing not observed on $TL_PANE within ${TUT_TEXT_LAND_TIMEOUT_MS:-5000}ms — submitting anyway (if it idles in the input box, press Enter there)" >&2
  diag "land-timeout pane=$TL_PANE idx=$TL_I len=${#TL_OUT}"
  printf '%s' "$TL_OUT"
  return 0
}

# Verified submit (7.2.1 input-box-cleared + bounded-resend-loop edition):
# $1 is the pane, $2 the with-text snapshot. Phase 1: ONE Enter, then verify
# for TUT_SUBMIT_TIMEOUT_MS (default 3000) by the cleared-box criterion —
# the healthy path stays exactly one Enter. Phase 2 (the box still holds
# the text): resend Enter at most once per TUT_SUBMIT_RETRY_MS (default
# 1500) within TUT_SUBMIT_RETRY_TIMEOUT_MS (default 30000), verifying every
# poll — the live sentinel proved the swallow window can outlive the
# idle readiness signal, so the loop resends on the clock, not on readiness,
# and only the box letting go of the text (not "any change") confirms.
# Exhaustion → manual-fallback note + STILL EXIT 0 (the prompt sits in the
# input box; a failure exit would re-trigger duplicate delivery). The text
# is never re-sent.
verified_submit() {
  VS_PANE="$1"; VS_BASE="$2"
  VS_POLL_MS="${TUT_READY_POLL_MS:-250}"
  VS_SLEEP=$(awk "BEGIN{printf \"%.3f\", $VS_POLL_MS/1000}")
  VS_SIG=$(screen_bottom "$VS_BASE" 3)
  VS_MAX_POLLS=$(( ${TUT_SUBMIT_TIMEOUT_MS:-3000} / VS_POLL_MS ))
  [ "$VS_MAX_POLLS" -gt 0 ] || VS_MAX_POLLS=1
  VS_RETRY_POLLS=$(( ${TUT_SUBMIT_RETRY_MS:-1500} / VS_POLL_MS ))
  [ "$VS_RETRY_POLLS" -gt 0 ] || VS_RETRY_POLLS=1
  VS_WINDOW_POLLS=$(( ${TUT_SUBMIT_RETRY_TIMEOUT_MS:-30000} / VS_POLL_MS ))
  [ "$VS_WINDOW_POLLS" -gt 0 ] || VS_WINDOW_POLLS=1
  VS_ATTEMPT=1
  VS_SINCE_ENTER=0
  diag "submit pane=$VS_PANE phase=initial attempt=1 verify_ms=${TUT_SUBMIT_TIMEOUT_MS:-3000} retry_ms=${TUT_SUBMIT_RETRY_MS:-1500} window_ms=${TUT_SUBMIT_RETRY_TIMEOUT_MS:-30000}"
  herdr pane send-keys "$VS_PANE" Enter >/dev/null 2>&1 || {
    echo "launch: herdr pane send-keys $VS_PANE Enter failed (initial attempt)" >&2
  }
  diag "enter pane=$VS_PANE attempt=1 phase=initial"
  VS_I=0
  while [ "$VS_I" -lt "$VS_MAX_POLLS" ]; do
    sleep "$VS_SLEEP"
    VS_SINCE_ENTER=$(( VS_SINCE_ENTER + 1 ))
    VS_OUT=$(pane_output "$VS_PANE")
    if [ -n "$VS_OUT" ] && box_cleared "$VS_OUT" "$VS_SIG"; then
      diag "submit-confirmed pane=$VS_PANE attempt=$VS_ATTEMPT phase=verify idx=$VS_I"
      return 0
    fi
    diag "read pane=$VS_PANE step=verify idx=$VS_I len=${#VS_OUT} box=held tail='$(diag_tail "$VS_OUT")'"
    VS_I=$(( VS_I + 1 ))
  done

  echo "launch: input box still holds the text on $VS_PANE after ${TUT_SUBMIT_TIMEOUT_MS:-3000}ms — bounded Enter resend loop (interval ${TUT_SUBMIT_RETRY_MS:-1500}ms, window ${TUT_SUBMIT_RETRY_TIMEOUT_MS:-30000}ms)" >&2
  diag "loop-start pane=$VS_PANE attempts=$VS_ATTEMPT interval_ms=${TUT_SUBMIT_RETRY_MS:-1500} window_ms=${TUT_SUBMIT_RETRY_TIMEOUT_MS:-30000}"
  VS_N=0
  while [ "$VS_N" -lt "$VS_WINDOW_POLLS" ]; do
    sleep "$VS_SLEEP"
    VS_SINCE_ENTER=$(( VS_SINCE_ENTER + 1 ))
    VS_N=$(( VS_N + 1 ))
    VS_OUT=$(pane_output "$VS_PANE")
    if [ -n "$VS_OUT" ] && box_cleared "$VS_OUT" "$VS_SIG"; then
      echo "launch: input box cleared on $VS_PANE — submit confirmed (attempt $VS_ATTEMPT)" >&2
      diag "submit-confirmed pane=$VS_PANE attempt=$VS_ATTEMPT phase=loop idx=$VS_N"
      return 0
    fi
    diag "read pane=$VS_PANE step=loop idx=$VS_N len=${#VS_OUT} box=held tail='$(diag_tail "$VS_OUT")'"
    if [ "$VS_SINCE_ENTER" -ge "$VS_RETRY_POLLS" ]; then
      VS_ATTEMPT=$(( VS_ATTEMPT + 1 ))
      VS_SINCE_ENTER=0
      herdr pane send-keys "$VS_PANE" Enter >/dev/null 2>&1 || {
        echo "launch: herdr pane send-keys $VS_PANE Enter failed (attempt $VS_ATTEMPT)" >&2
      }
      echo "launch: resending Enter (attempt $VS_ATTEMPT) on $VS_PANE — box still holds the text" >&2
      diag "enter pane=$VS_PANE attempt=$VS_ATTEMPT phase=loop resend"
    fi
  done

  echo "launch: submit not confirmed on $VS_PANE within ${TUT_SUBMIT_RETRY_TIMEOUT_MS:-30000}ms after $VS_ATTEMPT Enters — the prompt sits in the input box; press Enter there manually to start the round" >&2
  diag "give-up pane=$VS_PANE attempts=$VS_ATTEMPT window_ms=${TUT_SUBMIT_RETRY_TIMEOUT_MS:-30000}"
  return 0
}

# Deliver $2 to pane $1 (born branch). Every pane is born fresh, so the
# readiness gate always applies; then the closed loop: literal send-text →
# land-confirm → readiness-bound verified submit (see above). Only a
# send-text failure is fatal (nothing was delivered); the submit step never
# fails the launch (see verified_submit).
deliver_prompt() {
  DL_PANE="$1"; DL_TEXT="$2"
  DL_BASE=$(wait_born_ready "$DL_PANE")
  herdr pane send-text "$DL_PANE" "$DL_TEXT" >/dev/null || {
    echo "launch: herdr pane send-text $DL_PANE failed" >&2
    return 1
  }
  diag "send-text pane=$DL_PANE branch=born len=${#DL_TEXT}"
  DL_SNAP=$(confirm_text_landed "$DL_PANE" "$DL_BASE")
  verified_submit "$DL_PANE" "$DL_SNAP"
}

# Deliver $2 to the LIVE pane $1 (same-role continuation): no readiness gate
# (that is the born-pane mechanism — the seat's UI is already up), but the
# SAME land-confirm + readiness-bound verified-submit loop as the born branch (one
# delivery code path, no drift; a continuation Enter can be swallowed by the
# same init/turn-taking windows). Failure is loud only for send-text (exit
# 1); re-entry self-heals: a pane that died meanwhile is reaped and reborn
# by the next launch's birth branch.
deliver_continuation() {
  DC_PANE="$1"; DC_TEXT="$2"
  DC_BASE=$(pane_output "$DC_PANE")
  diag "read pane=$DC_PANE step=snapshot idx=0 len=${#DC_BASE} tail='$(diag_tail "$DC_BASE")'"
  herdr pane send-text "$DC_PANE" "$DC_TEXT" >/dev/null || {
    echo "launch: herdr pane send-text $DC_PANE failed" >&2
    return 1
  }
  diag "send-text pane=$DC_PANE branch=continuation len=${#DC_TEXT}"
  DC_SNAP=$(confirm_text_landed "$DC_PANE" "$DC_BASE")
  verified_submit "$DC_PANE" "$DC_SNAP"
}

# --- entry: --cleanup <task_id> (decide-close hook, best-effort) ---
if [ "${1:-}" = "--cleanup" ]; then
  if [ "$#" -ne 2 ]; then
    echo "usage: $0 --cleanup <task_id>" >&2
    exit 1
  fi
  CLEAN_TASK="$2"
  resolve_chain_root
  echo "launch: cleanup — reaping panes of task '$CLEAN_TASK'" >&2
  close_task_panes "$CLEAN_TASK" force
  exit 0
fi

# --- entry: [--fresh] <task_id> <role> [<agent>] (round hand-off) ---
FRESH=0
if [ "${1:-}" = "--fresh" ]; then
  FRESH=1
  shift
fi
if [ "$#" -lt 2 ]; then
  echo "usage: $0 [--fresh] <task_id> <role> [<agent> [<arg>...]]   |   $0 --cleanup <task_id>" >&2
  exit 1
fi

TASK_ID="$1"
ROLE="$2"
shift 2
resolve_chain_root
if [ "$#" -gt 0 ]; then
  set_route_from_invocation "$@" || exit 1
else
  ROUTE_DISPLAY=$(resolve_agent "$TASK_ID" "$ROLE") || exit 1
  set_route_from_invocation "$ROUTE_DISPLAY" || exit 1
fi

# Dual labels (4.4): tab label = template (human-facing; the pane label is
# the addressing key and stays fixed <task_id>.<role> — never templated).
TAB_LABEL=$(tab_label_for "$ROLE" "$TASK_ID" "$AGENT")
BIRTH_LABEL="${TASK_ID}.${ROLE}"

SKILL_FILE="$TUT_ROOT/skills/${ROLE}.md"
PROMPT="轮到你了（role: ${ROLE}）：请用 Context Hub 读取任务 ${TASK_ID} 的完整上下文（context.read），按你的 role skill（${SKILL_FILE}）开始本轮工作，完成后发布相应记录（context.publish）。"

# --fresh: the explicit outside-perspective choice — force-close this
# role's own panes (working included) before the birth below; idempotent
# when none exist. Continuation is bypassed by design (a fresh seat is the
# point); the narrowed reap for OTHER roles still runs in the birth branch.
if [ "$FRESH" -eq 1 ]; then
  echo "launch: --fresh — force-closing panes labeled '$BIRTH_LABEL' (explicit fresh choice, working included)" >&2
  close_task_panes "$TASK_ID" force "$ROLE"
fi

# Branch 1 — same-role continuation (4.4): a LIVE pane under the exact
# addressing key exists and the role is a continuity seat → deliver ONLY.
# No reap (the seat survives), no birth, no readiness gate (the seat's UI
# is already up) — the prompt plus a visible stderr note.
if [ "$FRESH" -ne 1 ] && is_continuity_role "$ROLE"; then
  CONT_PANE=$(find_live_pane "$BIRTH_LABEL")
  if [ -n "$CONT_PANE" ]; then
    echo "launch: same-role continuation — delivering to existing pane $CONT_PANE (label '$BIRTH_LABEL')" >&2
    if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
      echo "DRY-RUN: herdr pane send-text $CONT_PANE \"${PROMPT}\""
      echo "DRY-RUN: text-land check $CONT_PANE (timeout ${TUT_TEXT_LAND_TIMEOUT_MS:-5000}ms; on timeout submit anyway)"
      echo "DRY-RUN: herdr pane send-keys $CONT_PANE Enter"
      echo "DRY-RUN: submit verify $CONT_PANE (verify ${TUT_SUBMIT_TIMEOUT_MS:-3000}ms by input-box-cleared; then bounded Enter resend loop — interval ${TUT_SUBMIT_RETRY_MS:-1500}ms within ${TUT_SUBMIT_RETRY_TIMEOUT_MS:-30000}ms; exhaustion → manual-fallback note, still exit 0)"
      exit 0
    fi
    deliver_continuation "$CONT_PANE" "$PROMPT" || exit 1
    exit 0
  fi
fi

# Branch 2 — birth (role change / first round / dead pane / --fresh).
# Narrowed reap first: live continuity seats stay, dead panes of any role
# and non-continuity roles go, working is left for the next hook.
close_task_panes "$TASK_ID" ""

# Addressing-key guard: a LIVE `<T>.<role>` pane that survived the reap
# (e.g. a working seat with continuity disabled via TUT_CONTINUITY_ROLES="")
# must not be silently joined by a second pane under the same label — the
# key is unique and the reverse lookup depends on it. Loud abort instead;
# --fresh never reaches a hit (it force-closed its own panes above). Live
# runs only: dry-run simulates closes without executing them, so the pane
# list cannot reflect this run's closes — and there is no real birth to
# protect in a preview.
if [ "${TUT_DRY_RUN:-0}" != "1" ]; then
  GUARD_PANE=$(find_live_pane "$BIRTH_LABEL")
  if [ -n "$GUARD_PANE" ]; then
    echo "launch: live pane '$BIRTH_LABEL' ($GUARD_PANE) survived the reap — refusing to birth a second pane under the same label (use --fresh to force-close it)" >&2
    exit 1
  fi
fi

if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
  # Preview FIRST (uncaptured): dry-run birth prints its sequence on stdout,
  # so it must not run inside a command substitution that would swallow it.
  birth_pane "$TAB_LABEL" "$BIRTH_LABEL" "$AGENT" || exit 1
  TARGET="<label:${BIRTH_LABEL}>"
  echo "DRY-RUN: ready-probe ${TARGET} (born pane; floor ${TUT_READY_FLOOR_MS:-1500}ms, timeout ${TUT_READY_TIMEOUT_MS:-15000}ms)"
  echo "DRY-RUN: herdr pane send-text ${TARGET} (agent '${AGENT}', label '${BIRTH_LABEL}') \"${PROMPT}\""
  echo "DRY-RUN: text-land check ${TARGET} (timeout ${TUT_TEXT_LAND_TIMEOUT_MS:-5000}ms; on timeout submit anyway)"
  echo "DRY-RUN: herdr pane send-keys ${TARGET} Enter"
  echo "DRY-RUN: submit verify ${TARGET} (verify ${TUT_SUBMIT_TIMEOUT_MS:-3000}ms by input-box-cleared; then bounded Enter resend loop — interval ${TUT_SUBMIT_RETRY_MS:-1500}ms within ${TUT_SUBMIT_RETRY_TIMEOUT_MS:-30000}ms; exhaustion → manual-fallback note, still exit 0)"
  exit 0
fi

PANE_ID=$(birth_pane "$TAB_LABEL" "$BIRTH_LABEL" "$AGENT") || exit 1
if [ -z "${PANE_ID:-}" ]; then
  echo "launch: birth failed for agent '$AGENT' (label '$BIRTH_LABEL')" >&2
  exit 1
fi

deliver_prompt "$PANE_ID" "$PROMPT" || exit 1
exit 0
