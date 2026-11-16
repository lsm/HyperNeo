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
const raised: string[] = [];
const evidence: Record<string, unknown> = { verified: false, ports: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
let socket: WebSocket | undefined;
let accept = false, reachable = true, conflict = false, measuring = false, now = Date.now(), numbers = [1, 2, 3];
const inspect = <T>(read: () => T): T => {
  const wasMeasuring = measuring;
  measuring = false;
  try { return read(); } finally { measuring = wasMeasuring; }
};
const mailbox = (start: string) => inspect(() => (app!.db.getDatabase().prepare(
  "SELECT payload FROM job_queue WHERE queue='mailbox'").all() as { payload: string }[])
  .map((row) => JSON.parse(row.payload)).filter((entry) => entry.to.sessionId === root)
  .map((entry) => String(entry.message.message.content)).filter((text) => text.startsWith(start)));
const unowned = () => mailbox('New pull request observed without a known worker owner:')
  .map((text) => Number(/#(\d+) "/.exec(text)![1])).sort();
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
  const db = app.db.getDatabase(), prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    assert(!(measuring && /pack_coding_pr_unowned|WITH active AS/.test(sql)), 'Unowned and claim SQL must stay off main');
    return prepare(sql);
  }) as typeof db.prepare;
  const cutoff = db.prepare('SELECT activated_at AS at FROM pack_coding_pr_unowned_state').get() as { at: number };
  const ledger = new CodingPrLedgerRepository(db);
  const pack = createCodingPack({ database: () => db, readPrs: async () => [],
    todoPrs: new CodingTodoPrRepository(db), prLedger: ledger,
    prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db),
    projectRepos: () => [repo], readLedgerRepo: async () => ({ data: { rateLimit: { remaining: 4000 },
      repository: { nameWithOwner: repo, open: { pageInfo: { hasNextPage: false },
        nodes: numbers.map((number) => ({ number, title: `Synthetic ${number}`, headRefName: `work-${number}`,
          headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false,
          mergeable: conflict && number === 1 ? 'CONFLICTING' : 'MERGEABLE',
          reviewDecision: null, closedAt: null, createdAt: new Date(cutoff.at + 1).toISOString(),
          author: { login: 'synthetic', __typename: 'User' } })) }, done: { nodes: [] } } } }),
    prSweepDeps: { tell: async () => reachable, wake: async () => false },
    attend: async (event) => {
      raised.push(`${event.kind} ${event.subject.id}`);
      return accept && !!service!.defaultSessionId() && 'told' in (await service!.attend(event));
    },
  });
  app.jobProcessor.register('verify.unowned.claims', async (job) => {
    await pack.sweep!(now += Number(job.payload.advance));
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
const sweep = async (advance = 61000) => {
  const job = app!.jobQueue.enqueue({ queue: 'verify.unowned.claims', payload: { advance }, maxRetries: 0, priority: 100 });
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
  assert.deepEqual(raised, [1, 2, 3].map((number) => `coding.pr_unowned ${repo}#${number}`));
  assert.deepEqual(unowned(), [], 'A refused wake admits nothing');
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
  await close();
  await open();
  accept = true;
  await sweep();
  assert.deepEqual(unowned(), [3], 'Only the PR nobody claims reaches the Neo mailbox');
  evidence.delivered = mailbox('New pull request')[0];
  await sweep();
  await close();
  await open();
  await sweep();
  assert.deepEqual(unowned(), [3], 'A told PR is not told again after a restart');
  numbers = [1, 2, 3, 4];
  await sweep();
  await sweep();
  assert.deepEqual(unowned(), [3, 4], 'A new unowned PR is told once on its own');
  const removed = await rpc('neo.todo.remove', { todoId: 'linked', reason: 'Synthetic claim released' });
  assert((removed as { ok: boolean }).ok, JSON.stringify(removed));
  await sweep();
  await sweep();
  assert.deepEqual(unowned(), [2, 3, 4], 'A PR whose claim is released is told once');
  const tables = inspect(() => app!.db.getDatabase().prepare(
    "SELECT name FROM sqlite_master WHERE name = 'pack_coding_pr_unowned'").all());
  assert.deepEqual(tables, [], 'The pack keeps no record of told PRs');
  evidence.unownedTold = unowned();
  reachable = false;
  conflict = true;
  await sweep();
  await sweep(21 * 60_000);
  const escalations = () => mailbox('PR sweep:');
  assert.equal(escalations().length, 1, 'An unreachable owner escalates to the Neo mailbox');
  assert.match(escalations()[0], /in conflict with its base since \d{4}-.*could not be reached/);
  inspect(() => app!.db.getDatabase().prepare('UPDATE pack_coding_pr_ledger SET nudges = 0 WHERE number = 1').run());
  await sweep();
  assert.equal(raised.filter((item) => item.startsWith('coding.pr_sweep')).length, 2);
  assert.equal(escalations().length, 1, 'An escalation whose ledger mark was lost is not told twice');
  evidence.escalation = escalations()[0];
  evidence.verified = true;
  console.log('PASS: unclaimed PRs and an unreachable owner reach the Neo mailbox once each through the attention entry');
} finally {
  measuring = false;
  evidence.raised = raised;
  await close();
  globalThis.fetch = originalFetch;
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/unowned-pr-claims.json'), JSON.stringify(evidence, null, 2));
}
