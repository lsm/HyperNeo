import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
const [mode, portText, runText] = process.argv.slice(2);
assert(mode === 'verify' || mode === 'reproduce'); assert(runText);
const run = resolve(runText); const port = Number(portText);
assert(port > 0 && port !== 8399); assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home')); assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db'); assert(!existsSync(dbPath));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
let ws: WebSocket | undefined;
const output: { minute: number; text: string }[] = []; const snapshots: unknown[] = [];
let minute = 0;
try {
  await app.spaceRuntimeService.ready();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(); const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  for (const [key, value] of Object.entries({ mergePolicy: 'review_bot', reviewBot: 'hyperneo-ai-test', humanSignoff: ['docs/design/**'] }))
    assert.equal((await rpc('pack.preferences.set', { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/qlark-replay' }, key, value })).ok, true);
  const db = app.db.getDatabase(); const ledger = new CodingPrLedgerRepository(db);
  let approved = false;
  const pack = createCodingPack({ database: () => db, readPrs: async () => [], todoPrs: new CodingTodoPrRepository(db), prLedger: ledger,
    prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db), projectRepos: () => ['synthetic/qlark-replay'], readClaudeOwners: async () => [],
    prSweepDeps: { tell: async (_ref, _key, text) => { output.push({ minute, text }); return true; }, wake: async (_key, text) => { output.push({ minute, text }); return true; } },
    readLedgerRepo: async () => ({ data: { rateLimit: { remaining: 4000 }, repository: { nameWithOwner: 'synthetic/qlark-replay', done: { nodes: [] }, open: { pageInfo: { hasNextPage: false }, nodes: [{
      number: 19, title: 'Synthetic design awaiting human', headRefName: 'design', headRefOid: 'synthetic-head', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', closedAt: null,
      reviewDecision: approved ? 'APPROVED' : 'REVIEW_REQUIRED', reviews: { nodes: approved ? [{ state: 'APPROVED', commit: { oid: 'synthetic-head' }, author: { login: 'hyperneo-ai-test' } }] : [] },
      files: { nodes: [{ path: 'docs/design/synthetic.md' }], pageInfo: { hasNextPage: false } }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    }] } } } }),
  });
  pack.observeSessions!([{ ref: { adapter: 'codex', id: 'synthetic-worker' }, status: { state: 'running' } as never, lastActivityAt: 0, remotes: ['git@github.com:synthetic/qlark-replay.git'], branches: ['design'], openedPrs: [] }], Date.parse('2026-10-20T16:45:51Z'));
  for (const at of [0, 1, 21, 41, 61]) {
    minute = at; approved = at > 0;
    await pack.sweep!(Date.parse('2026-10-20T16:45:51Z') + at * 60000);
    const snapshot = await rpc('neo.snapshot', {});
    if (mode === 'verify' && at > 0) assert(snapshot.packRows.some((pack: any) => pack.rows.some((row: any) => row.pr === 'synthetic/qlark-replay#19' && row.state === 'waiting_human')));
    snapshots.push({ minute, rows: snapshot.packRows, ledger: ledger.list() });
  }
  const mergeNudges = output.filter((item) => /merge/i.test(item.text));
  const report = { surface: 'real coding pack sweep/events + real daemon snapshot, synthetic GraphQL/model-free delivery sinks', output, snapshots, mergeNudges };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(report, null, 2));
  if (mode === 'reproduce') assert(mergeNudges.some((item) => item.minute === 21), 'did not reproduce +20 minute merge nudge');
  else { assert.equal(mergeNudges.length, 0); assert.equal(ledger.list()[0].state, 'waiting_human'); }
  console.log(`${mode}: merge nudges=${mergeNudges.length}, state=${ledger.list()[0].state}; evidence=${run}/evidence/observed.json`);
} finally { ws?.close(); await app.cleanup(); }
