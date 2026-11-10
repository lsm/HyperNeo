import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { SessionScheduler } from '../../../packages/daemon/src/lib/scheduler/session-schedules.ts';
import { createScheduleDelivery } from '../../../packages/daemon/src/lib/scheduler/session-schedule-delivery.ts';
import { createSessionScheduleFire } from '../../../packages/daemon/src/lib/scheduler/session-schedule-fire.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import {
  createNeoOperations,
  createNeoService,
} from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const repo = resolve(import.meta.dir, '../../..');
const evidence = join(run, 'evidence');
const cwd = join(run, 'workspace');
const records = join(
  run,
  'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account'
);
const registrations = join(run, 'home/.claude/sessions');
const projects = join(run, 'home/.claude/projects', cwd.replace(/[/.]/g, '-'));
for (const dir of [evidence, cwd, records, registrations, projects, join(run, 'bin')])
  mkdirSync(dir, { recursive: true });
chmodSync(registrations, 0o700);
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(
  join(run, 'bin/claude'),
  `#!/bin/sh
if [ "$1" = agents ] && [ "$2" = --json ]; then
  exec /bin/cat ${shellQuote(join(evidence, 'live-sessions.json'))}
fi
exec ${shellQuote(process.execPath)} ${shellQuote(join(repo, 'packages/daemon/tests/fixtures/claude-b1-cli.ts'))} "$@"
`,
  { mode: 0o700 }
);
for (const name of ['gh', 'open'])
  writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

let offset = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + offset;
const stamp = () => new Date(Date.now()).toISOString();
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Worker = {
  name: string;
  id: string;
  pid: number;
  status: string;
  waitingFor?: string;
  hold: boolean;
  frames: string[];
  server: Server;
  ref: { adapter: string; id: string };
};
const workers: Worker[] = [];
const saveState = () => {
  const sessions = workers.map(({ id, name, pid, status, waitingFor }) => ({
    id,
    title: name,
    cwd,
    permissionMode: 'auto',
    pid,
    status,
    waitingFor,
  }));
  writeFileSync(join(evidence, 'native-sessions.json'), JSON.stringify(sessions));
  writeFileSync(
    join(evidence, 'live-sessions.json'),
    JSON.stringify(
      sessions.map((session) => ({
        sessionId: session.id,
        pid: session.pid,
        cwd,
        status: session.status,
        name: session.title,
        waitingFor: session.waitingFor,
      }))
    )
  );
};
const touch = (worker: Worker) =>
  writeFileSync(
    join(records, `local_${worker.id}.json`),
    JSON.stringify({
      sessionId: `local_${worker.id}`,
      cliSessionId: worker.id,
      title: worker.name,
      cwd,
      lastActivityAt: Date.now(),
      permissionMode: 'auto',
    })
  );
let frozenListing = false;
const write = (worker: Worker, entry: object) => {
  appendFileSync(
    join(projects, `${worker.id}.jsonl`),
    `${JSON.stringify({ timestamp: stamp(), cwd, ...entry })}\n`
  );
  if (!frozenListing) touch(worker);
};
const said = (worker: Worker, text: string, id = crypto.randomUUID()) =>
  write(worker, {
    type: 'assistant',
    uuid: id,
    message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  });
const typed = (worker: Worker, text: string) =>
  write(worker, {
    type: 'user',
    uuid: crypto.randomUUID(),
    message: { role: 'user', content: text },
  });
function ask(worker: Worker, input: object, closing = 'Closing message.') {
  const id = crypto.randomUUID();
  const tool = `toolu_${id.slice(0, 8)}`;
  write(worker, {
    type: 'assistant',
    uuid: id,
    message: {
      id,
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: tool, name: 'mcp__ccd_turn__wrap_up', input }],
    },
  });
  write(worker, {
    type: 'user',
    uuid: crypto.randomUUID(),
    message: { content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] },
  });
  said(worker, closing);
}
const question = (text: string) => ({
  recap: 'Reached a decision point.',
  ask: text,
  actions: [{ label: 'Yes' }, { label: 'Not now' }],
});

async function worker(name: string): Promise<Worker> {
  const pid = 9100 + workers.length;
  const socketPath = join(registrations, `${pid}.sock`);
  const id = crypto.randomUUID();
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.endsWith('\n')) return;
      const frame = JSON.parse(buffer);
      item.frames.push(frame.message.content);
      socket.end();
      if (item.hold) {
        write(item, {
          type: 'queue-operation',
          operation: 'enqueue',
          commandUuid: frame.uuid,
          content: frame.message.content,
        });
        return;
      }
      write(item, {
        type: 'user',
        uuid: frame.uuid,
        message: { role: 'user', content: frame.message.content },
      });
      said(item, 'Thanks, going on.');
    });
  });
  const item: Worker = {
    name,
    id,
    pid,
    status: 'idle',
    hold: false,
    frames: [],
    server,
    ref: { adapter: 'claude-desktop', id: `local_${id}` },
  };
  await new Promise<void>((done) => server.listen(socketPath, done));
  chmodSync(socketPath, 0o600);
  workers.push(item);
  saveState();
  writeFileSync(
    join(registrations, `${pid}.json`),
    JSON.stringify({
      sessionId: id,
      pid,
      procStart: 1,
      entrypoint: 'claude-desktop',
      version: '2.1.302',
      peerProtocol: 1,
      peerFeatures: ['notify_idle'],
      messagingSocketPath: socketPath,
    })
  );
  writeFileSync(
    join(run, 'bin/ps'),
    `#!/bin/sh\n${workers.map((w) => `printf '%s\\n' '${w.pid} 1 ${w.pid} 00:20 claude --resume ${w.id} --permission-mode auto'`).join('\n')}\n`,
    { mode: 0o700 }
  );
  writeFileSync(join(projects, `${id}.jsonl`), '');
  typed(item, 'Do the work');
  said(item, 'Working.');
  offset += 180_000;
  touch(item);
  return item;
}

saveState();
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
const app = await createDaemonApp({ config, verbose: false });
const results: Record<string, unknown> = {};
const told = () =>
  app.db
    .getJobQueueRepo()
    .listActiveByPayload('mailbox', { 'to.sessionId': 'synthetic-neo' })
    .map((job) => ({
      id: job.payload.messageUuid ?? job.id,
      text: String(job.payload.message.message.content),
    }));
const humanHub = new MessageHub({ defaultSessionId: 'global' });
let humanClosed = Promise.resolve();
const humanTransport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: (url) => {
    const socket = createLocalSocket(url);
    humanClosed = new Promise<void>((resolve) =>
      socket.addEventListener('close', () => resolve(), { once: true })
    );
    return socket;
  },
});
humanHub.registerTransport(humanTransport);
const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.jobProcessor.stop();
  await app.spaceRuntimeService.ready();
  await humanTransport.connect();
  const db = app.db.getDatabase();
  await app.db.createSession({
    id: 'synthetic-neo',
    title: 'Neo',
    workspacePath: cwd,
    createdAt: stamp(),
    lastActiveAt: stamp(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {},
  } as never);
  new NeoRepository(db).reserveBinding({
    sessionId: 'synthetic-neo',
    projectId: null,
    kind: 'neo',
  });
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const registry = app.sessionManager.getOperationRegistry();
  const neoRegistry = createOperationRegistry(createNeoOperations(service));
  const neo = { source: 'mcp', sessionId: 'synthetic-neo', role: 'neo' } as const;
  app.sessionManager.setOperationRegistryProvider(() =>
    createOperationRegistry([
      ...registry.entries.filter((operation) => !neoRegistry.get(operation.name)),
      ...neoRegistry.entries,
    ])
  );
  const op = async <T = Record<string, unknown>>(
    name: string,
    input: unknown,
    caller: object = neo
  ): Promise<T> => {
    const outcome = await invokeOperation(
      name.startsWith('neo.') ? neoRegistry : registry,
      name,
      input,
      caller as never
    );
    assert.equal(outcome.kind, 'completed', `${name}: ${JSON.stringify(outcome)}`);
    return (outcome as { value: T }).value;
  };
  const status = async (item: Worker) =>
    (await op<{ ok: boolean; value: Record<string, unknown> }>('work.status', { ref: item.ref }))
      .value;
  const refresh = async () => {
    await service.refreshDriverWork();
    await delay(5);
  };
  const heard = (text: string) => told().filter((note) => note.text.includes(text));
  const onTodo = async (item: Worker, title: string) => {
    const id = crypto.randomUUID();
    store.openAsk({
      id,
      sessionId: 'synthetic-neo',
      projectId: null,
      originMessageId: null,
      title,
      request: title,
      createdAt: Date.now(),
    });
    const todo = store.addTodo(
      crypto.randomUUID(),
      id,
      { title, doneWhen: 'Done', instruction: 'Do the work', check: null, named: null },
      Date.now()
    );
    sessions.bind(todo.id, item.ref, Date.now() - 1);
    sessions.recordStartedAt(todo.id, Date.now() - 1);
    store.updateTodo(todo, { state: 'doing', startedAt: Date.now() - 1 }, Date.now());
    return todo.id;
  };
  const noteKey = (item: Worker) => `${item.ref.adapter}::${item.ref.id}`;
  const answerCard = async (id: string, answer: string) => {
    const reply = await humanHub.request<{ ok: boolean; reason?: string }>('operation.invoke', {
      name: 'neo.question.answer',
      input: { questionId: id, answer },
    });
    assert(reply.ok, JSON.stringify(reply));
  };
  const card = async (questionId: string) =>
    (
      await humanHub.request<{ question: Record<string, unknown> }>('operation.invoke', {
        name: 'neo.question.get',
        input: { questionId },
      })
    ).question;
  const check = async (label: string, body: () => Promise<unknown>) => {
    try {
      results[label] = { pass: true, detail: await body() };
      console.log(`PASS ${label}`);
    } catch (error) {
      results[label] = { pass: false, error: String(error) };
      console.log(`FAIL ${label}: ${String(error).replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  };

  await check('1 todo: Neo answers', async () => {
    const item = await worker('case-1');
    const todoId = await onTodo(item, 'Case 1');
    ask(item, question('Case one question?'));
    await refresh();
    assert.equal(heard('Case one question?').length, 1, 'Neo hears once');
    assert.match(heard('Case one question?')[0].text, /Options: Yes; Not now/);
    const reply = await op<{ ok: boolean; reason?: string }>('neo.todo.continue', {
      todoId,
      message: 'Case one answer',
    });
    assert(reply.ok, JSON.stringify(reply));
    assert(
      item.frames.some((text) => text.includes('Case one answer')),
      'worker receives the answer'
    );
    assert.notEqual((await status(item)).status, 'needs_you');
    return { todo: store.getTodo(todoId)?.state };
  });

  await check('2 todo: human card', async () => {
    const item = await worker('case-2');
    const todoId = await onTodo(item, 'Case 2');
    ask(item, question('Case two question?'));
    await refresh();
    const relayed = await op<{
      ok: boolean;
      reason?: string;
      question: { id: string; text: string };
    }>('neo.question.relay', { todoId, title: 'Case two question?', options: ['Yes', 'Not now'] });
    assert(relayed.ok, JSON.stringify(relayed));
    const open = await card(relayed.question.id);
    assert.equal(open.text, 'Case two question?');
    assert.equal((open.sourceSession as { id: string }).id, item.ref.id);
    await answerCard(relayed.question.id, 'Yes');
    await refresh();
    assert(
      item.frames.some((text) => text.includes('Yes')),
      'worker receives the human answer'
    );
    const resumed = await status(item);
    assert.notEqual(resumed.status, 'needs_you');
    assert.match(String(resumed.lastReply), /Thanks, going on/);
    return { source: open.sourceSession, frames: item.frames.length };
  });

  await check('3a no todo: Neo answers', async () => {
    const item = await worker('case-3a');
    await refresh();
    ask(item, question('Case three A?'));
    await refresh();
    assert.equal(heard('Case three A?').length, 1, 'Neo hears once');
    assert.match(heard('Case three A?')[0].text, new RegExp(item.ref.id));
    const sent = await op<{ ok: boolean }>('work.send', {
      ref: item.ref,
      message: 'Three A answer',
      notice: true,
    });
    assert(sent.ok, JSON.stringify(sent));
    assert(item.frames.some((text) => text.includes('Three A answer')));
    assert.notEqual((await status(item)).status, 'needs_you');
  });

  await check('3b no todo: human card', async () => {
    const item = await worker('case-3b');
    await refresh();
    ask(item, question('Case three B?'));
    await refresh();
    const relayed = await op<{ ok: boolean; reason?: string; question: { id: string } }>(
      'neo.question.relay',
      { session: noteKey(item), title: 'Case three B?', options: ['Yes', 'Not now'] }
    );
    assert(relayed.ok, JSON.stringify(relayed));
    const open = await card(relayed.question.id);
    assert.equal((open.sourceSession as { id: string }).id, item.ref.id);
    await answerCard(relayed.question.id, 'Not now');
    await refresh();
    assert(
      item.frames.some((text) => text.includes('Not now')),
      'worker receives the human answer'
    );
    const resumed = await status(item);
    assert.notEqual(resumed.status, 'needs_you');
    assert.match(String(resumed.lastReply), /Thanks, going on/);
    return { status: resumed.status, reply: resumed.lastReply };
  });

  await check('4 two questions, running never seen', async () => {
    const free = await worker('case-4-free');
    const held = await worker('case-4-todo');
    const todoId = await onTodo(held, 'Case 4');
    await refresh();
    for (const item of [free, held]) ask(item, question(`First ${item.name}?`));
    await refresh();
    await delay(5);
    for (const item of [free, held]) {
      typed(item, 'Answered');
      ask(item, question(`Second ${item.name}?`));
    }
    offset += 150_000;
    await refresh();
    for (const item of [free, held]) {
      assert.equal(heard(`with a question: First ${item.name}?`).length, 1, `${item.name} first`);
      assert.equal(heard(`with a question: Second ${item.name}?`).length, 1, `${item.name} second`);
    }
    return { todo: store.getTodo(todoId)?.state };
  });

  await check('4b question found only by the 10-minute re-read', async () => {
    const item = await worker('case-4b');
    await refresh();
    const key = noteKey(item);
    const listing = async () =>
      (
        await op<{
          places: { work: { ref: { id: string }; lastActivityAt: number; status: string }[] }[];
        }>('work.find', { localOnly: true, limit: 30 })
      ).places
        .flatMap((place) => place.work)
        .find((work) => work.ref.id === item.ref.id);
    const before = await listing();
    frozenListing = true;
    ask(item, question('Case four B?'));
    frozenListing = false;
    const after = await listing();
    assert.equal(after?.lastActivityAt, before?.lastActivityAt, 'the listing does not change');
    assert.equal(after?.status, before?.status);
    await refresh();
    assert.equal(
      heard('with a question: Case four B?').length,
      0,
      'not read before the recheck is due'
    );
    offset += 10 * 60_000;
    await refresh();
    assert.equal(heard('with a question: Case four B?').length, 1, 'Neo hears within one re-read');
    offset += 10 * 60_000;
    await refresh();
    assert.equal(heard('with a question: Case four B?').length, 1, 'only once');
    return { key };
  });

  await check('5 human present for 2 minutes', async () => {
    const free = await worker('case-5-free');
    const held = await worker('case-5-todo');
    await onTodo(held, 'Case 5');
    await refresh();
    for (const item of [free, held]) {
      typed(item, 'Human typed this');
      ask(item, question(`Present ${item.name}?`));
    }
    await refresh();
    offset += 60_000;
    await refresh();
    assert.equal(heard('with a question: Present case-5').length, 0, 'nothing inside 2 minutes');
    offset += 90_000;
    await refresh();
    await refresh();
    assert.equal(
      heard('with a question: Present case-5-free?').length,
      1,
      'no-todo session heard after 2 minutes'
    );
    assert.equal(
      heard('with a question: Present case-5-todo?').length,
      1,
      'todo session heard after 2 minutes'
    );
    return { fyiDuringHold: heard('The human worked directly').length };
  });

  await check('6 human answers in Desktop', async () => {
    const item = await worker('case-6');
    const todoId = await onTodo(item, 'Case 6');
    ask(item, question('Case six?'));
    await refresh();
    const relayed = await op<{ ok: boolean; question: { id: string } }>('neo.question.relay', {
      todoId,
      title: 'Case six?',
      options: ['Yes', 'Not now'],
    });
    assert(relayed.ok, JSON.stringify(relayed));
    assert.equal((await status(item)).status, 'needs_you');
    typed(item, 'Answered in Desktop');
    said(item, 'Going on.');
    await refresh();
    assert.equal((await status(item)).status, 'done');
    const closed = await card(relayed.question.id);
    assert.notEqual(closed.state, 'open', 'card closes');
    return { card: closed.state, todo: store.getTodo(todoId)?.state };
  });

  await check('7 stale question', async () => {
    const item = await worker('case-7');
    const todoId = await onTodo(item, 'Case 7');
    ask(item, question('Case seven?'));
    await refresh();
    item.hold = true;
    const reply = await op<{ ok: boolean; reason?: string }>('neo.todo.continue', {
      todoId,
      message: 'Case seven answer',
    });
    assert(reply.ok, JSON.stringify(reply));
    assert.equal(
      (await status(item)).turnQuestion,
      undefined,
      'the queued answer clears the question before consumption'
    );
    await refresh();
    await refresh();
    assert.equal(heard('Case seven?').length, 1, 'the sent-over question is not told again');
    const later = await worker('case-7-later');
    ask(later, question('Older question?'));
    await delay(5);
    await onTodo(later, 'Case 7 later');
    await refresh();
    assert.equal(heard('Older question?').length, 0, 'a question from before the todo is not told');
    item.hold = false;
  });

  await check('8 blocked with no ask', async () => {
    const item = await worker('case-8');
    await onTodo(item, 'Case 8');
    ask(item, { recap: 'Waiting on a key from the human.', blocked: true });
    await refresh();
    assert.equal(heard('Waiting on a key from the human.').length, 1);
    const current = await status(item);
    assert.equal(current.status, 'needs_you');
    return { waitingFor: current.waitingFor };
  });

  await check('9 long turn and compaction', async () => {
    const item = await worker('case-9');
    write(item, {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      message: {
        id: 'big',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }],
      },
    });
    ask(item, question('Case nine?'), 'y'.repeat(2 * 1024 * 1024 - 4096));
    assert.equal((await status(item)).status, 'needs_you', 'wrap_up near the tail edge');
    const compacted = await worker('case-9-compact');
    ask(compacted, question('Case nine compacted?'));
    write(compacted, { type: 'system', subtype: 'compact_boundary', uuid: crypto.randomUUID() });
    write(compacted, {
      type: 'user',
      uuid: crypto.randomUUID(),
      isCompactSummary: true,
      message: { role: 'user', content: 'Summary of the conversation.' },
    });
    assert.equal((await status(compacted)).status, 'needs_you', 'compaction keeps the question');
    const beyond = await worker('case-9-beyond');
    ask(beyond, question('Beyond the tail?'), 'z'.repeat(3 * 1024 * 1024));
    return { closingLongerThanTail: (await status(beyond)).status };
  });

  await check('10 real permission prompt', async () => {
    const item = await worker('case-10');
    const todoId = await onTodo(item, 'Case 10');
    item.status = 'waiting';
    item.waitingFor = 'permission prompt';
    saveState();
    touch(item);
    const current = await status(item);
    assert.equal(current.status, 'needs_you');
    assert.equal(current.turnQuestion, undefined);
    const before = item.frames.length;
    const reply = await op<{ ok: boolean; reason?: string }>('neo.todo.continue', {
      todoId,
      message: 'Should not arrive',
    });
    assert.equal(reply.ok, false);
    assert.match(String(reply.reason), /^needs_you/);
    assert.equal(item.frames.length, before);
    return { reason: reply.reason };
  });
  await check('11 scheduled reminder reaches an idle question session', async () => {
    const item = await worker('case-11');
    ask(item, question('Keep this plan?'));
    assert.equal((await status(item)).status, 'needs_you');
    const scheduler = new SessionScheduler(db, app.db.getJobQueueRepo());
    const schedule = scheduler.create(
      {
        target: item.ref,
        sourceKind: 'reminder',
        sourceId: 'question-wake',
        note: 'Synthetic scheduled check',
        cadence: { kind: 'every', everyMs: 60_000 },
        nudgeEvery: 1,
        createdBySession: 'synthetic-neo',
      },
      Date.now() - 60_000
    );
    const result = await createSessionScheduleFire({
      scheduler,
      ...createScheduleDelivery(app.db, () => registry),
    })(app.db.getJobQueueRepo().getJob(schedule.pendingJobId!)!);
    assert.equal(result.outcome, 'fired');
    const resumed = await status(item);
    assert.notEqual(resumed.status, 'needs_you');
    assert.match(String(resumed.lastReply), /Synthetic scheduled check/);
    return { outcome: result.outcome, status: resumed.status, reply: resumed.lastReply };
  });

  writeFileSync(
    join(evidence, 'observed.json'),
    JSON.stringify({ results, told: told().map((note) => note.id) }, null, 2)
  );
  const failed = Object.entries(results).filter(([, value]) => !(value as { pass: boolean }).pass);
  assert.equal(failed.length, 0, `failed: ${failed.map(([label]) => label).join(', ')}`);
  console.log('PASS: every turn-ended question case');
} finally {
  await humanTransport.close();
  await humanClosed;
  humanHub.cleanup();
  await service.dispose();
  await app.cleanup();
  await Promise.all(
    workers.map((item) => new Promise<void>((resolve) => item.server.close(() => resolve())))
  );
  writeFileSync(
    join(evidence, 'cleanup.json'),
    JSON.stringify({ stopped: true, workers: workers.length })
  );
}
