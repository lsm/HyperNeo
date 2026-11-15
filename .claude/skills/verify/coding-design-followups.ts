import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { neoAskTurnedSettleWrites } from '../../../packages/daemon/src/storage/repositories/neo-ask-settlement.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const dir of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws` });
hub.registerTransport(transport);
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port!));
  await transport.connect();
  const root = 'neo:10000000-0000-4000-8000-000000000123';
  await app.db.createSession({ id: root, title: 'Synthetic coordinator', workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0,
      outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const db = app.db.getDatabase();
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  const prs = new CodingTodoPrRepository(db);
  const now = Date.now();
  store.openAsk({ id: 'design-ask', title: 'Ship a widget', request: 'Implement the widget', projectId: null,
    sessionId: root, originMessageId: null, createdAt: now });
  const add = (id: string) => store.addTodo(id, 'design-ask', { title: id, instruction: 'Implement this slice',
    doneWhen: 'PR merged', named: null, check: { pack: 'coding', kind: 'pr_merged', params: {} } }, now);
  const design = add('design');
  store.updateTodo(design, { state: 'done', finishedAt: now }, now);
  prs.record(design.id, [{ url: 'https://github.com/example/widget/pull/1', head: 'abc', state: 'MERGED',
    checks: 'passing', review: 'approved', files: ['docs/design/widget.md'] }], now);
  const makePack = () => createCodingPack({ database: () => db, todoPrs: prs,
    readPrs: async () => [], projectRepos: () => [], prLedger: new CodingPrLedgerRepository(db),
    prSweep: new CodingPrSweepRepository(db), prEvents: new CodingPrEventRepository(db),
    prSweepDeps: { tell: async () => true, wake: (key, text) => service.wakeNeo(key, text) },
  });
  const settle = () => hub.request<{ ok: boolean; reason?: string }>('operation.invoke', {
    name: 'neo.ask.settle', input: { askId: 'design-ask', status: 'done', outcome: 'Shipped' },
  });
  const visible = () => hub.request<{ ok: boolean; entry: { ask: { status: string } } }>('operation.invoke', {
    name: 'neo.ask.read', input: { askId: 'design-ask' },
  });
  const denied = await settle();
  assert.equal(denied.ok, false);
  assert.match(denied.reason!, /design_followup_required/);
  assert.equal((await visible()).entry.ask.status, 'open');
  await makePack().sweep!(now);
  await makePack().sweep!(now + 1);
  const notes = () => db.prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox'").all() as { payload: string }[];
  const designNotes = () => notes().filter((row) => row.payload.includes('neo-design-followup:'));
  assert.equal(designNotes().length, 1);
  assert.match(designNotes()[0].payload, /Change section/);
  assert.match(designNotes()[0].payload, /design-ask/);
  for (const [i, kind] of ['user', 'result'].entries()) {
    db.prepare(`INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp,
      sdk_uuid, consumed_seq, is_terminal, send_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'consumed')`)
      .run(`turn-${i}`, root, kind, JSON.stringify({ type: kind }), new Date(now + 1000 + i).toISOString(),
        i === 0 ? 'neo-stalled-ask:design-ask:1:0' : 'result', i + 1, i, );
  }
  assert.deepEqual(await app.db.gateway.run(neoAskTurnedSettleWrites, { now: now + 2000, ids: ['design-ask'] }), []);
  assert.equal((await visible()).entry.ask.status, 'open');
  const next = add('implementation');
  await makePack().sweep!(now + 3000);
  assert.equal(designNotes().length, 1);
  assert.match((await settle()).reason!, /todos_unfinished/);
  store.updateTodo(next, { state: 'done', finishedAt: now + 4000 }, now + 4000);
  assert.equal((await settle()).ok, true);
  assert.equal((await visible()).entry.ask.status, 'done');
  writeFileSync(join(run, 'evidence/result.json'), JSON.stringify({ passed: true,
    explicitSettlementHeld: true, automaticSettlementHeld: true, durableWakeCount: designNotes().length,
    unstartedFollowupAccepted: true, implementationStillRequired: true,
    completedAskVisible: true, port: app.server.port }, null, 2));
} finally {
  await transport.disconnect();
  await service.dispose();
  await app.cleanup();
}
