process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const directory of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, directory), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP refused'); }) as typeof fetch;
const repo = 'synthetic/unowned';
const root = 'neo:10000000-0000-4000-8000-000000001037';
const ref = { adapter: 'hyperneo', id: 'synthetic-owner' };
const url = (number: number) => `https://github.com/${repo}/pull/${number}`;
const attempts: { key: string; text: string }[] = [];
const evidence: Record<string, unknown> = { verified: false, ports: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
let socket: WebSocket | undefined;
let accept = false, loseAck = false, measuring = false, now = Date.now(), numbers = [1, 2, 3];
const inspect = <T>(read: () => T): T => {
  const wasMeasuring = measuring;
  measuring = false;
  try { return read(); } finally { measuring = wasMeasuring; }
};
const state = () => inspect(() => app!.db.getDatabase().prepare(
  'SELECT pending_key AS key, pending_rows AS rows FROM pack_coding_pr_unowned_state').get() as { key: string | null; rows: string | null });
const mailbox = () => inspect(() => (app!.db.getDatabase().prepare(
  "SELECT payload FROM job_queue WHERE queue='mailbox'").all() as { payload: string }[])
  .map((row) => JSON.parse(row.payload)).filter((entry) => entry.to.sessionId === root &&
    entry.message.message.content.startsWith('New pull requests observed without a known worker owner:')));
const open = async () => {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1',
    dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert(![8399, 8499].includes(app.server.port));
  (evidence.ports as unknown[]).push(app.server.port);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  await app.db.updateGlobalSettings({ neo: { packs: [] } });
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const execute = app.db.gateway.run.bind(app.db.gateway);
  app.db.gateway.run = (async (operation, args) => {
    if (loseAck && operation.name === 'coding.unowned.commands' &&
      (args as { method: string }).method === 'acknowledge') {
      loseAck = false;
      throw new Error('Synthetic acknowledgement lost after admission');
    }
    return execute(operation, args);
  }) as typeof app.db.gateway.run;
  const db = app.db.getDatabase(), prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    assert(!(measuring && /pack_coding_pr_unowned|WITH active AS/.test(sql)), 'Claim and receipt SQL must stay off main');
    return prepare(sql);
  }) as typeof db.prepare;
  const activated = state();
  assert(activated);
  const cutoff = db.prepare('SELECT activated_at AS at FROM pack_coding_pr_unowned_state').get() as { at: number };
  const ledger = new CodingPrLedgerRepository(db);
  const pack = createCodingPack({ database: () => db, readPrs: async () => [],
    todoPrs: new CodingTodoPrRepository(db), prLedger: ledger,
    prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db),
    projectRepos: () => [repo], readLedgerRepo: async () => ({ data: { rateLimit: { remaining: 4000 },
      repository: { nameWithOwner: repo, open: { pageInfo: { hasNextPage: false },
        nodes: numbers.map((number) => ({ number, title: `Synthetic ${number}`, headRefName: `work-${number}`,
          headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
          reviewDecision: null, closedAt: null, createdAt: new Date(cutoff.at + 1).toISOString(),
          author: { login: 'synthetic', __typename: 'User' } })) }, done: { nodes: [] } } } }),
    prSweepDeps: { tell: async () => true, delivery: {
      recipient: () => root,
      status: async (recipient, key) => service!.deliveryStatus(recipient, key),
      send: async (recipient, key, text) => {
        assert.equal(recipient, root);
        assert.equal(state().key, key);
        attempts.push({ key, text });
        if (!accept) return false;
        await service!.deliverForward(recipient, key, text, recipient, 'event');
        return true;
      },
    }, wake: async (key, text) => {
      assert.equal(state().key, key, 'Reservation must commit before delivery');
      attempts.push({ key, text });
      if (!accept) return false;
      await service!.deliverForward(root, key, text, root, 'event');
      return true;
    } },
  });
  app.jobProcessor.register('verify.unowned.claims', async () => {
    await pack.sweep!(now += 61000);
    return { swept: true };
  });
  socket = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`, join(run, 'data/local-rpc.credential'));
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('RPC unavailable')); });
};
const close = async () => {
  socket?.close(); socket = undefined;
  await service?.dispose(); service = undefined;
  await app?.cleanup(); app = undefined;
};
const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
  const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error(`${name} timed out`)), 10000);
  socket!.onmessage = (event) => {
    const reply = JSON.parse(String(event.data));
    if (reply.id !== id && reply.requestId !== id) return;
    clearTimeout(timer);
    reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data);
  };
  socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke',
    data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
const sweep = async () => {
  const job = app!.jobQueue.enqueue({ queue: 'verify.unowned.claims', payload: {}, maxRetries: 0, priority: 100 });
  measuring = true;
  await app!.jobProcessor.start();
  try {
    for (let count = 0; count < 400; count++) {
      const current = app!.jobQueue.getJob(job.id)!;
      if (current.status === 'completed') return;
      if (current.error) throw new Error(current.error);
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error('Sweep job did not finish');
  } finally { await app!.jobProcessor.stop(); measuring = false; }
};
try {
  await open();
  const watched = await rpc('pack.preferences.set', { pack: 'coding',
    scope: { kind: 'global', key: '' }, key: 'watchedRepos', value: [repo] });
  assert((watched as { ok: boolean }).ok, JSON.stringify(watched));
  await app!.db.createSession({ id: root, title: 'Synthetic coordinator', workspacePath: run,
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0,
      outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app!.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  await sweep();
  assert.equal(attempts.length, 1);
  assert.equal(mailbox().length, 0);
  const store = new NeoAskTodoRepository(app!.db.getDatabase());
  store.openAsk({ id: 'claims', sessionId: root, projectId: null, originMessageId: null,
    title: 'Synthetic claims', request: 'Build', createdAt: now });
  store.addTodo('linked', 'claims', { title: 'Linked work', instruction: 'Build', doneWhen: 'Merged',
    check: { pack: 'coding', kind: 'pr_merged', params: { urls: [] } }, named: null }, now);
  app!.db.getDatabase().prepare('UPDATE pack_coding_pr_ledger SET owner=? WHERE repo=? AND number=1')
    .run(JSON.stringify(ref), repo);
  const edited = await rpc('neo.todo.edit', { todoId: 'linked', addUrls: [url(2)] });
  assert((edited as { ok: boolean }).ok, JSON.stringify(edited));
  assert((store.getTodo('linked')!.check!.params.urls as string[]).includes(url(2)));
  assert.equal((app!.db.getDatabase().prepare('SELECT owner FROM pack_coding_pr_ledger WHERE repo=? AND number=2')
    .get(repo) as { owner: string | null }).owner, null, 'An explicit todo link needs no assigned worker');
  await sweep();
  assert.equal(attempts.length, 2);
  assert(!attempts[1].text.includes(`${repo}#1`));
  assert(!attempts[1].text.includes(`${repo}#2`));
  assert(attempts[1].text.includes(`${repo}#3`));
  const retry = attempts[1];
  await close();
  await open();
  accept = true;
  await sweep();
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[2], retry);
  assert.equal(mailbox().length, 1);
  evidence.delivered = mailbox()[0].message.message.content;
  assert.equal(state().key, null);
  await sweep();
  assert.equal(attempts.length, 3);
  numbers = [1, 2, 3, 4, 5];
  loseAck = true;
  await assert.rejects(sweep(), /Synthetic acknowledgement lost after admission/);
  assert.equal(attempts.length, 4);
  assert.equal(mailbox().length, 2);
  const admittedKey = attempts[3].key;
  assert.equal(state().key, admittedKey);
  await close();
  await open();
  app!.db.getDatabase().prepare('UPDATE pack_coding_pr_ledger SET owner=? WHERE repo=? AND number=4')
    .run(JSON.stringify(ref), repo);
  await sweep();
  assert.equal(attempts.length, 4, 'Durable admission reconciles without another send');
  assert.equal(mailbox().length, 2, 'Lost acknowledgement must not admit the remaining PR twice');
  assert.equal(mailbox().filter((entry) => entry.message.message.content.includes(`${repo}#5`)).length, 1);
  assert.equal(state().key, null);
  evidence.admittedCrash = { key: admittedKey, remainingPrInputs: 1, mailboxEntries: mailbox().length };
  numbers = [1, 2, 3, 4, 5, 6, 7];
  accept = false;
  await sweep();
  assert.equal(attempts.length, 5);
  app!.db.getDatabase().prepare('UPDATE pack_coding_pr_ledger SET owner=? WHERE repo=? AND number IN (6,7)')
    .run(JSON.stringify(ref), repo);
  accept = true;
  await sweep();
  assert.equal(attempts.length, 5);
  assert.equal(state().key, null);
  assert.equal(mailbox().length, 2);
  assert.equal(attempts[1].key, attempts[0].key);
  app!.db.getDatabase().prepare('UPDATE pack_coding_pr_ledger SET owner=NULL WHERE repo=? AND number IN (4,6,7)').run(repo);
  await sweep();
  assert.equal(attempts.length, 6);
  assert(!attempts[5].text.includes(`${repo}#4`), 'Admitted history survives claim removal');
  assert(attempts[5].text.includes(`${repo}#6`));
  assert(attempts[5].text.includes(`${repo}#7`));
  assert.equal(mailbox().length, 3);
  evidence.claimRemoval = { neverAdmittedNotified: [6, 7], admittedStillOnce: 4 };
  const retired: unknown[] = [];
  for (const [index, shape] of ['array', 'null', 'unbound', 'deleted'].entries()) {
    const retiredNumber = 8 + index * 2, nextNumber = retiredNumber + 1;
    numbers.push(retiredNumber);
    accept = false;
    await sweep();
    const before = attempts.length, mailboxBefore = mailbox().length;
    const db = app!.db.getDatabase();
    const history = db.prepare('SELECT * FROM pack_coding_pr_unowned ORDER BY key').all();
    const saved = JSON.parse(state().rows!);
    const rows = shape === 'array' ? saved.rows : shape === 'null' ? null
      : { ...saved, recipient: shape === 'deleted' ? 'synthetic-deleted-recipient' : root };
    db.prepare('UPDATE pack_coding_pr_unowned_state SET pending_rows=?').run(rows === null ? null : JSON.stringify(rows));
    if (shape === 'unbound') db.prepare('DELETE FROM neo_session_bindings WHERE session_id=?').run(root);
    accept = true;
    await sweep();
    assert.equal(state().key, null);
    assert.equal(attempts.length, before, `${shape} batch must not send`);
    assert.equal(mailbox().length, mailboxBefore);
    assert.deepEqual(db.prepare('SELECT * FROM pack_coding_pr_unowned ORDER BY key').all(), history);
    if (shape === 'unbound') new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    numbers.push(nextNumber);
    await sweep();
    assert.equal(attempts.length, before + 1);
    assert(attempts.at(-1)!.text.includes(`${repo}#${nextNumber}`));
    assert(!attempts.at(-1)!.text.includes(`${repo}#${retiredNumber}`));
    assert.equal(mailbox().length, mailboxBefore + 1);
    retired.push({ shape, retiredNumber, nextNumber, noSend: true, historyPreserved: true });
  }
  evidence.legacyAndOrphaned = retired;
  evidence.publicAddUrls = edited;
  evidence.verified = true;
  console.log('PASS: rejected and admitted retries keep their delivery ID across trimming and restart; claimed batches retire');
} finally {
  measuring = false;
  evidence.attempts = attempts;
  if (app) evidence.pendingState = state();
  await close();
  globalThis.fetch = originalFetch;
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/unowned-pr-claims.json'), JSON.stringify(evidence, null, 2));
}
