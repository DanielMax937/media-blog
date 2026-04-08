#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-9300}"
PID_FILE="${BLOG2MEDIA_PID_FILE:-./blog2media.pid}"

if PID=$(lsof -ti:"$PORT" 2>/dev/null); then
  echo "Stopping blog2media on port $PORT (PID: $PID)..."
  echo "$PID" | xargs kill 2>/dev/null || true
  sleep 2
  if lsof -ti:"$PORT" >/dev/null 2>&1; then
    echo "Force stopping..."
    lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "✓ blog2media stopped"
  exit 0
fi

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping blog2media (PID: $PID)..."
    kill "$PID" 2>/dev/null || true
    sleep 2
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "✓ blog2media stopped"
  exit 0
fi

echo "No process found on port $PORT. blog2media not running."
exit 0
