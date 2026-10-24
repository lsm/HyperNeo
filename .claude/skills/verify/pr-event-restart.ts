import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Logger } from '../../../packages/daemon/src/lib/logger.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository, planCodingLedgerRead } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';

const run = resolve(process.argv[2]), repo = 'synthetic/no-policy', worker = 'synthetic-event-owner';
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data')); assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const part of ['bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
const fetchBefore = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in PR event proof'); }) as typeof fetch;
const warnings: string[] = [];
const warnBefore = Logger.prototype.warn;
Logger.prototype.warn = function (message: unknown, ...rest: unknown[]) { warnings.push(String(message)); return warnBefore.call(this, message, ...rest); };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, neo: ReturnType<typeof createNeoService> | undefined;
let ledger: CodingPrLedgerRepository, pack: ReturnType<typeof createCodingPack>;
const evidence: Record<string, unknown> = { verified: false, providerTurns: 0 };
const sql = () => app!.db.getDatabase();
const rows = () => sql().prepare('SELECT number, state, owner, terminal_event_json FROM pack_coding_pr_ledger ORDER BY number').all();
const jobs = () => sql().prepare("SELECT payload FROM job_queue WHERE queue='mailbox'").all().map((row: { payload: string }) => JSON.parse(row.payload));
let decision: string | null = null, ci = 'SUCCESS';
const node = (number: number) => ({ number, title: `Synthetic ${number}`, headRefName: `synthetic-${number}`, headRefOid: `head-${number}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: decision, closedAt: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: number === 2 ? ci : 'SUCCESS' } } }] } });
const raw = () => ({ data: { rateLimit: { remaining: 4000 }, repository: { nameWithOwner: repo, open: { pageInfo: { hasNextPage: false }, nodes: [node(188), node(2)] }, done: { nodes: [] } } } });
async function open() {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
  app.db.updateGlobalSettings({ neo: { packs: [] } });
  neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  ledger = new CodingPrLedgerRepository(sql());
  pack = createCodingPack({ database: sql, readPrs: async () => [], readClaudeOwners: async () => [],
    todoPrs: new CodingTodoPrRepository(sql()), prLedger: ledger, prEvents: new CodingPrEventRepository(sql()),
    prSweep: new CodingPrSweepRepository(sql()), projectRepos: () => [repo], readLedgerRepo: async () => raw(),
    prSweepDeps: { tell: (ref, key, text) => neo!.sendToRef(ref, key, text), wake: (key, text) => neo!.wakeNeo(key, text) } });
}
async function close() { await neo?.dispose(); neo = undefined; await app?.cleanup(); app = undefined; }
try {
  await open();
  const now = Date.now();
  for (const id of ['synthetic-event-neo', worker]) await app!.db.createSession({ id, title: id, workspacePath: join(run, 'home'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  neo!.repo.reserveBinding({ sessionId: 'synthetic-event-neo', projectId: null, kind: 'neo' });
  await ledger!.write('observeSessions', [{ ref: { adapter: 'hyperneo', id: worker }, status: 'running', lastActivityAt: now, remotes: [`git@github.com:${repo}.git`], branches: ['synthetic-188'], openedPrs: [] }], now);
  await pack!.sweep!(now + 1);
  evidence.waitingHuman = rows();
  decision = 'CHANGES_REQUESTED'; ci = 'FAILURE';
  await ledger!.write('replace', repo, planCodingLedgerRead(raw(), now + 2, () => ({}))!.rows, now + 2);
  assert.equal(jobs().length, 0); evidence.afterLostReturn = rows();
  await close(); await open();
  await pack!.sweep!(now + 3);
  const mail = jobs(); evidence.afterRestart = { ledger: rows(), mailbox: mail };
  assert.equal(mail.length, 1); assert.equal(mail[0].to.sessionId, worker);
  assert(JSON.stringify(mail[0]).includes('has requested changes on head head-18'));
  await pack!.sweep!(now + 4);
  assert.equal(jobs().length, 1);
  decision = null; ci = 'SUCCESS'; await pack!.sweep!(now + 5); ci = 'FAILURE'; await pack!.sweep!(now + 6);
  const skipped = warnings.filter((line) => line.includes('skipped'));
  evidence.skippedWarnings = skipped;
  assert(skipped.includes(`PR event neo-pr-event:${repo}#2:head-2:failing skipped: ${repo}#2 has no owner`));
  evidence.verified = true;
  console.log(JSON.stringify({ verified: true, ownerMailboxEvents: 1, repeatDuplicates: 0, unownedSkipLogged: true, providerTurns: 0 }));
} finally {
  await close(); globalThis.fetch = fetchBefore; Logger.prototype.warn = warnBefore; evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/pr-event-restart.json'), JSON.stringify(evidence, null, 2));
}
