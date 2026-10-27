import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../../packages/daemon/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0,
  dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'home') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
await app.spaceRuntimeService.ready();
await app.jobProcessor.stop();
const root = `neo:${crypto.randomUUID()}`, worker = crypto.randomUUID(), history = crypto.randomUUID();
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const sdk = createOperationMcpServer(() => app.sessionManager.getOperationRegistry(), () => ({ role: 'neo', sessionId: root }));
const client = new Client({ name: 'archive-proof', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
const evidence: Record<string, unknown> = {};
const call = async (name: string, input: unknown) => {
  const reply = await client.callTool({ name: 'invoke', arguments: { name, input } });
  assert(!reply.isError, JSON.stringify(reply));
  const result = JSON.parse((reply.content as { text: string }[])[0].text);
  evidence[name] = result;
  return result;
};
try {
  assert.notEqual(app.server.port, 8399);
  const now = new Date().toISOString();
  for (const id of [root, worker]) await app.db.createSession({ id, title: 'Archive proof', workspacePath: run,
    createdAt: now, lastActiveAt: now, status: 'active', config: { model: 'claude-sonnet-4-5-20250929', maxTokens: 8192, temperature: 1 },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  await app.db.saveUserMessage(worker, { type: 'user', uuid: history, session_id: worker, parent_tool_use_id: null,
    inputKind: 'human', message: { role: 'user', content: 'Conversation retained after archiving.' } });
  await sdk.instance.connect(b); await client.connect(a); await transport.initialize();
  const ref = { adapter: 'hyperneo', id: worker };
  const archived = await call('neo.session.archive', { ref });
  evidence.archiveResult = archived;
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(archived.value.archived, true);
  const found = await call('work.find', { id: worker, adapters: ['hyperneo'], includeClosed: true, localOnly: true });
  assert(JSON.stringify(found).includes(worker));
  const opened = await hub.request<{ session: { status: string } }>('session.get', { sessionId: worker });
  evidence.archivedSession = opened;
  assert.equal(opened.session.status, 'archived');
  const messages = await hub.request('message.sdkMessages', { sessionId: worker });
  evidence.archivedConversation = messages;
  assert(JSON.stringify(messages).includes(history));
  assert(JSON.stringify(messages).includes('Conversation retained after archiving.'));
  await hub.request('session.update', { sessionId: worker, status: 'active' });
  const reopened = await hub.request<{ session: { status: string } }>('session.get', { sessionId: worker });
  evidence.reopenedSession = reopened;
  assert.equal(reopened.session.status, 'active');
  const todos = new NeoAskTodoRepository(app.db.getDatabase());
  const ask = todos.openAsk({ id: 'guard', sessionId: root, projectId: null, originMessageId: null, title: 'Keep working', request: 'Keep working', createdAt: Date.now() });
  const todo = todos.addTodo('guard-todo', ask.id, { title: 'Doing todo', doneWhen: 'Done', instruction: null, named: null, check: null }, Date.now());
  todos.updateTodo(todo, { state: 'doing' }, Date.now());
  new NeoTodoSessionRepository(app.db.getDatabase()).bind(todo.id, ref, Date.now());
  const guarded = await call('neo.session.archive', { ref });
  evidence.liveTodoGuard = guarded;
  assert.equal(guarded.reason, 'live_todo');
  console.log('PASS: bound Neo archives via real MCP/driver; archived session is discoverable, conversation readable, session reopens through RPC; doing-todo guard still refuses.');
} finally {
  writeFileSync(join(run, 'evidence/archive.json'), JSON.stringify(evidence, null, 2));
  await client.close(); await sdk.instance.close();
  await transport.close(); hub.cleanup();
  await app.cleanup();
}
