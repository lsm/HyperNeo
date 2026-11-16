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
import { refreshNeoDriverWork } from '../../../packages/daemon/src/lib/neo/driver-refresh.ts';
import { neoStalledAskUuids } from '../../../packages/daemon/src/lib/neo/stalled-asks.ts';

const run = resolve(process.argv[2]);
assert(/^\/(private\/)?tmp\//.test(run));
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
  const finished = (askId: string, todoId: string, producesFollowUp: boolean) => {
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
      {
        title: `${askId} step`,
        doneWhen: 'Written',
        check: null,
        instruction: null,
        named: null,
        ...(producesFollowUp ? { producesFollowUp: true } : {}),
      },
      at
    );
    service!.todos.updateTodo(step, { state: 'done', evidence: 'Written' }, at);
  };
  finished('plan-ask', 'plan-step', true);
  finished('plain-ask', 'plain-step', false);
  const wakeUuid = (askId: string) =>
    neoStalledAskUuids({
      id: askId,
      ...(db
        .prepare(`SELECT title, COALESCE((SELECT MAX(updated_at) FROM neo_todos
          WHERE ask_id = neo_asks.id), updated_at) AS since FROM neo_asks WHERE id = ?`)
        .get(askId) as { title: string; since: number }),
    })[0]!;
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
  for (const askId of ['plan-ask', 'plain-ask']) {
    sdk('user', wakeUuid(askId), 10 + seq);
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
              AND json_extract(payload, '$.message.message.content')
                LIKE '%finished and produces follow-up work%'`
        )
        .all() as { key: string; text: string }[]
    ).map((row) => ({ key: row.key, text: String(row.text) }));
  await refreshNeoDriverWork(app.jobQueue, service);
  const settled = asks();
  (evidence.checks as unknown[]).push({ name: 'auto-settle after one refresh', rows: settled });
  assert.equal(settled['plain-ask'], 'done', 'an ordinary finished ask still settles itself');
  assert.equal(settled['plan-ask'], 'open', 'a finished plan with no follow-up stays open');
  await service.sweepPacks();
  await service.sweepPacks();
  const woken = wakes();
  (evidence.checks as unknown[]).push({ name: 'wakes after two pack sweeps', woken });
  assert.equal(woken.length, 1, 'two sweeps queue one wake for Neo');
  assert(woken[0]!.text.includes('plan-ask step') && woken[0]!.text.includes('plan-ask'));
  const ops = Object.fromEntries(createNeoOperations(service).map((op) => [op.name, op]));
  const settle = ops['neo.ask.settle']!;
  const caller = { source: 'mcp' as const, sessionId: root, role: 'neo' as const };
  const refused = (await settle.execute(
    settle.inputSchema.parse({ askId: 'plan-ask', status: 'done', outcome: 'Planned' }),
    caller
  )) as { ok: boolean; reason?: string };
  (evidence.checks as unknown[]).push({ name: 'settle done without follow-up', refused });
  assert.equal(refused.ok, false);
  assert(refused.reason?.startsWith('follow_up_missing'));
  service.todos.addTodo(
    'build-step',
    'plan-ask',
    { title: 'Build it', doneWhen: 'Merged', check: null, instruction: null, named: null },
    at
  );
  service.todos.updateTodo(service.todos.getTodo('build-step')!, { state: 'done' }, at);
  const accepted = (await settle.execute(
    settle.inputSchema.parse({ askId: 'plan-ask', status: 'done', outcome: 'Planned and built' }),
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
