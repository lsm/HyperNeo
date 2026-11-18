process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NEO_REQUEST_REPLY } from '../../../packages/daemon/src/lib/neo/request-todo.ts';
import { NeoConversationReader } from '../../../packages/daemon/src/storage/repositories/neo-conversation-reader.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

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
  assert.deepEqual(recorded!.named, { requestFrom: 'synthetic-requester' });
  assert.equal(asks[0]!.originMessageId, (sent as { value: { messageId: string } }).value.messageId);
  (evidence.checks as unknown[]).push({ name: 'recorded', ask: asks[0], todo: recorded });
  const snapshot = await invokeOperation(registry, 'neo.snapshot', {}, {
    source: 'mcp',
    sessionId: root,
    role: 'neo',
  });
  const snapshotNamed = Object.fromEntries(
    (snapshot as { value: { todoAsks: { todos: { id: string; named: unknown }[] }[] } }).value.todoAsks
      .flatMap((entry) => entry.todos)
      .map((todo) => [todo.id, todo.named])
  );
  assert.deepEqual(
    snapshotNamed,
    { worked: null, [recorded!.id]: { requestFrom: 'synthetic-requester' } },
    'neo.snapshot keeps the request marker on the request todo only'
  );
  (evidence.checks as unknown[]).push({ name: 'snapshot marker', named: snapshotNamed });
  const humanSnapshot = await invokeOperation(registry, 'neo.snapshot', {}, {
    source: 'rpc',
    principal: 'local',
  });
  const humanQueue = (
    humanSnapshot as { value: { humanQueue: { items: { todoId?: string }[] } } }
  ).value.humanQueue;
  assert.deepEqual(
    humanQueue.items.map((item) => item.todoId),
    ['worked'],
    "the human's queue lists the worked todo and never the request todo"
  );
  (evidence.checks as unknown[]).push({ name: 'human queue', humanQueue });
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
  assert.match(hour.at(-1)!, /is a request from session synthetic-requester waiting for your answer/);
  assert.doesNotMatch(hour.at(-1)!, /Write the instruction and start it/);
  const mailbox = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM job_queue WHERE queue = 'mailbox'").get() as { n: number }).n;
  const inbox = (sessionId: string) =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.origin') AS origin,
                  json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = 'mailbox'
              AND json_extract(payload, '$.to.sessionId') = ? ORDER BY created_at, rowid`
        )
        .all(sessionId) as { origin: string; text: string }[]
    ).map((row) => ({ origin: row.origin, text: String(row.text) }));
  db.prepare(
    'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    'synthetic-requester',
    'Synthetic requester',
    'general',
    join(run, 'workspace'),
    new Date(at).toISOString(),
    new Date(at).toISOString(),
    'active',
    '{}',
    '{}'
  );
  const asNeo = { source: 'mcp' as const, sessionId: root, role: 'neo' as const };
  const closed = await invokeOperation(
    registry,
    'neo.todo.done',
    { todoId: recorded!.id, reason: 'Closed the merged synthetic todo' },
    asNeo
  );
  assert.equal((closed as { value?: { ok?: boolean } }).value?.ok, true, JSON.stringify(closed));
  const deliver = async () => {
    const jobs = app!.jobQueue.dequeue(NEO_REQUEST_REPLY, 10);
    const results = [];
    for (const job of jobs) results.push(await service!.deliverRequestReply(job));
    return results;
  };
  assert.deepEqual(await deliver(), [{ kind: 'accepted' }]);
  const replies = inbox('synthetic-requester');
  assert.equal(replies.length, 1, 'closing the request sends exactly one reply to its sender');
  assert.equal(replies[0]!.origin, `session:${encodeURIComponent(root)}`);
  assert.match(
    replies[0]!.text,
    /Neo closed your request "Close the merged synthetic todo" as done: Closed the merged synthetic todo/
  );
  const conversationId = new NeoRepository(db).conversationId()!;
  const page = await new NeoConversationReader(db).read({ conversationId, limit: 100 });
  const answers = page.items.filter(
    (item) =>
      item.role === 'session' &&
      item.message.toSession === 'synthetic-requester' &&
      item.message.fromSession === root
  );
  assert.equal(answers.length, 1, "Neo's conversation holds exactly one outbound answer");
  const humanAnswers = (
    await new NeoConversationReader(db).read({ conversationId, limit: 100 }, true)
  ).items.filter((item) => item.role === 'session');
  assert.equal(humanAnswers.length, 0, 'the human view shows no session-to-session row');
  (evidence.checks as unknown[]).push({
    name: 'Neo closed it',
    closed,
    replies,
    answers,
    humanAnswers,
  });
  const again = await invokeOperation(
    registry,
    'neo.todo.remove',
    { todoId: recorded!.id, reason: 'Retire it' },
    asNeo
  );
  assert.deepEqual(await deliver(), [], 'retiring a closed request queues no second reply');
  assert.equal(inbox('synthetic-requester').length, 1, 'retiring a closed request sends no second reply');
  (evidence.checks as unknown[]).push({ name: 'retired after close', again });
  clock += 11 * 60_000;
  const queued = mailbox();
  const repeat = await send('synthetic-requester', `${title}\nIts pull request merged.`);
  assert.equal((repeat as { value?: { kind?: string } }).value?.kind, 'rejected', JSON.stringify(repeat));
  assert.equal(mailbox(), queued, 'a repeat of a closed request queues no wake');
  assert.equal(todos.listTodos(asks[0]!.id).length, 1);
  (evidence.checks as unknown[]).push({ name: 'repeat after close', repeat, mailbox: mailbox() });
  const lost = 'Close the other synthetic todo';
  assert.equal(
    ((await send('gone-requester', lost)) as { value?: { kind?: string } }).value?.kind,
    'accepted'
  );
  const lostAsk = requestAsks().find((ask) => ask.title === lost)!;
  const [lostTodo] = todos.listTodos(lostAsk.id);
  const failed = await invokeOperation(
    registry,
    'neo.todo.remove',
    { todoId: lostTodo!.id, reason: 'Not needed' },
    asNeo
  );
  assert.equal((failed as { value?: { ok?: boolean } }).value?.ok, true, JSON.stringify(failed));
  assert.deepEqual(await deliver(), [{ kind: 'rejected' }]);
  const told = (
    db
      .prepare(
        `SELECT json_extract(payload, '$.message.message.content') AS text
           FROM job_queue WHERE queue = 'mailbox' AND json_extract(payload, '$.to.sessionId') = ?`
      )
      .all(root) as { text: string }[]
  ).filter((row) => String(row.text).includes('did not reach session gone-requester'));
  assert.equal(told.length, 1, 'Neo is woken with the failed answer');
  (evidence.checks as unknown[]).push({ name: 'reply to an unknown session fails visibly', failed });
  const allAsks = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM neo_asks').get() as { n: number }).n;
  const asksBefore = allAsks();
  const reported = await send('synthetic-worker', 'Which synthetic region should I use?');
  assert.equal((reported as { value?: { kind?: string } }).value?.kind, 'accepted');
  assert.equal(allAsks(), asksBefore, "a worker's own report records no request todo");
  const delivered = (text: string) =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = 'mailbox' AND json_extract(payload, '$.to.sessionId') = ?`
        )
        .all(root) as { text: string }[]
    )
      .map((row) => String(row.text))
      .filter((content) => content.startsWith('<session-message') && content.includes(text));
  const report = delivered('Which synthetic region should I use?');
  assert.equal(report.length, 1);
  assert.doesNotMatch(report[0]!, / ask="/, "a worker's own report carries no ask");
  const split = 'Label the synthetic pull request';
  await send('synthetic-requester', split);
  const splitAsk = requestAsks().find((ask) => ask.title === split)!;
  const [envelope] = delivered(split);
  const named = envelope!.match(/^<session-message from-session="synthetic-requester" ask="([^"]+)"/)?.[1];
  assert.equal(named, splitAsk.id, 'the delivered request names its recorded ask');
  const filed = await invokeOperation(
    registry,
    'neo.todo.add',
    {
      askId: named,
      title: 'Add the synthetic label',
      check: { pack: 'core', kind: 'evidence', params: {} },
      after: [],
    },
    asNeo
  );
  assert.equal((filed as { kind?: string }).kind, 'completed', JSON.stringify(filed));
  assert.equal((filed as { value?: { ok?: boolean } }).value?.ok, false, JSON.stringify(filed));
  assert.deepEqual(todos.listTodos(splitAsk.id).map((todo) => todo.title), [split]);
  (evidence.checks as unknown[]).push({ name: 'request cannot accept work', envelope, report, filed });
  evidence.passed = true;
  console.log(
    `PASS request_todos=1 wakes_at_30m=${half.length} wakes_at_1h=${hour.length} replies=${replies.length} answers=${answers.length} human_answers=${humanAnswers.length} reply_failed=woke_neo closed_repeat=rejected snapshot_marker=request_only human_queue=no_request envelope_ask=request_only work_on_request_ask=refused`
  );
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await service?.dispose();
  await app?.cleanup();
  Date.now = realNow;
  writeFileSync(join(run, 'evidence/neo-request-todo.json'), JSON.stringify(evidence, null, 2));
}
