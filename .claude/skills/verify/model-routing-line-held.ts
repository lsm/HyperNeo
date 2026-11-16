process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';

const run = resolve(process.argv[2]);
assert(/^\/(private\/)?tmp\//.test(run));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'KIMI_API_KEY'])
  assert.equal(process.env[key], undefined, `${key} must be unset`);
assert(!existsSync(join(run, 'data')));
for (const dir of ['home', 'workspace', 'evidence']) mkdirSync(join(run, dir), { recursive: true });

const MINUTE = 60_000;
const at = Date.now();
const evidence: Record<string, unknown> = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  checks: [],
};
const check = (name: string, value: unknown) => (evidence.checks as unknown[]).push({ name, value });
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
  const root = 'neo:00000000-0000-4000-8000-00000000d352';
  const session = (id: string, config: unknown, state: unknown) =>
    db
      .prepare(
        'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata,processing_state) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        id,
        'general',
        join(run, 'workspace'),
        new Date(at).toISOString(),
        new Date(at).toISOString(),
        'active',
        JSON.stringify(config),
        '{}',
        JSON.stringify(state)
      );
  session(root, {}, { status: 'idle' });
  db.prepare("INSERT INTO neo_session_bindings (session_id, kind) VALUES (?, 'neo')").run(root);
  service.todos.openAsk({
    id: 'ask-1',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    title: 'Synthetic ask',
    request: 'Synthetic work',
    createdAt: at,
  });
  const todoSessions = new NeoTodoSessionRepository(db);
  const heldTodo = (id: string, worker: string, heldMinutes: number) => {
    const todo = service!.todos.addTodo(
      id,
      'ask-1',
      {
        title: `${id} work`,
        doneWhen: 'Done',
        check: null,
        instruction: 'Do the work.',
        named: null,
        approvedAt: at,
        dependsOn: [],
      },
      at
    );
    const ref = { adapter: 'hyperneo', id: worker };
    todoSessions.create(id, { verb: 'send', ref });
    todoSessions.recordRef(id, ref, at);
    service!.todos.updateTodo(todo, { state: 'doing', startedAt: at }, at);
    todoSessions.recordNudge(id, { since: at, nudges: 0, live: 'running' });
    session(
      worker,
      { provider: 'anthropic', model: 'claude-opus-4-1' },
      {
        status: 'rate_limit_cooldown',
        retryCount: 0,
        maxRetries: 0,
        retryAt: at + 10 * MINUTE,
        reason: 'limit',
        since: at - heldMinutes * MINUTE,
      }
    );
  };
  heldTodo('long-hold', 'worker-long', 31);
  heldTodo('short-hold', 'worker-short', 10);
  const wakes = () =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = 'mailbox' AND text LIKE '%is held on%'`
        )
        .all() as { text: string }[]
    ).map((row) => String(row.text));

  await service.sweepPacks();
  check('wakes while model-routing is off', wakes());
  assert.deepEqual(wakes(), [], 'a disabled pack scans nothing');

  app.settingsManager.updateGlobalSettings({
    neo: { ...app.settingsManager.getGlobalSettings().neo, packs: ['coding', 'delegation', 'model-routing'] },
  });
  await service.sweepPacks();
  await service.sweepPacks();
  const told = wakes();
  check('wakes after two sweeps with model-routing on', told);
  assert.equal(told.length, 1, 'the long hold is told once; the short hold is not told');
  assert(told[0]!.startsWith('Todo "long-hold work" (long-hold) is held on anthropic claude-opus-4-1 via hyperneo (limit) since '));
  assert(told[0]!.includes('No other line is usable for it.'), 'no route is set on a fresh daemon');
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await service?.dispose();
  await app?.cleanup();
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify(evidence, null, 2));
}
console.log(`PASS: a long limit hold on a todo's worker told Neo once. Evidence: ${run}/evidence/result.json`);
