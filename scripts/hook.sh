#!/bin/sh
# POSIX thin shim for the Herdr plugin manifest: forwards the stdin event
# payload (and argv) to the canonical Node hook herdr-hook.mjs — mapping, state
# and label resolution all live there. The exit code passes through verbatim.
# (system-design 7.2 signal-source contract.)
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/herdr-hook.mjs" "$@"
