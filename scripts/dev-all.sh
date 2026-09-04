#!/usr/bin/env bash
#
# Everything at once: the API, the dashboard, and the tunnel that makes both
# reachable from outside this machine.
#
# One process group, one Ctrl-C. If any of the three dies the rest come down
# with it, because a half-running demo is worse than a stopped one.
#
#   pnpm dev:all              api + web + tunnel
#   pnpm dev:all --no-tunnel  api + web only
#
# Runs from the repo root, like every other script here: .env, policy.yaml and
# data/ are all resolved relative to it.

set -euo pipefail
cd "$(dirname "$0")/.."

TUNNEL=1
for arg in "$@"; do
  case "$arg" in
    --no-tunnel) TUNNEL=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

pids=()

cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Prefixed, so three streams in one terminal stay readable.
run() {
  local label=$1; shift
  ( "$@" 2>&1 | sed -u "s/^/[$label] /" ) &
  pids+=($!)
}

run api pnpm dev
run web pnpm dev:web

if [[ $TUNNEL -eq 1 ]]; then
  if command -v ngrok >/dev/null 2>&1; then
    run tunnel pnpm ngrok
  else
    echo "[tunnel] ngrok is not installed — skipping. Local URLs still work." >&2
  fi
fi

# Any one of them exiting takes the whole thing down.
wait -n
echo
echo "One process exited. Stopping the rest." >&2
