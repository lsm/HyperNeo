import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import type { WorkDetail } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { hyperneoInputText } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { sdkMessageBodyAt } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-read.ts';

const run = resolve(process.argv[2]);
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
const root = 'neo:10000000-0000-4000-8000-000000001035';
const evidence: Record<string, unknown> = {};
const ws = createLocalSocket(
  `ws://127.0.0.1:${app.server.port}/ws`,
  join(run, 'data/local-rpc.credential')
);
const rpc = (name: string, input: unknown) =>
  new Promise<{ ok: boolean; value: WorkDetail }>((done, fail) => {
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
const seedSession = (id: string) =>
  app.db.createSession({
    id,
    title: 'Synthetic report proof',
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
const messages = () =>
  (
    db
      .prepare(
        `SELECT ${sdkMessageBodyAt('m.rowid')} AS body FROM sdk_messages m WHERE session_id=? AND message_type='user' ORDER BY seq`
      )
      .all(root) as { body: string }[]
  ).map((row) => hyperneoInputText(row.body));
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
  throw new Error('Driver refresh did not complete');
};
try {
  await new Promise<void>((done, fail) => {
    ws.onopen = () => done();
    ws.onerror = () => fail(new Error('Synthetic RPC unavailable'));
  });
  await seedSession(root);
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  for (const scenario of [
    'empty',
    'whitespace',
    'changed',
    'unknown',
    'question',
    'meaningful',
    'human',
    'blocker',
  ]) {
    const worker = `report-${scenario}`;
    await seedSession(worker);
    const at = Date.now();
    todos.openAsk({
      id: worker,
      title: worker,
      request: 'Observe worker report',
      sessionId: root,
      projectId: null,
      originMessageId: null,
      createdAt: at,
    });
    const ref = { adapter: 'hyperneo', id: worker };
    const todo = todos.addTodo(
      worker,
      worker,
      {
        title: worker,
        doneWhen: 'Synthetic check passes',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } },
        instruction: 'Observe this worker',
        named: null,
      },
      at
    );
    sessions.create(worker, { verb: 'send', ref });
    sessions.recordRef(worker, ref, at);
    if (scenario !== 'unknown')
      sessions.recordLive(worker, scenario === 'changed' ? 'running' : 'done', undefined);
    todos.updateTodo(
      todo,
      {
        state: scenario === 'blocker' ? 'blocked' : 'doing',
        blockedBy: scenario === 'blocker' ? 'needs-human' : null,
        blockedReason: scenario === 'blocker' ? 'New decision required' : null,
        startedAt: at,
        report: 'Retained report',
      },
      at
    );
    const dispatch = await sessions.inputs.accept(
      worker,
      root,
      { verb: 'send', ref },
      'Observe this worker',
      at
    );
    await sessions.inputs.recordOutcome(
      dispatch,
      { ref, receipt: { executionId: worker, inputId: `${worker}-input` } },
      at
    );
    if (scenario === 'question')
      todos.askQuestion(
        `${worker}-question`,
        worker,
        {
          text: 'Choose next step',
          kind: 'reply',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos: null,
          todoId: worker,
        },
        at
      );
    for (const type of ['user', 'result']) {
      const id = `${worker}-${type === 'user' ? (scenario === 'human' ? 'human' : 'input') : 'result'}`;
      const text =
        type === 'user'
          ? scenario === 'human'
            ? 'Human asks for a decision'
            : 'Observe this worker'
          : scenario === 'meaningful'
            ? 'A new decision'
            : scenario === 'blocker'
              ? 'Blocked (needs_human): A new decision is required'
              : scenario === 'whitespace'
                ? '  \n'
                : '';
      const body =
        type === 'result'
          ? { type, uuid: id, subtype: 'success', result: text, is_error: false }
          : {
              type,
              uuid: id,
              inputKind: scenario === 'human' ? 'human' : 'agent',
              message: { content: text },
            };
      db.prepare(
        "INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,send_status,is_terminal,consumed_seq) VALUES (?,?,?,?,?,?,'consumed',?,?)"
      ).run(
        id,
        worker,
        id,
        type,
        JSON.stringify(body),
        new Date().toISOString(),
        type === 'result' ? 1 : 0,
        type === 'result' ? 2 : 1
      );
      await new Promise((done) => setTimeout(done, 5));
    }
    const statusResult = await rpc('work.status', { ref, since: at - 1 });
    assert.equal(statusResult.ok, true);
    const observedStatus = statusResult.value;
    assert.equal(observedStatus.status, 'done', `${scenario} driver status`);
    const resultRow = db
      .prepare('SELECT CAST(rowid AS TEXT) AS id FROM sdk_messages WHERE id=?')
      .get(`${worker}-result`) as { id: string };
    const terminal = observedStatus.turnEnds?.find((turn) => turn.id === resultRow.id);
    assert(terminal, `${scenario} terminal result visible`);
    assert.equal(
      terminal.message,
      scenario === 'meaningful'
        ? 'A new decision'
        : scenario === 'blocker'
          ? 'Blocked (needs_human): A new decision is required'
          : scenario === 'whitespace'
            ? '  \n'
            : ''
    );
    await refresh();
    await new Promise((done) => setTimeout(done, 500));
    const reports = messages().filter(
      (text) =>
        (text.startsWith('Worker turn report') || text.startsWith('The human worked directly')) &&
        text.includes(`todo ${worker}`)
    );
    assert.equal(reports.length, ['empty', 'whitespace'].includes(scenario) ? 0 : 1, scenario);
    if (scenario === 'human') assert(reports[0].startsWith('The human worked directly'));
    const beforeReplay = messages().length;
    await refresh();
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(messages().length, beforeReplay, `${scenario} exact replay`);
    evidence[scenario] = {
      reports,
      observedStatus,
      stored: todos.getTodo(worker),
      questionCount: todos.listQuestions(worker).length,
      replayInputs: messages().length - beforeReplay,
    };
  }
  evidence.port = app.server.port;
  console.log('PASS: quiet reports skipped; six actionable counterparts retained');
} finally {
  ws.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
