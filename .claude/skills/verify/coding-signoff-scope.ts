import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

const run = resolve(process.argv[2]), repo = 'synthetic/signoff', worker = 'synthetic-signoff-worker';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const network = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in signoff proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, neo: ReturnType<typeof createNeoService> | undefined, ws: WebSocket | undefined;
const proof: Record<string, unknown> = { verified: false, providerTurns: 0, recipientConsumptionVerified: false };
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  await app.db.updateGlobalSettings({ neo: { packs: [] } });
  neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  for (const id of ['synthetic-signoff-neo', worker]) await app.db.createSession({ id, title: id, workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  neo.repo.reserveBinding({ sessionId: 'synthetic-signoff-neo', projectId: null, kind: 'neo' });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'global', key: '' }, key: 'watchedRepos', value: [repo] })).ok, true);
  for (const [key, value] of Object.entries({ mergePolicy: 'review_bot', reviewBot: 'hyperneo-ai-test', humanSignoff: ['docs/design/**'] })) assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: repo }, key, value })).ok, true);
  const db = app.db.getDatabase(), ledger = new CodingPrLedgerRepository(db);
  let approved = false, terminal = false;
  const nodes = () => [1, 2].map(number => ({ number, title: number === 1 ? 'Synthetic code' : 'Synthetic design', headRefName: `slice-${number}`, headRefOid: `head-${number}`, state: terminal ? (number === 1 ? 'MERGED' : 'CLOSED') : 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: approved ? 'APPROVED' : 'REVIEW_REQUIRED', closedAt: terminal ? new Date().toISOString() : null, labels: { nodes: number === 1 ? [] : [{ name: 'needs-human' }], pageInfo: { hasNextPage: false } }, files: { nodes: [{ path: number === 1 ? 'packages/daemon/src/app.ts' : 'docs/design/synthetic.md' }], pageInfo: { hasNextPage: false } }, reviews: { nodes: approved ? [{ state: 'APPROVED', commit: { oid: `head-${number}` }, author: { login: 'hyperneo-ai-test' } }] : [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }));
  const pack = createCodingPack({ database: () => db, readPrs: async () => [], readClaudeOwners: async () => [], todoPrs: new CodingTodoPrRepository(db), prLedger: ledger, prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db), projectRepos: () => [repo], prSweepDeps: { tell: (ref, key, text) => neo!.sendToRef(ref, key, text), wake: (key, text) => neo!.wakeNeo(key, text) }, readLedgerRepo: async () => ({ data: { rateLimit: { remaining: 4000 }, repository: { nameWithOwner: repo, open: { pageInfo: { hasNextPage: false }, nodes: terminal ? [] : nodes() }, done: { nodes: terminal ? nodes() : [] } } } }) });
  await pack.observeSessions!([{ ref: { adapter: 'hyperneo', id: worker }, status: { state: 'running' } as never, lastActivityAt: Date.now(), remotes: [`git@github.com:${repo}.git`], branches: ['slice-1', 'slice-2'], openedPrs: [] }], Date.now());
  const jobs = () => db.prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY id").all().map((row: { payload: string }) => JSON.parse(row.payload));
  const preferencesBefore = await rpc('pack.preferences.list', {});
  assert.equal((await rpc('pack.preferences.get', { pack: 'coding', scope: { kind: 'repo', key: repo }, key: 'mergeBy' })).preference, null);
  assert.equal(pack.preferences!.mergeBy.default, 'owner');
  assert.equal(ledger.policy(repo).mergeBy, 'owner');
  assert.deepEqual(await rpc('pack.preferences.list', {}), preferencesBefore);
  assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: repo }, key: 'mergeBy', value: 'automatic' })).ok, false);
  assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: repo }, key: 'mergeBy', value: 'daemon' })).ok, true);
  assert.equal((await rpc('pack.preferences.get', { pack: 'coding', scope: { kind: 'repo', key: repo }, key: 'mergeBy' })).preference.value, 'daemon');
  const head = 'a'.repeat(40);
  const facts = { ok: true as const, head, state: 'OPEN', draft: false, mergeable: 'MERGEABLE', requiredCi: { head, green: true }, threads: { head, unresolved: 0 }, reviews: [{ login: 'hyperneo-ai-test', head, state: 'APPROVED' }], files: ['src/app.ts'], labels: [] as string[] };
  const decisions = {
    unowned: pack.decideMerge(facts, ledger.policy(repo)),
    owner: pack.decideMerge(facts, { ...ledger.policy(repo), mergeBy: 'owner' }),
    staleCi: pack.decideMerge({ ...facts, requiredCi: { head: 'b'.repeat(40), green: true } }, ledger.policy(repo)),
    unresolved: pack.decideMerge({ ...facts, threads: { head, unresolved: 1 } }, ledger.policy(repo)),
    unreadable: pack.decideMerge({ ok: false, reason: 'Synthetic GitHub read failure' }, ledger.policy(repo)),
    humanPolicy: pack.decideMerge(facts, { ...ledger.policy(repo), mergePolicy: 'human' }),
  };
  assert.equal(decisions.unowned.kind, 'merge');assert.equal(decisions.owner.kind, 'skip');
  assert.equal(decisions.staleCi.kind, 'skip');assert.equal(decisions.unresolved.kind, 'skip');
  assert.equal(decisions.unreadable.kind, 'read_failure');assert.equal(decisions.humanPolicy.kind, 'needs_human_signoff');
  proof.daemonGate = { decisions, pureDecision: true, mergeExecuted: false, defaultDidNotSave: true };
  const now = Date.now();
  await pack.sweep!(now);
  approved = true; await assert.rejects(pack.sweep!(now + 1000), /Merge held:/);
  proof.approved = { snapshot: await rpc('neo.snapshot', {}), ledger: ledger.list(), mailbox: jobs() };
  const states = ledger.list().map(row => [row.number, row.state]);
  assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: repo }, key: 'humanSignoff', value: ['label:needs-human'] })).ok, true);
  await assert.rejects(pack.sweep!(now + 1500), /Merge held:/);
  const labelStates = ledger.list().map(row => [row.number, row.state]);
  proof.labelPolicy = { snapshot: await rpc('neo.snapshot', {}), ledger: ledger.list(), mailbox: jobs() };
  terminal = true; await pack.sweep!(now + 2000);
  const terminalJobs = jobs();
  await pack.sweep!(now + 3000);
  proof.terminal = { snapshot: await rpc('neo.snapshot', {}), ledger: ledger.list(), mailbox: jobs() };
  assert.deepEqual(states, [[1, 'approved_green'], [2, 'waiting_human']]);
  assert.deepEqual(labelStates, [[1, 'approved_green'], [2, 'waiting_human']]);
  assert.equal(terminalJobs.length, 2);
  assert.deepEqual(jobs(), terminalJobs);
  assert(jobs().every((job: any) => job.to.sessionId === worker));
  assert.deepEqual(jobs().map((job: any) => job.messageUuid).sort(), ['neo-pr-event:synthetic/signoff#1:head-1:merged', 'neo-pr-event:synthetic/signoff#2:head-2:closed'].sort());
  assert.equal(db.prepare('SELECT count(*) AS count FROM sdk_messages').get().count, 0);
  proof.verified = true;
  console.log(JSON.stringify({ verified: true, states, ownerMailboxEvents: jobs().length, duplicateEvents: 0, providerTurns: 0 }));
} finally {
  ws?.close(); await neo?.dispose(); await app?.cleanup(); globalThis.fetch = network;
  proof.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/signoff-scope.json'), JSON.stringify(proof, null, 2));
}
