#!/usr/bin/env bash
# Rebuild and (re)start the slash server on localhost:8765, detached from
# this shell. Safe to run repeatedly: it kills any stray instance first, so
# there is always exactly one process and exactly one open port afterwards.
#
# Notes (macOS): there is no `setsid` on macOS, so we detach with
# `nohup ... & disown` instead; a process kept alive by a shell/background
# job dies with it once that job is cleaned up. Startup takes ~35s (engine
# recovery + inbox fetch) before the HTTP port actually listens, so this
# script polls until the server responds instead of assuming it's ready
# right after starting it.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

BINARY="./slash-bin"
LOG_FILE="$REPO_ROOT/.claude/scripts/server.log"
ADDR="localhost:8765"
PORT="8765"
READY_URL="http://$ADDR/pr-overview"
READY_TIMEOUT=60

echo "== Killing stray slash-bin instance(s) on port $PORT =="
PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  echo "Found PID(s): $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 1
  # Fallback: force-kill anything still alive.
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "PID $pid still alive, sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
else
  echo "Nothing listening on port $PORT."
fi

echo "== Building $BINARY =="
go build -o "$BINARY" .

echo "== Starting $BINARY -addr $ADDR (detached) =="
nohup "$BINARY" -addr "$ADDR" >"$LOG_FILE" 2>&1 &
disown
NEW_PID=$!
echo "Started with PID $NEW_PID, logging to $LOG_FILE"

echo "== Waiting for $READY_URL to respond (timeout ${READY_TIMEOUT}s) =="
elapsed=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$READY_URL" 2>/dev/null)" = "200" ]; do
  if [ "$elapsed" -ge "$READY_TIMEOUT" ]; then
    echo "Server did not become ready within ${READY_TIMEOUT}s. Last log lines:"
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

echo "== Server is up =="
echo "PID: $NEW_PID"
echo "Port: $PORT"
echo "Log: $LOG_FILE"
