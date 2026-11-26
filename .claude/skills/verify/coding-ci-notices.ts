import { seedPrOwner } from './seed-pr-owner.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

const [mode, path] = process.argv.slice(2), run = resolve(path), repo = 'synthetic/notices', worker = 'synthetic-owner';
assert(['reproduce', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, neo: ReturnType<typeof createNeoService> | undefined, ws: WebSocket | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  await app.db.updateGlobalSettings({ neo: { packs: [] } });
  neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  for (const id of ['synthetic-neo', worker]) await app.db.createSession({ id, title: id, workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  neo.repo.reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  ws = new createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'global', key: '' }, key: 'watchedRepos', value: [repo] })).ok, true);
  for (const [key, value] of Object.entries({ mergePolicy: 'human', humanSignoff: [] })) assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: repo }, key, value })).ok, true);
  const db = app.db.getDatabase(), ledger = new CodingPrLedgerRepository(db);
  const messages: string[] = [], escalations: string[] = [];
  const pack = createCodingPack({ database: () => db, readPrs: async () => [], todoPrs: new CodingTodoPrRepository(db), prLedger: ledger, prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db), projectRepos: () => [repo], prSweepDeps: { tell: async (_ref, _key, text) => { messages.push(text); return neo!.sendToRef({ adapter: 'hyperneo', id: worker }, _key, text); }, wake: async () => true }, attend: async event => { escalations.push(String(event.facts.text)); return true; }, readLedgerRepo: async () => ({ data: { rateLimit: { remaining: 4000 }, repository: { nameWithOwner: repo, done: { nodes: [] }, open: { pageInfo: { hasNextPage: false }, nodes: [{ number: 1, title: 'Pending CI', headRefName: 'work', headRefOid: 'a'.repeat(40), state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', closedAt: null, reviewDecision: 'REVIEW_REQUIRED', reviews: { nodes: [] }, files: { nodes: [{ path: 'src/app.ts' }], pageInfo: { hasNextPage: false } }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }] } } } }) });
  seedPrOwner(db, repo, { adapter: 'hyperneo', id: worker });
  const now = Date.now();
  for (const minutes of [0, 20, 40, 60]) await pack.sweep!(now + minutes * 60_000);
  const jobs = db.prepare("SELECT payload FROM job_queue WHERE queue='mailbox' ORDER BY id").all().map((row: { payload: string }) => JSON.parse(row.payload));
  const result = { state: ledger.list()[0]?.state, messages, escalations, ownerMailboxCount: jobs.length };
  writeFileSync(join(run, 'evidence/ci-notices.json'), JSON.stringify(result, null, 2));
  assert.equal(result.state, 'waiting_ci');
  if (mode === 'reproduce') assert(messages.some(text => text.includes('CI is still running')));
  else { assert.equal(messages.length, 0); assert.equal(escalations.length, 1); }
  console.log(JSON.stringify(result));
} finally { ws?.close(); await neo?.dispose(); await app?.cleanup(); }
