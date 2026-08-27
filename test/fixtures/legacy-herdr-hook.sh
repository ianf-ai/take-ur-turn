#!/bin/sh
# VENDORED legacy Herdr hook (reference fixture — do not deploy).
# This is the pre-Node event-chain hook exactly as deployed at
# ~/.config/herdr/plugins/tut-notify/hook.sh (env-var transport + python3
# body), with only the machine-local default TUT_ON_AGENT_EVENT path
# parameterized to the repo sibling. It exists so the parity tests can run the
# OLD hook and the canonical Node hook (scripts/herdr-hook.mjs) side by side
# and assert identical observable semantics. Semantics preserved verbatim:
#   - payload from HERDR_PLUGIN_EVENT_JSON (NOT stdin — old transport);
#   - state under HERDR_PLUGIN_STATE_DIR (old fallback: bare /tmp), filename
#     tut-pane-status-<pane_id with ':'→'_'>.txt;
#   - idle AFTER working → done, other idle ignored;
#   - label via `herdr pane get` from HERDR_BIN_PATH, fallback raw pane_id;
#   - best-effort everywhere, exit 0.
set -u
EV_SCRIPT="${TUT_ON_AGENT_EVENT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)/scripts/on-agent-event.sh}"
[ -x "$EV_SCRIPT" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

TUT_EVENT_JSON="${HERDR_PLUGIN_EVENT_JSON:-}" \
TUT_HERDR_BIN="${HERDR_BIN_PATH:-}" \
TUT_STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-}" \
TUT_EV_SCRIPT="$EV_SCRIPT" python3 - <<'PY'
import json, os, subprocess, sys

try:
    data = json.loads(os.environ.get("TUT_EVENT_JSON") or "{}").get("data", {})
except ValueError:
    sys.exit(0)
status = data.get("agent_status")
agent = data.get("agent") or ""
pane_id = data.get("pane_id") or ""
if not pane_id or not agent or status not in ("idle", "working", "blocked", "done"):
    sys.exit(0)

state_dir = os.environ.get("TUT_STATE_DIR") or "/tmp"
state_file = os.path.join(state_dir, "tut-pane-status-" + pane_id.replace(":", "_") + ".txt")
try:
    with open(state_file) as f:
        prev = f.read().strip()
except OSError:
    prev = ""

event = None
if status in ("working", "blocked", "done"):
    event = status
elif status == "idle" and prev == "working":
    event = "done"  # focused/seen-tab finish reports idle; the turn did end
try:
    os.makedirs(state_dir, exist_ok=True)
    with open(state_file, "w") as f:
        f.write(status)
except OSError:
    pass
if event is None:
    sys.exit(0)

label = pane_id
herdr = os.environ.get("TUT_HERDR_BIN")
if herdr:
    try:
        out = subprocess.run(
            [herdr, "pane", "get", pane_id], capture_output=True, text=True, timeout=5
        )
        if out.returncode == 0:
            label = json.loads(out.stdout).get("result", {}).get("pane", {}).get("label") or pane_id
    except Exception:
        pass

try:
    subprocess.run(
        [os.environ["TUT_EV_SCRIPT"], event, agent, label],
        timeout=10,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
except Exception:
    pass  # a lost event is acceptable: polling is the primary channel (6.1)
PY
exit 0
