#!/bin/sh
# Signal-source contract (system-design 7.2).
# Usage: on-agent-event.sh <event> <agent> <pane>   event ∈ working | blocked | done
#
# Forwards the event to the Notifier's HTTP listener. COUPLING WARNING: if you
# change the notifier's --event-port, you must update TUT_EVENT_PORT_URL here
# (or export it in the Herdr plugin environment) — the two are configured
# independently by design (scripts may use env vars; the tut CLI does not).
# Unreachable notifier exits 0 silently: a lost event is acceptable because
# polling is the primary channel (system-design 6.1).

set -u

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <working|blocked|done> <agent> <pane>" >&2
  exit 1
fi

URL="${TUT_EVENT_PORT_URL:-http://127.0.0.1:3002/agent-event}"
# JSON-stringify the bare minimum (quotes/backslashes in names are not expected).
BODY=$(printf '{"event":"%s","agent":"%s","pane":"%s"}' "$1" "$2" "$3")

curl -s -m 2 -X POST -H "Content-Type: application/json" -d "$BODY" "$URL" >/dev/null 2>&1 || true
exit 0
