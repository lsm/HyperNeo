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
import { CodingAssignmentsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { CodingStageFact } from '../../../packages/daemon/src/lib/neo/packs/coding/stage-facts.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const url = 'https://github.com/synthetic/merge-gates/pull/7';
const write = { adapter: 'codex', id: 'colliding-id', daemon: 'author' };
const qaRef = { adapter: 'codex', id: 'colliding-id', daemon: 'qa' };
const qa: CodingStageFact = { url, head: 'head-a', stage: 'qa', ref: qaRef,
  actor: { kind: 'agent', id: qaRef.id, model: 'gpt-6', harness: qaRef.adapter },
  verdict: 'pass', acceptanceContract: 'artifact:acceptance', evidence: ['artifact:qa-result'] };
const candidate = { url, head: qa.head, open: true, requiredCiGreen: true,
  findingsResolved: true, humanSignoffSatisfied: true, ciEvidence: ['ci:synthetic-run'], reviewEvidence: ['github:review-7'] };
const review = { kind: 'bot', head: qa.head, login: 'review-bot', approved: true };
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden in merge-gate proof'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    try {
      await app.jobProcessor.stop();
      assert.notEqual(app.server.port, 8399);
      const db = app.db.getDatabase(); createCodingPackTables(db);
      const todos = new CodingTodoPrRepository(db), ledger = new CodingPrLedgerRepository(db);
      const pack = createCodingPack({ todoPrs: todos, prLedger: ledger,
        prEvents: new CodingPrEventRepository(db), prSweep: new CodingPrSweepRepository(db),
        readPrs: async () => [], readClaudeOwners: async () => [], projectRepos: () => [],
        prSweepDeps: { tell: async () => true, wake: async () => true } });
      const assignments = new CodingAssignmentsRepository(db);
      if (phase === 'initial') {
        db.exec("INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES ('ask','synthetic','Merge','Merge',1,1); INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES ('todo','ask',1,'Merge','Verified','doing',1,1)");
        await todos.write('record', 'todo', [{ url, head: qa.head, state: 'OPEN', checks: 'passing', review: 'approved' }], Date.now());
        const base = { url, head: qa.head, acceptanceContract: qa.acceptanceContract, newDispatch: true as const, write };
        assert(await assignments.recordLater('todo', 'review', { ...base, bot: review.login }));
        assert(await assignments.recordLater('todo', 'qa', { ...base, actor: qa.actor, ref: qaRef }));
        assert(await ledger.write('recordStage', qa));
        const assigned = assignments.read('todo', url, qa.head);
        const contract = { bot: assigned.review!.bot, reference: assigned.qa!.acceptanceContract, write: assigned.qa!.write, qa: assigned.qa!.ref! };
        const facts = ledger.stageFacts.read(url);
        const repo = todos.deliveryFacts;
        const wrongBot = await pack.prepareMerge(repo, 'todo', candidate, contract, { ...review, login: 'unassigned-bot' }, facts, async () => qa.head);
        evidence.push({ phase, name: 'wrong-bot', outcome: wrongBot });
        assert.deepEqual(wrongBot, { accepted: false, reason: 'matching_head_review_required' });
        const prepare = (head = qa.head, approved = true, current = candidate, input = facts) =>
          pack.prepareMerge(repo, 'todo', current, contract, { ...review, approved }, input, async () => head);
        for (const [name, outcome, reason] of [
          ['stale-head', await prepare('head-b'), 'head_changed_before_manual_merge'],
          ['bot-rejected', await prepare(qa.head, false), 'matching_head_review_required'],
          ['qa-absent', await prepare(qa.head, true, candidate, []), 'independent_matching_head_qa_required'],
          ['wrong-daemon', await prepare(qa.head, true, candidate, [{ ...qa, ref: write }]), 'independent_matching_head_qa_required'],
          ['ci-pending', await prepare(qa.head, true, { ...candidate, requiredCiGreen: false }), 'merge_requirements_not_satisfied'],
          ['findings-open', await prepare(qa.head, true, { ...candidate, findingsResolved: false }), 'merge_requirements_not_satisfied'],
          ['human-signoff', await prepare(qa.head, true, { ...candidate, humanSignoffSatisfied: false }), 'merge_requirements_not_satisfied'],
        ] as const) {
          evidence.push({ phase, name, outcome }); assert.deepEqual(outcome, { accepted: false, reason });
        }
        assert.equal(repo.read('todo', url, qa.head), null);
        const prepared = await prepare(); evidence.push({ phase, prepared });
        assert(prepared.accepted);
        assert.deepEqual(prepared.command, ['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', qa.head]);
      }
      const stored = todos.deliveryFacts.read('todo', url, qa.head);
      assert.deepEqual(stored?.gate.qa, qaRef);
      assert.deepEqual(stored?.gate.write, write);
      assert(stored?.gate.evidence.includes('github:review-7'));
      assert.equal(stored?.smoke, null);
      const state = db.prepare("SELECT state FROM neo_todos WHERE id = 'todo'").get() as { state: string };
      assert.equal(state.state, 'doing');
      evidence.push({ phase, daemonPort: app.server.port, stored, todoState: state.state });
    } finally { await app.cleanup(); }
  }
  evidence.push({ verified: true, scope: 'Build API only: no merge executed; completion and operation wiring remain later slices.' });
  console.log('PASS: daemon merge preparation refuses stale heads, bot rejection, missing/other-ref QA, CI, findings and signoff; pinned command and receipt survive restart.');
} catch (error) { evidence.push({ error: String(error) }); throw error; }
finally {
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
