process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { refreshNeoDriverWork } from '../../../packages/daemon/src/lib/neo/driver-refresh.ts';

const run = resolve(process.argv[2]);
assert(run.startsWith('/private/tmp/'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home', 'workspace', 'bin', 'evidence'])
  mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const at = Date.now(),
  realNow = Date.now;
let clock = at;
Date.now = () => clock;
const evidence: Record<string, unknown> = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  checks: [],
};
const config = getConfig({
  port: 0,
  host: '127.0.0.1',
  dbPath: join(run, 'data/daemon.db'),
  workspaceRoot: join(run, 'workspace'),
});
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
try {
  app = await createDaemonApp({
    config: { ...config, disableWorktrees: true, disableGoalProcessing: true },
    verbose: false,
  });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  (evidence.ports ??= [] as number[]);
  (evidence.ports as number[]).push(app.server.port!);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const db = app.db.getDatabase();
  const root = 'neo:00000000-0000-4000-8000-00000000a517';
  db.prepare(
    'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    root,
    'Synthetic driver',
    'general',
    join(run, 'workspace'),
    new Date(at).toISOString(),
    new Date(at).toISOString(),
    'active',
    '{}',
    '{}'
  );
  const open = (id: string, withCard = false, withLive = false) => {
    service!.todos.openAsk({
      id,
      sessionId: root,
      projectId: null,
      originMessageId: null,
      title: id,
      request: 'Synthetic work',
      createdAt: at,
    });
    if (withLive)
      service!.todos.addTodo(
        `live-${id}`,
        id,
        { title: 'Still running', doneWhen: 'Done', check: null, instruction: null, named: null },
        at
      );
    if (withCard)
      service!.todos.askQuestion(
        `card-${id}`,
        id,
        {
          kind: 'yesno',
          text: 'Go?',
          options: null,
          multiple: false,
          yesLabel: null,
          noLabel: null,
          startTodos: null,
          confirm: null,
          document: null,
          replyTo: [],
          todoId: null,
          artifacts: [],
        },
        at
      );
  };
  open('finished-ask');
  open('empty-ask');
  open('live-ask', false, true);
  open('card-ask', true);
  const step = service!.todos.addTodo(
    'step',
    'finished-ask',
    { title: 'Ship the slice', doneWhen: 'Merged', check: null, instruction: null, named: null },
    at
  );
  service!.todos.updateTodo(step, { state: 'done', evidence: 'Merged' }, at);
  const note = (askId: string) =>
    db
      .prepare(`INSERT INTO job_queue (id, queue, status, payload, run_at, created_at, completed_at)
        VALUES (?, 'neo_notes', 'completed', ?, 0, 0, 0)`)
      .run(
        `note-${askId}`,
        JSON.stringify({
          to: { kind: 'session', sessionId: root },
          origin: `session:${root}`,
          messageUuid: `neo-stalled-ask:${askId}:1:0`,
          message: { type: 'user', message: { content: 'reminder' } },
          neoBatchUuid: `batch-${askId}`,
        })
      );
  let seq = 0;
  const sdk = (kind: 'user' | 'result', uuid: string, consumedSeq: number) =>
    db
      .prepare(`INSERT INTO sdk_messages
        (seq, id, session_id, message_type, sdk_message, timestamp, sdk_uuid, consumed_seq,
         is_terminal, send_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumed')`)
      .run(
        ++seq,
        `m${seq}`,
        root,
        kind,
        JSON.stringify({ type: kind }),
        new Date(at + 1000 + seq).toISOString(),
        uuid,
        consumedSeq,
        kind === 'result' ? 1 : 0
      );
  for (const askId of ['finished-ask', 'empty-ask', 'live-ask', 'card-ask']) {
    note(askId);
    sdk('user', `batch-${askId}`, 10 + seq);
    sdk('result', `result-${askId}`, 20 + seq);
  }
  const asks = () =>
    Object.fromEntries(
      (
        db.prepare('SELECT id, status, outcome FROM neo_asks ORDER BY id').all() as {
          id: string;
          status: string;
          outcome: string | null;
        }[]
      ).map((row) => [row.id, row])
    );
  (evidence.checks as unknown[]).push({ name: 'before refresh', rows: asks() });
  await refreshNeoDriverWork(app.jobQueue, service);
  (evidence.checks as unknown[]).push({ name: 'after refresh', rows: asks() });
  const rows = asks() as Record<string, { status: string; outcome: string | null }>;
  assert.equal(rows['finished-ask']!.status, 'done');
  assert(rows['finished-ask']!.outcome?.includes('Ship the slice'), 'outcome names the step');
  assert.equal(rows['empty-ask']!.status, 'dropped');
  assert.equal(rows['empty-ask']!.outcome, 'No steps recorded.');
  assert.equal(rows['live-ask']!.status, 'open', 'a live todo keeps the ask open');
  assert.equal(rows['card-ask']!.status, 'open', 'an open card keeps the ask open');
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await service?.dispose();
  await app?.cleanup();
  Date.now = realNow;
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
