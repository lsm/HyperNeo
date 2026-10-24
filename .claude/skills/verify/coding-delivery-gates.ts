import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { readGithubDeploys } from '../../../packages/daemon/src/lib/neo/packs/coding/deploy-checks.ts';
import type { CodingStageFact } from '../../../packages/daemon/src/lib/neo/packs/coding/stage-facts.ts';
import type { CodingSmoke } from '../../../packages/daemon/src/lib/neo/packs/coding/delivery-facts.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const url = 'https://github.com/synthetic/delivery/pull/7';
const write = { adapter: 'codex', id: 'same-local-id', daemon: 'author-daemon' };
const qaRef = { adapter: 'codex', id: 'same-local-id', daemon: 'qa-daemon' };
const qa: CodingStageFact = { url, head: 'head-a', stage: 'qa', ref: qaRef,
  actor: { kind: 'agent', id: qaRef.id, model: 'gpt-6', harness: qaRef.adapter },
  verdict: 'pass', acceptanceContract: 'artifact:acceptance', evidence: ['artifact:qa'] };
const smoke: CodingSmoke = { actor: qa.actor, ref: qaRef, mergeCommit: 'merge-a', verdict: 'pass',
  evidence: ['artifact:smoke'], build: { daemon: 'target', commit: 'build-a' } };
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden in delivery proof'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    try {
      await app.jobProcessor.stop();
      assert.notEqual(app.server.port, 8399);
      const db = app.db.getDatabase(); createCodingPackTables(db);
      const todos = new CodingTodoPrRepository(db);
      const pack = createCodingPack({ todoPrs: todos, prLedger: new CodingPrLedgerRepository(db),
        prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db),
        readPrs: async () => [], readClaudeOwners: async () => [], projectRepos: () => [],
        prSweepDeps: { tell: async () => true, wake: async () => true } });
      const repo = todos.deliveryFacts;
      const deploys = await readGithubDeploys([url], async () => [{ daemon: 'target', commit: 'build-a' }],
        () => { throw new Error('Unexpected GitHub command'); }, async () => 'merge-a', async () => true, async () => [{ url, head: qa.head, state: 'MERGED', checks: 'passing', review: 'approved' }]);
      if (phase === 'initial') {
        db.exec("INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES ('ask','synthetic','Deliver','Deliver',1,1); INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES ('todo','ask',1,'Deliver','Verified','doing',1,1)");
        await todos.write('record', 'todo', [{ url, head: qa.head, state: 'MERGED', checks: 'passing', review: 'approved' }], Date.now());
        assert(await new CodingPrLedgerRepository(db).write('recordStage', qa));
        await repo.write('recordGate', 'todo', { url, head: qa.head, acceptanceContract: qa.acceptanceContract,
          write, reviewer: 'review-bot', qa: qaRef, evidence: ['artifact:qa', 'ci:synthetic-run'] });
        const wrongHead = await pack.recordSmoke(repo, 'todo', url, qa.head, smoke, { ...deploys, prs: [{ url, head: 'head-b', mergeCommit: smoke.mergeCommit }] });
        evidence.push({ wrongHead }); assert.deepEqual(wrongHead, { accepted: false, reason: 'matching_merge_commit_required' });
        const absent = await pack.recordSmoke(repo, 'todo', url, qa.head, smoke, { ...deploys, daemons: [] });
        evidence.push({ absent }); assert.deepEqual(absent, { accepted: false, reason: 'running_build_must_contain_merge' });
        const self = await pack.recordSmoke(repo, 'todo', url, qa.head, { ...smoke, ref: write }, deploys);
        evidence.push({ self }); assert.deepEqual(self, { accepted: false, reason: 'independent_qa_required' });
        assert.deepEqual(await pack.recordSmoke(repo, 'todo', url, qa.head, smoke, deploys), { accepted: true });
        assert.deepEqual(await pack.recordSmoke(repo, 'todo', url, qa.head, { ...smoke, verdict: 'fail' }, deploys), { accepted: true });
        assert.equal(repo.read('todo', url, qa.head)?.smoke?.verdict, 'fail');
      } else {
        assert.equal(repo.read('todo', url, qa.head)?.smoke?.verdict, 'fail');
        assert.equal(repo.read('todo', url, 'head-b'), null);
        assert.deepEqual(await pack.recordSmoke(repo, 'todo', url, qa.head, { ...smoke, verdict: 'inapplicable', build: undefined, reason: 'Docs-only change; no deployed behavior' }, deploys), { accepted: true });
      }
      assert.deepEqual(todos.stageFacts.read(url)[0].ref, qaRef);
      const stored = repo.read('todo', url, qa.head);
      const state = db.prepare("SELECT state FROM neo_todos WHERE id = 'todo'").get() as { state: string };
      assert.equal(state.state, 'doing');
      evidence.push({ phase, daemonPort: app.server.port, deploys, stored, todoState: state.state });
    } finally { await app.cleanup(); }
  }
  evidence.push({ verified: true, scope: 'Build slice: delivery storage and smoke API. Merge preparation, todo completion and dispatch wiring are not part of this slice.' });
  console.log('PASS: isolated daemon rejects ungated merged head, self-QA and absent build; preserves full fact refs and failed smoke across restart; records explicit inapplicability.');
} catch (error) { evidence.push({ error: String(error) }); throw error; }
finally {
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
