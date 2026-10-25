import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrLedgerRepository, reconcileCodingPrLedger } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { CodingStageFact } from '../../../packages/daemon/src/lib/neo/packs/coding/stage-facts.ts';
import { createOperationRegistry, defineOperation } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { SendWorkInputSchema, SendWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/work-operations.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const url = 'https://github.com/synthetic/stages/pull/7';
const reviewer = { kind: 'agent', id: 'review-session', model: 'claude-opus-5-5', harness: 'Harness B' } as const;
const fact: CodingStageFact = { url, head: 'head-a', stage: 'review', actor: reviewer, verdict: 'pass', acceptanceContract: 'artifact:acceptance-7', evidence: ['https://ci.example/run/7'] };
const setting = { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/stages' }, key: 'provenance' };
const row = (head: string) => ({ repo: 'synthetic/stages', number: 7, head, title: 'Stages', branch: 'stages', state: 'waiting_human' as const, closedAt: null });
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('No HTTP in local stage proof'); }) as typeof fetch;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    let ws: WebSocket | undefined;
    try {
      await app.jobProcessor.stop();
      const db = app.db.getDatabase(); createCodingPackTables(db);
      const ledger = new CodingPrLedgerRepository(db), todos = new CodingTodoPrRepository(db);
      db.prepare("UPDATE neo_pack_preferences SET value_json = ? WHERE pack = 'coding' AND key = 'watchedRepos'").run(JSON.stringify(['synthetic/first', 'synthetic/stages']));
      const messages: string[] = [];
      const registry = app.sessionManager.getOperationRegistry();
      const harness = defineOperation({ name: 'work.send', description: 'Capture the synthetic worker inbox.', inputSchema: SendWorkInputSchema, resultSchema: SendWorkResultSchema, execute: async input => {
        assert.equal(input.ref.id, 'signature-fixture');
        messages.push(input.message);
        return { ok: true as const, value: { delivered: true, receipt: { executionId: input.ref.id, inputId: crypto.randomUUID() } } };
      } });
      const bound = createOperationRegistry(registry.entries.map(entry => entry.name === 'work.send' ? harness : entry));
      app.sessionManager.setOperationRegistryProvider(() => bound);
      assert.notEqual(app.server.port, 8399);
      ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
      await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
      const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
        const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
        ws!.onmessage = event => {
          const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return;
          clearTimeout(timer); evidence.push({ phase, name, input, reply });
          if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
        };
        ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
      });
      if (phase === 'initial') {
        db.exec("INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at) VALUES ('ask-7', 'synthetic', 'Stages', 'Stages', 1, 1); INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at) VALUES ('todo-7', 'ask-7', 1, 'Stages', 'Merged', 'doing', 1, 1)");
        db.prepare('UPDATE neo_todos SET check_json = ? WHERE id = ?').run(JSON.stringify({ pack: 'coding', kind: 'pr', params: {} }), 'todo-7');
        const ref = { adapter: 'codex-desktop', id: 'signature-fixture' };
        db.prepare('INSERT INTO neo_todo_sessions (todo_id, target, ref, actual_model, actual_effort) VALUES (?, ?, ?, ?, ?)').run('todo-7', JSON.stringify({ verb: 'send', ref }), JSON.stringify(ref), 'gpt-6.1-sol', 'high');
        const continued = await rpc('neo.todo.continue', { todoId: 'todo-7', message: 'Write the PR body.' }) as { ok: boolean };
        assert.equal(continued.ok, true);
        assert.equal(messages.length, 1);
        assert(messages[0].includes('Agent: gpt-6.1-sol (effort: high) via Codex'));
        evidence.push({ workerInbox: messages[0] });
        for (const effort of ['extra high', 'off']) {
          const hyperneoRef = { ...ref, adapter: 'hyperneo' };
          db.prepare('UPDATE neo_todo_sessions SET ref = ?, target = ?, actual_effort = ? WHERE todo_id = ?').run(JSON.stringify(hyperneoRef), JSON.stringify({ verb: 'send', ref: hyperneoRef }), effort, 'todo-7');
          const followed = await rpc('neo.todo.continue', { todoId: 'todo-7', message: 'Copy the recorded signature.' }) as { ok: boolean };
          assert.equal(followed.ok, true);
          const body = messages.at(-1)!;
          assert(body.includes(`Agent: gpt-6.1-sol (effort: ${effort}) via HyperNeo`));
          const policy = ledger.reviewerPolicy('synthetic/stages', body, reviewer);
          assert.equal(policy.qualifies, true, `Recorded effort ${effort}: ${policy.reason}`);
          evidence.push({ effort, workerInbox: body, policy });
        }
        for (const body of ['Agent: GPT-6 via Codex', 'Agent: gpt-6.1-sol via Codex', 'Agent: GPT-6 (effort: high) via Codex']) {
          const repair = ledger.reviewerPolicy('synthetic/stages', body, reviewer);
          assert.equal(repair.qualifies, false);
          assert(repair.reason.includes('ask the author'));
          evidence.push({ body, repair });
        }
        await todos.write('claim', 'todo-7', [{ url, claim: 'named' }], 1);
        await ledger.write('replace', 'synthetic/stages', [row('head-a')], 1);
        assert(await ledger.write('recordStage', fact));
        assert(await ledger.write('recordStage', { ...fact, stage: 'qa' }));
        assert.equal(todos.stages('todo-7').length, 2);
        assert.deepEqual(await rpc('pack.preferences.get', setting), { preference: null });
        assert.equal(ledger.reviewerPolicy('synthetic/stages', '', reviewer).qualifies, false);
        assert.equal(ledger.reviewerPolicy('synthetic/stages', 'Agent: gpt-6.1-sol (effort: high) via Harness A', reviewer).preferred, true);
        const proposal = await rpc('pack.preferences.ask', { askId: 'ask-7', requestId: 'stage-provenance', values: [{ ...setting, value: true }, { ...setting, key: 'mergePolicy', value: 'ci_only' }] }) as { ok: boolean; questionId: string };
        assert.equal(proposal.ok, true);
        assert(proposal.questionId);
        const listed = await rpc('pack.preferences.list', {}) as { preferences: { pack: string; key: string }[] };
        assert.deepEqual(listed.preferences.filter(p => p.pack === 'coding' && p.key === 'provenance'), []);
        assert.equal(ledger.reviewerPolicy('synthetic/stages', 'Author: gpt-6-sol (effort: high) via Harness A', reviewer).qualifies, true);
        const aliases = ['gpt-6-2026-09', 'openai/gpt-6', 'unidentified-model'].map(model => ledger.reviewerPolicy('synthetic/stages', 'Agent: gpt-6-sol (effort: high) via A', { ...reviewer, model }));
        await rpc('neo.question.answer', { questionId: proposal.questionId, answer: 'no' });
        const afterNo = await rpc('pack.preferences.get', setting) as { preference: { value: unknown } | null };
        evidence.push({ aliases, afterNo });
        assert.equal(afterNo.preference, null, 'No must leave provenance unanswered and on');
        assert.deepEqual(await rpc('pack.preferences.get', { ...setting, key: 'mergePolicy' }), { preference: null });
        const label = db.prepare('SELECT no_label AS label FROM neo_questions WHERE id = ?').get(proposal.questionId) as { label: string };
        assert.equal(label.label, 'Keep current settings');
        assert.equal(ledger.reviewerPolicy('synthetic/stages', '', reviewer).qualifies, false);
        for (const model of ['claude-fable-5-1', 'Opus 5.5', 'claude-opus-5-5[1m]'])
          assert.equal(ledger.reviewerPolicy('synthetic/stages', 'Agent: gpt-6-sol (effort: high) via A', { ...reviewer, model }).qualifies, true, model);
        assert.equal(ledger.reviewerPolicy('synthetic/stages', 'Agent: gpt-6-sol (effort: high) via A', { ...reviewer, model: 'gpt-6.0' }).qualifies, false);
        const disable = await rpc('pack.preferences.ask', { askId: 'ask-7', requestId: 'disable-provenance', values: [{ ...setting, value: false }] }) as { ok: boolean; questionId: string };
        assert.equal(disable.ok, true);
        await rpc('neo.question.answer', { questionId: disable.questionId, answer: 'yes' });
        const disabled = await rpc('pack.preferences.get', setting) as { preference: { value: boolean } };
        assert.equal(disabled.preference.value, false);
        assert(aliases.every(policy => !policy.qualifies), 'Aliases and unknown models must not qualify');
        assert.equal(ledger.reviewerPolicy('synthetic/stages', '', reviewer).qualifies, true);
      } else {
        evidence.push({ phase, stages: todos.stages('todo-7') });
        assert.equal(todos.stages('todo-7').length, 2);
        assert.equal(ledger.reviewerPolicy('synthetic/stages', '', reviewer).qualifies, true);
        await ledger.write('replace', 'synthetic/stages', [row('head-b')], 2);
        assert.deepEqual(todos.stages('todo-7'), []);
        assert.equal(await ledger.write('recordStage', fact), false);
        assert(await ledger.write('recordStage', { ...fact, head: 'head-b' }));
        assert(await ledger.write('recordStage', { ...fact, head: 'head-b', stage: 'qa', verdict: 'inconclusive' }));
        await todos.write('record', 'todo-7', [{ url, head: 'head-a', state: 'OPEN', checks: 'passing', review: 'approved' }], 1);
        assert.equal(todos.stages('todo-7').length, 2, 'An older read must not erase current-head facts');
        assert.equal(await ledger.write('recordStage', fact), false, 'Old head must stay rejected');
        await ledger.write('replace', 'synthetic/stages', [row('head-a')], 1);
        assert.equal(todos.stages('todo-7').length, 2);
        assert.equal(await ledger.write('recordStage', fact), false);
        assert(await ledger.write('recordStage', { ...fact, head: 'head-b', verdict: 'fail' }));
        assert.equal(await ledger.write('recordStage', { ...fact, head: 'head-b' }), false, 'A pass must not erase a fail');
        await ledger.write('replace', 'synthetic/stages', [row('head-c')], 2);
        assert.deepEqual(todos.stages('todo-7'), [], 'Conflicting timestamps must invalidate approvals');
        assert.equal(await ledger.write('recordStage', { ...fact, head: 'head-b' }), false);
        assert.equal(await ledger.write('recordStage', { ...fact, head: 'head-c' }), false);
        await todos.write('record', 'todo-7', [{ url, head: 'head-c', state: 'OPEN', checks: 'passing', review: 'approved' }], 3);
        assert.deepEqual(todos.stages('todo-7'), []);
        await reconcileCodingPrLedger(ledger, ['synthetic/first', 'synthetic/stages'], async repo => {
          if (repo === 'synthetic/first') {
            ledger.stageFacts.observeHead(url, 'head-c', Date.now());
            await new Promise(done => setTimeout(done, 3));
          }
          return { data: { rateLimit: { remaining: 4000 }, repository: {
            nameWithOwner: repo,
            open: { pageInfo: { hasNextPage: false }, nodes: repo === 'synthetic/stages' ? [{ number: 7, title: 'Stages', headRefName: 'stages', headRefOid: 'head-d', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, closedAt: null }] : [] }, done: { nodes: [] },
          } } };
        }, Date.now());
        assert.equal(await ledger.write('recordStage', { ...fact, head: 'head-c' }), false);
        assert(await ledger.write('recordStage', { ...fact, head: 'head-d' }));
        evidence.push({ perRepoReadStages: todos.stages('todo-7') });
        evidence.push({ phase, afterPush: todos.stages('todo-7'), todo: db.prepare("SELECT state FROM neo_todos WHERE id = 'todo-7'").get() });
      }
    } finally { ws?.close(); await app.cleanup(); }
  }
  console.log(`PASS: stage facts survive daemon restart, both pushes invalidate review and QA, stale results refused; human RPC disables provenance; unanswered fallback stores nothing. Evidence: ${run}/evidence/stage-facts.json`);
} finally {
  writeFileSync(join(run, 'evidence/stage-facts.json'), JSON.stringify(evidence, null, 2));
  globalThis.fetch = network;
}
