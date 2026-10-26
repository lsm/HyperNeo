import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
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
let approvalId = '';
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
      ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: name === 'settings.global.update' ? name : 'operation.invoke', data: name === 'settings.global.update' ? input : { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'neo:10000000-0000-4000-8000-000000000002', role: 'neo' }));
    const mcp = async (name: string, input: unknown) => {
      await app.db.updateSession('neo:10000000-0000-4000-8000-000000000002', { title: 'Synthetic Neo' });
      const result = await handler({ name, input }); evidence.push({ phase, name, input, mcp: result });
      return JSON.parse(result.content[0].text);
    };
    if (phase === 'initial') {
      const db = app.db.getDatabase();
      db.exec(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
        VALUES ('neo:10000000-0000-4000-8000-000000000002','Synthetic Neo','/tmp','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z','active','{}','{}')`);
      new NeoAskTodoRepository(db).openAsk({ id: 'synthetic-ask', projectId: null, sessionId: 'neo:10000000-0000-4000-8000-000000000002', originMessageId: null, title: 'Synthetic settings', request: 'Verify immutable proposal', createdAt: 1 });
      new NeoRepository(db).reserveBinding({ sessionId: 'neo:10000000-0000-4000-8000-000000000002', kind: 'neo', projectId: null });
      assert.equal((await mcp('neo.rule.save', { add: edit.add, from: edit.add[0] })).ok, false);
      const repo = app.db.getSDKMessageRepo();
      for (const [uuid, inputKind, content] of [['event', 'system', 'Synthetic event'], ['human-rule', 'human', edit.add[0]]])
        repo.saveSDKMessage('neo:10000000-0000-4000-8000-000000000002', { type: 'user', uuid, session_id: 'neo:10000000-0000-4000-8000-000000000002', parent_tool_use_id: null, inputKind, message: { role: 'user', content } } as any);
      repo.markDeliveryConsumedByUuid('neo:10000000-0000-4000-8000-000000000002', 'human-rule');
      assert.equal((await mcp('neo.rule.save', { add: edit.add, from: edit.add[0], triggerId: 'human:human-rule' })).ok, false);
      approvalId = crypto.randomUUID();
      const sessionId = 'neo:10000000-0000-4000-8000-000000000002';
      const content = 'Yes, remember to ask me before publication.';
      repo.saveSDKMessage(sessionId, { type: 'user', uuid: approvalId, session_id: sessionId, parent_tool_use_id: null, inputKind: 'human', message: { role: 'user', content } } as any);
      new NeoConversationAskRepository(db).append({ conversationId: new NeoRepository(db).conversationId(), requestId: approvalId, askOrigin: { sessionId, messageId: approvalId }, content });
      repo.markDeliveryConsumedByUuid('neo:10000000-0000-4000-8000-000000000002', approvalId);
      assert.equal((await mcp('neo.rule.save', { add: edit.add, messageId: approvalId })).ok, true);
      const sources = app.db.getGlobalSettings().neo?.standingRuleSources;
      assert.deepEqual(sources?.[edit.add[0]], { sessionId: 'neo:10000000-0000-4000-8000-000000000002', messageId: approvalId });
      evidence.push({ approvalSources: sources });
      await rpc('settings.global.update', { updates: { neo: { workerPermissionMode: 'default', standingRuleSources: {} } } });
      assert.deepEqual((await rpc('neo.snapshot', {})).standingRuleSources, sources);
      assert.equal(app.db.getGlobalSettings().neo?.workerPermissionMode, 'default');
      const many = Array.from({ length: 25 }, (_, i) => `Extra rule ${i}.`);
      assert.equal((await rpc('neo.rule.save', { add: many })).ok, true);
      assert.deepEqual((await rpc('neo.snapshot', {})).standingRules, [...edit.add, ...many]);
      await rpc('neo.rule.save', { remove: many });
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
      if (phase === 'initial') {
      const stale = await mcp('neo.rule.ask', { askId: 'synthetic-ask', requestId: 'stale', add: ['Next synthetic rule.'], remove: edit.add });
      assert.equal(stale.ok, true);
      await rpc('neo.rule.save', { remove: edit.add, add: ['An intervening human rule.'] });
      const sent = await rpc('neo.message.send', { sessionId: 'neo:10000000-0000-4000-8000-000000000002', requestId: crypto.randomUUID(), content: 'yes', replyTo: { kind: 'question', id: stale.questionId } });
      assert.equal(sent.ok, true); assert.equal(sent.created, true);
      assert.equal((await rpc('neo.question.get', { questionId: stale.questionId })).answeredByHuman, true);
      assert.equal((await mcp('neo.rule.applyAnswer', { questionId: stale.questionId })).ok, false);
      assert.deepEqual((await rpc('neo.snapshot', {})).standingRules, ['An intervening human rule.']);
      await rpc('neo.rule.save', { remove: ['An intervening human rule.'], add: edit.add });
    }
    assert.deepEqual((await rpc('neo.snapshot', {})).standingRules, edit.add);
    if (phase === 'initial') {
      const chatRule = 'A synthetic rule confirmed in chat.';
      const chatProposal = await mcp('neo.rule.ask', { askId: 'synthetic-ask', requestId: 'chat-broadcast', add: [chatRule], remove: edit.add });
      assert.equal(chatProposal.ok, true);
      const broadcast = new Promise<void>((done, fail) => {
        const timer = setTimeout(() => { ws!.removeEventListener('message', observed); fail(new Error('No updated state.settings broadcast after chat consent')); }, 2000);
        const observed = (event: MessageEvent) => {
          const update = JSON.parse(String(event.data));
          if (update.type !== 'EVENT' || update.method !== 'state.settings') return;
          evidence.push({ phase, settingsBroadcast: update });
          if (JSON.stringify(update.data.settings?.neo?.standingRules) !== JSON.stringify([chatRule])) return;
          clearTimeout(timer); ws!.removeEventListener('message', observed); done();
        };
        ws!.addEventListener('message', observed);
      });
      assert.equal((await rpc('neo.message.send', { sessionId: 'neo:10000000-0000-4000-8000-000000000002', requestId: crypto.randomUUID(), content: 'yes', replyTo: { kind: 'question', id: chatProposal.questionId } })).ok, true);
      await broadcast;
      await rpc('neo.rule.save', { remove: [chatRule], add: edit.add });
    }
    assert.equal((await mcp('neo.rule.applyAnswer', { questionId, add: ['Tampered.'] })).code, 'invalid_input');
    assert.equal((await mcp('neo.rule.ask', { askId: 'synthetic-ask', requestId: 'accepted', add: ['Tampered.'] })).ok, false);
    assert.equal((await mcp('neo.rule.applyAnswer', { questionId })).ok, true);
    assert.deepEqual((await rpc('neo.snapshot', {})).standingRules, edit.add);
    if (phase === 'initial') assert.equal((await mcp('neo.rule.save', { add: edit.add, messageId: approvalId })).ok, true);
    assert.deepEqual((await rpc('neo.snapshot', {})).standingRuleSources?.[edit.add[0]], { sessionId: 'neo:10000000-0000-4000-8000-000000000002', messageId: approvalId });
  } finally { ws?.close(); await app.cleanup(); writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
}
writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
console.log(`PASS: direct model rule save refused, question-bound add/remove, no unchanged, tampering refused, restart persisted. ${run}/evidence/observed.json`);
