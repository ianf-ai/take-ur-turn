#!/bin/sh
# Launcher contract (system-design 7.2). Usage:
#   launch.sh <task_id> <role> [<agent>]   # round hand-off (start-next / auto)
#   launch.sh --new <label> "<text>"       # deliver a NEW-task kickoff verbatim (tut new)
#
# Routing: panes are AGENT-keyed (pane label = agent name). The round
# entry resolves the agent for <role> through the chain
#   task cast (GET /state, TUT_HUB_URL env, default http://127.0.0.1:3001)
#   → workspace.json roles.<role>.agent → routes.json value (legacy ≡ agent)
#   → DEFAULT_ROLES — mirroring src/workspace.ts resolveAgent (dual
# implementation kept during the legacy-label transition, to be unified). Callers that already resolved
# the agent (tut start-next, Notifier) pass it as the 3rd arg and the script
# skips its own /state read. If the hub is unreachable the script falls back
# to the file chain (default lineup) with a stderr note.
#
# Pane lookup (system-design 4.4): 1) label == agent → hit; 2) label ==
# legacy label (workspace.json label field / DEFAULT arch|exec|review) →
# hit with a stderr rename hint (legacy transition); 3) miss →
# ON-DEMAND provisioning:
#     command -v <agent>            # not on PATH → error exit 1
#     base pane: $TUT_SPLIT_BASE, else the first pane in the list
#     herdr pane split <base> --direction right --no-focus
#     herdr tab create --label <agent>
#     herdr pane move <new> --tab <tab> --split down
#     herdr pane rename <new> <agent>
#     herdr pane run <new> <agent>
# Provisioning failures exit 1 AFTER the caller's launch marker — recover
# with start-next --force. TUT_DRY_RUN=1 prints commands instead of running
# them (tests use this); in dry-run a pane miss prints the provisioning
# sequence and a failed resolution is not fatal (no live Herdr required).
#
# Readiness-gated delivery tail: after provisioning (or a pane hit) the prompt is NOT sent
# with `pane run` — its type+submit rides the terminal's bracketed-paste path
# and races a freshly born TUI's mode switches (observed twice: text in the
# composer, Enter lost, 0.0% status; one live capture even leaked [200~ paste
# markers into the shell). Delivery is instead, in order:
#   ready-probe (born panes only): poll `herdr pane read <pane>
#     --source visible --lines 40` until the output differs from the
#     post-echo baseline AND is stable for two consecutive polls AND the floor
#     wait has elapsed (TUT_READY_FLOOR_MS, default 1500; poll interval
#     TUT_READY_POLL_MS, default 250) — i.e. the receiver's UI has painted and
#     its input loop is live. TUT_READY_TIMEOUT_MS (default 15000) caps the
#     wait; on timeout the prompt is delivered anyway with a stderr note
#     (never worse than the pre-fix behavior).
#   herdr pane send-text <pane> "<prompt>"   literal text, no paste markers
#                                             (byte-verified vs cat -v)
#   herdr pane send-keys <pane> Enter        explicit commit
#
# The --new entry delivers its prompt verbatim to the pane labeled <label>
# (tut new passes the architect's agent name); a miss provisions on demand
# the same way when <label> is a command on PATH.
#
# Callers pass the absolute path to this script (module-relative resolution
# on the tut side); the script itself never depends on cwd.

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TUT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORKSPACE_FILE="$SCRIPT_DIR/workspace.json"
ROUTES_FILE="$SCRIPT_DIR/routes.json"
HUB_URL="${TUT_HUB_URL:-http://127.0.0.1:3001}"

# --- helpers ---------------------------------------------------------------------

pane_list_json() {
  herdr pane list 2>/dev/null || true
}

# pane_id of the first pane whose label equals $1; empty when no hit / no herdr.
find_pane_by_label() {
  pane_list_json | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const list = JSON.parse(raw);
    const panes = list?.result?.panes ?? list?.panes ?? [];
    const hit = panes.find((p) => p.label === process.argv[1]);
    if (hit) process.stdout.write(hit.pane_id);
  } catch {}
});
' "$1"
}

# Agent for $1 (role) from the file chain only: workspace.json agent →
# routes.json value (legacy ≡ agent name) → DEFAULT_ROLES agent.
agent_from_files() {
  node -e '
const fs = require("fs");
const role = process.argv[3];
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};
const seat = readJson(process.argv[1])?.roles?.[role];
if (typeof seat === "object" && seat !== null && typeof seat.agent === "string" && seat.agent.length > 0) {
  process.stdout.write(seat.agent);
  process.exit(0);
}
const route = readJson(process.argv[2])?.[role];
if (typeof route === "string" && route.length > 0) {
  process.stdout.write(route); // legacy label value ≡ agent name
  process.exit(0);
}
const defaults = { architect: "codex", executor: "pi", reviewer: "codex" };
process.stdout.write(defaults[role] ?? "codex");
' "$WORKSPACE_FILE" "$ROUTES_FILE" "$1" </dev/null
}

# Legacy pane label for $1 (role): workspace.json label field → DEFAULT map.
legacy_label_of() {
  node -e '
const fs = require("fs");
const role = process.argv[2];
try {
  const seat = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))?.roles?.[role];
  if (typeof seat === "object" && seat !== null && typeof seat.label === "string" && seat.label.length > 0) {
    process.stdout.write(seat.label);
    process.exit(0);
  }
} catch {}
const defaults = { architect: "arch", executor: "exec", reviewer: "review" };
process.stdout.write(defaults[role] ?? role);
' "$WORKSPACE_FILE" "$1" </dev/null
}

# Resolve the full agent chain for ($1 task_id, $2 role): cast via /state,
# then files. Prints the agent; on hub failure falls back to files with a
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
    const agent = entry?.cast?.[process.argv[2]];
    if (typeof agent === "string" && agent.length > 0) process.stdout.write(agent);
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

# On-demand provisioning (system-design 4.4): raise a pane for agent $1.
# Prints the new pane_id. Dry-run prints the sequence and exits 0 WITHOUT a
# pane id (callers fall back to a placeholder target). Requires the agent on
# PATH and a base pane ($TUT_SPLIT_BASE or the first pane).
provision_pane() {
  AG="$1"
  if ! command -v "$AG" >/dev/null 2>&1; then
    if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
      echo "DRY-RUN: provision skipped: agent '$AG' not on PATH"
      return 0
    fi
    echo "launch: agent '$AG' not on PATH — cannot provision a pane for it" >&2
    return 1
  fi
  BASE="${TUT_SPLIT_BASE:-}"
  if [ -z "$BASE" ]; then
    BASE=$(pane_list_json | node -e '
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const list = JSON.parse(raw);
    const panes = list?.result?.panes ?? list?.panes ?? [];
    if (panes.length > 0) process.stdout.write(panes[0].pane_id);
  } catch {}
});
' 2>/dev/null || true)
  fi
  if [ -z "$BASE" ]; then
    if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
      # Preview-only fallback: no reachable base pane (no Herdr session) —
      # show the sequence with a placeholder instead of failing the preview.
      BASE="<base>"
    else
      echo "launch: no base pane to split from — set TUT_SPLIT_BASE or start Herdr" >&2
      return 1
    fi
  fi
  if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
    echo "DRY-RUN: provision pane for agent '$AG': herdr pane split $BASE --direction right --no-focus"
    echo "DRY-RUN: provision: herdr tab create --label $AG"
    echo "DRY-RUN: provision: herdr pane move <new> --tab <$AG> --split down"
    echo "DRY-RUN: provision: herdr pane rename <new> $AG"
    echo "DRY-RUN: provision: herdr pane run <new> $AG"
    return 0
  fi
  NEW=$(herdr pane split "$BASE" --direction right --no-focus 2>/dev/null | node -e '
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
  [ -n "$NEW" ] || { echo "launch: herdr pane split returned no pane_id" >&2; return 1; }
  TAB=$(herdr tab create --label "$AG" 2>/dev/null | node -e '
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
  [ -n "$TAB" ] || { echo "launch: herdr tab create returned no tab id" >&2; return 1; }
  herdr pane move "$NEW" --tab "$TAB" --split down >/dev/null 2>&1 || {
    echo "launch: herdr pane move $NEW --tab $TAB failed" >&2
    return 1
  }
  herdr pane rename "$NEW" "$AG" >/dev/null 2>&1 || {
    echo "launch: herdr pane rename $NEW $AG failed" >&2
    return 1
  }
  herdr pane run "$NEW" "$AG" >/dev/null 2>&1 || {
    echo "launch: herdr pane run $NEW $AG failed" >&2
    return 1
  }
  echo "$NEW"
}

# Resolve $1 (a pane label = agent name, or a legacy label) to a live
# pane_id in the GLOBAL PANE_ID: agent-named hit → legacy hit (with a stderr
# hint) → on-demand provisioning. Also sets GLOBAL BORN="born" when the pane
# was raised by provisioning this run (readiness-gated delivery applies),
# cleared on pane hits. In dry-run a miss prints the provisioning sequence
# and leaves PANE_ID empty (placeholder target). Exit code non-zero on
# provisioning failure.
pane_for_agent() {
  AG="$1"; ROLE="$2"
  PANE_ID=$(find_pane_by_label "$AG")
  if [ -n "$PANE_ID" ]; then
    BORN=""
    return 0
  fi
  LEGACY=$(legacy_label_of "$ROLE")
  if [ "$LEGACY" != "$AG" ]; then
    PANE_ID=$(find_pane_by_label "$LEGACY")
    if [ -n "$PANE_ID" ]; then
      echo "launch: pane '$LEGACY' carries role $ROLE's legacy label (panes are agent-keyed) — consider: herdr pane rename $PANE_ID $AG" >&2
      BORN=""
      return 0
    fi
  fi
  if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
    provision_pane "$AG" || return 1 # prints the DRY-RUN sequence; PANE_ID stays empty
    PANE_ID=""
    BORN="born"
    return 0
  fi
  PANE_ID=$(provision_pane "$AG") || {
    BORN=""
    return 1
  }
  BORN="born"
}

# --- readiness-gated delivery ----------------------------------------------------

# Terminal text of pane $1 (probe input). --source visible: the rendered
# screen — available on every pane from birth (herdr 0.8's "recent"
# snapshots proved UNRELIABLE on freshly born panes: two live cases served
# 0 bytes for seconds while visible showed the screen; one woke after a
# pane move, another worked without a move — no dependable rule, so the
# probe uses visible, which worked on every pane tested).
pane_output() {
  herdr pane read "$1" --source visible --lines 40 2>/dev/null || true
}

# Wait until the freshly born pane $1 shows its receiver: the output must
# have CHANGED from the baseline captured right after `pane run <agent>`
# (the shell echo of the agent command — the change is the agent's first
# paint) and be STABLE for two consecutive polls, no earlier than the floor
# wait. On timeout: deliver anyway (stderr note) — never worse than before.
wait_born_ready() {
  WBR_PANE="$1"
  WBR_POLL_MS="${TUT_READY_POLL_MS:-250}"
  WBR_FLOOR_POLLS=$(( ${TUT_READY_FLOOR_MS:-1500} / WBR_POLL_MS ))
  WBR_MAX_POLLS=$(( ${TUT_READY_TIMEOUT_MS:-15000} / WBR_POLL_MS ))
  WBR_SLEEP=$(awk "BEGIN{printf \"%.3f\", $WBR_POLL_MS/1000}")
  WBR_BASE=$(pane_output "$WBR_PANE")
  WBR_PREV="$WBR_BASE"
  WBR_I=0
  while [ "$WBR_I" -lt "$WBR_MAX_POLLS" ]; do
    sleep "$WBR_SLEEP"
    WBR_OUT=$(pane_output "$WBR_PANE")
    if [ -n "$WBR_OUT" ] && [ "$WBR_OUT" != "$WBR_BASE" ] && [ "$WBR_OUT" = "$WBR_PREV" ] && [ "$WBR_I" -ge "$WBR_FLOOR_POLLS" ]; then
      return 0
    fi
    WBR_PREV="$WBR_OUT"
    WBR_I=$(( WBR_I + 1 ))
  done
  echo "launch: born pane $WBR_PANE not observed ready within $(( WBR_MAX_POLLS * WBR_POLL_MS ))ms — delivering anyway (if the text idles in the input box, press Enter there)" >&2
  return 0
}

# Deliver $2 to pane $1. $3="born" → readiness-gate first. Text goes out
# literally (send-text) and is committed by a discrete Enter key press.
deliver_prompt() {
  DL_PANE="$1"; DL_TEXT="$2"; DL_BORN="${3:-}"
  if [ -n "$DL_BORN" ]; then
    wait_born_ready "$DL_PANE"
  fi
  herdr pane send-text "$DL_PANE" "$DL_TEXT" >/dev/null || {
    echo "launch: herdr pane send-text $DL_PANE failed" >&2
    return 1
  }
  herdr pane send-keys "$DL_PANE" Enter >/dev/null || {
    echo "launch: herdr pane send-keys $DL_PANE Enter failed" >&2
    return 1
  }
  return 0
}

# --- entry: --new <label> "<prompt text>" (verbatim delivery; no round template) ---
if [ "${1:-}" = "--new" ]; then
  if [ "$#" -ne 3 ]; then
    echo "usage: $0 --new <label> \"<text>\"" >&2
    exit 1
  fi
  NEW_LABEL="$2"
  NEW_PROMPT="$3"
  BORN=""
  PANE_ID=$(find_pane_by_label "$NEW_LABEL")
  if [ -z "$PANE_ID" ]; then
    if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
      # tolerated miss (tests, no live Herdr): preview provisioning only when
      # the label is a real command on PATH; placeholder target either way.
      if command -v "$NEW_LABEL" >/dev/null 2>&1; then
        provision_pane "$NEW_LABEL" || exit 1
        BORN="born"
      fi
    elif command -v "$NEW_LABEL" >/dev/null 2>&1; then
      # The target agent has no pane yet — raise one on demand (label =
      # agent name).
      PANE_ID=$(provision_pane "$NEW_LABEL") || exit 1
      BORN="born"
    fi
  fi
  if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
    TARGET="${PANE_ID:-<label:${NEW_LABEL}>}"
    if [ -n "$BORN" ]; then
      echo "DRY-RUN: ready-probe ${TARGET} (born pane; floor ${TUT_READY_FLOOR_MS:-1500}ms, timeout ${TUT_READY_TIMEOUT_MS:-15000}ms)"
    fi
    echo "DRY-RUN: herdr pane send-text ${TARGET} (label '${NEW_LABEL}') \"${NEW_PROMPT}\""
    echo "DRY-RUN: herdr pane send-keys ${TARGET} Enter"
    exit 0
  fi
  if [ -z "${PANE_ID:-}" ]; then
    echo "launch: no pane labeled '$NEW_LABEL' and it is not a command on PATH — rename one (herdr pane rename <pane_id> $NEW_LABEL) or install the agent" >&2
    exit 1
  fi
  deliver_prompt "$PANE_ID" "$NEW_PROMPT" "$BORN" || exit 1
  exit 0
fi

# --- entry: <task_id> <role> [<agent>] (round hand-off) ---
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <task_id> <role> [<agent>]   |   $0 --new <label> \"<text>\"" >&2
  exit 1
fi

TASK_ID="$1"
ROLE="$2"
AGENT="${3:-}"
if [ -z "$AGENT" ]; then
  AGENT=$(resolve_agent "$TASK_ID" "$ROLE")
fi

PANE_ID=""
BORN=""
pane_for_agent "$AGENT" "$ROLE"
if [ $? -ne 0 ]; then
  exit 1
fi

SKILL_FILE="$TUT_ROOT/skills/${ROLE}.md"
PROMPT="轮到你了（role: ${ROLE}）：请用 Context Hub 读取任务 ${TASK_ID} 的完整上下文（context.read），按你的 role skill（${SKILL_FILE}）开始本轮工作，完成后发布相应记录（context.publish）。"

if [ "${TUT_DRY_RUN:-0}" = "1" ]; then
  TARGET="${PANE_ID:-<agent:${AGENT}>}"
  if [ -n "$BORN" ]; then
    echo "DRY-RUN: ready-probe ${TARGET} (born pane; floor ${TUT_READY_FLOOR_MS:-1500}ms, timeout ${TUT_READY_TIMEOUT_MS:-15000}ms)"
  fi
  echo "DRY-RUN: herdr pane send-text ${TARGET} (agent '${AGENT}') \"${PROMPT}\""
  echo "DRY-RUN: herdr pane send-keys ${TARGET} Enter"
  exit 0
fi

if [ -z "${PANE_ID:-}" ]; then
  echo "launch: no pane for agent '$AGENT' and provisioning is unavailable" >&2
  exit 1
fi

deliver_prompt "$PANE_ID" "$PROMPT" "$BORN" || exit 1
exit 0
