process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SDKMessage } from '../../../packages/shared/src/sdk/sdk.d.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { NeoConversationAskRepository } from '../../../packages/daemon/src/storage/repositories/neo-conversation-ask-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const phase = process.argv[2], run = resolve(process.argv.at(-1)!);
assert(['before', 'after'].includes(phase));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const part of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
let front: ReturnType<typeof Bun.serve> | undefined;
const evidence: Record<string, unknown> = { phase, passed: false };
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(app.server.port, 8399);
  await app.db.updateGlobalSettings({ language: 'en' });
  const conversationId = crypto.randomUUID(), root = `neo:${conversationId}`, worker = 'overflow-worker';
  for (const id of [root, worker]) await app.db.createSession({ id, title: id === root ? 'Synthetic Neo' : `Worker-${'LongUnbrokenName'.repeat(12)}`, workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const raw = app.db.getDatabase();
  new NeoRepository(raw).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const longLink = `https://example.invalid/${'unbroken-path-'.repeat(18)}`;
  const columns = Array.from({ length: 9 }, (_, i) => `Column ${i + 1}`);
  const rich = ['Mobile overflow fixture', '', `[${longLink}](#local-link)`, '', '`' + 'inline_identifier_'.repeat(12) + '`', '', '```sh', `printf '%s' '${'long-command-'.repeat(40)}'`, '```', '', `| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, `| ${columns.map(() => 'UnbreakableCellValue'.repeat(2)).join(' | ')} |`].join('\n');
  const asks = new NeoConversationAskRepository(raw), humanId = crypto.randomUUID();
  assert(asks.append({ conversationId, requestId: humanId, askOrigin: { sessionId: root, messageId: humanId }, content: rich }).accepted);
  const publish = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const published = JSON.parse((await publish({ name: 'neo.publication.publish', input: { requestId: crypto.randomUUID(), text: rich, details: rich + '\n\nFull details', session: worker } })).content[0].text);
  assert(published.accepted, JSON.stringify(published));
  await app.db.saveSDKMessage(worker, { type: 'assistant', uuid: 'overflow-report', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: rich }] } } as SDKMessage);
  const store = new NeoAskTodoRepository(raw), links = new NeoTodoSessionRepository(raw), at = Date.now();
  store.openAsk({ id: 'overflow-work', sessionId: root, projectId: null, originMessageId: null, title: `Work-${'LongUnbrokenTitle'.repeat(15)}`, request: rich, createdAt: at });
  const todo = store.addTodo('overflow-todo', 'overflow-work', { title: `Todo-${'UnbrokenTaskName'.repeat(15)}`, doneWhen: longLink, check: null, instruction: null, named: null }, at);
  links.bind(todo.id, { adapter: 'hyperneo', id: worker }, at);
  links.recordRef(todo.id, { adapter: 'hyperneo', id: worker }, at, `/session/${worker}`);
  store.askQuestion('overflow-question', 'overflow-work', { kind: 'choice', text: rich, options: ['Continue with ' + longLink, 'Hold'], multiple: false, yesLabel: null, noLabel: null, startTodos: null }, at);
  const dist = resolve('packages/web/dist');
  front = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/ws') { if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return; return new Response('Upgrade failed', { status: 500 }); }
    const file = Bun.file(join(dist, path === '/neo' ? 'neo/index.html' : path));
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  }, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
  assert.notEqual(front.port, 8399);
  writeFileSync(join(run, 'fixture.json'), JSON.stringify({ phase, url: `http://127.0.0.1:${front.port}/neo`, humanId, publicationId: published.publication.publicationId, longLink, desktopBaseline: process.argv.length > 4 ? process.argv[3] : undefined }));
  const browser = await promisify(execFile)('node', ['.claude/skills/verify/neo-mobile-overflow-web.mjs', run], { env: process.env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  evidence.browser = JSON.parse(browser.stdout);
  assert((evidence.browser as { passed: boolean }).passed);
  evidence.passed = true;
} catch (error) { evidence.error = String(error); throw error; }
finally { await front?.stop(true); await app.cleanup(); evidence.resourcesClosed = true; writeFileSync(join(run, 'evidence/mobile-overflow.json'), JSON.stringify(evidence, null, 2)); }
