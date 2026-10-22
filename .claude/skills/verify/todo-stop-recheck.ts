import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const [portText, runText] = process.argv.slice(2);
const run = resolve(runText);
const port = Number(portText);
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['home/.codex/app-server-control', 'evidence', 'bin', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const root = 'neo:10000000-0000-4000-8000-000000008115';
const old = Date.now() - 100 * 60_000;
const blockedAt = Date.now() - 5 * 60_000;
const ids = ['activity', 'sibling', 'still-stopped'];
const pinRemoval = process.env.VERIFY_PIN_REMOVAL === '1';
const removedId = 'removed-history';
const completeReport = 'Complete synthetic worker result 🦊\n'.repeat(4000);
const reportHash = (report: string) => createHash('sha256').update(report).digest('hex');
const rpcTimes: { name: string; ms: number }[] = [];
let sqlExecutions = 0, maxSqlMs = 0, maxLagMs = 0, peakRssBytes = process.memoryUsage().rss, lastTick = performance.now();
const unsubscribe = subscribeToStructuredLogs(log => {
  if (!pinRemoval || log.module !== 'hyperneo:daemon:sqlite.query' || log.metadata.workerKind) return;
  if (log.metadata.event === 'summary') sqlExecutions += Number(log.metadata.executionCount ?? 0);
  if (typeof log.metadata.durationMs === 'number') maxSqlMs = Math.max(maxSqlMs, log.metadata.durationMs);
  for (const q of (log.metadata.queries ?? []) as { maxDurationMs: number }[]) maxSqlMs = Math.max(maxSqlMs, q.maxDurationMs);
});
const lagTimer = pinRemoval ? setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now-lastTick-10); lastTick=now; peakRssBytes=Math.max(peakRssBytes,process.memoryUsage().rss); },10) : undefined;
const statePath = join(run, 'home/.codex/state_5.sqlite');
const state = new Database(statePath);
state.exec('CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT,updated_at_ms INTEGER); CREATE TABLE project_roots (project_id TEXT,position INTEGER,path TEXT); CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER,rollout_path TEXT,git_branch TEXT)');
for (const id of ids) {
  const rollout = join(run, `home/.codex/${id}.jsonl`);
  writeFileSync(rollout, JSON.stringify({ timestamp: new Date(old).toISOString(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Synthetic prior report.' } }) + '\n');
  state.prepare("INSERT INTO threads VALUES (?,?,'','',?,'vscode',0,?,?,NULL)").run(id, id, join(run, 'workspace'), old, rollout);
}
state.close();
const peerCalls: unknown[] = [];
const peer = Bun.serve({ unix: join(run, 'home/.codex/app-server-control/app-server-control.sock'),
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('websocket only', { status: 400 }); },
  websocket: { message(socket, bytes) {
    const call = JSON.parse(String(bytes));
    if (!('id' in call)) return;
    peerCalls.push(call);
    const result = call.method === 'thread/turns/list' ? { data: [] }
      : call.method === 'turn/start' ? { turn: { id: 'synthetic-new-sibling-turn' } }
      : call.method === 'thread/resume' ? { thread: { id: 'sibling', status: { type: 'idle' }, turns: [] } } : {};
    socket.send(JSON.stringify({ id: call.id, jsonrpc: '2.0', result }));
  } },
});
const evidence: Record<string, unknown> = { peerCalls };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: { ...getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), ...(pinRemoval ? { sqlQueryObservability: { slowThresholdMs:250, summaryIntervalMs:0, maxQueryGroups:1000, summaryQueryLimit:1000 } } : {}) }, verbose: false });
  await app.spaceRuntimeService.ready();
  const db = app.db.getDatabase();
  db.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic stop proof', ?, ?, ?, 'active', '{\"queryMode\":\"manual\"}', '{}')").run(root, join(run, 'workspace'), new Date(old).toISOString(), new Date(old).toISOString());
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({ id: 'synthetic-stop-ask', title: 'Synthetic stopped todo recovery', request: 'Observe only synthetic worker facts', sessionId: root, projectId: null, originMessageId: null, createdAt: old });
  for (const id of ids) {
    const todo = store.addTodo(id, 'synthetic-stop-ask', { title: id, doneWhen: 'Synthetic evidence observed', check: null, instruction: 'Synthetic work only', named: null }, old);
    sessions.create(id, { verb: 'send', ref: { adapter: 'codex-desktop', id } });
    sessions.recordRef(id, { adapter: 'codex-desktop', id }, old);
    sessions.recordFollowAnchor(id, old + 1);
    store.updateTodo(todo, { state: 'blocked', startedAt: old, report: 'Synthetic prior report.', blockedBy: 'worker', blockedReason: 'Its session stopped 90 min ago and nobody ticked it after 2 reminders.', nextAction: 'Continue the session, or close it.' }, blockedAt);
  }
  if (pinRemoval) {
    const todo = store.addTodo(removedId, 'synthetic-stop-ask', { title:'Removed worker history',doneWhen:'Synthetic removal',check:null,instruction:'Synthetic work',named:null },old);
    sessions.create(removedId,{verb:'send',ref:{adapter:'codex-desktop',id:'sibling'}});
    sessions.recordRef(removedId,{adapter:'codex-desktop',id:'sibling'},old);
    store.updateTodo(todo,{state:'doing',startedAt:old,report:completeReport},blockedAt);
  }
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('isolated RPC connect failed')); });
  const rpc = (name: string, input: unknown) => new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), requestAt = performance.now();
    const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (pinRemoval) rpcTimes.push({name,ms:performance.now()-requestAt}); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const refresh = async () => {
    const job = app!.jobQueue.enqueue({ queue: 'neo.work.driver.refresh', payload: { scope: 'neo' }, runAt: Date.now() });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const current = app!.jobQueue.getJob(job.id)!;
      if (current.status === 'completed') return current;
      assert.notEqual(current.status, 'dead', JSON.stringify(current));
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error('synthetic driver refresh did not complete');
  };
  if (pinRemoval) {
    const removeHandler = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => ({sessionId:root,role:'neo'}));
    const removalAt=performance.now();
    const reply = await removeHandler({name:'neo.todo.remove',input:{todoId:removedId,reason:'Synthetic explicit removal'}});
    assert.equal(reply.content[0].type,'text');
    const receipt=JSON.parse(reply.content[0].text);
    evidence.removalReceipt=receipt; evidence.removalMcpMs=performance.now()-removalAt;
    assert.equal(receipt.ok,true,JSON.stringify(receipt));
    assert.equal(receipt.todo.state,'removed');
    assert.equal(store.getTodo(removedId)?.report,completeReport);
    evidence.inputReport={bytes:Buffer.byteLength(completeReport),sha256:reportHash(completeReport)};
  }
  evidence.beforeSnapshot = await rpc('neo.snapshot', {});
  evidence.baselineJob = await refresh();
  evidence.baseline = ids.map(id => store.getTodo(id));
  assert(ids.every(id => store.getTodo(id)?.state === 'blocked'));
  const edit = new Database(statePath);
  edit.prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?').run(Date.now(), 'activity');
  edit.close();
  writeFileSync(join(run, 'home/.codex/activity.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'synthetic-activity-turn' } }) + '\n', { flag: 'a' });
  const handler = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const reply = await handler({ name: 'neo.todo.add', input: { askId: 'synthetic-stop-ask', title: 'Synthetic sibling starts', doneWhen: 'Synthetic facts observed', instruction: 'Synthetic sibling work', target: { verb: 'send', ref: { adapter: 'codex-desktop', id: 'sibling' } }, start: true } });
  assert.equal(reply.content[0].type, 'text');
  const started = JSON.parse(reply.content[0].text);
  evidence.siblingStart = started;
  assert.equal(started.todo?.state, 'doing', JSON.stringify(started));
  evidence.refreshJob = await refresh();
  evidence.after = ids.map(id => store.getTodo(id));
  evidence.afterSnapshot = await rpc('neo.snapshot', {});
  evidence.observed = Object.fromEntries(ids.map(id => [id, store.getTodo(id)?.state]));
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  assert.equal(store.getTodo('activity')?.state, 'doing', 'a new Codex turn must clear the stop block');
  assert.equal(store.getTodo('sibling')?.state, 'doing', 'a sibling start must clear the stop block');
  assert.equal(store.getTodo('still-stopped')?.state, 'blocked');
  const snapshotTodos = (evidence.afterSnapshot as { todoAsks: { todos: { id: string; state: string; blockedBy: unknown; blockedReason: unknown }[] }[] }).todoAsks.flatMap(entry => entry.todos);
  for (const id of ids) {
    const shown = snapshotTodos.find(todo => todo.id === id);
    assert.equal(shown?.state, id === 'still-stopped' ? 'blocked' : 'doing');
    if (id !== 'still-stopped') { assert.equal(shown?.blockedBy, null); assert.equal(shown?.blockedReason, null); }
  }
  for (const id of ['activity', 'sibling']) { const todo = store.getTodo(id)!; assert.equal(todo.blockedBy, null); assert.equal(todo.report, 'Synthetic prior report.'); }
  if (pinRemoval) {
    const removed=store.getTodo(removedId)!;
    assert.equal(removed.state,'removed'); assert.equal(removed.report,completeReport);
    evidence.removedAfterResume={state:removed.state,bytes:Buffer.byteLength(removed.report!),sha256:reportHash(removed.report!)};
    const starts=peerCalls.filter(call => (call as {method:string}).method==='turn/start').length;
    ws.close(); await app.cleanup(); app=undefined;
    app=await createDaemonApp({config:{...getConfig({port,host:'127.0.0.1',dbPath:join(run,'data/daemon.db')}),sqlQueryObservability:{slowThresholdMs:250,summaryIntervalMs:0,maxQueryGroups:1000,summaryQueryLimit:1000}},verbose:false});
    await app.spaceRuntimeService.ready();
    ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((done,fail)=>{ws!.onopen=()=>done();ws!.onerror=()=>fail(new Error('restart RPC connect failed'));});
    evidence.restartRefresh=await refresh();
    evidence.restartSnapshot=await rpc('neo.snapshot',{});
    const recovered=new NeoAskTodoRepository(app.db.getDatabase()).getTodo(removedId)!;
    assert.equal(recovered.state,'removed');assert.equal(recovered.report,completeReport);
    assert.equal(peerCalls.filter(call=>(call as {method:string}).method==='turn/start').length,starts,'restart must not redispatch removed work');
    evidence.removedAfterRestart={state:recovered.state,bytes:Buffer.byteLength(recovered.report!),sha256:reportHash(recovered.report!)};
    evidence.restartDidNotRedispatch=true;
  }
  console.log('PASS: real isolated refresh + Neo snapshot: activity/sibling -> doing; unchanged stop -> blocked; prior reports retained.');
} finally {
  ws?.close(); await app?.cleanup(); peer.stop(true);
  if(lagTimer)clearInterval(lagTimer);
  unsubscribe();
  if(pinRemoval){evidence.metrics={maxLagMs,maxObservedSqlMs:maxSqlMs,sqlExecutions,peakSampledRssBytes:peakRssBytes,rpcTimes};writeFileSync(join(run,'evidence/observed.json'),JSON.stringify(evidence,null,2));assert(sqlExecutions>0,'SQL timing unavailable: no executions observed');}
}
