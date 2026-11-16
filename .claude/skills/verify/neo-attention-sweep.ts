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
  const worker = { adapter: 'hyperneo', id: 'synthetic-worker' };
  const fail = (id: string) => {
    todoSessions.create(id, { verb: 'send', ref: worker });
    todoSessions.recordRef(id, worker, at);
    todos.updateTodo(todos.getTodo(id)!, { state: 'doing', startedAt: at }, at);
    todoSessions.recordNudge(id, { since: at, nudges: 0, live: 'done' });
    return todos.updateTodo(
      todos.getTodo(id)!,
      { state: 'blocked', blockedBy: 'failure', blockedReason: 'Synthetic build exited 7.' },
      at
    );
  };
  add('plan-step', { producesFollowUp: true, instruction: null });
  todos.updateTodo(todos.getTodo('plan-step')!, { state: 'done', finishedAt: at }, at);
  add('covered-step', { dependsOn: ['plan-step'] });
  todos.askQuestion(
    'card',
    'ask',
    {
      text: 'Retry the covered step?',
      kind: 'choice',
      options: ['Retry', 'Remove'],
      multiple: false,
      noLabel: null,
      yesLabel: null,
      todos: [fail('covered-step').id],
    },
    at
  );
  add('queued-step');
  todoSessions.create('queued-step', { verb: 'start', adapter: 'hyperneo' } as never);
  add('waiting-step', { instruction: null, dependsOn: ['queued-step'] });
  add('failed-step');
  fail('failed-step');
  const wakes = () =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = 'mailbox'
              AND json_extract(payload, '$.to.sessionId') = ? ORDER BY created_at, rowid`
        )
        .all(root) as { text: string }[]
    ).map((row) => String(row.text));
  const sweep = async (name: string, hours: number) => {
    clock = at + hours * HOUR;
    await service!.sweepPacks();
    await service!.sweepPacks();
    const told = wakes();
    (evidence.checks as unknown[]).push({ name, hours, told });
    return told;
  };
  const step = (id: string) => `Todo "${id}" (${id}) needs your next step`;
  const first = await sweep('two sweeps at the start', 0);
  assert.equal(first.length, 1, 'only the failed todo with no card is told, once');
  assert(first[0]!.startsWith(`${step('failed-step')}: it failed: Synthetic build exited 7.`));
  const second = await sweep('two sweeps after the 1 h rung', 1);
  assert.equal(second.length, 2, 'the same step is told once more at its 1 h rung');
  todos.updateTodo(todos.getTodo('failed-step')!, { state: 'done', finishedAt: clock }, clock);
  const third = await sweep('after Neo finished the failed todo and it became the last step', 4);
  assert.equal(third.length, 2, 'a todo that left Neo is no longer told');
  todos.updateTodo(todos.getTodo('failed-step')!, { state: 'removed', reason: 'Synthetic' }, clock);
  for (const id of ['covered-step', 'queued-step', 'waiting-step'])
    todos.updateTodo(todos.getTodo(id)!, { state: 'removed', reason: 'Synthetic' }, clock);
  const fourth = await sweep('the plan step is last and nothing follows it', 5);
  assert.equal(fourth.length, 3, 'the missing follow-up is told through the same entry');
  assert(fourth[2]!.includes('"plan-step" (plan-step) in ask "Synthetic ask" (ask) finished'));
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
    join(run, 'evidence/neo-attention-sweep.json'),
    JSON.stringify(evidence, null, 2)
  );
}
