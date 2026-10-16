#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
PORT="${PORT:-3080}"
URL="http://127.0.0.1:${PORT}"
LOGFILE="$SCRIPT_DIR/runtime-server.log"
PIDFILE="$SCRIPT_DIR/runtime-server.pid"

echo "=== Virtual Server Manager 0.90.0 / Linux ==="
command -v node >/dev/null 2>&1 || { echo "Node.js nie jest zainstalowany."; exit 1; }
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  npm install --no-fund --no-audit
fi
if command -v lsof >/dev/null 2>&1; then
  lsof -ti tcp:"$PORT" | xargs -r kill -9 >/dev/null 2>&1 || true
fi
rm -f "$PIDFILE"
PORT="$PORT" nohup node server.js >> "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
for _ in $(seq 1 45); do
  if command -v curl >/dev/null 2>&1 && curl -fsS "$URL/api/health" >/dev/null 2>&1; then
    echo "OK: $URL"
    exit 0
  fi
  sleep 1
done
echo "Serwer nie odpowiedział. Sprawdź $LOGFILE"
exit 1
