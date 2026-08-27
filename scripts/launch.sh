#!/bin/sh
# POSIX compatibility entry only. The launcher implementation lives in the
# built Node CLI; this shim has no lifecycle or routing decisions.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/../dist/cli.js" launch "$@"
