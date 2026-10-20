import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NeoCoordinatorTurn } from '../../../packages/daemon/src/lib/neo/coordinator-turn.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
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
const edit = { add: ['Ask before publishing synthetic work.'], remove: ['Retire this synthetic rule.'] };
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
    let turn: NeoCoordinatorTurn | undefined;
    const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-root', role: 'neo', neoTurn: turn?.identity() }));
    const mcp = async (name: string, input: unknown) => {
      const result = await handler({ name, input }); evidence.push({ phase, name, input, mcp: result });
      return JSON.parse(result.content[0].text);
    };
    if (phase === 'initial') {
      const db = app.db.getDatabase();
      db.exec(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
        VALUES ('synthetic-root','Synthetic Neo','/tmp','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','active','{}','{}')`);
      new NeoAskTodoRepository(db).openAsk({ id: 'synthetic-ask', projectId: null, sessionId: 'synthetic-root', originMessageId: null, title: 'Synthetic settings', request: 'Verify immutable proposal', createdAt: 1 });
      new NeoRepository(db).reserveBinding({ sessionId: 'synthetic-root', kind: 'neo', projectId: null });
      assert.equal((await mcp('neo.rule.save', { add: edit.add, from: edit.add[0] })).ok, false);
      const repo = app.db.getSDKMessageRepo();
      for (const [uuid, inputKind, content] of [['event', 'system', 'Synthetic event'], ['human-rule', 'human', edit.add[0]]])
        repo.saveSDKMessage('synthetic-root', { type: 'user', uuid, session_id: 'synthetic-root', parent_tool_use_id: null, inputKind, message: { role: 'user', content } } as any);
      repo.markDeliveryConsumedByUuid('synthetic-root', 'human-rule');
      turn = new NeoCoordinatorTurn(app.db, 'synthetic-root', { isLive: () => true });
      turn.bind('event'); turn.noteSteered('human-rule');
      assert.equal((await mcp('neo.rule.save', { add: edit.add, from: edit.add[0], triggerId: 'human:human-rule' })).ok, true);
      turn.dispose(); turn = undefined;
      await rpc('neo.rule.save', { remove: edit.add, add: edit.remove });
      const declined = await mcp('neo.rule.ask', { askId: 'synthetic-ask', requestId: 'declined', ...edit });
      assert.equal(declined.ok, true);
      assert.equal((await rpc('neo.question.answer', { questionId: declined.questionId, answer: 'no' })).ok, true);
      assert.deepEqual((await rpc('neo.snapshot', {})).standingRules, edit.remove);
      assert.equal((await mcp('neo.rule.applyAnswer', { questionId: declined.questionId })).ok, false);
      const proposed = await mcp('neo.rule.ask', { askId: 'synthetic-ask', requestId: 'accepted', ...edit });
      assert.equal(proposed.ok, true); questionId = proposed.questionId;
      const read = await rpc('neo.question.get', { questionId });
      assert.equal(read.answeredByHuman, false);
      for (const rule of [...edit.add, ...edit.remove]) assert(read.question.text.includes(JSON.stringify(rule)));
      assert.equal((await mcp('neo.question.answer', { questionId, answer: 'yes' })).ok, false);
      assert.equal((await rpc('neo.question.answer', { questionId, answer: 'yes' })).ok, true);
    }
    assert.equal((await rpc('neo.question.get', { questionId })).answeredByHuman, true);
    assert.deepEqual((await rpc('neo.snapshot', {})).standingRules, edit.add);
    assert.equal((await mcp('neo.rule.applyAnswer', { questionId, add: ['Tampered.'] })).code, 'invalid_input');
    assert.equal((await mcp('neo.rule.ask', { askId: 'synthetic-ask', requestId: 'accepted', add: ['Tampered.'] })).ok, false);
    assert.equal((await mcp('neo.rule.applyAnswer', { questionId })).ok, true);
    assert.deepEqual((await rpc('neo.snapshot', {})).standingRules, edit.add);
  } finally { ws?.close(); await app.cleanup(); writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
}
writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
console.log(`PASS: consumed mid-turn human rule save, question-bound add/remove, no unchanged, tampering refused, restart persisted. ${run}/evidence/observed.json`);
