import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query, createSdkMcpServer, tool } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { z } from '../../../packages/daemon/node_modules/zod/index.js';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { ProviderCredentialManager } from '../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts';
import { initializeProviders, registerBuiltInProvider } from '../../../packages/daemon/src/lib/providers/factory.ts';
import { neoReadTools } from '../../../packages/daemon/src/lib/neo/session-config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import type { Session } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
const baseline = process.argv.includes('--baseline');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['EXA_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(process.env[key], undefined);
for (const dir of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, dir), { recursive: true });
for (const name of ['gh', 'security', 'open']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
let requests = 0, calls = 0;
const model = 'deepseek-v4-pro';
const toolName = 'mcp__exa__web_search_exa';
const marker = 'LOCAL_EXA_SEARCH_RESULT';
const toolResults: unknown[] = [];
const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.url.includes('count_tokens')) return Response.json({ input_tokens: 20 });
  if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({});
  const body = await request.json() as { stream?: boolean; messages?: { content?: unknown }[] };
  const isTool = requests++ === 0;
  for (const message of body.messages ?? []) {
    if (Array.isArray(message.content)) toolResults.push(...message.content.filter(block => block.type === 'tool_result'));
  }
  const input = { query: 'What is the capital of France?' };
  const block = isTool ? { type: 'tool_use', id: 'exa-search', name: toolName, input } : { type: 'text', text: 'Permission probe complete.' };
  const usage = { input_tokens: 20, output_tokens: 10 };
  const message = { id: `msg_${requests}`, type: 'message', role: 'assistant', model, content: [block], stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
  if (!body.stream) return Response.json(message);
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response([
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: isTool ? { ...block, input: {} } : { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: isTool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: 'Permission probe complete.' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let stream: ReturnType<typeof query> | undefined;
const evidence: Record<string, unknown> = { baseline, realProvider: false, realExaService: false, toolResults };
try {
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true }, verbose: false });
  for (const port of [app.server.port, mock.port]) assert(![8399, 8499].includes(port!));
  await app.jobProcessor.stop();
  await registerBuiltInProvider(initializeProviders(), 'deepseek');
  await app.settingsManager.updateGlobalSettings({ settingSources: [], exa: { enabled: true } });
  await ProviderCredentialManager.create(app.db.getDatabase()).storeApiKey('exa', 'synthetic-loopback-only');
  const session: Session = {
    id: `neo:${crypto.randomUUID()}`, title: 'Exa permission probe', workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { ...neoReadTools(), model, provider: 'deepseek', queryMode: 'manual', providerConfig: { apiKey: 'synthetic-loopback-only', baseUrl: `http://127.0.0.1:${mock.port}` } },
    metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  };
  await app.db.createSession(session);
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: session.id, kind: 'neo', projectId: null });
  const options = await new QueryOptionsBuilder({ session, db: app.db, settingsManager: app.settingsManager }).build();
  assert.equal(options.permissionMode, 'dontAsk');
  assert(options.mcpServers?.exa);
  assert(options.disallowedTools?.includes('WebSearch'));
  assert(options.disallowedTools?.includes('WebFetch'));
  evidence.config = { provider: session.config.provider, model, permissionMode: options.permissionMode, allowedTools: options.allowedTools, disallowedTools: options.disallowedTools, exaAttached: true };
  options.mcpServers = { exa: createSdkMcpServer({ name: 'exa', tools: [tool('web_search_exa', 'Search a synthetic local web fixture', { query: z.string() }, async ({ query }) => {
    calls++;
    assert.equal(query, 'What is the capital of France?');
    return { content: [{ type: 'text', text: marker }] };
  })] }) };
  options.env = { ...options.env, ANTHROPIC_API_KEY: 'synthetic-loopback-only', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  options.stderr = data => writeFileSync(join(run, 'evidence/sdk-stderr.log'), data, { flag: 'a' });
  stream = query({ prompt: 'Run the scripted Exa search once.', options });
  const timer = setTimeout(() => stream?.close(), 60000);
  let terminal = false;
  try {
    for await (const event of stream) {
      writeFileSync(join(run, 'evidence/sdk-events.jsonl'), JSON.stringify(event) + '\n', { flag: 'a' });
      if (event.type === 'result') {
        terminal = true;
        evidence.permissionDenials = event.permission_denials;
        evidence.result = event.subtype;
      }
    }
  } finally { clearTimeout(timer); stream.close(); stream = undefined; }
  assert(terminal, 'Native SDK must finish the turn');
  assert.equal(calls, baseline ? 0 : 1);
  if (baseline) assert(JSON.stringify(evidence.permissionDenials).includes(toolName));
  else {
    assert.deepEqual(evidence.permissionDenials, []);
    assert(JSON.stringify(toolResults).includes(marker));
    assert(options.allowedTools?.includes('mcp__exa'));
  }
  evidence.passed = true;
} finally {
  stream?.close();
  await app?.cleanup();
  await mock.stop(true);
  Object.assign(evidence, { calls, requests, resourcesClosed: true });
  writeFileSync(join(run, 'evidence/exa-admission.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ baseline, calls, requests, passed: true }));
