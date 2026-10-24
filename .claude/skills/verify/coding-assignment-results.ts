import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingAssignmentsRepository, type CodingAssignment } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const url = 'https://github.com/synthetic/assignments/pull/7';
const write = { adapter: 'codex-desktop', id: 'author' };
const ref = { adapter: 'hyperneo', id: 'review-session' };
const actor = { kind: 'agent', id: ref.id, model: 'claude-opus-5-5', harness: ref.adapter } as const;
const assignment: CodingAssignment = { url, head: 'head-a', acceptanceContract: 'artifact:acceptance-7', newDispatch: true, write, ref, actor };
const fact = { url, head: 'head-a', stage: 'review', actor, verdict: 'pass', acceptanceContract: assignment.acceptanceContract, evidence: ['artifact:observed-review-7'] };
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No HTTP in synthetic assignment-result proof'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    let ws: WebSocket | undefined;
    try {
      await app.jobProcessor.stop();
      assert.notEqual(app.server.port, 8399);
      const db = app.db.getDatabase(); createCodingPackTables(db);
      const assignments = new CodingAssignmentsRepository(db), ledger = new CodingPrLedgerRepository(db);
      ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
      await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
      const rpc = (input: unknown) => new Promise<unknown>((done, fail) => {
        const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
        ws!.onmessage = event => {
          const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return;
          clearTimeout(timer); evidence.push({ phase, input, reply });
          if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
        };
        ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'neo.coding.result', input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
      });
      if (phase === 'initial') {
        db.exec("INSERT INTO neo_asks (id,session_id,title,request,created_at,updated_at) VALUES ('ask','synthetic','Assignments','Assignments',1,1); INSERT INTO neo_todos (id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES ('todo','ask',1,'Assignments','Merged','doing',1,1)");
        ledger.stageFacts.observeHead(url, 'head-a', 1);
        assert(await assignments.recordLater('todo', 'review', assignment));
        assert(await assignments.recordLater('todo', 'qa', { ...assignment, ref: { ...ref, id: 'qa-session' }, actor: { ...actor, id: 'qa-session' } }));
        assert.deepEqual(await rpc({ todoId: 'todo', ref, fact }), { ok: true });
        for (const patch of [{ ref: { ...ref, id: 'author' } }, { fact: { ...fact, acceptanceContract: 'other' } }, { fact: { ...fact, actor: { ...actor, model: 'gpt-6' } } }, { fact: { ...fact, head: 'head-b' } }])
          assert.deepEqual(await rpc({ todoId: 'todo', ref, fact, ...patch }), { ok: false, reason: 'stage_assignment_mismatch' });
        assert.deepEqual(await rpc({ todoId: 'todo', ref: { ...ref, id: 'qa-session' }, fact: { ...fact, actor: { ...actor, id: 'qa-session' }, stage: 'qa', verdict: 'inconclusive' } }), { ok: true });
        assert.equal(ledger.stageFacts.read(url).length, 2);
      } else {
        const stored = assignments.read('todo', url, 'head-a');
        assert.deepEqual(stored.review, assignment);
        assert.equal(stored.qa?.ref?.id, 'qa-session');
        assert.equal(ledger.stageFacts.read(url).length, 2);
        evidence.push({ phase, assignments: stored, results: ledger.stageFacts.read(url) });
        assert.deepEqual(await rpc({ todoId: 'todo', ref, fact: { ...fact, verdict: 'fail' } }), { ok: true });
        assert.deepEqual(await rpc({ todoId: 'todo', ref, fact }), { ok: false, reason: 'head_changed_or_failed_stage' });
        ledger.stageFacts.observeHead(url, 'head-b', 2);
        assert.deepEqual(await rpc({ todoId: 'todo', ref, fact }), { ok: false, reason: 'head_changed_or_failed_stage' });
        assert.deepEqual(assignments.read('todo', url, 'head-b'), {});
        assert.deepEqual(ledger.stageFacts.read(url), []);
      }
      const todo = db.prepare("SELECT state FROM neo_todos WHERE id = 'todo'").get();
      assert.deepEqual(todo, { state: 'doing' });
      evidence.push({ phase, todo });
    } finally { ws?.close(); await app.cleanup(); }
  }
  console.log(`PASS: real RPC accepts assigned review/QA, rejects mismatches and stale results; assignments and evidence survive restart, todo stays doing. Evidence: ${run}/evidence/assignment-results.json`);
} finally {
  writeFileSync(join(run, 'evidence/assignment-results.json'), JSON.stringify(evidence, null, 2));
  globalThis.fetch = network;
}
