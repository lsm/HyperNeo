import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { neoFolder } from '../../../packages/daemon/src/lib/neo/folder.ts';
import { createNeoWorkerQuestionWriter } from '../../../packages/daemon/src/lib/neo/question-operations.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['workspace', 'evidence']) mkdirSync(join(run, dir), { recursive: true });

const root = 'neo:10000000-0000-4000-8000-000000009800';
const worker = '10000000-0000-4000-8000-000000009801';
const peer = '10000000-0000-4000-8000-000000009802';
const ref = { adapter: 'hyperneo', id: worker };
const at = Date.now() - 60_000;
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const evidence: Record<string, unknown> = { daemonPort: app.server.port };
const session = (id: string, title: string, workspacePath: string) =>
  app.db.createSession({
    id,
    title,
    workspacePath,
    createdAt: new Date(at).toISOString(),
    lastActiveAt: new Date(at).toISOString(),
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
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const current = app.jobQueue.getJob(job.id)!;
    if (current.status === 'completed') return;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('driver refresh did not complete');
};
try {
  const db = app.db.getDatabase();
  const folder = neoFolder();
  await session(root, 'Synthetic Neo', folder);
  await session(worker, 'Synthetic worker', join(run, 'workspace'));
  await session(peer, 'Synthetic Neo-project peer', folder);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    title: 'Shared worker',
    request: 'Two todos on one HyperNeo worker',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    createdAt: at,
  });
  for (const id of ['answered', 'other']) {
    const todo = store.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Done', check: null, instruction: `Do ${id}`, named: null },
      at
    );
    sessions.create(id, { verb: 'send', ref });
    sessions.recordRef(id, ref, at);
    store.updateTodo(todo, { state: 'doing', startedAt: at, report: `${id} report` }, at);
  }
  const source = { ...ref, name: 'Worker', label: 'Worker', provider: 'Synthetic', link: null };
  const asked = await createNeoWorkerQuestionWriter(
    store,
    sessions,
    () => 'en',
    async () => source
  )(source, {
    todoId: 'answered',
    kind: 'blocked',
    title: 'Which destination?',
    options: ['Staging', 'Production'],
    language: 'en',
    report: 'Need a destination',
  });
  assert(asked.ok);
  const last = await sessions.inputs.accept('other', root, { verb: 'send', ref }, 'Other', at + 1);
  await sessions.inputs.recordOutcome(last, { ref }, at + 1);
  store.answerQuestion(asked.question, ['Staging'], 'button', Date.now());
  await refresh();

  const rows = (id: string) => sessions.inputs.list(id).map((row) => row.message);
  const answer = rows('answered').at(-1) ?? '';
  assert.match(answer, /Staging/, 'the answer is recorded under its own todo');
  assert.equal(rows('other').length, 1, 'the other todo gets no new input');
  evidence.answerInput = answer.slice(0, 120);

  const turnAt = new Date(Date.now() + 1000).toISOString();
  const body = {
    type: 'result',
    uuid: crypto.randomUUID(),
    subtype: 'success',
    result: 'Used staging.\n\nBlocked (needs_human): confirm the staging window.',
    is_error: false,
  };
  db.prepare(
    "INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,consumed_seq,is_terminal) VALUES (?,?,?,'result',?,?,'consumed',9001,1)"
  ).run(crypto.randomUUID(), worker, body.uuid, JSON.stringify(body), turnAt);
  await new Promise((done) => setTimeout(done, 1200));
  await refresh();
  const answered = store.getTodo('answered')!;
  const other = store.getTodo('other')!;
  evidence.todos = {
    answered: { state: answered.state, blockedBy: answered.blockedBy, reason: answered.blockedReason },
    other: { state: other.state, report: other.report },
  };
  assert.equal(answered.blockedReason, 'confirm the staging window.');
  assert.equal(other.state, 'doing');
  assert.equal(other.report, 'other report', 'the answered turn must not touch the other todo');

  const registry = app.sessionManager.getOperationRegistry();
  const neo = { source: 'mcp', role: 'neo', sessionId: root } as const;
  const send = (to: string) =>
    invokeOperation(registry, 'message.send', { to, text: 'Synthetic note' }, neo);
  const refused = await send(worker);
  const allowed = await send(peer);
  assert.match(JSON.stringify(refused), /work_send_required/);
  assert.match(JSON.stringify(allowed), /accepted/);
  evidence.messageSend = { refused, allowed };

  const key = 'proof-repeat-key';
  const repeat = () =>
    invokeOperation(
      registry,
      'work.send',
      { ref, message: 'Repeat notice', notice: true, idempotencyKey: key },
      { source: 'internal', role: 'neo', sessionId: root }
    );
  const twice = [await repeat(), await repeat()].map((sent) => sent.kind);
  const copies = (
    db.prepare("SELECT count(*) AS n FROM job_queue WHERE queue='mailbox' AND json_extract(payload,'$.messageUuid')=?").get(key) as { n: number }
  ).n;
  assert.deepEqual(twice, ['completed', 'completed']);
  assert.equal(copies, 1, 'a repeated key reaches the mailbox once');
  evidence.repeatedKey = { twice, copies };
  evidence.verified = true;
  console.log(
    'VERIFIED: an answered turn on a shared HyperNeo worker lands on its todo only; Neo message.send stays in its project; a repeated key is delivered once'
  );
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
