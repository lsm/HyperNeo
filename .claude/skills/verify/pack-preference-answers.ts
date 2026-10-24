import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
const [portText, runText] = process.argv.slice(2); assert(runText);
const run = resolve(runText); const port = Number(portText);
assert(port > 0 && port !== 8399); assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home')); assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db'); assert(!existsSync(dbPath));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const values = [{ pack: 'coding', scope: { kind: 'repo', key: 'synthetic/repo' }, key: 'mergePolicy', value: 'review_bot' },
  { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/repo' }, key: 'reviewBot', value: 'synthetic-bot' }];
let questionId = '';
for (const phase of ['initial', 'restart']) {
  const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
  let ws: WebSocket | undefined;
  try {
    await app.spaceRuntimeService.ready();
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
    const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
      const id = crypto.randomUUID(); const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
      ws!.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer); evidence.push({ phase, name, input, reply });
        if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
      ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-root', role: 'neo' }));
    const mcp = async (name: string, input: unknown) => {
      const result = await handler({ name, input }); evidence.push({ phase, name, input, mcp: result });
      return JSON.parse(result.content[0].text);
    };
    if (phase === 'initial') {
      const db = app.db.getDatabase();
      db.exec(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
        VALUES ('synthetic-root','Synthetic Neo','/tmp','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','active','{}','{}')`);
      new NeoAskTodoRepository(db).openAsk({ id: 'synthetic-ask', projectId: null, sessionId: 'synthetic-root', originMessageId: null, title: 'Synthetic settings', request: 'Verify immutable proposal', createdAt: 1 });
      const declined = await mcp('pack.preferences.ask', { askId: 'synthetic-ask', requestId: 'declined-request', values });
      assert.equal(declined.ok, true);
      assert.equal((await rpc('neo.question.answer', { questionId: declined.questionId, answer: 'no' })).ok, true);
      const closed = await mcp('pack.preferences.ask', { askId: 'synthetic-ask', requestId: 'declined-request', values });
      assert.deepEqual(closed, { ok: false, reason: 'question_closed' });
      const proposed = await mcp('pack.preferences.ask', { askId: 'synthetic-ask', requestId: 'synthetic-request', values });
      assert.equal(proposed.ok, true); questionId = proposed.questionId;
      assert.equal((await rpc('pack.preferences.list', {})).preferences.filter((row: { key: string }) => row.key !== 'watchedRepos').length, 0);
      const read = await rpc('neo.question.get', { questionId });
      assert.equal(read.answeredByHuman, false); assert(read.question.text.includes('| --- | --- |')); for (const value of values) assert(!read.question.text.includes(JSON.stringify(value)));
      const snapshot = await rpc('neo.snapshot', {});
      assert(snapshot.todoAsks.some((entry: any) => entry.questions.some((q: any) => q.id === questionId)));
      assert.equal((await mcp('neo.question.answer', { questionId, answer: 'yes' })).ok, false);
      assert.equal((await rpc('neo.question.answer', { questionId, answer: 'yes' })).ok, true);
    }
    assert.equal((await rpc('neo.question.get', { questionId })).answeredByHuman, true);
    const saved = (await rpc('pack.preferences.list', {})).preferences.filter((row: { key: string }) => row.key !== 'watchedRepos');
    assert.deepEqual(saved.map((s: any) => ({ pack: s.pack, scope: s.scope, key: s.key, value: s.value })), values);
    assert(saved.every((s: any) => s.setBy === 'human'));
    assert.equal((await mcp('pack.preferences.applyAnswer', { questionId, values: [{ ...values[0], value: 'ci_only' }] })).code, 'invalid_input');
    assert.equal((await mcp('pack.preferences.ask', { askId: 'synthetic-ask', requestId: 'synthetic-request', values: [{ ...values[0], value: 'ci_only' }] })).reason, 'proposal_is_immutable');
    assert.equal((await mcp('pack.preferences.applyAnswer', { questionId })).ok, true);
    assert.deepEqual((await rpc('pack.preferences.list', {})).preferences.filter((row: { key: string }) => row.key !== 'watchedRepos'), saved);
  } finally { ws?.close(); await app.cleanup(); }
}
writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
console.log(`PASS: real question/snapshot, human tap applies stored values, agent tampering refused across restart. ${run}/evidence/observed.json`);
