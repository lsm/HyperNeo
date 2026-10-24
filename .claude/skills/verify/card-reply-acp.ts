import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { handoffPromptToMailbox } from '../../../packages/daemon/src/lib/mailbox/handoff.ts';
import { renderAddress } from '../../../packages/daemon/src/lib/mailbox/address.ts';
import type { NeoPublication } from '../../../packages/shared/src/types/neo-publication.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) assert(!process.env[key], key);
for (const dir of ['evidence', 'bin']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/card-reply-acp.ts', import.meta.url));
process.env.HYPERNEO_ACP_COMMAND = `${process.execPath} ${fixture} ${run}`;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const evidence: Record<string, unknown> = {};
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const invoke = <T>(name: string, input: unknown) => hub.request<T>('operation.invoke', { name, input });
try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'acp', displayName: 'Synthetic ACP', kind: 'built_in', authType: 'none', isEnabled: true, isDefault: true, sortOrder: 0 } });
  const { servers } = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  app.db.updateGlobalSettings({ language: 'zh-Hans', neo: { preferences: { provider: 'acp', model: 'acp-default', thinkingLevel: 'low' } } });
  const opened = await invoke<{ ok: boolean; sessionId: string }>('neo.open', {});
  assert(opened.ok);
  const root = opened.sessionId, conversationId = root.slice(4), requestId = crypto.randomUUID();
  assert.equal(app.db.getSession(root)?.config.provider, 'acp');
  const todos = new NeoAskTodoRepository(app.db.getDatabase());
  todos.openAsk({ id: 'costco', sessionId: root, projectId: null, originMessageId: null, title: 'Costco', request: 'Synthetic weekend choice', createdAt: Date.now() });
  assert((await invoke<{ ok: boolean }>('neo.message.send', { sessionId: root, requestId, content: '周六还是周日去 Costco？用卡片问我' })).ok);
  await until(() => !!app.db.getMessageByStatusAndUuid(root, 'consumed', requestId), 'human input not consumed');
  writeFileSync(join(run, 'release-tools'), 'yes');
  await until(() => todos.listQuestions('costco').length >= 1 && app.sessionManager.getCachedSession(root)?.getProcessingState().status === 'idle', 'ACP question did not finish');
  const page = await invoke<{ items: NeoPublication[] }>('neo.publication.read', { conversationId });
  const statuses = await invoke('neo.conversation.asks.read', { conversationId });
  Object.assign(evidence, { root, requestId, page, statuses, questions: todos.listQuestions('costco') });
  const notices = page.items.filter((row) => row.cardReply);
  assert.equal(notices.length, 1, 'ACP no-replyTo response must persist one card reply notice');
  assert.equal(todos.listQuestions('costco').length, 1, 'duplicate MCP call must reuse the question');
  assert.deepEqual(notices[0].cardReply?.sourceMessageIds, [requestId]);
  assert.equal(notices[0].replyTo, undefined);
  const background = crypto.randomUUID();
  await handoffPromptToMailbox({ to: renderAddress({ kind: 'session', sessionId: root }), origin: 'session:synthetic-teammate', messageUuid: background, message: { type: 'user', parent_tool_use_id: null, inputKind: 'task', message: { role: 'user', content: 'BACKGROUND_CARD' } }, jobQueue: app.db.getJobQueueRepo() });
  await until(() => todos.listQuestions('costco').length === 2 && app.sessionManager.getCachedSession(root)?.getProcessingState().status === 'idle', 'background turn did not finish');
  const after = await invoke<{ items: NeoPublication[] }>('neo.publication.read', { conversationId });
  evidence.afterBackground = after;
  assert.deepEqual(after.items, page.items, 'background prompt must not borrow the completed human turn');
  evidence.pass = true;
  console.log(`PASS ACP card reply; ${run}/evidence/card-reply-acp.json`);
} finally {
  evidence.protocol = existsSync(join(run, 'evidence/acp-protocol.jsonl')) ? readFileSync(join(run, 'evidence/acp-protocol.jsonl'), 'utf8') : '';
  writeFileSync(join(run, 'evidence/card-reply-acp.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
}
