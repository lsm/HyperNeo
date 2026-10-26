import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../../../packages/daemon/src/storage/database-core.ts';
import { JobQueueRepository } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createHyperneoAdapter } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';
import { createWorkVerbOperations } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';
import { handoffPromptToMailbox } from '../../../packages/daemon/src/lib/mailbox/handoff.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { recordOperationRefusal } from '../../../packages/daemon/src/storage/repositories/operation-refusal-repository.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
const receipts: unknown[] = [];
let database = new DatabaseCore(join(run, 'data/daemon.db'));
const root = 'neo:10000000-0000-4000-8000-000000008847';
const worker = '10000000-0000-4000-8000-000000008847';
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
try {
  await database.initialize();
  const db = database.getDb();
  for (const id of [root, worker]) db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic worker', ?, '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z', 'active', '{}', '{}')").run(id, run);
  const store = new NeoAskTodoRepository(db);
  for (const id of ['open', 'closed', 'foreign']) {
    const ask = store.openAsk({ id, sessionId: id === 'foreign' ? worker : root, projectId: null, originMessageId: null, title: 'Synthetic ask', request: 'Track synthetic work', createdAt: 1 });
    store.addTodo(`${id}-todo`, ask.id, { title: 'Synthetic todo', doneWhen: 'Verified', instruction: null, check: null, named: null }, 1);
    if (id === 'closed') store.settleAsk(ask, 'done', 'Synthetic settlement', 2);
  }
  const unavailable = () => { throw new Error('Session control must not run'); };
  const adapter = createHyperneoAdapter({
    db: () => db, machine: 'synthetic', homeDir: join(run, 'home'), neoFolder: () => run,
    searchChats: async () => [], folderExists: () => true, makeFolder: unavailable,
    sessions: { create: unavailable, resolveModel: unavailable, model: () => null, chooseWorktree: unavailable, announce: unavailable, interrupt: unavailable },
    handoff: (id, message, from, messageUuid, deliveryMode) => handoffPromptToMailbox({
      to: `session:${id}`, origin: from, messageUuid, deliveryMode,
      message: { type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null },
      jobQueue: new JobQueueRepository(db),
    }),
  });
  const registry = createOperationRegistry(createWorkVerbOperations({
    adapters: () => [adapter], daemonName: 'synthetic',
    remote: { list: () => [], invoke: async () => { throw new Error('Remote work must not run'); } },
    isOpenTodo: (id, sessionId) => {
      const todo = store.getTodo(id), ask = todo && store.getAsk(todo.askId);
      return !!ask && ask.status === 'open' && ask.sessionId === sessionId;
    },
  }));
  const handler = createOperationMcpHandler(registry, () => ({ sessionId: root, role: 'neo' }), (refusal) => gatewayFor(db).run(recordOperationRefusal, { refusal, sessionId: root, at: Date.now() }));
  const call = async (name: string, todoId?: string) => {
    const reply = await handler({ name, input: { ref: { adapter: 'hyperneo', id: worker }, message: `Synthetic ${name} ${todoId ?? 'untracked'}`, ...(todoId ? { todoId } : {}) } });
    const value = JSON.parse(reply.content[0].text);
    receipts.push({ name, todoId, reply: value });
    assert.equal(reply.isError ?? false, false);
    assert.equal(value.ok, true, JSON.stringify(value));
    return value;
  };
  for (const name of ['work.send', 'work.queue']) {
    for (const todoId of [undefined, 'unknown', 'closed-todo', 'foreign-todo']) {
      const reply = await call(name, todoId);
      assert(reply.records?.some((record: string) => record.startsWith('todo_required:')));
      assert.equal(reply.value.receipt.executionId, worker);
      if (name === 'work.queue') assert.equal(reply.value.delivered, false);
    }
  }
  assert.equal((await call('work.send', 'open-todo')).records, undefined);
  const jobs = db.prepare("SELECT payload FROM job_queue WHERE queue='mailbox'").all();
  assert.equal(jobs.length, 9);
  const queued = jobs.map((row) => JSON.parse((row as { payload: string }).payload));
  assert.equal(queued.filter((entry) => entry.deliveryMode === 'defer').length, 4);
  assert(queued.every((entry) => entry.to.sessionId === worker && entry.origin === `session:${encodeURIComponent(root)}`));
  evidence.mailbox = queued;
  database.close();
  database = new DatabaseCore(join(run, 'data/daemon.db'));
  await database.initialize();
  assert.equal(database.getDb().prepare("SELECT count(*) AS count FROM job_queue WHERE queue='mailbox'").get()?.count, 9);
  const audits = database.getDb().prepare('SELECT operation,reason,accepted FROM operation_refusals').all();
  assert.equal(audits.length, 8); assert(audits.every((audit) => (audit as { accepted: number }).accepted === 1));
  evidence.audits = audits;
  evidence.passed = true;
  evidence.scope = 'Production MCP receipt, HyperNeo adapter and durable mailbox acceptance across DB reopen; no provider execution or full daemon listener.';
  console.log('PASS: eight untracked work calls accepted with visible records; all nine mailbox deliveries survive database reopen.');
} finally {
  database.close();
  globalThis.fetch = originalFetch;
  evidence.receipts = receipts;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
