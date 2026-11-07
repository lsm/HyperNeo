process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoSnapshot } from '../../../packages/shared/src/types/neo-snapshot.ts';

const [mode, directory] = process.argv.slice(2),
  run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const name of ['workspace', 'bin', 'evidence'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(
  join(run, 'bin/gh'),
  '#!/bin/sh\necho forbidden >> "' + join(run, 'gh-calls') + '"\nexit 91\n',
  { mode: 0o700 }
);
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert(![8399, 8499].includes(app.server.port));
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws`,
});
hub.registerTransport(transport);
const root = 'neo:10000000-0000-4000-8000-000000008736';
const db = app.db.getDatabase(),
  store = new NeoAskTodoRepository(db);
const prepare = db.prepare.bind(db);
const result: Record<string, unknown> = { mode, port: app.server.port };
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  await app.db.createSession({
    id: root,
    title: 'Synthetic plan context',
    workspacePath: join(run, 'workspace'),
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
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const ids = Array.from({ length: 12 }, (_, i) => `plan-${i}`),
    detail = 'Synthetic retained detail 亮 '.repeat(200);
  db.transaction(() => {
    const ask = prepare(
      'INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,1,1)'
    );
    const todo = prepare(
      "INSERT INTO neo_todos(id,ask_id,position,title,done_when,report,evidence,reason,blocked_reason,next_action,state,approved_at,depends_on,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'todo',1,'[]',1,1)"
    );
    const question = prepare(
      "INSERT INTO neo_questions(id,ask_id,text,kind,state,created_at) VALUES(?,?,?,'reply','open',1)"
    );
    for (const id of ids) {
      ask.run(id, root, `Plan ${id}`, detail);
      for (let i = 0; i < 40; i++)
        todo.run(
          `${id}-step-${i}`,
          id,
          i,
          `Step ${i}`,
          detail,
          detail,
          detail,
          detail,
          detail,
          detail
        );
      question.run(`${id}-question`, id, 'Choose a direction');
    }
  })();
  const mcp = createOperationMcpHandler(app.sessionManager.getOperationRegistry(), () => ({
    sessionId: root,
    role: 'neo',
  }));
  let reads = 0;
  db.prepare = ((sql: string) => {
    if (/\bFROM neo_(asks|todos|questions)\b/i.test(sql)) reads++;
    return prepare(sql);
  }) as typeof db.prepare;
  const rpc = await hub.request<NeoSnapshot>('operation.invoke', {
    name: 'neo.snapshot',
    input: {},
  });
  assert.equal(rpc.todoAsks?.length, 12);
  const reply = await mcp({ name: 'neo.snapshot', input: {} });
  assert(!reply.isError, JSON.stringify(reply));
  const snapshot = JSON.parse(reply.content[0].text) as NeoSnapshot;
  Object.assign(result, {
    rpcAsks: rpc.todoAsks?.map((entry) => entry.ask.id),
    rpcBytes: Buffer.byteLength(JSON.stringify(rpc)),
    snapshot,
    compactBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    mainReads: reads,
  });
  assert.deepEqual(
    snapshot.todoAsks?.map((entry) => entry.ask.id).sort(),
    [...ids].sort(),
    'Open asks are never dropped from the real MCP compact snapshot'
  );
  assert.equal(reads, 0, 'Snapshot read ran target SQL on main');
  const facts = await store.read('planContext');
  assert.equal(facts.asks.length, 12);
  assert.equal(facts.todos.length, 480);
  assert.equal(facts.questions.length, 12);
  const { neoPlanLines, fitNeoPlanLines, planNeoPlanContext } = await import(
    '../../../packages/daemon/src/lib/neo/plan-context.ts'
  );
  const lines = fitNeoPlanLines(neoPlanLines(facts.asks, facts.todos, facts.questions), 2000);
  assert.equal(lines.filter((line) => line.kind === 'ask').length, 12);
  for (const id of ids)
    assert(lines.find((line) => line.id === id)?.text.includes(`neo.ask.read ${id}`));
  assert(planNeoPlanContext(null, lines, 'compact').includes('plan-11'));
  assert.equal(planNeoPlanContext(lines, lines, 'prompt'), '');
  Object.assign(result, {
    lines,
    planReadCounts: {
      asks: facts.asks.length,
      todos: facts.todos.length,
      questions: facts.questions.length,
    },
    mainReads: reads,
  });
  assert.equal(reads, 0, 'Plan read ran target SQL on main');
  for (const [id, parent] of [
    ['legacy-child', 'plan-0'],
    ['legacy-grandchild', 'legacy-child'],
  ])
    prepare(
      'INSERT INTO neo_asks(id,session_id,title,request,parent_id,created_at,updated_at) VALUES(?,?,?,?,?,1,1)'
    ).run(id, root, id, '', parent);
  const legacy = await store.read('planContext');
  const duplicateSteps = legacy.todos.length - new Set(legacy.todos.map((todo) => todo.id)).size;
  const retainedSteps =
    snapshot.todoAsks?.reduce((count, entry) => count + entry.todos.length, 0) ?? 0;
  Object.assign(result, { duplicateSteps, retainedSteps });
  assert.equal(duplicateSteps, 0, 'Legacy family steps were delivered more than once');
  assert(
    retainedSteps > 0,
    'Compact snapshot discarded every step despite space for serialized details'
  );
  assert(!existsSync(join(run, 'gh-calls')), 'A domain client was invoked');
  result.verified = true;
  console.log(
    'PASS: real RPC and agent MCP snapshot retain 12 open plans; gateway plan facts and compact digest retain all owners without target SQL on main'
  );
} finally {
  db.prepare = prepare;
  await transport.close();
  hub.cleanup();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(result, null, 2));
}
