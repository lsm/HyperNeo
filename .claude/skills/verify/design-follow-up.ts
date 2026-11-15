process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import {
  createNeoOperations,
  createNeoService,
} from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
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
  const root = 'neo:00000000-0000-4000-8000-00000000d351';
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
  db.prepare("INSERT INTO neo_session_bindings (session_id, kind) VALUES (?, 'neo')").run(root);
  const prs = new CodingTodoPrRepository(db);
  const finished = (askId: string, todoId: string, url: string, design: boolean) => {
    service!.todos.openAsk({
      id: askId,
      sessionId: root,
      projectId: null,
      originMessageId: null,
      title: askId,
      request: 'Synthetic work',
      createdAt: at,
    });
    const step = service!.todos.addTodo(
      todoId,
      askId,
      { title: `${askId} step`, doneWhen: 'Merged', check: null, instruction: null, named: null },
      at
    );
    service!.todos.updateTodo(step, { state: 'done', evidence: 'Merged' }, at);
    prs.record(
      todoId,
      [
        {
          url,
          state: 'MERGED',
          checks: 'passing',
          review: 'approved',
          title: `${askId} PR`,
          ...(design ? { design: true as const } : {}),
        },
      ],
      at
    );
  };
  const designUrl = 'https://github.com/example/project/pull/7';
  finished('design-ask', 'design-step', designUrl, true);
  finished('plain-ask', 'plain-step', 'https://github.com/example/project/pull/8', false);
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
  for (const askId of ['design-ask', 'plain-ask']) {
    note(askId);
    sdk('user', `batch-${askId}`, 10 + seq);
    sdk('result', `result-${askId}`, 20 + seq);
  }
  const asks = () =>
    Object.fromEntries(
      (
        db.prepare('SELECT id, status FROM neo_asks ORDER BY id').all() as {
          id: string;
          status: string;
        }[]
      ).map((row) => [row.id, row.status])
    );
  const wakes = () =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.messageUuid') AS key,
                  json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = 'mailbox'
              AND json_extract(payload, '$.messageUuid') LIKE 'neo-design-follow-up:%'`
        )
        .all() as { key: string; text: string }[]
    ).map((row) => ({ key: row.key, text: String(row.text) }));
  await refreshNeoDriverWork(app.jobQueue, service);
  const settled = asks();
  (evidence.checks as unknown[]).push({ name: 'auto-settle after one refresh', rows: settled });
  assert.equal(settled['plain-ask'], 'done', 'an ordinary finished ask still settles itself');
  assert.equal(settled['design-ask'], 'open', 'a merged design with no follow-up stays open');
  await service.sweepPacks();
  await service.sweepPacks();
  const woken = wakes();
  (evidence.checks as unknown[]).push({ name: 'wakes after two coding sweeps', woken });
  assert.equal(woken.length, 1, 'two sweeps queue one wake for Neo');
  assert(woken[0]!.text.includes(designUrl) && woken[0]!.text.includes('Change section'));
  const ops = Object.fromEntries(createNeoOperations(service).map((op) => [op.name, op]));
  const settle = ops['neo.ask.settle']!;
  const caller = { source: 'mcp' as const, sessionId: root, role: 'neo' as const };
  const refused = (await settle.execute(
    settle.inputSchema.parse({ askId: 'design-ask', status: 'done', outcome: 'Designed' }),
    caller
  )) as { ok: boolean; reason?: string };
  (evidence.checks as unknown[]).push({ name: 'settle done without follow-up', refused });
  assert.equal(refused.ok, false);
  assert(refused.reason?.startsWith('design_follow_up_missing'));
  service.todos.addTodo(
    'build-step',
    'design-ask',
    { title: 'Build it', doneWhen: 'Merged', check: null, instruction: null, named: null },
    at
  );
  service.todos.updateTodo(service.todos.getTodo('build-step')!, { state: 'done' }, at);
  const accepted = (await settle.execute(
    settle.inputSchema.parse({ askId: 'design-ask', status: 'done', outcome: 'Designed and built' }),
    caller
  )) as { ok: boolean };
  (evidence.checks as unknown[]).push({ name: 'settle done after a follow-up', ok: accepted.ok });
  assert.equal(accepted.ok, true);
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
