#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$SCRIPT_DIR/runtime-server.pid"
PORT="${PORT:-3080}"
if [ -f "$PIDFILE" ]; then
  kill -9 "$(cat "$PIDFILE")" >/dev/null 2>&1 || true
  rm -f "$PIDFILE"
fi
if command -v lsof >/dev/null 2>&1; then
  lsof -ti tcp:"$PORT" | xargs -r kill -9 >/dev/null 2>&1 || true
fi
echo "Zatrzymano Virtual Server Manager."
