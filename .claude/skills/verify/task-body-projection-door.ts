import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { DEBOUNCE_SPACE_TASK_FEEDS_MS } from '../../../packages/daemon/src/lib/live-query/queries/task-messages.ts';

const [portText, runText] = process.argv.slice(2);
const port = Number(portText);
const run = resolve(runText);
assert(port > 0 && port !== 8399);
assert(process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const dbPath = join(run, 'data/daemon.db');
const seed = JSON.parse(readFileSync(join(run, 'evidence/seed.json'), 'utf8'));
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let maxLagMs = 0;
let last = performance.now();
const timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - last - 10); last = now; }, 10);
const pause = () => new Promise((done) => setTimeout(done, 25));
const queries: { sql: string; method: string; elapsedMs: number }[] = [];
const calls: { method: string; elapsedMs: number; data: unknown }[] = [];
const phases: Record<string, number> = {};
const start = async () => {
  last = performance.now();
  app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key);
      if (!['get', 'all', 'run'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value;
      return (...params: unknown[]) => {
        const at = performance.now();
        try { return value.apply(target, params); }
        finally { queries.push({ sql, method: String(key), elapsedMs: performance.now() - at }); }
      };
    } });
  }) as typeof db.prepare;
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  return { db, prepare };
};
const rpc = async (method: string, data: unknown, includeEvents = false) => {
  const id = crypto.randomUUID();
  const at = performance.now();
  const events: unknown[] = [];
  const reply = await new Promise<Record<string, unknown>>((done, fail) => {
    const timeout = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 30000);
    ws!.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'EVENT' && (!includeEvents || message.data?.subscriptionId === (data as { subscriptionId?: string }).subscriptionId)) events.push({ method: message.method, data: message.data });
      if (message.requestId !== id && message.id !== id) return;
      clearTimeout(timeout);
      if (message.error) fail(new Error(JSON.stringify(message.error)));
      else if (includeEvents) setTimeout(() => done({ reply: message.data, events }), 25);
      else done(message.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  calls.push({ method, elapsedMs: performance.now() - at, data: reply });
  return reply;
};
const stop = async () => { ws?.close(); ws = undefined; await app?.cleanup(); app = undefined; };
try {
  const first = await start();
  await pause(); phases.startupLagMs = maxLagMs; maxLagMs = 0; last = performance.now();
  first.db.prepare("UPDATE sessions SET session_context=? WHERE id='synthetic-live'").run(JSON.stringify({ taskId: 'proof-task' }));
  const repo = app!.db.getSDKMessageRepo();
  const full = '完整工具结果-'.repeat(100000);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(repo.saveUserMessageCore('synthetic-live', { type: 'user', uuid: `dual-${i}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-tool', content: full }] } } as SDKMessage).id);
    await pause();
  }
  const resultId = 'proof-recovery';
  assert(await app!.db.saveSDKMessage('synthetic-live', { type: 'result', uuid: resultId, subtype: 'success', result: 'complete' } as SDKMessage));
  repo.markResultRecoveryIntercepted('synthetic-live', resultId, true);
  repo.markResultInternalCompactionTurn('synthetic-live', resultId);
  const recovery = first.prepare('SELECT m.sdk_message AS original,b.sdk_message AS body FROM sdk_messages m JOIN sdk_message_bodies b USING(seq) WHERE m.sdk_uuid=?').get(resultId) as { original: string; body: string };
  assert.equal(recovery.original, recovery.body);
  assert.equal(JSON.parse(recovery.body).recovery_billing_terminal, 1);
  const beforeDelete = first.prepare('SELECT b.sdk_message FROM sdk_message_bodies b JOIN sdk_messages m USING(seq) WHERE m.id=?').get(ids[1]) as { sdk_message: string };
  first.db.prepare('DELETE FROM sdk_messages WHERE id=?').run(ids[0]);
  assert.equal(first.prepare('SELECT COUNT(*) AS n FROM sdk_message_bodies b LEFT JOIN sdk_messages m USING(seq) WHERE m.seq IS NULL').get().n, 0);
  const remaining = first.prepare('SELECT b.sdk_message FROM sdk_message_bodies b JOIN sdk_messages m USING(seq) WHERE m.id=?').get(ids[1]) as { sdk_message: string };
  assert.equal(remaining.sdk_message, beforeDelete.sdk_message);
  assert.equal(JSON.parse(remaining.sdk_message).message.content[0].content, full);
  const projection = () => first.prepare('SELECT id,flags,artifact_keys,json_subtype,send_status,turn_index FROM task_message_rows WHERE task_id=? ORDER BY id').all('proof-task');
  const beforeStatus = projection();
  repo.updateMessageStatus(ids, 'failed');
  const afterStatus = projection();
  for (const id of ids.slice(1)) {
    const before = beforeStatus.find((row) => row.id === id);
    const after = afterStatus.find((row) => row.id === id);
    assert(before && after);
    assert.deepEqual(after, { ...before, send_status: 'failed' });
  }
  const action = { type: 'hyperneo_action' as const, uuid: 'projection-action', session_id: 'synthetic-live', action: 'sdk_resume_choice' as const, resolved: false, timestamp: Date.now() };
  const actionId = repo.saveHyperNeoActionMessage('synthetic-live', action);
  first.db.prepare('DELETE FROM task_message_rows WHERE id=?').run(actionId);
  await app!.reactiveDb.db.updateMessageStatus([actionId], 'failed');
  assert.equal(projection().find((row) => row.id === actionId)?.flags, 80);
  for (let i = 0; i < 100; i++) {
    assert(await app!.db.saveSDKMessage('synthetic-live', { type: 'system', subtype: 'informational', level: 'warn', content: `ordinary ${i}`, uuid: `ordinary-${i}` } as SDKMessage));
    if (i % 10 === 0) await pause();
  }
  const taskFeed = (label: string) => rpc('liveQuery.subscribe', { queryName: 'spaceTaskMessages.byTask', subscriptionId: `projection-${label}`, params: ['proof-task'] }, true);
  const compactFeed = (label: string) => rpc('liveQuery.subscribe', { queryName: 'spaceTaskMessages.byTask.compact', subscriptionId: `compact-${label}`, params: ['proof-task', 100] }, true);
  const taskBefore = await taskFeed('before');
  const compactBefore = await compactFeed('before');
  const bodyFlagsBefore = projection().find((row) => row.id === actionId);
  assert.equal(bodyFlagsBefore.flags, 80);
  const blankProof = { before: bodyFlagsBefore, after: null as unknown };
  assert.throws(() => first.db.transaction(() => {
    first.db.prepare("UPDATE sdk_messages SET sdk_message='' WHERE id=?").run(actionId);
    first.db.prepare("UPDATE sdk_messages SET send_status='failed' WHERE id=?").run(actionId);
    blankProof.after = projection().find((row) => row.id === actionId);
    assert.deepEqual(blankProof.after, { ...bodyFlagsBefore, send_status: 'failed' });
    throw new Error('proof rollback');
  })(), /proof rollback/);
  const copyProof = { before: projection(), skipped: null as unknown };
  assert.throws(() => first.db.transaction(() => {
    first.db.exec('INSERT INTO sdk_message_body_copy_active DEFAULT VALUES');
    first.db.prepare('UPDATE sdk_message_bodies SET sdk_message=? WHERE seq=(SELECT seq FROM sdk_messages WHERE id=?)').run(JSON.stringify({ ...action, resolved: true }), actionId);
    copyProof.skipped = projection();
    assert.deepEqual(copyProof.skipped, copyProof.before);
    throw new Error('copy rollback');
  })(), /copy rollback/);
  assert.equal(first.prepare('SELECT COUNT(*) AS n FROM sdk_message_body_copy_active').get().n, 0);
  repo.updateHyperNeoActionMessage(actionId, { ...action, resolved: true, chosenOption: 'start_fresh' });
  const bodyFlagsAfter = projection().find((row) => row.id === actionId);
  assert.equal(bodyFlagsAfter.flags, 16);
  await new Promise((done) => setTimeout(done, DEBOUNCE_SPACE_TASK_FEEDS_MS + 50));
  const taskAfter = await taskFeed('after');
  const compactAfter = await compactFeed('after');
  writeFileSync(join(run, 'evidence/task-before.json'), JSON.stringify(taskBefore, null, 2));
  writeFileSync(join(run, 'evidence/task-after.json'), JSON.stringify(taskAfter, null, 2));
  const taskAction = (value: Record<string, unknown>) => {
    const events = value.events as { method: string; data: { rows?: { content: string }[] } }[];
    const rows = events.find((event) => event.method === 'liveQuery.snapshot')?.data.rows ?? [];
    const bodies = rows.map((row) => JSON.parse(row.content));
    return bodies.find((message) => message.uuid === 'projection-action');
  };
  assert.equal(taskAction(taskBefore)?.resolved, false);
  assert.equal(taskAction(taskAfter)?.resolved, true);
  assert.equal(taskAction(taskAfter)?.chosenOption, 'start_fresh');
  assert.equal(taskAction(compactBefore)?.resolved, false);
  assert.equal(taskAction(compactAfter), undefined);
  writeFileSync(join(run, 'evidence/compact-before.json'), JSON.stringify(compactBefore, null, 2));
  writeFileSync(join(run, 'evidence/compact-after.json'), JSON.stringify(compactAfter, null, 2));
  const taskProof = { beforeStatus, afterStatus, bodyFlagsBefore, bodyFlagsAfter, blankProof, copyProof };
  const created = await rpc('session.create', { workspacePath: run, title: 'Synthetic dual-write proof' });
  const sid = created.sessionId;
  assert.equal(typeof sid, 'string');
  const text = 'RPC dual-write token';
  const sent = await rpc('message.send', { sessionId: sid, content: text, deliveryMode: 'defer' });
  assert(sent.messageId);
  let body: { original: string; body: string } | null = null;
  for (let attempt = 0; attempt < 100 && !body; attempt++) {
    body = first.prepare('SELECT m.sdk_message AS original,b.sdk_message AS body FROM sdk_messages m JOIN sdk_message_bodies b USING(seq) WHERE m.sdk_uuid=?').get(sent.messageId) as typeof body;
    if (!body) await new Promise((done) => setTimeout(done, 100));
  }
  assert(body, 'Mailbox input never materialized into SDK storage');
  const readFeed = () => rpc('liveQuery.subscribe', { queryName: 'messages.bySession', subscriptionId: 'dual-body-proof', params: [sid, 200] }, true);
  const feed = await readFeed();
  writeFileSync(join(run, 'evidence/rpc-before-restart.json'), JSON.stringify(feed, null, 2));
  assert.equal(body.body, body.original);
  assert(body.body.includes(text));
  assert(JSON.stringify(feed).includes(text));
  const mirrorHash = () => {
    const hash = createHash('sha256');
    for (const row of first.prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq').iterate() as Iterable<{ sdk_message: string }>) hash.update(row.sdk_message);
    return hash.digest('hex');
  };
  await pause(); phases.operationsLagMs = maxLagMs;
  const initialHash = mirrorHash();
  const legacyHash = createHash('sha256');
  for (const row of first.prepare('SELECT sdk_message FROM sdk_messages WHERE seq<=? ORDER BY seq').iterate(seed.rows) as Iterable<{ sdk_message: string }>) legacyHash.update(row.sdk_message);
  assert.equal(legacyHash.digest('hex'), seed.bodyHash);
  await stop();
  maxLagMs = 0; last = performance.now();
  const second = await start();
  await pause(); phases.restartLagMs = maxLagMs;
  const taskRestart = await taskFeed('restart');
  const compactRestart = await compactFeed('restart');
  writeFileSync(join(run, 'evidence/compact-restart.json'), JSON.stringify(compactRestart, null, 2));
  writeFileSync(join(run, 'evidence/task-restart.json'), JSON.stringify(taskRestart, null, 2));
  const after = await readFeed();
  writeFileSync(join(run, 'evidence/rpc-after-restart.json'), JSON.stringify(after, null, 2));
  const snapshot = (value: Record<string, unknown>) => {
    const event = (value.events as { method: string; data: { rows: unknown; metadata: unknown } }[]).find((entry) => entry.method === 'liveQuery.snapshot');
    assert(event);
    return { rows: event.data.rows, metadata: event.data.metadata };
  };
  assert.deepEqual(snapshot(after), snapshot(feed));
  assert.deepEqual(snapshot(taskRestart), snapshot(taskAfter));
  assert.deepEqual(snapshot(compactRestart), snapshot(compactAfter));
  await pause(); phases.restartLagMs = maxLagMs;
  const afterHash = createHash('sha256');
  for (const row of second.prepare('SELECT sdk_message FROM sdk_message_bodies ORDER BY seq').iterate() as Iterable<{ sdk_message: string }>) afterHash.update(row.sdk_message);
  assert.equal(afterHash.digest('hex'), initialHash);
  const counts = second.prepare('SELECT (SELECT COUNT(*) FROM sdk_messages) AS messages,(SELECT COUNT(*) FROM sdk_message_bodies) AS bodies').get();
  const report = { syntheticOnly: true, corpusRows: seed.rows, normalizedSeed: 1, fullToolResultCharacters: full.length, retainedToolResultUnchanged: true, legacyBodyHash: seed.bodyHash, mirrorHash: initialHash, restartFeedIdentical: true, counts, taskProof, phases, maxQueryMs: Math.max(...queries.map((q) => q.elapsedMs)), queries, calls };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, queries: queries.length, calls: calls.length }));
  assert(Math.max(...Object.values(phases)) < 1000);
  assert(report.maxQueryMs < 250);
} finally { clearInterval(timer); await stop(); }
