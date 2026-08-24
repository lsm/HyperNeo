#!/bin/bash
# deno-smoke.sh — Deno boot smoke test (dual-runtime support, task #1409).
#
# Boots the daemon under Deno and verifies the boot contract from the
# 2026-08 dual-runtime spike:
#   1. HTTP GET / answers 200 (there is no /api/health route)
#   2. the WebSocket /ws handshake completes
#   3. migrations ran — sqlite_master holds > 80 tables (read-only probe)
#   4. SIGTERM triggers a graceful shutdown
#
# Requires: deno on PATH (CI pins 2.9.4), curl, and node_modules populated by
# `bun install` (Deno resolves workspace npm deps from it).
#
# Usage: ./scripts/deno-smoke.sh
# Env:   DENO_SMOKE_PORT          port to boot on        (default 9283)
#        DENO_SMOKE_BOOT_TIMEOUT  HTTP readiness seconds (default 120)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PORT="${DENO_SMOKE_PORT:-9283}"
BOOT_TIMEOUT="${DENO_SMOKE_BOOT_TIMEOUT:-120}"

if ! command -v deno &> /dev/null; then
	echo "Error: deno is not on PATH (CI pins 2.9.4 via denoland/setup-deno)."
	exit 1
fi

WORK_DIR="$(mktemp -d)"
DB_PATH="$WORK_DIR/deno-smoke.db"
LOG_FILE="$WORK_DIR/daemon.log"

DAEMON_PID=""
cleanup() {
	if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2> /dev/null; then
		kill -9 "$DAEMON_PID" 2> /dev/null || true
	fi
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

dump_log() {
	echo "--- daemon log (last 50 lines of $LOG_FILE) ---"
	tail -n 50 "$LOG_FILE" || true
}

echo "[deno-smoke] $(deno --version | head -1)"
echo "[deno-smoke] port=$PORT db=$DB_PATH"

cd "$REPO_ROOT/packages/daemon"
HYPERNEO_PORT="$PORT" DB_PATH="$DB_PATH" \
	deno run -A main.ts > "$LOG_FILE" 2>&1 &
DAEMON_PID=$!

CODE="000"
READY=0
for _ in $(seq 1 "$BOOT_TIMEOUT"); do
	if ! kill -0 "$DAEMON_PID" 2> /dev/null; then
		echo "[deno-smoke] FAIL: daemon exited during startup"
		dump_log
		exit 1
	fi
	CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" || true)"
	if [ "$CODE" = "200" ]; then
		READY=1
		break
	fi
	sleep 1
done
if [ "$READY" != "1" ]; then
	echo "[deno-smoke] FAIL: no HTTP 200 on / within ${BOOT_TIMEOUT}s (last code: $CODE)"
	dump_log
	exit 1
fi
echo "[deno-smoke] HTTP GET / -> 200"

if ! SMOKE_WS_URL="ws://localhost:$PORT/ws" deno eval '
	const ws = new WebSocket(Deno.env.get("SMOKE_WS_URL"));
	const timer = setTimeout(() => {
		console.error("[deno-smoke] FAIL: /ws handshake timed out");
		Deno.exit(1);
	}, 15000);
	ws.addEventListener("open", () => {
		clearTimeout(timer);
		console.log("[deno-smoke] WebSocket /ws handshake OPEN");
		ws.close();
		Deno.exit(0);
	});
	ws.addEventListener("error", () => {
		clearTimeout(timer);
		console.error("[deno-smoke] FAIL: /ws handshake errored");
		Deno.exit(1);
	});
'; then
	dump_log
	exit 1
fi

if ! SMOKE_DB_PATH="$DB_PATH" deno eval '
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(Deno.env.get("SMOKE_DB_PATH"), { readOnly: true });
	const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = ?").get("table");
	db.close();
	const tables = Number(row.n);
	if (!(tables > 80)) {
		console.error(`[deno-smoke] FAIL: expected > 80 sqlite tables, found ${tables}`);
		Deno.exit(1);
	}
	console.log(`[deno-smoke] sqlite tables: ${tables} (> 80)`);
'; then
	dump_log
	exit 1
fi

echo "[deno-smoke] sending SIGTERM"
kill -TERM "$DAEMON_PID"
EXITED=0
for _ in $(seq 1 30); do
	if ! kill -0 "$DAEMON_PID" 2> /dev/null; then
		EXITED=1
		break
	fi
	sleep 1
done
if [ "$EXITED" != "1" ]; then
	echo "[deno-smoke] FAIL: daemon still alive 30s after SIGTERM"
	dump_log
	exit 1
fi
EXIT_STATUS=0
wait "$DAEMON_PID" || EXIT_STATUS=$?
if [ "$EXIT_STATUS" != "0" ]; then
	echo "[deno-smoke] FAIL: daemon exited with status $EXIT_STATUS after SIGTERM"
	dump_log
	exit 1
fi
if ! grep -q "Received SIGTERM, shutting down gracefully" "$LOG_FILE"; then
	echo "[deno-smoke] FAIL: no 'Received SIGTERM' shutdown log line"
	dump_log
	exit 1
fi
if ! grep -q "Graceful shutdown complete" "$LOG_FILE"; then
	echo "[deno-smoke] FAIL: no 'Graceful shutdown complete' log line"
	dump_log
	exit 1
fi
DAEMON_PID=""

echo "[deno-smoke] PASS: Deno daemon boots (HTTP 200, /ws OPEN, migrations, graceful SIGTERM)"
