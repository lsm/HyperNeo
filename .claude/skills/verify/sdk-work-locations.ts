import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import type { Space } from '../../../packages/shared/src/mod.ts';
import { buildCustomAgentTaskMessage } from '../../../packages/daemon/src/lib/agents/task-message.ts';
import { makeSessionKindTask } from '../../../packages/daemon/tests/unit/helpers/session-kinds.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const name of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
for (const name of ['gh', 'open', 'security', 'codex', 'claude']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const marker = 'WORK_LOCATION_SDK_PROOF';
const captures: { count: number; systemCount: number; hasWorktrees: boolean; hasWorkspace: boolean }[] = [];
const model = 'claude-haiku-4-5-20251001';
const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (request.method === 'HEAD') return new Response(null, { status: 200 });
  if (path.endsWith('/models')) return Response.json({ data: [{ id: model, type: 'model', display_name: 'Fixture Haiku', created_at: '2025-10-01T00:00:00Z' }], has_more: false });
  const body = await request.json() as { stream?: boolean; messages?: unknown[]; system?: unknown };
  if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 50 });
  if (JSON.stringify(body.messages).includes(marker)) {
    const text = JSON.stringify([body.system, body.messages]);
    captures.push({ count: text.split('## Runtime Location').length - 1, systemCount: JSON.stringify(body.system ?? '').split('## Runtime Location').length - 1, hasWorktrees: text.includes('HYPERNEO_WORKTREES'), hasWorkspace: text.includes(join(run, 'workspace')) });
  }
  const usage = { input_tokens: 50, output_tokens: 10 };
  const block = { type: 'text', text: 'WORK_LOCATION_SDK_RECEIVED' };
  const message = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model, content: [block], stop_reason: 'end_turn', stop_sequence: null, usage };
  if (!body.stream) return Response.json(message);
  const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  return new Response([
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
assert.notEqual(mock.port, 8399);
const previousUrl = process.env.ANTHROPIC_BASE_URL;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`;
let app: Awaited<ReturnType<typeof import('../../../packages/daemon/src/app.ts')['createDaemonApp']>> | undefined;
let transport: WebSocketClientTransport | undefined;
try {
  const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
  const { getConfig } = await import('../../../packages/daemon/src/config.ts');
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Local fixture', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const registry = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list');
  for (const server of registry.servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  const catalog = await hub.request<{ models: { id: string; provider: string }[] }>('models.list', { forceRefresh: true });
  const chosen = catalog.models.find((entry) => entry.provider === 'anthropic' && entry.id.includes('haiku'));
  assert(chosen);
  const space: Space = { id: 'fixture-space', slug: 'fixture', name: 'Fixture', description: '', workspacePath: join(run, 'workspace'), sessionIds: [], status: 'active', createdAt: 1, updatedAt: 1 };
  const message = buildCustomAgentTaskMessage({ task: makeSessionKindTask({ description: marker }), space, workspacePath: join(run, 'workspace') });
  const started = await hub.request<Result<WorkStarted>>('operation.invoke', { name: 'work.start', input: { adapter: 'hyperneo', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Fixture' }, title: 'Fixture dev 1', model: chosen.id, message } });
  assert(started.ok, JSON.stringify(started));
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const result = app.db.getDatabase().prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='assistant'").get(started.value.ref.id) as { n: number };
    if (result.n > 0 && captures.length > 0) break;
    await Bun.sleep(100);
  }
  assert(captures.length > 0, 'real SDK sent the worker task to the loopback model');
  const workers = captures.filter((capture) => capture.systemCount > 0);
  assert(workers.length > 0, 'captured the worker request with its host system prompt');
  for (const capture of workers) {
    assert.equal(capture.count, 1, 'model receives one runtime location section');
    assert(capture.hasWorktrees && capture.hasWorkspace);
  }
} finally {
  await transport?.close();
  await app?.cleanup();
  await mock.stop(true);
  if (previousUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousUrl;
  writeFileSync(join(run, 'evidence/sdk-work-locations.json'), JSON.stringify({ captures, realSdk: true, scriptedLoopbackModel: true, loopbackRequestObserved: captures.length > 0, resourcesStopped: true }, null, 2));
}
console.log('PASS: actual SDK worker model request receives one runtime location section');
