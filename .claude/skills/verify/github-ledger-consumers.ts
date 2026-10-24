import assert from 'node:assert/strict';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readGithubBranchPrs } from '../../../packages/daemon/src/lib/neo/packs/coding/branch-prs.ts';
import { readGithubDeploys } from '../../../packages/daemon/src/lib/neo/packs/coding/deploy-checks.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository, readCodingLedgerRepo, reconcileCodingPrLedger } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';

const [scenario, runText] = process.argv.slice(2), run = resolve(runText);
assert(['merged', 'head', 'unreadable'].includes(scenario));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
assert.equal(process.env.GH_TOKEN, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
mkdirSync(join(run, 'bin')); mkdirSync(join(run, 'evidence'));
copyFileSync(fileURLToPath(new URL('./github-ledger-gh.ts', import.meta.url)), join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const now = Date.now(), repo = 'synthetic/ledger', url = `https://github.com/${repo}/pull/7`;
const control = (phase: string) => writeFileSync(join(run, 'fixture.json'), JSON.stringify({ scenario, phase, now }));
control('initial');
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No real HTTP in this proof'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const evidence: Record<string, unknown> = { scenario, baseline: true, productionChanges: 0 };
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (input: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timed out')), 10_000);
    ws!.onmessage = event => {
      const msg = JSON.parse(String(event.data)); if (msg.id !== id && msg.requestId !== id) return;
      clearTimeout(timer); if (msg.error) return fail(new Error(JSON.stringify(msg.error)));
      done(msg.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', method: 'operation.invoke', data: { name: 'neo.github.read', input }, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const db = app.db.getDatabase(); createCodingPackTables(db);
  db.prepare("UPDATE neo_pack_preferences SET value_json = ? WHERE pack = 'coding' AND key = 'watchedRepos'").run(JSON.stringify([repo]));
  const ledger = new CodingPrLedgerRepository(db);
  const reconcile = () => reconcileCodingPrLedger(ledger, [repo], readCodingLedgerRepo, Date.now());
  const detail = () => rpc({ url });
  const list = () => rpc({ repo, state: 'all', withinHours: 3 });
  const branch = () => readGithubBranchPrs({ cwd: join(run, 'home'), branch: 'synthetic-branch' });
  const deploy = () => readGithubDeploys([url], async () => [{ daemon: 'synthetic-laptop', commit: 'd'.repeat(40) }]);
  if (scenario === 'merged') {
    await reconcile(); const first = { detail: await detail(), list: await list(), branch: await branch(), deploy: await deploy(), ledger: ledger.snapshot([repo], Date.now()) };
    assert.deepEqual(first.detail, { ok: true, kind: 'pr', url, state: 'MERGED', checks: 'passing', review: 'approved', blockers: [], title: 'Synthetic shared fact' });
    assert.deepEqual(first.branch, [url]); assert.equal(first.ledger[0].state, 'merged');
    assert.equal(first.deploy.prs[0].mergeCommit, 'c'.repeat(40)); assert.deepEqual(first.deploy.daemons[0].contains, ['c'.repeat(40)]);
    assert.equal((first.list as { items: { url: string }[] }).items[0].url, url);
    control('repeat'); await reconcile(); await detail(); await list(); await branch(); await deploy();
    evidence.first = first;
  } else if (scenario === 'head') {
    const first = await detail() as { review: string; blockers: string[] };
    assert.equal(first.review, 'approved'); assert.deepEqual(first.blockers, ['1 unresolved review thread']);
    control('changed'); const changed = await detail() as { review: string; blockers: string[] };
    assert.equal(changed.review, 'none'); assert.deepEqual(changed.blockers, first.blockers);
    evidence.first = first; evidence.changed = changed;
  } else {
    await reconcile(); const before = ledger.snapshot([repo], Date.now()); await detail();
    control('failed'); const failedDetail = await detail() as { ok: boolean; reason: string }, failedList = await list() as { ok: boolean; reason: string };
    assert.equal(failedDetail.ok, false); assert.match(failedDetail.reason, /unreadable/);
    assert.equal(failedList.ok, false); assert.match(failedList.reason, /unreadable/);
    control('issue'); const issue = await rpc({ url: `https://github.com/${repo}/issues/3` });
    assert.deepEqual(issue, { ok: true, kind: 'issue', url: `https://github.com/${repo}/issues/3`, state: 'CLOSED', closedAs: 'completed', closedBy: url, parent: `https://github.com/${repo}/issues/1` }); evidence.issue = issue;
    control('empty'); const empty = await list() as { ok: boolean; items: unknown[] }; assert.equal(empty.ok, true); assert.deepEqual(empty.items, []);
    control('partial'); await reconcile(); const after = ledger.snapshot([repo], Date.now()); assert.deepEqual(after, before);
    evidence.failedDetail = failedDetail; evidence.failedList = failedList; evidence.empty = empty; evidence.before = before; evidence.after = after;
  }
  const requests = readFileSync(join(run, 'evidence/requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const counts = (phase: string) => Object.fromEntries([...new Set(requests.filter(row => row.phase === phase).map(row => row.family))].map(family => [family, requests.filter(row => row.phase === phase && row.family === family).length]));
  evidence.requests = requests; evidence.initialRequests = counts('initial'); evidence.repeatRequests = counts('repeat');
  evidence.ledgerGraphqlCost = requests.filter(row => row.family === 'ledger-reconcile').reduce((sum, row) => sum + row.graphqlCost, 0);
  evidence.otherGraphqlCost = 'unknown: gh pr view/list do not return cost; do not equate request count with points';
  if (scenario === 'merged') {
    assert.deepEqual(evidence.initialRequests, { 'ledger-reconcile': 1, 'work-detail': 1, 'query-window': 1, 'branch-membership': 1, 'deploy-merge': 1, 'deploy-ancestry': 1 });
    assert.deepEqual(evidence.repeatRequests, { 'ledger-reconcile': 1, 'work-detail': 1, 'query-window': 1 });
  }
  evidence.verified = true;
  console.log(JSON.stringify({ scenario, verified: true, initialRequests: evidence.initialRequests, repeatRequests: evidence.repeatRequests, ledgerGraphqlCost: evidence.ledgerGraphqlCost }));
} finally {
  writeFileSync(join(run, 'evidence/consumers.json'), JSON.stringify(evidence, null, 2));
  ws?.close(); await app?.cleanup(); globalThis.fetch = network;
}
