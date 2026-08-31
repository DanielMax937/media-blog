#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:/Users/caoxiaopeng/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"
export no_proxy="${no_proxy:-127.0.0.1,localhost}"

PORT="${PORT:-9300}"
BASE_URL="${BLOG2MEDIA_BASE_URL:-http://127.0.0.1:${PORT}}"
HEALTH_URL="${BASE_URL%/}/api/health"
START_TIMEOUT_SECONDS="${BLOG2MEDIA_START_TIMEOUT_SECONDS:-45}"
POST_TIMEOUT_SECONDS="${BLOG2MEDIA_POST_TIMEOUT_SECONDS:-180}"
PAYLOAD="${BLOG2MEDIA_CRON_PAYLOAD:-{}}"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S %z'
}

is_healthy() {
  curl --noproxy '*' -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1
}

ensure_running() {
  if is_healthy; then
    return 0
  fi

  printf '[%s] blog2media health check failed; starting service\n' "$(timestamp)"
  ./start-bg.sh

  local deadline=$((SECONDS + START_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if is_healthy; then
      printf '[%s] blog2media is healthy\n' "$(timestamp)"
      return 0
    fi
    sleep 1
  done

  printf '[%s] blog2media did not become healthy within %ss\n' "$(timestamp)" "$START_TIMEOUT_SECONDS" >&2
  return 1
}

if [[ "${1:-}" == "--health-only" ]]; then
  ensure_running
  exit 0
fi

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s <rednote|medium|futures> | --health-only\n' "$0" >&2
  exit 64
fi

ENDPOINT="${1#/api/}"
ENDPOINT="${ENDPOINT#/}"
API_URL="${BASE_URL%/}/api/${ENDPOINT}"

ensure_running
printf '[%s] POST %s\n' "$(timestamp)" "$API_URL"
curl --noproxy '*' -sS --max-time "$POST_TIMEOUT_SECONDS" \
  -X POST "$API_URL" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD"
printf '\n'
