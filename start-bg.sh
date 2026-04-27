#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-9300}"
PID_FILE="${BLOG2MEDIA_PID_FILE:-./blog2media.pid}"
LOG_FILE="${BLOG2MEDIA_LOG_FILE:-./blog2media.log}"

if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "Port $PORT already in use. Stop the service first with: ./stop-bg.sh"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "──────────────────────────────────────────"
echo "  blog2media (Next.js)"
echo ""
echo "  URL:      http://127.0.0.1:${PORT}"
echo "  API doc:  ./docs/API.md"
echo "  Log file: $LOG_FILE"
echo "──────────────────────────────────────────"

start_detached() {
  python3 - "$LOG_FILE" <<'PY'
import os
import subprocess
import sys

log_file = sys.argv[1]
env = os.environ.copy()
with open(log_file, "ab", buffering=0) as log:
    proc = subprocess.Popen(
        ["npx", "next", "dev", "-H", "0.0.0.0", "-p", env.get("PORT", "9300")],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env=env,
    )
print(proc.pid)
PY
}

SERVICE_PID="$(PORT="$PORT" start_detached)"
echo "$SERVICE_PID" > "$PID_FILE"

sleep 2

if kill -0 "$SERVICE_PID" 2>/dev/null; then
  echo ""
  echo "✓ Service started (PID: $SERVICE_PID)"
else
  echo ""
  echo "✗ Failed to start (see $LOG_FILE)"
  rm -f "$PID_FILE"
  exit 1
fi

echo ""
echo "Commands:"
echo "  View logs:  tail -f $LOG_FILE"
echo "  Stop:       ./stop-bg.sh"
