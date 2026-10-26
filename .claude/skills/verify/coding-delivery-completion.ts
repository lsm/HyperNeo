import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { BUILD_METADATA } from '../../../packages/daemon/src/lib/build-metadata.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingAssignmentsRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/assignments.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
assert(!existsSync(join(run, 'data')));
for (const name of ['evidence', 'bin', 'workspace']) mkdirSync(join(run, name), { recursive: true });
const url = 'https://github.com/synthetic/completion/pull/7', head = 'a'.repeat(40), merge = 'c'.repeat(40);
const root = 'neo:10000000-0000-4000-8000-000000008429';
const write = { adapter: 'test', id: 'author' }, ref = { adapter: 'test', id: 'qa' };
const actor = { kind: 'agent', id: ref.id, model: 'gpt-6', harness: ref.adapter } as const;
const fact = { url, head, stage: 'qa' as const, actor, verdict: 'pass' as const, acceptanceContract: 'artifact:acceptance', evidence: ['artifact:qa'] };
const smoke = { actor, ref, verdict: 'pass' as const, mergeCommit: merge, evidence: ['artifact:smoke'], build: { daemon: hostname(), commit: BUILD_METADATA.commit } };
const fixture = (state: string) => writeFileSync(join(run, 'pr.json'), JSON.stringify({ url, state, headRefOid: head,
  mergeStateStatus: 'CLEAN', baseRefName: 'dev', mergeCommit: { oid: merge },
  reviews: [{ state: 'APPROVED', commit: { oid: head }, author: { login: 'review-bot' } }], statusCheckRollup: [{ state: 'SUCCESS' }] }));
writeFileSync(join(run, 'bin/gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${run}/evidence/gh.log'\nif [ "$1" = pr ] && [ "$2" = view ]; then cat '${run}/pr.json'; elif [ "$1" = api ]; then case "$2" in repos/synthetic/completion/compare/*) printf '{"status":"ahead"}' ;; *) exit 1 ;; esac; else exit 1; fi\n`, { mode: 0o700 });
const evidence: unknown[] = [];
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    let ws: WebSocket | undefined;
    try {
      await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
      const db = app.db.getDatabase(), todos = new CodingTodoPrRepository(db), ledger = new CodingPrLedgerRepository(db);
      const store = new NeoAskTodoRepository(db);
      ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
      await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
      const rpc = (name: string, input: unknown) => new Promise<Record<string, unknown>>((done, fail) => {
        const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout: ' + name)), 15000);
        ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return;
          clearTimeout(timer); evidence.push({ phase, name, input, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
        ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
      });
      if (phase === 'initial') {
        const now = new Date().toISOString();
        db.prepare("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Delivery proof',?,?,?,'active','{\"queryMode\":\"manual\"}','{}')").run(root, join(run, 'workspace'), now, now);
        new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
        store.openAsk({ id: 'ask', sessionId: root, projectId: null, originMessageId: null, title: 'Deliver', request: 'Deliver', createdAt: 1 });
        store.addTodo('todo', 'ask', { title: 'Deliver', doneWhen: 'Gated merge and smoke', check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url] } }, instruction: null, named: null }, 1);
        await todos.write('record', 'todo', [{ url, head, state: 'OPEN', checks: 'passing', review: 'approved' }], Date.now());
        const assignments = new CodingAssignmentsRepository(db);
        const base = { url, head, acceptanceContract: fact.acceptanceContract, newDispatch: true as const, write };
        assert(await assignments.recordLater('todo', 'review', { ...base, bot: 'review-bot' }));
        assert(await assignments.recordLater('todo', 'qa', { ...base, ref, actor }));
        assert.deepEqual(await rpc('neo.coding.result', { todoId: 'todo', ref, fact }), { ok: true });
        const pack = createCodingPack({ database: () => db, todoPrs: todos, prLedger: ledger, readPrs: async () => [],
          prSweep: new CodingPrSweepRepository(db), prEvents: new CodingPrEventRepository(db),
          prSweepDeps: { tell: async () => true, wake: async () => true }, readClaudeOwners: async () => [], projectRepos: () => [] });
        const prepared = await pack.prepareMerge(todos.deliveryFacts, 'todo', { url, head, open: true, requiredCiGreen: true, findingsResolved: true, humanSignoffSatisfied: true, ciEvidence: ['ci:run'], reviewEvidence: ['github:review'] },
          { reference: fact.acceptanceContract, write, qa: ref, bot: 'review-bot' }, { kind: 'bot', head, login: 'review-bot', approved: true }, ledger.stageFacts.read(url), async () => head);
        assert(prepared.accepted); evidence.push({ phase, prepared });
        fixture('MERGED');
        assert.equal((await rpc('neo.todo.close', { todoId: 'todo', reason: 'Merge only' })).ok, true);
        assert.deepEqual(await rpc('neo.coding.smoke', { todoId: 'todo', url, head, smoke: { ...smoke, verdict: 'fail' } }), { accepted: true });
        assert.equal((await rpc('neo.todo.close', { todoId: 'todo', reason: 'Failed smoke' })).ok, true);
        assert.equal(store.getTodo('todo')?.state, 'done');
      } else {
        assert.equal(store.getTodo('todo')?.state, 'done');
        assert.equal((await rpc('neo.todo.close', { todoId: 'todo', reason: 'Restart preserves the passed check' })).ok, true);
        assert.deepEqual(await rpc('neo.coding.smoke', { todoId: 'todo', url, head, smoke: { ...smoke, ref: write, actor: { ...actor, id: write.id } } }), { accepted: false, reason: 'stage_assignment_mismatch' });
        assert.deepEqual(await rpc('neo.coding.smoke', { todoId: 'todo', url, head, smoke }), { accepted: true });
        assert.equal((await rpc('neo.todo.close', { todoId: 'todo', reason: 'Observed deployed smoke' })).ok, true);
        assert.equal(store.getTodo('todo')?.state, 'done');
      }
      evidence.push({ phase, todo: store.getTodo('todo'), delivery: todos.deliveryFacts.read('todo', url, head) });
    } finally { ws?.close(); await app.cleanup(); }
  }
  evidence.push({ verified: true });
  console.log('PASS: real todo-close RPC follows the passed merge check across failed smoke and restart; assigned QA smoke still validates actor and build containment independently.');
} catch (error) { evidence.push({ error: String(error) }); throw error; }
finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
