process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const dir of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
globalThis.fetch = (() => {
  throw new Error('External HTTP is disabled');
}) as typeof fetch;
const HOUR = 3_600_000;
const at = Date.now();
const realNow = Date.now;
let clock = at;
Date.now = () => clock;
const evidence: Record<string, unknown> = { checks: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({
        port: 0,
        host: '127.0.0.1',
        dbPath: join(run, 'data/daemon.db'),
        workspaceRoot: join(run, 'workspace'),
      }),
      disableWorktrees: true,
      disableGoalProcessing: true,
    },
    verbose: false,
  });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const db = app.db.getDatabase();
  const root = 'neo:00000000-0000-4000-8000-00000000a771';
  db.prepare(
    'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    root,
    'Synthetic Neo',
    'general',
    join(run, 'workspace'),
    new Date(at).toISOString(),
    new Date(at).toISOString(),
    'active',
    '{}',
    '{}'
  );
  db.prepare("INSERT INTO neo_session_bindings (session_id, kind) VALUES (?, 'neo')").run(root);
  const { todos, todoSessions } = service;
  todos.openAsk({
    id: 'ask',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    title: 'Synthetic ask',
    request: 'Synthetic work',
    createdAt: at,
  });
  const add = (id: string, change: Record<string, unknown> = {}) =>
    todos.addTodo(
      id,
      'ask',
      {
        title: id,
        doneWhen: 'Observed',
        check: null,
        named: null,
        instruction: 'Do the synthetic step.',
        approvedAt: at,
        dependsOn: [],
        ...change,
      },
      at
    );
  const queued = (queue: 'mailbox' | 'neo_notes') =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = ?
              AND json_extract(payload, '$.to.sessionId') = ? ORDER BY created_at, rowid`
        )
        .all(queue, root) as { text: string }[]
    ).map((row) => String(row.text));
  const warn = (message: string, error: unknown) => {
    throw new Error(`${message}: ${String(error)}`);
  };
  const pass = async (name: string, hours: number, act: () => Promise<unknown>) => {
    clock = at + hours * HOUR;
    await act();
    await act();
    const told = { wakes: queued('mailbox'), digest: queued('neo_notes') };
    (evidence.checks as unknown[]).push({ name, hours, ...told });
    return told;
  };

  add('unapproved-step', { approvedAt: null });
  todos.openAsk({
    id: 'finished-ask',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    title: 'Finished ask',
    request: 'Synthetic work',
    createdAt: at,
  });
  todos.addTodo(
    'confirmed-step',
    'finished-ask',
    {
      title: 'confirmed-step',
      doneWhen: 'Observed',
      named: null,
      approvedAt: at,
      dependsOn: [],
      instruction: null,
      check: { pack: 'core', kind: 'human_confirmed', params: { questionId: 'confirm' } },
    },
    at
  );
  todos.askQuestion(
    'confirm',
    'finished-ask',
    {
      text: 'Is the synthetic step done?',
      kind: 'yesno',
      options: null,
      multiple: false,
      noLabel: 'No',
      yesLabel: 'Yes',
      todoId: 'confirmed-step',
    },
    at
  );
  todos.answerQuestion(todos.getQuestion('confirm')!, 'yes', 'button', at);
  const interrupted = add('interrupted-step');
  todoSessions.create(interrupted.id, { verb: 'start', adapter: 'hyperneo' } as never);
  todos.claimStart(interrupted, at);

  const runner = await pass('the runner checks the answer and recovers the start', 0, async () => {
    await service!.todoRunner.checkNow({ questionId: 'confirm' }, warn);
    await service!.todoRunner.refresh(warn);
  });
  assert.equal(todos.getTodo('confirmed-step')?.state, 'done');
  assert.deepEqual(
    [todos.getTodo('interrupted-step')?.state, todos.getTodo('interrupted-step')?.blockedBy],
    ['blocked', 'failure']
  );
  assert.deepEqual(runner, { wakes: [], digest: [] }, 'the runner itself sends Neo nothing');

  const finished =
    'Ask: Finished ask (finished-ask)\nAll todos are finished: write the outcome with neo.ask.settle, or add the next todo.';
  const driver = await pass('two driver refreshes after the last todo finished', 0, () =>
    service!.refreshDriverWork()
  );
  assert.deepEqual(driver, { wakes: [finished], digest: [] }, 'the finished ask is one wake');

  const unapproved =
    'Todo "unapproved-step" (unapproved-step) cannot start: it was not approved. Review it with neo.todo.read.';
  const first = await pass('two sweeps at the start', 0, () => service!.sweepPacks());
  const steps = first.wakes.filter((text) => text !== finished);
  assert.equal(steps.length, 1, 'the failed start is one wake');
  assert.equal(first.wakes.length, 2, 'the finished ask is not told again');
  assert(
    steps[0]!.startsWith(
      'Todo "interrupted-step" (interrupted-step) needs your next step: it failed: Start was interrupted'
    )
  );
  assert.deepEqual(first.digest, [unapproved], 'the unapproved todo is one digest line');
  assert(![...first.wakes, ...first.digest].some((text) => text.includes('confirmed-step')));

  todos.updateTodo(todos.getTodo('interrupted-step')!, { state: 'removed', reason: 'Synthetic' }, at);
  const later = await pass('two sweeps a day later', 24, () => service!.sweepPacks());
  assert.deepEqual(
    later.digest.filter((text) => text === unapproved),
    [unapproved, unapproved],
    'and one more line a day later'
  );
  assert.equal(later.wakes.length, 2, 'a removed todo is no longer told');
  evidence.passed = true;
  console.log('PASS');
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await service?.dispose();
  await app?.cleanup();
  Date.now = realNow;
  writeFileSync(
    join(run, 'evidence/neo-attention-todo-notes.json'),
    JSON.stringify(evidence, null, 2)
  );
}
