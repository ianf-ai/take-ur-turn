#!/bin/sh
# POSIX compatibility entry only. The canonical implementation is the sibling
# Node entry on-agent-event.mjs (same package): JSON.stringify body, Node fetch
# + AbortController (2s), unreachable notifier → exit 0, argv contract errors →
# exit 1. This shim forwards argv and the exit code verbatim — no transport
# decisions of its own. (system-design 7.2 signal-source contract.)
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/on-agent-event.mjs" "$@"
