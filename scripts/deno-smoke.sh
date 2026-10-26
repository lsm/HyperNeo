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

SMOKE_TMP_ROOT=${TMPDIR:-/tmp}
WORK_DIR="$(mktemp -d "${SMOKE_TMP_ROOT%/}/deno-smoke.XXXXXX")"
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

# Repository fixtures own the migrated DB only after the daemon writer has exited.
echo "[deno-smoke] daemon stopped; running isolated database fixtures"

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
    db.exec("PRAGMA busy_timeout=5000");
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
      const { claudeDesktopOutboxWrites } = await import(src + "/storage/repositories/claude-desktop-outbox-repository.ts");
      const sid = "3b286924-739c-487d-82d2-c3e36fd5ed36";
      const queued = await gateway.call(claudeDesktopOutboxWrites, "enqueueReported", sid, "session:neo", {kind:"submit",text:"complete synthetic prompt"});
      const reported = db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE queue = ? AND payload LIKE ?").get("mailbox", "%driver:claude-desktop:" + sid + "%");
      const reply = await gateway.call(claudeDesktopOutboxWrites, "exchange", {version:1,sessionId:sid,instanceId:sid+":1:1",events:[{sequence:1,kind:"session.start"}]}, 4242, true);
      const journal = db.prepare("SELECT last_sequence FROM claude_desktop_bridge_instances WHERE session_id = ?").get(sid);
      if (!queued.id || reported.n !== 1 || reply.ack !== 1 || reply.command?.id !== queued.id || journal?.last_sequence !== 1) Deno.exit(1);
      console.log("[deno-smoke] Claude Desktop outbox report and bridge exchange commit on the gateway");
      const { neoTodoSessionReads, neoTodoSessionWrites } = await import(src + "/storage/repositories/neo-todo-session-repository.ts");
      const { codingTodoPrReads } = await import(src + "/lib/neo/packs/coding/todo-prs.ts");
      db.prepare("INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,1,1)").run("deno-todo-ask", "deno-root", "Synthetic todo", "Observe");
      db.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,started_at,created_at,updated_at) VALUES(?,?,0,?,?,?,1,1,1)").run("deno-todo", "deno-todo-ask", "Synthetic step", "Observed", "doing");
      db.prepare("INSERT INTO neo_todo_sessions(todo_id,target) VALUES(?,?)").run("deno-todo", "{}");
      const starts = await gateway.call(neoTodoSessionReads, "unrecordedStarts");
      const reports = await gateway.call(neoTodoSessionReads, "awaitingReports");
      const window = await gateway.call(codingTodoPrReads, "window", "deno-todo");
      const changed = await gateway.call(neoTodoSessionWrites, "recordLive", "deno-todo", "running", undefined);
      const unchanged = await gateway.call(neoTodoSessionWrites, "recordLive", "deno-todo", "running", undefined);
      if (!starts.includes("deno-todo") || reports.some(row => row.todoId === "deno-todo") || window.start !== 1 || window.end !== null || !changed || unchanged) Deno.exit(1);
      if (db.prepare("SELECT live_status AS status FROM neo_todo_sessions WHERE todo_id=?").get("deno-todo").status !== "running") Deno.exit(1);
      console.log("[deno-smoke] todo recovery, PR window and committed live status use DB workers");
      const dispatched = await gateway.call(neoTodoSessionWrites, "recordDispatch", {todoId:"deno-todo",askId:"deno-todo-ask",ref:{adapter:"hyperneo",id:"deno-worker"},startedAt:2,observed:{model:"synthetic-model",effort:"high"},keepIdentity:false,sent:{inputBefore:0,opening:"Complete synthetic instruction"}});
      const receipt = db.prepare("SELECT ref,actual_model,sent_opening FROM neo_todo_sessions WHERE todo_id=?").get("deno-todo");
      if (!dispatched.askOpen || dispatched.todo?.id !== "deno-todo" || JSON.parse(receipt.ref).id !== "deno-worker" || receipt.actual_model !== "synthetic-model" || receipt.sent_opening !== "Complete synthetic instruction") Deno.exit(1);
      db.exec("CREATE TRIGGER reject_todo_receipt BEFORE UPDATE OF sent_opening ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, \u0027synthetic refusal\u0027); END");
      let refused = false;
      try { await gateway.call(neoTodoSessionWrites, "recordDispatch", {todoId:"deno-todo",askId:"deno-todo-ask",ref:{adapter:"hyperneo",id:"rejected-worker"},observed:{},keepIdentity:true,sent:null}); } catch { refused = true; }
      db.exec("DROP TRIGGER reject_todo_receipt");
      if (!refused || JSON.parse(db.prepare("SELECT ref FROM neo_todo_sessions WHERE todo_id=?").get("deno-todo").ref).id !== "deno-worker") Deno.exit(1);
      console.log("[deno-smoke] dispatch assignment and receipt commit or roll back together");
      const { neoTodoReads } = await import(src + "/storage/repositories/neo-ask-todo-repository.ts");
      const cards = await gateway.call(neoTodoReads, "snapshot", undefined, 50);
      const page = await gateway.call(neoTodoReads, "doneTodoFacts", "deno-read-missing");
      const checks = await gateway.call(neoTodoReads, "listCheckable");
      if (!Array.isArray(cards.asks) || !(cards.facts.links instanceof Map) || page.ask !== null || page.todos.length || !Array.isArray(checks)) Deno.exit(1);
      console.log("[deno-smoke] Neo card, done-page and check-list reader commands preserve snapshots");
    } finally { db.close(); }
    console.log("[deno-smoke] session event ingest commit/dedupe ok");
  } finally { await gateway.close(); }
'; then
  dump_log
  exit 1
fi

if ! SMOKE_DB_PATH="$DB_PATH" SMOKE_SRC="$REPO_ROOT/packages/daemon/src" deno eval --config "$REPO_ROOT/packages/daemon/deno.json" '
  const src = Deno.env.get("SMOKE_SRC"), path = Deno.env.get("SMOKE_DB_PATH");
  const { Database } = await import(src + "/storage/sqlite-compat.ts");
  const { DbGateway } = await import(src + "/storage/db-gateway/db-gateway.ts");
  const { neoTodoSessionWrites } = await import(src + "/storage/repositories/neo-todo-session-repository.ts");
  const db = new Database(path), gateway = new DbGateway(path), id = "deno-progress-todo";
  try {
    db.prepare("INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,1,1)").run("deno-progress-ask", "deno-root", "Synthetic progress", "Observe");
    db.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,created_at,updated_at) VALUES(?,?,0,?,?,1,1)").run(id, "deno-progress-ask", "Synthetic step", "Observed");
    db.prepare("INSERT INTO neo_todo_sessions(todo_id,target,live_status,needs_you_since,started_at) VALUES(?,?,?,?,?)").run(id, "{}", "needs_you", 900, 1);
    const progress = {landed:42,live:{status:"running",lastActivityAt:42},cardStatus:"running"};
    if (!await gateway.call(neoTodoSessionWrites, "recordProgress", id, progress, 43)) Deno.exit(1);
    const read = () => db.prepare("SELECT started_at AS startedAt,checked_at AS checkedAt,live_status AS live,needs_you_since AS needs,unchecked FROM neo_todo_sessions WHERE todo_id=?").get(id);
    let row = read();
    if (row.startedAt !== 42 || row.checkedAt !== 43 || row.live !== "running" || row.needs !== null || row.unchecked !== 0) Deno.exit(1);
    db.prepare("UPDATE neo_todo_sessions SET started_at=?,live_status=?,needs_you_since=? WHERE todo_id=?").run(1, "needs_you", 900, id);
    db.exec("CREATE TRIGGER reject_progress_check BEFORE UPDATE OF checked_at ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, \u0027synthetic progress refusal\u0027); END");
    let refused = false;
    try { await gateway.call(neoTodoSessionWrites, "recordProgress", id, {...progress,landed:99}, 100); }
    catch (error) { refused = String(error).includes("synthetic progress refusal"); }
    db.exec("DROP TRIGGER reject_progress_check");
    row = read();
    if (!refused || row.startedAt !== 1 || row.checkedAt !== 43 || row.live !== "needs_you" || row.needs !== 900) Deno.exit(1);
    console.log("[deno-smoke] worker progress commits and rolls back all timestamps, status and incident state together");
    db.prepare("UPDATE neo_todos SET state=? WHERE id=?").run("doing", id);
    db.prepare("UPDATE neo_todo_sessions SET needs_you_since=NULL WHERE todo_id=?").run(id);
    const claims = await Promise.all([gateway.call(neoTodoSessionWrites, "claimNeedsYou", id, 10), gateway.call(neoTodoSessionWrites, "claimNeedsYou", id, 11)]);
    if (claims.filter(Boolean).length !== 1 || claims.find(Boolean).id !== id || read().needs !== 10) Deno.exit(1);
    db.prepare("UPDATE neo_todo_sessions SET needs_you_since=NULL WHERE todo_id=?").run(id);
    db.exec("CREATE TRIGGER reject_needs_you BEFORE UPDATE OF needs_you_since ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, \u0027synthetic incident refusal\u0027); END");
    refused = false;
    try { await gateway.call(neoTodoSessionWrites, "claimNeedsYou", id, 12); }
    catch (error) { refused = String(error).includes("synthetic incident refusal"); }
    db.exec("DROP TRIGGER reject_needs_you");
    if (!refused || read().needs !== null) Deno.exit(1);
    db.prepare("UPDATE neo_todos SET state=? WHERE id=?").run("done", id);
    if (await gateway.call(neoTodoSessionWrites, "claimNeedsYou", id, 13) !== null || read().needs !== null) Deno.exit(1);
    console.log("[deno-smoke] needs-you writer admits one notice and refuses failed or closed incidents");
    const ref = {adapter:"hyperneo",id:"synthetic-nudge-worker"}, live = {status:"stopped",lastActivityAt:1};
    db.prepare("UPDATE neo_todos SET state=?,instruction=?,updated_at=1 WHERE id=?").run("doing", "Continue synthetic work", id);
    db.prepare("UPDATE neo_todo_sessions SET target=?,ref=? WHERE todo_id=?").run(JSON.stringify({verb:"send",ref}), JSON.stringify(ref), id);
    const { neoTodoSessionReads } = await import(src + "/storage/repositories/neo-todo-session-repository.ts");
    if (!(await gateway.call(neoTodoSessionReads, "nudgeContext", id))?.todo.instruction) Deno.exit(1);
    const reminders = await Promise.all([gateway.call(neoTodoSessionWrites, "claimNudge", id, ref, live, 1200001, 1), gateway.call(neoTodoSessionWrites, "claimNudge", id, ref, live, 1200001, 1)]);
    if (reminders.filter(Boolean).length !== 1 || reminders.find(Boolean).plan.nudges !== 1) Deno.exit(1);
    await gateway.call(neoTodoSessionWrites, "finishNudge", id, 1, 1, 0);
    if (!(await gateway.call(neoTodoSessionWrites, "claimNudge", id, ref, live, 1200001, 1))) Deno.exit(1);
    db.prepare("UPDATE pack_facts SET value_json=? WHERE todo_id=? AND pack=? AND key=?").run(JSON.stringify({since:99,nudges:0}), id, "core", "nudge");
    await gateway.call(neoTodoSessionWrites, "finishNudge", id, 1, 1, 3);
    const incident = JSON.parse(db.prepare("SELECT value_json FROM pack_facts WHERE todo_id=? AND pack=? AND key=?").get(id, "core", "nudge").value_json);
    if (incident.since !== 99 || incident.nudges !== 0) Deno.exit(1);
    console.log("[deno-smoke] reminder reservation has one winner, permits release and preserves newer activity");
    const { codingTodoPrReads } = await import(src + "/lib/neo/packs/coding/todo-prs.ts");
    if (await gateway.call(codingTodoPrReads, "isWaiting", "missing-waiting-todo")) Deno.exit(1);
    for (const state of ["OPEN", "CLOSED", "MERGED"]) {
      db.prepare("INSERT OR REPLACE INTO pack_coding_todo_prs(todo_id,prs_json,read_at) VALUES(?,?,1)").run(id, JSON.stringify([{url:"https://github.com/example/synthetic/pull/1",state,checks:"none",review:"none"}]));
      if (await gateway.call(codingTodoPrReads, "isWaiting", id) !== (state === "OPEN")) Deno.exit(1);
    }
    console.log("[deno-smoke] cached PR waiting reader preserves missing, open, closed and merged decisions");
    const { neoTodoWrites } = await import(src + "/storage/repositories/neo-ask-todo-repository.ts");
    const stateId = "deno-state-first", nextId = "deno-state-next", body = "Complete report 🦊".repeat(1000);
    db.prepare("INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,1,1)").run("deno-state-ask", "deno-root", "Atomic state", "Complete both");
    for (const [position, todoId] of [stateId, nextId].entries()) db.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,started_at,report,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1)").run(todoId, "deno-state-ask", position, todoId, "Observed", position ? "todo" : "doing", position ? null : 1, body);
    db.prepare("INSERT INTO neo_questions(id,ask_id,text,kind,start_todos,created_at) VALUES(?,?,?,?,?,1)").run("deno-state-question", "deno-state-ask", "Start first?", "start", JSON.stringify([stateId]));
    const stateRead = () => db.prepare("SELECT state FROM neo_todos WHERE id=?").get(stateId).state;
    const questionRead = () => db.prepare("SELECT state FROM neo_questions WHERE id=?").get("deno-state-question").state;
    db.exec("CREATE TRIGGER refuse_state_ask BEFORE UPDATE OF updated_at ON neo_asks BEGIN SELECT RAISE(ABORT, \u0027synthetic state refusal\u0027); END");
    refused = false;
    try { await gateway.call(neoTodoWrites, "commitState", stateId, {}, 10, {state:"done",evidence:"Complete"}); }
    catch (error) { refused = String(error).includes("synthetic state refusal"); }
    db.exec("DROP TRIGGER refuse_state_ask");
    if (!refused || stateRead() !== "doing" || questionRead() !== "open") Deno.exit(1);
    const committed = await gateway.call(neoTodoWrites, "commitState", stateId, {}, 11, {state:"done",evidence:"Complete"});
    if (committed.todo.state !== "done" || committed.startNext !== nextId || committed.todo.report !== body || questionRead() !== "retired" || db.prepare("SELECT state FROM neo_todos WHERE id=?").get(nextId).state !== "todo") Deno.exit(1);
    console.log("[deno-smoke] todo state, pruning and ask stamps commit together; next work is returned without dispatch");
    for (const missingId of ["deno-unknown-state", "deno-deleted-state"]) {
      if (missingId === "deno-deleted-state") {
        db.prepare("INSERT INTO neo_todos(id,ask_id,position,title,done_when,created_at,updated_at) VALUES(?,?,2,?,?,1,1)").run(missingId, "deno-state-ask", "Deleted step", "Observed");
        db.prepare("DELETE FROM neo_todos WHERE id=?").run(missingId);
      }
      const missing = await gateway.call(neoTodoWrites, "commitState", missingId, {}, 20, {state:"done",evidence:"Late completion"});
      if (missing.todo !== null || missing.startNext !== null || stateRead() !== "done" || questionRead() !== "retired") Deno.exit(1);
    }
    console.log("[deno-smoke] missing and deleted todo state commands return empty results without changing siblings");
  } finally { db.close(); await gateway.close(); }
'; then
  dump_log
  exit 1
fi

TODO_MUTATION_RUN="$WORK_DIR/todo-mutation-command"
mkdir -p "$TODO_MUTATION_RUN/home" "$TODO_MUTATION_RUN/tmp"
env -i HOME="$TODO_MUTATION_RUN/home" PATH="$PATH" TMPDIR="$TODO_MUTATION_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$TODO_MUTATION_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/todo-mutation-command.ts" verify "$TODO_MUTATION_RUN"

NEO_SETTINGS_RUN="$WORK_DIR/neo-settings-writer"
mkdir -p "$NEO_SETTINGS_RUN/home" "$NEO_SETTINGS_RUN/tmp"
env -i HOME="$NEO_SETTINGS_RUN/home" PATH="$PATH" TMPDIR="$NEO_SETTINGS_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$NEO_SETTINGS_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/neo-settings-writer.ts" verify "$NEO_SETTINGS_RUN"

CLEANUP_ENQUEUE_RUN="$WORK_DIR/cleanup-enqueue"
mkdir -p "$CLEANUP_ENQUEUE_RUN/home"
env -i HOME="$CLEANUP_ENQUEUE_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$CLEANUP_ENQUEUE_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-cleanup-enqueue.ts" "$CLEANUP_ENQUEUE_RUN"

MAILBOX_ADMISSION_RUN="$WORK_DIR/mailbox-admission"
mkdir -p "$MAILBOX_ADMISSION_RUN/home"
env -i HOME="$MAILBOX_ADMISSION_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$MAILBOX_ADMISSION_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-mailbox-admission.ts" "$MAILBOX_ADMISSION_RUN"

EVENT_SUBMISSION_RUN="$WORK_DIR/event-submission"
mkdir -p "$EVENT_SUBMISSION_RUN/home"
env -i HOME="$EVENT_SUBMISSION_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$EVENT_SUBMISSION_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-event-submission.ts" "$EVENT_SUBMISSION_RUN"

DELIVERY_PARKING_RUN="$WORK_DIR/delivery-parking"
mkdir -p "$DELIVERY_PARKING_RUN/home"
env -i HOME="$DELIVERY_PARKING_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$DELIVERY_PARKING_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-delivery-parking.ts" "$DELIVERY_PARKING_RUN"

RATE_LIMIT_CANCEL_RUN="$WORK_DIR/rate-limit-cancel"
mkdir -p "$RATE_LIMIT_CANCEL_RUN/home"
env -i HOME="$RATE_LIMIT_CANCEL_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$RATE_LIMIT_CANCEL_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-rate-limit-cancel.ts" "$RATE_LIMIT_CANCEL_RUN"

OWNED_WITHDRAWAL_RUN="$WORK_DIR/owned-withdrawal"
mkdir -p "$OWNED_WITHDRAWAL_RUN/home"
env -i HOME="$OWNED_WITHDRAWAL_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$OWNED_WITHDRAWAL_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-owned-input-withdrawal.ts" "$OWNED_WITHDRAWAL_RUN"

RATE_LIMIT_RETRY_RUN="$WORK_DIR/rate-limit-retry"
mkdir -p "$RATE_LIMIT_RETRY_RUN/home"
env -i HOME="$RATE_LIMIT_RETRY_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$RATE_LIMIT_RETRY_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-rate-limit-retry.ts" "$RATE_LIMIT_RETRY_RUN"

PROVIDER_RPC_WRITES_RUN="$WORK_DIR/provider-rpc-writes"
mkdir -p "$PROVIDER_RPC_WRITES_RUN/home"
env -i HOME="$PROVIDER_RPC_WRITES_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$PROVIDER_RPC_WRITES_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-c-provider-rpc-writes.ts" "$PROVIDER_RPC_WRITES_RUN"

CREDENTIAL_STORE_WRITES_RUN="$WORK_DIR/credential-store-writes"
mkdir -p "$CREDENTIAL_STORE_WRITES_RUN/home"
env -i HOME="$CREDENTIAL_STORE_WRITES_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$CREDENTIAL_STORE_WRITES_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-c-credential-store-writes.ts" "$CREDENTIAL_STORE_WRITES_RUN"

SESSION_DELIVERY_ENQUEUE_RUN="$WORK_DIR/session-delivery-enqueue"
mkdir -p "$SESSION_DELIVERY_ENQUEUE_RUN/home"
env -i HOME="$SESSION_DELIVERY_ENQUEUE_RUN/home" PATH="$PATH" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$SESSION_DELIVERY_ENQUEUE_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-session-delivery-enqueue.ts" "$SESSION_DELIVERY_ENQUEUE_RUN"

STALE_RECLAIM_RUN="$WORK_DIR/stale-reclaim-writer"
mkdir -p "$STALE_RECLAIM_RUN/home" "$STALE_RECLAIM_RUN/tmp"
env -i HOME="$STALE_RECLAIM_RUN/home" PATH="$PATH" TMPDIR="$STALE_RECLAIM_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$STALE_RECLAIM_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-stale-reclaim-writer.ts" "$STALE_RECLAIM_RUN"

MAILBOX_EXPIRY_RUN="$WORK_DIR/mailbox-expiry-writer"
mkdir -p "$MAILBOX_EXPIRY_RUN/home" "$MAILBOX_EXPIRY_RUN/tmp"
env -i HOME="$MAILBOX_EXPIRY_RUN/home" PATH="$PATH" TMPDIR="$MAILBOX_EXPIRY_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$MAILBOX_EXPIRY_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-mailbox-expiry-writer.ts" "$MAILBOX_EXPIRY_RUN"

GITHUB_POLL_SUCCESSOR_RUN="$WORK_DIR/github-poll-successor-writer"
mkdir -p "$GITHUB_POLL_SUCCESSOR_RUN/home" "$GITHUB_POLL_SUCCESSOR_RUN/tmp"
env -i HOME="$GITHUB_POLL_SUCCESSOR_RUN/home" PATH="$PATH" TMPDIR="$GITHUB_POLL_SUCCESSOR_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$GITHUB_POLL_SUCCESSOR_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-github-poll-successor-writer.ts" "$GITHUB_POLL_SUCCESSOR_RUN"

TODO_EDIT_WRITER_RUN="$WORK_DIR/todo-edit-writer"
mkdir -p "$TODO_EDIT_WRITER_RUN/home" "$TODO_EDIT_WRITER_RUN/tmp"
env -i HOME="$TODO_EDIT_WRITER_RUN/home" PATH="$PATH" TMPDIR="$TODO_EDIT_WRITER_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$TODO_EDIT_WRITER_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/todo-edit-writer.ts" verify "$TODO_EDIT_WRITER_RUN"
NATIVE_FEED_ENQUEUE_RUN="$WORK_DIR/native-feed-enqueue-writer"
mkdir -p "$NATIVE_FEED_ENQUEUE_RUN/home" "$NATIVE_FEED_ENQUEUE_RUN/tmp"
env -i HOME="$NATIVE_FEED_ENQUEUE_RUN/home" PATH="$PATH" TMPDIR="$NATIVE_FEED_ENQUEUE_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$NATIVE_FEED_ENQUEUE_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-native-feed-enqueue-writer.ts" "$NATIVE_FEED_ENQUEUE_RUN"

SESSION_TITLE_ENQUEUE_RUN="$WORK_DIR/session-title-enqueue-writer"
mkdir -p "$SESSION_TITLE_ENQUEUE_RUN/home" "$SESSION_TITLE_ENQUEUE_RUN/tmp"
env -i HOME="$SESSION_TITLE_ENQUEUE_RUN/home" PATH="$PATH" TMPDIR="$SESSION_TITLE_ENQUEUE_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$SESSION_TITLE_ENQUEUE_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-session-title-enqueue-writer.ts" "$SESSION_TITLE_ENQUEUE_RUN"

SKILL_VALIDATION_ENQUEUE_RUN="$WORK_DIR/skill-validation-enqueue-writer"
mkdir -p "$SKILL_VALIDATION_ENQUEUE_RUN/home" "$SKILL_VALIDATION_ENQUEUE_RUN/tmp"
env -i HOME="$SKILL_VALIDATION_ENQUEUE_RUN/home" PATH="$PATH" TMPDIR="$SKILL_VALIDATION_ENQUEUE_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$SKILL_VALIDATION_ENQUEUE_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-c-skill-validation-enqueue-writer.ts" "$SKILL_VALIDATION_ENQUEUE_RUN"

GITHUB_POLL_REFRESH_RUN="$WORK_DIR/github-poll-refresh-writer"
mkdir -p "$GITHUB_POLL_REFRESH_RUN/home" "$GITHUB_POLL_REFRESH_RUN/tmp"
env -i HOME="$GITHUB_POLL_REFRESH_RUN/home" PATH="$PATH" TMPDIR="$GITHUB_POLL_REFRESH_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$GITHUB_POLL_REFRESH_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-c-github-poll-refresh-writer.ts" "$GITHUB_POLL_REFRESH_RUN"

GITHUB_POLL_REFRESH_RETRY_RUN="$WORK_DIR/github-poll-refresh-retry"
mkdir -p "$GITHUB_POLL_REFRESH_RETRY_RUN/home" "$GITHUB_POLL_REFRESH_RETRY_RUN/tmp"
env -i HOME="$GITHUB_POLL_REFRESH_RETRY_RUN/home" PATH="$PATH" TMPDIR="$GITHUB_POLL_REFRESH_RETRY_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$GITHUB_POLL_REFRESH_RETRY_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-c-github-poll-refresh-retry.ts" "$GITHUB_POLL_REFRESH_RETRY_RUN"

GITHUB_POLL_STARTUP_DEGRADED_RUN="$WORK_DIR/github-poll-startup-degraded"
mkdir -p "$GITHUB_POLL_STARTUP_DEGRADED_RUN/home" "$GITHUB_POLL_STARTUP_DEGRADED_RUN/tmp"
env -i HOME="$GITHUB_POLL_STARTUP_DEGRADED_RUN/home" PATH="$PATH" TMPDIR="$GITHUB_POLL_STARTUP_DEGRADED_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$GITHUB_POLL_STARTUP_DEGRADED_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-c-github-poll-startup-degraded.ts" "$GITHUB_POLL_STARTUP_DEGRADED_RUN"

GITHUB_POLL_CAPABILITY_FAILURE_RUN="$WORK_DIR/github-poll-capability-failure"
mkdir -p "$GITHUB_POLL_CAPABILITY_FAILURE_RUN/home" "$GITHUB_POLL_CAPABILITY_FAILURE_RUN/tmp"
env -i HOME="$GITHUB_POLL_CAPABILITY_FAILURE_RUN/home" PATH="$PATH" TMPDIR="$GITHUB_POLL_CAPABILITY_FAILURE_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$GITHUB_POLL_CAPABILITY_FAILURE_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-c-github-poll-capability-failure.ts" "$GITHUB_POLL_CAPABILITY_FAILURE_RUN"

TRANSCRIPT_SESSION_READER_RUN="$WORK_DIR/transcript-session-reader"
mkdir -p "$TRANSCRIPT_SESSION_READER_RUN/home" "$TRANSCRIPT_SESSION_READER_RUN/tmp"
env -i HOME="$TRANSCRIPT_SESSION_READER_RUN/home" PATH="$PATH" TMPDIR="$TRANSCRIPT_SESSION_READER_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$TRANSCRIPT_SESSION_READER_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-transcript-session-reader.ts" "$TRANSCRIPT_SESSION_READER_RUN"

SESSION_LIST_READER_RUN="$WORK_DIR/session-list-reader"
mkdir -p "$SESSION_LIST_READER_RUN/home" "$SESSION_LIST_READER_RUN/tmp"
env -i HOME="$SESSION_LIST_READER_RUN/home" PATH="$PATH" TMPDIR="$SESSION_LIST_READER_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$SESSION_LIST_READER_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-session-list-reader.ts" "$SESSION_LIST_READER_RUN"

SESSION_LIST_LIVE_READER_RUN="$WORK_DIR/session-list-live-reader"
mkdir -p "$SESSION_LIST_LIVE_READER_RUN/home" "$SESSION_LIST_LIVE_READER_RUN/tmp"
env -i HOME="$SESSION_LIST_LIVE_READER_RUN/home" PATH="$PATH" TMPDIR="$SESSION_LIST_LIVE_READER_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$SESSION_LIST_LIVE_READER_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-session-list-live-reader.ts" "$SESSION_LIST_LIVE_READER_RUN"

HEALTH_SESSION_COUNT_READER_RUN="$WORK_DIR/health-session-count-reader"
mkdir -p "$HEALTH_SESSION_COUNT_READER_RUN/home" "$HEALTH_SESSION_COUNT_READER_RUN/tmp"
env -i HOME="$HEALTH_SESSION_COUNT_READER_RUN/home" PATH="$PATH" TMPDIR="$HEALTH_SESSION_COUNT_READER_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$HEALTH_SESSION_COUNT_READER_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-health-session-count-reader.ts" "$HEALTH_SESSION_COUNT_READER_RUN"

PROJECTED_SESSION_READER_RUN="$WORK_DIR/projected-session-reader"
mkdir -p "$PROJECTED_SESSION_READER_RUN/home" "$PROJECTED_SESSION_READER_RUN/tmp"
env -i HOME="$PROJECTED_SESSION_READER_RUN/home" PATH="$PATH" TMPDIR="$PROJECTED_SESSION_READER_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$PROJECTED_SESSION_READER_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-projected-session-reader.ts" "$PROJECTED_SESSION_READER_RUN"

PROJECTED_SYSTEM_BROADCAST_FAILURE_RUN="$WORK_DIR/projected-system-broadcast-failure"
mkdir -p "$PROJECTED_SYSTEM_BROADCAST_FAILURE_RUN/home" "$PROJECTED_SYSTEM_BROADCAST_FAILURE_RUN/tmp"
env -i HOME="$PROJECTED_SYSTEM_BROADCAST_FAILURE_RUN/home" PATH="$PATH" TMPDIR="$PROJECTED_SYSTEM_BROADCAST_FAILURE_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$PROJECTED_SYSTEM_BROADCAST_FAILURE_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-projected-system-broadcast-failure.ts" "$PROJECTED_SYSTEM_BROADCAST_FAILURE_RUN"

TRANSCRIPT_SHUTDOWN_ORDER_RUN="$WORK_DIR/transcript-shutdown-order"
mkdir -p "$TRANSCRIPT_SHUTDOWN_ORDER_RUN/home" "$TRANSCRIPT_SHUTDOWN_ORDER_RUN/tmp"
env -i HOME="$TRANSCRIPT_SHUTDOWN_ORDER_RUN/home" PATH="$PATH" TMPDIR="$TRANSCRIPT_SHUTDOWN_ORDER_RUN/tmp" NODE_ENV=test \
	HYPERNEO_DATA_DIR="$TRANSCRIPT_SHUTDOWN_ORDER_RUN/data" LOG_LEVEL=warn \
	deno run -A --no-check "$REPO_ROOT/.claude/skills/verify/lane-b-transcript-shutdown-order.ts" "$TRANSCRIPT_SHUTDOWN_ORDER_RUN"

echo "[deno-smoke] PASS: Deno daemon boots (HTTP 200, /ws OPEN, system.health, migrations, graceful SIGTERM)"
