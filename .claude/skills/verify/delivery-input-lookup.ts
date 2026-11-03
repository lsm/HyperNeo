import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { sdkMessageBodyAt } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-read.ts';
import { hyperneoInputText } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';
import { measureWorkDeliveryLookup, seedWorkDeliveryFixture } from '../../../packages/daemon/tests/unit/helpers/work-delivery-fixture.ts';

const run = resolve(process.argv[2]!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const dir of ['bin', 'data', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
const fingerprint = (db: Database) => createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM work_delivery_inputs ORDER BY rowid').all())).digest('hex');
const fixture = new Database(config.dbPath);
let legacy: ReturnType<typeof measureWorkDeliveryLookup>;
let retained: string;
try {
  runMigrations(fixture, () => {});
  createTables(fixture);
  fixture.exec(`DROP INDEX idx_work_delivery_inputs_ref;
    DELETE FROM migration_markers WHERE key='migration_469'`);
  seedWorkDeliveryFixture(fixture);
  retained = fingerprint(fixture);
  legacy = measureWorkDeliveryLookup(fixture);
} finally {
  fixture.close();
}
const app = await createDaemonApp({ config, verbose: false });
assert.notEqual(app.server.port, 8399);
const db = app.db.getDatabase();
const evidence: Record<string, unknown> = { rows: 1466, legacy };
try {
  const reader = new Database(config.dbPath, { readonly: true });
  try {
    const indexed = measureWorkDeliveryLookup(reader);
    assert.equal(fingerprint(reader), retained);
    assert(legacy.plan.some((row) => row.detail === 'SCAN work_delivery_inputs'));
    assert(indexed.plan.some((row) => row.detail.startsWith('SEARCH work_delivery_inputs')));
    assert(indexed.plan.every((row) => !/SCAN work_delivery_inputs|TEMP B-TREE/.test(row.detail)));
    assert.deepEqual(indexed.ids, legacy.ids);
    evidence.indexed = indexed;
    evidence.upgradedOnStartup = true;
  } finally {
    reader.close();
  }
  const root = 'neo:10000000-0000-4000-8000-000000009587';
  const worker = 'synthetic-lookup-worker';
  const report = 'Unicode worker result 完整报告\n'.repeat(1200);
  const seedSession = (id: string) => app.db.createSession({ id, title: 'Synthetic delivery lookup', workspacePath: run, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  await seedSession(root);
  await seedSession(worker);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const todos = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const at = Date.now();
  const ref = { adapter: 'hyperneo', id: worker };
  todos.openAsk({ id: 'lookup-ask', title: 'Observe completed work', request: 'Retain the entire worker result', sessionId: root, projectId: null, originMessageId: null, createdAt: at });
  const todo = todos.addTodo('lookup-todo', 'lookup-ask', { title: 'Completed worker', doneWhen: 'Synthetic PR merged', check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } }, instruction: 'Return the worker report', named: null }, at);
  sessions.create(todo.id, { verb: 'send', ref });
  sessions.recordRef(todo.id, ref, at);
  sessions.recordSent(todo.id, { inputBefore: at, opening: 'Return the worker report', receipt: { executionId: worker, inputId: 'lookup-input' } });
  todos.updateTodo(todo, { state: 'doing', startedAt: at }, at);
  const dispatch = await sessions.inputs.accept(todo.id, root, { verb: 'send', ref }, 'Return the worker report', at);
  await sessions.inputs.recordOutcome(dispatch, { ref, receipt: { executionId: worker, inputId: 'lookup-input' } }, at);
  const put = (id: string, type: string, text: string) => db.prepare(`INSERT INTO sdk_messages
    (id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,is_terminal,consumed_seq)
    VALUES (?,?,?,?,?,?,'consumed',?,?)`).run(id, worker, id, type, JSON.stringify(type === 'result' ? { type, uuid: id, subtype: 'success', result: text, is_error: false } : { type, uuid: id, message: { content: text } }), new Date().toISOString(), type === 'result' ? 1 : 0, type === 'result' ? 2 : 1);
  put('lookup-input', 'user', 'Return the worker report');
  await new Promise((done) => setTimeout(done, 5));
  put('lookup-result', 'result', report);
  const rpc = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), 'work.status', JSON.stringify({ ref })], { env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit' });
  evidence.status = JSON.parse(await new Response(rpc.stdout).text());
  assert.equal(await rpc.exited, 0);
  const status = evidence.status as { reply: { ok: boolean; value: { status: string } } };
  assert.equal(status.reply.ok, true);
  assert.equal(status.reply.value.status, 'done');
  const messages = () => (db.prepare(`SELECT ${sdkMessageBodyAt('m.rowid')} AS body FROM sdk_messages m WHERE session_id=? AND message_type='user' ORDER BY seq`).all(root) as { body: string }[]).map((row) => hyperneoInputText(row.body));
  const durationsMs: number[] = [];
  for (let round = 0; round < 2; round++) {
    const start = performance.now();
    const job = app.jobQueue.enqueue({ queue: 'neo.work.driver.refresh', payload: { scope: 'neo' }, runAt: Date.now() });
    const deadline = Date.now() + 20000;
    while (app.jobQueue.getJob(job.id)?.status !== 'completed') {
      assert.notEqual(app.jobQueue.getJob(job.id)?.status, 'dead');
      assert(Date.now() < deadline, 'driver refresh timed out');
      await new Promise((done) => setTimeout(done, 20));
    }
    durationsMs.push(performance.now() - start);
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(todos.getTodo(todo.id)?.report, `Agent: ${report}`);
    assert.equal(messages().filter((text) => text.startsWith('Worker turn report')).length, 1);
    assert(messages().some((text) => text.includes(report)));
  }
  evidence.workflow = { dispatch, reportBytes: Buffer.byteLength(report), reportSha256: createHash('sha256').update(report).digest('hex'), report: todos.getTodo(todo.id)?.report, recipientInputs: messages(), durationsMs, sameTerminalObservedTwice: true };
  console.log('PASS: populated startup upgrade, indexed lookup and exact worker report delivery');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
