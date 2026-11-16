process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';

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
  const root = 'neo:00000000-0000-4000-8000-00000000b772';
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
  const worker = { adapter: 'hyperneo', id: 'synthetic-worker' };
  todos.addTodo(
    'worked',
    'ask',
    {
      title: 'worked',
      doneWhen: 'Observed',
      check: null,
      named: null,
      instruction: 'Do the synthetic step.',
      approvedAt: at,
      dependsOn: [],
    },
    at
  );
  todoSessions.bind('worked', worker, at);
  todos.updateTodo(todos.getTodo('worked')!, { state: 'doing', startedAt: at }, at);
  const registry = app.sessionManager.getOperationRegistry();
  const send = (sessionId: string, text: string) =>
    invokeOperation(registry, 'message.send', { to: root, kind: 'question', text }, {
      source: 'mcp',
      sessionId,
    });
  const requestAsks = () => todos.listOpenAsks().filter((ask) => ask.id !== 'ask');
  const title = 'Close the merged synthetic todo';
  const sent = await send('synthetic-requester', `${title}\nIts pull request merged.`);
  assert.equal((sent as { value?: { kind?: string } }).value?.kind, 'accepted', JSON.stringify(sent));
  const asks = requestAsks();
  assert.equal(asks.length, 1, 'a request from a session with no open todo is recorded');
  const [recorded] = todos.listTodos(asks[0]!.id);
  assert.equal(recorded!.title, title);
  assert.equal(asks[0]!.originMessageId, (sent as { value: { messageId: string } }).value.messageId);
  (evidence.checks as unknown[]).push({ name: 'recorded', ask: asks[0], todo: recorded });
  const wakes = () =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = 'mailbox'
              AND json_extract(payload, '$.to.sessionId') = ? ORDER BY created_at, rowid`
        )
        .all(root) as { text: string }[]
    )
      .map((row) => String(row.text))
      .filter((text) => text.startsWith(`Todo "${title}"`));
  const sweep = async (name: string, hours: number) => {
    clock = at + hours * HOUR;
    await service!.sweepPacks();
    await service!.sweepPacks();
    const told = wakes();
    (evidence.checks as unknown[]).push({ name, hours, told });
    return told;
  };
  const half = await sweep('Neo ignored it for 30 minutes', 0.5);
  const hour = await sweep('Neo still ignored it at 1 h', 1);
  assert.equal(hour.length, half.length + 1, 'the request todo wakes Neo again at its 1 h rung');
  const reported = await send('synthetic-worker', 'Which synthetic region should I use?');
  assert.equal((reported as { value?: { kind?: string } }).value?.kind, 'accepted');
  assert.equal(requestAsks().length, 1, "a worker's own report records no request todo");
  evidence.passed = true;
  console.log(`PASS request_todos=1 wakes_at_30m=${half.length} wakes_at_1h=${hour.length}`);
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await service?.dispose();
  await app?.cleanup();
  Date.now = realNow;
  writeFileSync(join(run, 'evidence/neo-request-todo.json'), JSON.stringify(evidence, null, 2));
}
