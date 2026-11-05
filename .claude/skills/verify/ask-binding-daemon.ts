import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const conversationId = '7c2f0f8e-1d54-4a51-9a39-5f0f3d1c2b6a', root = `neo:${conversationId}`;
const fresh = 'c1d0a5c2-36a4-4f37-a7f0-0b4c2e1f9a11', followUp = 'f2e4b6a8-1c3d-4e5f-8a7b-9c0d1e2f3a4b';
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const call = async (name: string, input: Record<string, unknown>) => {
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const result = await handler({ name, input });
  assert(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
const evidence: Record<string, unknown> = {};
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  await app.db.createSession({ id: root, title: 'Synthetic ask binding', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  store.openAsk({ id: 'slow-sql', title: 'Slow sdk_messages SQL', request: 'Synthetic', sessionId: root, projectId: null, originMessageId: null, createdAt: 1 });
  const sends = [
    { requestId: fresh, content: 'The card shows two Open buttons' },
    { requestId: followUp, content: 'Also check the count query', replyTo: { kind: 'ask', id: 'slow-sql' } },
  ];
  for (const send of sends) {
    const sent = await invokeOperation(app.sessionManager.getOperationRegistry(), 'neo.message.send', { sessionId: root, ...send }, { source: 'rpc', principal: 'local' });
    assert.equal(sent.kind, 'completed');
    const ids = app.db.getDatabase().prepare('SELECT id FROM sdk_messages WHERE session_id=? AND sdk_uuid=?').all(root, send.requestId) as { id: string }[];
    await app.db.writeSDKMessage('updateMessageStatus', ids.map((row) => row.id), 'consumed');
  }
  const question = await call('neo.question.ask', { input: fresh, askId: 'slow-sql', kind: 'reply', text: 'Which Open button should stay?' });
  assert(question.ok, JSON.stringify(question));
  assert.notEqual(question.question.askId, 'slow-sql');
  assert(question.records.some((line: string) => line.startsWith('ask_rebound')));
  const opened = store.getAsk(question.question.askId)!;
  assert.equal(opened.originMessageId, fresh);
  assert.equal(opened.request, 'The card shows two Open buttons');
  const check = { pack: 'core', kind: 'human_confirmed', params: { questionId: question.question.id } };
  const sameInput = await call('neo.todo.add', { input: fresh, title: 'Keep one Open button', check });
  assert(sameInput.ok, JSON.stringify(sameInput));
  assert.equal(sameInput.todo.askId, opened.id);
  const reply = await call('neo.todo.add', { input: followUp, title: 'Index the count query', check });
  assert(reply.ok, JSON.stringify(reply));
  assert.equal(reply.todo.askId, 'slow-sql');
  const followOnly = await call('neo.todo.add', { askId: 'slow-sql', title: 'Worker report follow-up', check });
  assert(followOnly.ok && followOnly.todo.askId === 'slow-sql');
  const neither = await call('neo.todo.add', { title: 'No binding', check }).catch((error: Error) => ({ rejected: error.message }));
  const unknown = await call('neo.todo.add', { input: crypto.randomUUID(), title: 'Unknown input', check });
  assert(!unknown.ok && unknown.reason.startsWith('unknown_input'));
  const db = app.db.getDatabase();
  evidence.receipts = { question, sameInput, reply, followOnly, neither, unknown };
  evidence.asks = db.prepare('SELECT id, title, request, origin_message_id FROM neo_asks WHERE session_id = ? ORDER BY created_at').all(root);
  evidence.todos = db.prepare('SELECT title, ask_id FROM neo_todos ORDER BY created_at').all();
  evidence.questions = db.prepare('SELECT text, ask_id FROM neo_questions ORDER BY created_at').all();
  assert.equal((evidence.questions as { ask_id: string }[]).filter((row) => row.ask_id === 'slow-sql').length, 0);
  console.log(`PASS ask binding daemon; ${run}/evidence/ask-binding.json`);
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/ask-binding.json'), JSON.stringify(evidence, null, 2));
}
