import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const part of ['home/.codex/app-server-control', 'workspace', 'bin', 'evidence'])
  mkdirSync(join(run, part), { recursive: true });
const root = 'neo:10000000-0000-4000-8000-000000008230';
const at = Date.now();
const report = '  Complete explicit worker result 🔬\n'.repeat(1000) + '\n';
const prior = '  Previously stored report 🦊\n';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const pr = 'https://github.com/synthetic/results/pull/1';
writeFileSync(join(run, 'pr.json'), JSON.stringify({ url: pr, state: 'OPEN', headRefOid: 'a'.repeat(40), reviews: [], statusCheckRollup: [] }));
writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}
const fs=require('node:fs'),run=${JSON.stringify(run)},args=process.argv.slice(2);
fs.appendFileSync(run+'/evidence/gh.log',JSON.stringify(args)+'\\n');
if(args[0]!=='pr'||args[1]!=='view'||!args.includes(${JSON.stringify(pr)}))process.exit(2);
process.stdout.write(fs.readFileSync(run+'/pr.json','utf8'));
`, { mode: 0o700 });
const external = new Database(join(run, 'home/.codex/state_5.sqlite'));
external.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,updated_at_ms INTEGER);CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,first_user_message TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at_ms INTEGER,rollout_path TEXT,git_branch TEXT)');
const rollout = join(run, 'home/.codex/next.jsonl');
writeFileSync(rollout, '');
external.prepare("INSERT INTO threads VALUES ('next','next','','',?,'vscode',0,?,?,NULL)").run(join(run, 'workspace'), at, rollout);
external.close();
const calls: { method: string; params: Record<string, unknown> }[] = [];
const peer = Bun.serve({ unix: join(run, 'home/.codex/app-server-control/app-server-control.sock'),
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('websocket', { status: 400 }); },
  websocket: { message(socket, bytes) {
    const call = JSON.parse(String(bytes));
    if (!('id' in call)) return;
    calls.push(call);
    const result = call.method === 'thread/turns/list' ? { data: [] }
      : call.method === 'thread/resume' ? { thread: { id: 'next', status: { type: 'idle' }, turns: [] } }
      : call.method === 'turn/start' ? { turn: { id: crypto.randomUUID() } } : {};
    socket.send(JSON.stringify({ id: call.id, jsonrpc: '2.0', result }));
  } },
});
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let store: NeoAskTodoRepository;
let sessions: NeoTodoSessionRepository;
const evidence: Record<string, unknown> = { mode, calls, report: { bytes: Buffer.byteLength(report), sha256: hash(`Agent: ${report}`) } };
const open = async () => {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  store = new NeoAskTodoRepository(app.db.getDatabase());
  sessions = new NeoTodoSessionRepository(app.db.getDatabase());
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC unavailable')); });
};
const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => fail(new Error(name + ' timeout')), 20000);
  ws!.onmessage = (event) => {
    const result = JSON.parse(String(event.data));
    if (result.id !== id && result.requestId !== id) return;
    clearTimeout(timer);
    result.error ? fail(new Error(JSON.stringify(result.error))) : done(result.data);
  };
  ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
const refresh = async () => {
  const job = app!.jobQueue.enqueue({ queue: 'neo.work.driver.refresh', payload: { scope: 'neo' }, runAt: Date.now() });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const current = app!.jobQueue.getJob(job.id)!;
    if (current.status === 'completed') return;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('Driver refresh did not finish');
};
const seedSession = (id: string) => app!.db.createSession({ id, title: 'Synthetic result proof', workspacePath: join(run, 'workspace'), createdAt: new Date(at).toISOString(), lastActiveAt: new Date(at + 100).toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
const put = (worker: string, id: string, type: string, text: string, consumed: number) => {
  const body = type === 'result' ? { type, subtype: 'success', result: text, is_error: false } : { type, message: { content: [{ type: 'text', text }] } };
  app!.db.getDatabase().prepare("INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,consumed_seq,is_terminal) VALUES (?,?,?,?,?,?,'consumed',?,?)").run(id, worker, id, type, JSON.stringify(body), new Date(at + consumed).toISOString(), consumed, type === 'result' ? 1 : 0);
};
const seed = (id: string, packed: boolean, receipt: boolean) => {
  store.openAsk({ id, title: id, request: 'Synthetic explicit worker result', sessionId: root, projectId: null, originMessageId: null, createdAt: at });
  const todo = store.addTodo(id, id, { title: id, doneWhen: packed ? 'Synthetic PR merged' : 'Human confirms result', check: packed ? { pack: 'coding', kind: 'pr_merged', params: { urls: [pr] } } : null, instruction: `Perform ${id}`, named: null }, at - 100);
  seedSession(id);
  const ref = { adapter: 'hyperneo', id };
  sessions.create(id, { verb: 'send', ref });
  sessions.recordRef(id, ref, at);
  sessions.recordSent(id, { inputBefore: at, opening: `Perform ${id}`, ...(receipt ? { receipt: { executionId: id, inputId: `${id}-input` } } : {}) });
  store.updateTodo(todo, { state: 'doing', startedAt: at, report: prior }, at);
  put(id, `${id}-input`, 'user', `Perform ${id}`, 10);
  put(id, `${id}-result`, 'result', report, 20);
  put(id, `${id}-later`, 'user', 'Unrelated later input', 30);
  put(id, `${id}-later-result`, 'result', 'UNRELATED LATER RESULT', 40);
};
const starts = () => calls.filter((call) => call.method === 'turn/start').length;
try {
  await open();
  seedSession(root);
  new NeoRepository(app!.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  seed('legacy', true, false);
  seed('explicit', true, true);
  seed('human', false, true);
  const next = store.addTodo('next', 'explicit', { title: 'Next after facts', doneWhen: 'Human checks next', instruction: 'Perform next', named: null }, at);
  sessions.create(next.id, { verb: 'send', ref: { adapter: 'codex-desktop', id: 'next' } });
  const sdkHash = () => hash(JSON.stringify(app!.db.getDatabase().prepare("SELECT * FROM sdk_messages WHERE session_id IN ('legacy','explicit','human') ORDER BY seq").all()));
  const original = sdkHash();
  await refresh();
  evidence.initial = ['legacy', 'explicit', 'human', 'next'].map((id) => store.getTodo(id));
  evidence.initialSnapshot = await rpc('neo.snapshot', {});
  assert.equal(store.getTodo('explicit')?.report, `Agent: ${report}`);
  assert.equal(store.getTodo('explicit')?.state, 'doing');
  assert.equal(store.getTodo('human')?.state, 'doing');
  assert.equal(starts(), 0);
  if (mode === 'before') {
    assert.notEqual(store.getTodo('legacy')?.report, prior);
    console.log('REPRODUCED: an opening-matched result without a dispatch receipt replaces the stored todo report.');
  } else {
    assert.equal(store.getTodo('legacy')?.report, prior);
    evidence.unmetClose = await rpc('neo.todo.close', { todoId: 'explicit', reason: 'Worker says complete' });
    assert.equal((evidence.unmetClose as any).ok, false);
    assert.equal(starts(), 0);
    evidence.humanClose = await rpc('neo.todo.close', { todoId: 'human', reason: 'Human confirms the synthetic result' });
    assert.equal((evidence.humanClose as any).todo.state, 'done');
    assert.equal(store.getTodo('human')?.report, `Agent: ${report}`);
    await refresh();
    assert.equal(store.getTodo('legacy')?.report, prior);
    evidence.removal = await rpc('neo.todo.remove', { todoId: 'legacy', reason: 'Synthetic explicit removal' });
    assert.equal((evidence.removal as any).todo.state, 'removed');
    ws!.close();
    await app!.cleanup();
    app = undefined;
    await open();
    await refresh();
    assert.equal(store.getTodo('legacy')?.state, 'removed');
    assert.equal(store.getTodo('legacy')?.report, prior);
    assert.equal(store.getTodo('explicit')?.report, `Agent: ${report}`);
    assert.equal(store.getTodo('explicit')?.state, 'doing');
    assert.equal(starts(), 0);
    writeFileSync(join(run, 'pr.json'), JSON.stringify({ url: pr, state: 'MERGED', mergedAt: new Date().toISOString(), headRefOid: 'a'.repeat(40), reviews: [], statusCheckRollup: [] }));
    await refresh();
    await refresh();
    assert.equal(store.getTodo('explicit')?.state, 'done');
    assert.equal(store.getTodo('next')?.state, 'doing');
    assert.equal(starts(), 1);
    assert.equal(store.getTodo('explicit')?.report, `Agent: ${report}`);
    assert.equal(sdkHash(), original);
    evidence.finalSnapshot = await rpc('neo.snapshot', {});
    evidence.final = { states: ['legacy','explicit','human','next'].map((id) => ({ id, state: store.getTodo(id)?.state })), starts: starts(), storedReportHash: hash(store.getTodo('explicit')!.report!), sdkStorageUnchanged: true };
    console.log('PASS: only receipt-bound results replace reports; prose cannot finish a pack todo; human confirmation, exact bytes, restart/removal and fact-driven next dispatch preserved.');
  }
} finally {
  ws?.close();
  await app?.cleanup();
  peer.stop(true);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
