import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { sdkMessageBodyAt } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-read.ts';
import { hyperneoInputText } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert(![8399, 8499].includes(app.server.port));
const db = app.db.getDatabase();
const todos = new NeoAskTodoRepository(db);
const sessions = new NeoTodoSessionRepository(db);
const root = 'neo:10000000-0000-4000-8000-000000008835';
const evidence: Record<string, unknown> = {};
const ws = createLocalSocket(
  `ws://127.0.0.1:${app.server.port}/ws`,
  join(run, 'data/local-rpc.credential')
);
await new Promise<void>((done, fail) => {
  ws.onopen = () => done();
  ws.onerror = () => fail(new Error('RPC unavailable'));
});
const rpc = (name: string, input: unknown) =>
  new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 20000);
    ws.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data);
    };
    ws.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method: 'operation.invoke',
        data: { name, input },
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
const seedSession = (id: string, title = 'Synthetic inbox proof') =>
  app.db.createSession({
    id,
    title,
    workspacePath: run,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
const refresh = async () => {
  const job = app.jobQueue.enqueue({
    queue: 'neo.work.driver.refresh',
    payload: { scope: 'neo' },
    runAt: Date.now(),
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const status = app.jobQueue.getJob(job.id)?.status;
    if (status === 'completed') return;
    assert.notEqual(status, 'dead');
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('refresh timed out');
};
const messages = () =>
  (
    db
      .prepare(
        `SELECT ${sdkMessageBodyAt('m.rowid')} AS body FROM sdk_messages m WHERE session_id=? AND message_type='user' ORDER BY seq`
      )
      .all(root) as { body: string }[]
  ).map((row) => hyperneoInputText(row.body));
try {
  await seedSession(root);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const id = '10000000-0000-4000-8000-000000000123';
  const ref = { adapter: 'hyperneo', id };
  await seedSession(id, '  Synthetic\n inbox\u0000 proof\t  ');
  const now = Date.now();
  const ask = todos.openAsk({
    id: 'synthetic-ask',
    title: 'Synthetic work',
    request: 'Observe worker identity',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    createdAt: now,
  });
  const todo = todos.addTodo(
    'synthetic-todo',
    ask.id,
    {
      title: 'Synthetic task',
      doneWhen: 'Synthetic PR merged',
      check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } },
      instruction: 'Observe worker identity',
      named: null,
    },
    now
  );
  sessions.create(todo.id, { verb: 'send', ref });
  sessions.recordRef(todo.id, ref, now);
  todos.updateTodo(todo, { state: 'doing', startedAt: now }, now);
  const inputId = crypto.randomUUID();
  const dispatch = await sessions.inputs.accept(
    null,
    root,
    { verb: 'send', ref },
    'Synthetic notice',
    now
  );
  await sessions.inputs.recordOutcome(
    dispatch,
    { ref, receipt: { executionId: id, inputId } },
    now
  );
  db.prepare(
    "INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,is_terminal,consumed_seq) VALUES (?,?,?,?,?,?,'consumed',?,?)"
  ).run(
    inputId,
    id,
    inputId,
    'user',
    JSON.stringify({
      type: 'user',
      uuid: inputId,
      message: { content: 'Synthetic notice' },
      inputKind: 'system',
    }),
    new Date().toISOString(),
    0,
    1
  );
  const resultId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,is_terminal,consumed_seq) VALUES (?,?,?,?,?,?,'consumed',?,?)"
  ).run(
    resultId,
    id,
    resultId,
    'result',
    JSON.stringify({
      type: 'result',
      uuid: resultId,
      subtype: 'success',
      result: '',
      is_error: false,
    }),
    new Date(Date.now() + 1).toISOString(),
    1,
    2
  );
  db.prepare('UPDATE sessions SET processing_state=? WHERE id=?').run(
    JSON.stringify({ status: 'processing' }),
    id
  );
  evidence.worker = await rpc('work.status', { ref, since: now });
  await refresh();
  const reports = () =>
    messages().filter(
      (text) => text.startsWith('Worker turn report') && text.includes(`dispatch ${dispatch},`)
    );
  const deliveredBy = Date.now() + 10000;
  while (reports().length === 0 && Date.now() < deliveredBy)
    await new Promise((done) => setTimeout(done, 20));
  evidence.reports = reports();
  evidence.inputs = messages();
  assert.equal(reports().length, 1);
  assert(reports()[0].includes('a notice, no todo'));
  assert(reports()[0].includes(`Synthetic inbox proof (hyperneo:${id})`));
  assert(reports()[0].includes(`/session/${id}`));
  assert(reports()[0].includes('worker ended its turn with no reply'));
  await refresh();
  assert.equal(reports().length, 1);
  evidence.passed = true;
  console.log(
    JSON.stringify({ passed: true, reports: reports().length, fullRef: `hyperneo:${id}` })
  );
} finally {
  ws.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
