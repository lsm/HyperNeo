import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { readMessageFacts } from '../../../packages/daemon/src/lib/neo/message-status.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const conversationId = '4baf7cad-7db1-451f-a728-27624107a3d1', root = `neo:${conversationId}`;
const human1 = '10e0f276-7698-4ef1-bab0-aed15a1a057e', human2 = '4a1f5cf0-af34-4a72-9c91-e4d5648b384f';
const config = () => getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
let app = await createDaemonApp({ config: config(), verbose: false });
let consumedInputId: string | undefined;
const evidence: unknown[] = [];
const handler = () => createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo', consumedInputId }));
const ask = async (input: Record<string, unknown>) => {
  const result = await handler()({ name: 'neo.question.ask', input: { askId: 'sign-off-8442', kind: 'choice', text: 'How should we sign off?', options: ['Keep', 'Change'], ...input } });
  assert(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text);
};
const readPage = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('socket failed')); });
  try {
    return await new Promise<unknown>((done, fail) => {
      const id = crypto.randomUUID(), timeout = setTimeout(() => fail(new Error('read timeout')), 10000);
      ws.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timeout); reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data); };
      ws.send(JSON.stringify({ id, type: 'REQ', method: 'operation.invoke', data: { name: 'neo.publication.read', input: { conversationId } }, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
  } finally { ws.close(); }
};
const rows = () => new NeoPublicationRepository(app.db.getDatabase()).list(conversationId)!;
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  await app.db.createSession({ id: root, title: 'Synthetic card replies', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  app.db.updateGlobalSettings({ language: 'en' });
  new NeoAskTodoRepository(app.db.getDatabase()).openAsk({ id: 'sign-off-8442', title: '#8442 sign-off', request: 'Synthetic', sessionId: root, projectId: null, originMessageId: null, createdAt: 1 });
  for (const requestId of [human1, human2]) {
    const sent = await invokeOperation(app.sessionManager.getOperationRegistry(), 'neo.message.send', { sessionId: root, requestId, content: 'Please revise this card', replyTo: { kind: 'ask', id: 'sign-off-8442' } }, { source: 'rpc', principal: 'local' });
    assert.equal(sent.kind, 'completed'); assert((sent as { value: { ok: boolean } }).value.ok);
    const stored = app.db.getSDKMessageRepo().getStoredPromptsByUuid(root, requestId);
    assert.equal(stored.length, 1);
    const ids = app.db.getDatabase().prepare('SELECT id FROM sdk_messages WHERE session_id=? AND sdk_uuid=?').all(root, requestId) as { id: string }[];
    await app.db.writeSDKMessage('updateMessageStatus', ids.map(row => row.id), 'consumed');
  }
  consumedInputId = human1;
  const first = await ask({}); assert(first.ok); assert.equal(rows().length, 1);
  assert.equal(rows()[0].replyTo, undefined);
  assert.deepEqual(rows()[0].cardReply?.sourceMessageIds, [human1]);
  assert(rows()[0].shortText.startsWith('I replied · View card'));
  assert(!rows()[0].fullText.includes('Keep'));
  const firstSequence = rows()[0].sequence;
  assert.equal((await ask({})).question.id, first.question.id);
  const replacement = { replaces: first.question.id, text: 'A revised sign-off' };
  const next = await ask(replacement); assert(next.ok); assert.equal(rows().length, 1);
  assert.equal(rows()[0].cardReply?.questionId, next.question.id); assert.equal(rows()[0].sequence, firstSequence);
  evidence.push({ first, next, publications: rows() });
  await app.cleanup();
  app = await createDaemonApp({ config: config(), verbose: false }); await app.jobProcessor.stop();
  assert.equal((await ask(replacement)).question.id, next.question.id); assert.equal(rows().length, 1);
  const manual = await handler()({ name: 'neo.publication.publish', input: { requestId: 'same-card-manual', shortText: 'I replied · View card · Revised sign-off', fullText: 'I replied · View card · Revised sign-off', cardReply: rows()[0].cardReply } });
  assert(JSON.parse(manual.content[0].text).accepted); assert.equal(rows().length, 1);
  consumedInputId = human2;
  assert((await ask({ text: 'A distinct later reply' })).ok); assert.equal(rows().length, 2);
  consumedInputId = undefined;
  assert((await ask({ text: 'Unrelated background card' })).ok); assert.equal(rows().length, 2);
  const before = rows().length;
  const rejected = await ask({ replyTo: [crypto.randomUUID()] }); assert(!rejected.ok); assert.equal(rows().length, before);
  const facts = readMessageFacts(app.db.getDatabase(), [human1, human2].map(requestId => ({ conversationId, requestId, askOrigin: { sessionId: root, messageId: requestId } })));
  assert(facts.every(fact => !fact.answered));
  const page = await readPage();
  assert.deepEqual(await readPage(), page, 'reconnecting readers see the same persisted rows');
  assert(JSON.stringify(page).includes(next.question.id));
  evidence.push({ afterRestart: rows(), inputFacts: facts, manual, reconnectedPage: page });
  console.log(`PASS card reply daemon; ${run}/evidence/card-reply.json`);
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/card-reply.json'), JSON.stringify(evidence, null, 2));
}
