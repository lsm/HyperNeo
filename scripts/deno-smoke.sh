#!/bin/bash
# deno-smoke.sh — Deno boot smoke test (dual-runtime support, task #1409).
#
# Boots the daemon under Deno and verifies the boot contract from the
# 2026-08 dual-runtime spike:
#   1. HTTP GET / answers 200 (there is no /api/health route)
#   2. the WebSocket /ws handshake completes and the system.health RPC
#      answers with status ok (boot wiring regression for issue #3563:
#      handler registration lives in setupRPCHandlers, invisible to unit shards)
#   3. migrations ran — sqlite_master holds > 80 tables (read-only probe)
#   4. SIGTERM triggers a graceful shutdown
#   5. a manual session status read opens and closes the read-only SDK worker
#
# Requires: deno on PATH (CI pins 2.9.4), curl, and node_modules populated by
# `bun install` (Deno resolves workspace npm deps from it).
#
# Usage: ./scripts/deno-smoke.sh
# Env:   DENO_SMOKE_PORT          port to boot on        (default 9283)
#        DENO_SMOKE_BOOT_TIMEOUT  HTTP readiness seconds (default 120)
#        DENO_SMOKE_BIN           path to a pre-built `deno compile` binary;
#                                 when set, the script boots that binary
#                                 instead of `deno run -A main.ts` (the same
#                                 four boot assertions are run unchanged
#                                 against the binary's HTTP server).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PORT="${DENO_SMOKE_PORT:-9283}"
[[ "$PORT" != 8399 ]]
BOOT_TIMEOUT="${DENO_SMOKE_BOOT_TIMEOUT:-120}"
DENO_SMOKE_BIN="${DENO_SMOKE_BIN:-}"

if ! command -v deno &> /dev/null; then
	echo "Error: deno is not on PATH (CI pins 2.9.4 via denoland/setup-deno; required for the /ws WebSocket probe even when DENO_SMOKE_BIN is set)."
	exit 1
fi
if [ -n "$DENO_SMOKE_BIN" ] && [ ! -x "$DENO_SMOKE_BIN" ]; then
	echo "Error: DENO_SMOKE_BIN is set to '$DENO_SMOKE_BIN' but the file is not executable."
	exit 1
fi

WORK_DIR="$(mktemp -d)"
DB_PATH="$WORK_DIR/deno-smoke.db"
LOG_FILE="$WORK_DIR/daemon.log"
mkdir -p "$WORK_DIR/home"

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

echo "[deno-smoke] port=$PORT db=$DB_PATH"
echo "[deno-smoke] $(deno --version | head -1)"
if [ -n "$DENO_SMOKE_BIN" ]; then
	echo "[deno-smoke] booting pre-built binary: $DENO_SMOKE_BIN"
fi

if [ -n "$DENO_SMOKE_BIN" ]; then
	env -i PATH="$PATH" NODE_ENV=test HOME="$WORK_DIR/home" HYPERNEO_DATA_DIR="$WORK_DIR/data" HYPERNEO_WORKSPACE_PATH="$WORK_DIR" HYPERNEO_PORT="$PORT" DB_PATH="$DB_PATH" \
		"$DENO_SMOKE_BIN" > "$LOG_FILE" 2>&1 &
else
	cd "$REPO_ROOT/packages/daemon"
	env -i PATH="$PATH" NODE_ENV=test HOME="$WORK_DIR/home" HYPERNEO_DATA_DIR="$WORK_DIR/data" HYPERNEO_WORKSPACE_PATH="$WORK_DIR" HYPERNEO_PORT="$PORT" DB_PATH="$DB_PATH" \
		deno run -A main.ts > "$LOG_FILE" 2>&1 &
fi
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
		const id = crypto.randomUUID();
		const rpcTimer = setTimeout(() => {
			console.error("[deno-smoke] FAIL: system.health RPC timed out");
			Deno.exit(1);
		}, 15000);
		ws.addEventListener("message", (event) => {
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch {
				return;
			}
			if (msg.requestId !== id && msg.id !== id) return;
			clearTimeout(rpcTimer);
			if (msg.error) {
				console.error(`[deno-smoke] FAIL: system.health errored: ${msg.error}`);
				Deno.exit(1);
			}
			const data = msg.data ?? {};
			if (data.status !== "ok") {
				console.error(`[deno-smoke] FAIL: system.health returned unexpected payload: ${JSON.stringify(data).slice(0, 200)}`);
				Deno.exit(1);
			}
			console.log("[deno-smoke] system.health RPC ok");
			ws.close();
			Deno.exit(0);
		});
		ws.send(JSON.stringify({
			id,
			type: "REQ",
			sessionId: "global",
			method: "system.health",
			data: {},
			timestamp: new Date().toISOString(),
			version: "1.0.0",
		}));
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

if ! SMOKE_WS_URL="ws://localhost:$PORT/ws" SMOKE_WORKSPACE_PATH="$WORK_DIR" deno eval '
	const ws = new WebSocket(Deno.env.get("SMOKE_WS_URL"));
	const timer = setTimeout(() => { console.error("SDK status reader RPC timed out"); Deno.exit(1); }, 15000);
	let sessionId, liveSnapshot = false;
	const send = (id, method, data) => ws.send(JSON.stringify({ id, method, data, type:"REQ", sessionId:"global", version:"1.0.0", timestamp:new Date().toISOString() }));
	ws.onopen = () => send("create", "session.create", {workspacePath:Deno.env.get("SMOKE_WORKSPACE_PATH"), config:{queryMode:"manual"}});
	ws.onmessage = ({data}) => {
		const reply = JSON.parse(data), id = reply.requestId ?? reply.id;
		if (reply.method === "liveQuery.snapshot" && reply.data.subscriptionId === "deno-live") {
			if (reply.data.rows.length !== 0) Deno.exit(1);
			liveSnapshot = true; return;
		}
		if (id !== "create" && id !== "status" && id !== "page" && id !== "live") return;
		if (reply.error) { console.error(JSON.stringify(reply.error)); Deno.exit(1); }
		if (id === "create") { sessionId=reply.data.sessionId; send("status", "session.messages.byStatus", {sessionId, status:"consumed", limit:20}); }
		else if (id === "status") {
			if (reply.data.total !== 0 || reply.data.messages.length !== 0) Deno.exit(1);
			send("page", "message.sdkMessages", {sessionId:reply.data.sessionId ?? sessionId,limit:20});
		} else if (id === "page") {
			if (reply.data.sdkMessages.length !== 0 || reply.data.backgroundTaskMessages.length !== 0) Deno.exit(1);
			send("live", "liveQuery.subscribe", {queryName:"messages.bySession", subscriptionId:"deno-live", params:[sessionId,20]});
		} else {
			if (!liveSnapshot || reply.data.ok !== true) Deno.exit(1);
			clearTimeout(timer); console.log("[deno-smoke] SDK status/page/live reader RPC ok"); ws.close(); Deno.exit(0);
		}
	};
'; then
	dump_log
	exit 1
fi

if ! SMOKE_DB_PATH="$DB_PATH" SMOKE_READER_PATH="$REPO_ROOT/packages/daemon/src/storage/sdk-status-reader.ts" deno eval --config "$REPO_ROOT/packages/daemon/deno.json" '
  const { SDKStatusReader } = await import("file://" + Deno.env.get("SMOKE_READER_PATH"));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(Deno.env.get("SMOKE_DB_PATH"));
  const body = "Complete synthetic turn-range history";
  const id = Number(db.prepare("INSERT INTO message_search_content(kind,source_id,session_id,message_type,title,body,timestamp) VALUES (?,?,?,?,?,?,?)").run("message","deno-turn-range","synthetic","user","Synthetic",body,1).lastInsertRowid);
  db.close();
  const reader = new SDKStatusReader(Deno.env.get("SMOKE_DB_PATH"));
  try {
    const rows = await reader.readPendingTurns("synthetic-model",3,32);
    if (!rows.some(row => row.id === id && row.text === body && row.bodyLength === body.length)) Deno.exit(1);
    if (await reader.countPendingTurns("synthetic-model",3) !== rows.length) Deno.exit(1);
    console.log("[deno-smoke] Turn-vector range/pending/count shared reader ok");
    const externalPath = Deno.env.get("SMOKE_DB_PATH") + ".codex";
    const external = new DatabaseSync(externalPath);
    external.exec("CREATE TABLE projects(id TEXT,name TEXT,updated_at_ms INTEGER); CREATE TABLE project_roots(project_id TEXT,path TEXT); CREATE TABLE threads(id TEXT,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER)");
    external.prepare("INSERT INTO projects VALUES (?,?,?)").run("p1","Synthetic Codex",1);
    external.prepare("INSERT INTO project_roots VALUES (?,?)").run("p1","/synthetic");
    external.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)").run("t1","Complete thread","","Full retained history","/synthetic","vscode",0,2);
    external.close();
    const snapshot = await reader.readCodexSnapshot(externalPath, false);
    if (snapshot.roots[0]?.projectId !== "p1" || snapshot.folders[0]?.openCount !== 1 || snapshot.threads[0]?.id !== "t1") Deno.exit(1);
    console.log("[deno-smoke] Codex external snapshot shared reader ok");
    const failed = reader.readCodexSnapshot(externalPath + ".missing",false).then(() => false, () => true);
    const status = reader.read({sessionId:"synthetic-empty",status:"consumed",limit:1});
    if (!await failed || (await status).total !== 0) Deno.exit(1);
    console.log("[deno-smoke] Codex external error preserves queued SDK read");
  } finally { await reader.close(); }
'; then dump_log; exit 1; fi

if ! SMOKE_DB_PATH="$DB_PATH" SMOKE_SRC="$REPO_ROOT/packages/daemon/src" deno eval --config "$REPO_ROOT/packages/daemon/deno.json" '
  const src = "file://" + Deno.env.get("SMOKE_SRC");
  const { DbGateway } = await import(src + "/storage/db-gateway/db-gateway.ts");
  const { recordWouldRefuse } = await import(src + "/storage/repositories/device-pairing-repository.ts");
  const gateway = new DbGateway(Deno.env.get("SMOKE_DB_PATH"), null);
  try {
    const seen = { reason: "host_not_allowed", kind: "ws", host: "deno-gateway.test", origin: null };
    await Promise.all([1, 2].map((now) => gateway.run(recordWouldRefuse, { seen, now })));
    const unknown = await gateway.run({ name: "deno.unknown", mode: "read", run: () => 1 }, undefined).then(() => false, () => true);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(Deno.env.get("SMOKE_DB_PATH"));
    try {
      const row = db.prepare("SELECT count FROM would_refuse_requests WHERE host = ?").get("deno-gateway.test");
      if (row?.count !== 2 || !unknown) Deno.exit(1);
    } finally { db.close(); }
    console.log("[deno-smoke] DB gateway writer serializes ops and rejects unknown ones");
  } finally { await gateway.close(); }
'; then
  dump_log
  exit 1
fi

if ! SMOKE_DB_PATH="$DB_PATH" SMOKE_SRC="$REPO_ROOT/packages/daemon/src" deno eval --config "$REPO_ROOT/packages/daemon/deno.json" '
  const src = "file://" + Deno.env.get("SMOKE_SRC");
  const { DbGateway } = await import(src + "/storage/db-gateway/db-gateway.ts");
  const { ingestSessionEvent } = await import(src + "/lib/external-events/session-external-event-store.ts");
  const { cleanupJobs, jobQueueWrites } = await import(src + "/storage/repositories/job-queue-repository.ts");
  const { purgeWorkFeedSessions } = await import(src + "/storage/work-feed.ts");
  const gateway = new DbGateway(Deno.env.get("SMOKE_DB_PATH"), null);
  try {
    const event = { id:"deno-writer", spaceId:"sessions", source:"github", topic:"github/synthetic/writer/pull_request/1.review_submitted", dedupeKey:"deno-once", occurredAt:1, ingestedAt:2, summary:"Synthetic", payload:{body:"complete synthetic result"} };
    const first = await gateway.run(ingestSessionEvent, event);
    const duplicate = await gateway.run(ingestSessionEvent, {...event,id:"deno-duplicate"});
    if (first.action !== "ingested" || duplicate.action !== "duplicate" || duplicate.eventId !== event.id) Deno.exit(1);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(Deno.env.get("SMOKE_DB_PATH"));
    try {
      const insert = db.prepare("INSERT INTO message_search_content(kind,source_id,session_id,message_type,title,body,timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const kind of ["claude", "codex"]) insert.run(kind, "deno-purge-"+kind, "deno-purge-sdk", "user", "Synthetic", "complete retained result", 1);
      await purgeWorkFeedSessions(gateway, "claude", ["deno-purge-sdk"]);
      const rows = db.prepare("SELECT kind,body FROM message_search_content WHERE session_id=?").all("deno-purge-sdk");
      if (rows.length !== 1 || rows[0].kind !== "codex" || rows[0].body !== "complete retained result") Deno.exit(1);
      console.log("[deno-smoke] Claude feed purge preserves other feed kinds");
      const now = Date.now(), hour = 3600000;
      const job = db.prepare("INSERT INTO job_queue(id,queue,status,payload,priority,max_retries,retry_count,run_at,created_at,completed_at) VALUES(?,?,?,?,0,3,0,?,?,?)");
      for (const [id,queue,status,age] of [["deno-cleanup-old","synthetic-cleanup","completed",8*24*hour],["deno-cleanup-reminder","longHorizonAgentReminder.fire","completed",2*hour],["deno-cleanup-keep","longHorizonAgentReminder.fire","failed",2*hour]]) job.run(id,queue,status,"{\"body\":\"complete retained job\"}",now-age,now-age,now-age);
      const count = await gateway.run(cleanupJobs, {beforeMs:now-7*24*hour,completed:[{queue:"longHorizonAgentReminder.fire",beforeMs:now-hour}]});
      const kept = db.prepare("SELECT id,payload FROM job_queue WHERE id LIKE ?").all("deno-cleanup-%");
      if (count !== 2 || kept.length !== 1 || kept[0].id !== "deno-cleanup-keep" || JSON.parse(kept[0].payload).body !== "complete retained job") Deno.exit(1);
      console.log("[deno-smoke] job cleanup preserves cutoffs and retained payloads");
      db.exec("PRAGMA busy_timeout=5000");
      const holder = new Worker("data:application/javascript," + encodeURIComponent(`
        import { DatabaseSync } from "node:sqlite";
        onmessage = ({data}) => {
          const db = new DatabaseSync(data);
          db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
          postMessage("acquired");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
          db.exec("COMMIT"); db.close();
        };
      `), {type:"module"});
      try {
        await new Promise((resolve, reject) => {
          holder.onmessage = () => resolve(null);
          holder.onerror = reject;
          holder.postMessage(Deno.env.get("SMOKE_DB_PATH"));
        });
        db.prepare("INSERT INTO job_queue(id,queue,status,payload,run_at,created_at) VALUES(?,?,?,?,?,?)").run("deno-claim", "synthetic-claim", "pending", "{\"body\":\"complete claim payload\"}", now, now);
        const claimed = await gateway.call(jobQueueWrites, "dequeue", "synthetic-claim", 5);
        const again = await gateway.call(jobQueueWrites, "dequeue", "synthetic-claim", 5);
        if (claimed.length !== 1 || again.length !== 0 || !claimed[0].claimToken || claimed[0].payload.body !== "complete claim payload") Deno.exit(1);
      } finally { holder.terminate(); }
      console.log("[deno-smoke] gateway claim is fenced and not duplicated");
    } finally { db.close(); }
    console.log("[deno-smoke] session event ingest commit/dedupe ok");
  } finally { await gateway.close(); }
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

echo "[deno-smoke] PASS: Deno daemon boots (HTTP 200, /ws OPEN, system.health, migrations, graceful SIGTERM)"
