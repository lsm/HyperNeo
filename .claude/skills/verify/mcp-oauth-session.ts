import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport, type AppMcpServer } from '../../../packages/shared/src/mod.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { startFakeMcpOAuthServer } from '../../../packages/daemon/tests/helpers/fake-mcp-oauth-server.ts';

const run = resolve(process.argv.at(-1)!);
const data = join(run, 'data');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
assert.equal(process.env.NODE_ENV, 'test');
for (const name of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
for (const name of ['gh', 'open', 'security', 'claude'])
  writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

const name = 'oauth-session-proof';
const model = 'claude-haiku-4-5-20251001';
const toolName = `mcp__${name}__read`;
const readText = 'Synthetic record read';
const results = new Map<string, string>();
const requested = new Set<string>();
const turns = ['read-first', 'read-reconnected', 'read-retired', 'read-revoked'];
let revoke = false;
const hold = Promise.withResolvers<void>();
let entered = false;
const fake = await startFakeMcpOAuthServer({
  port: 18347,
  beforeRefreshReply: async () => revoke ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : undefined,
  mcpReply: async (request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const { id, method, params } = await request.json();
    if (id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
    if (method === 'initialize')
      return reply({ protocolVersion: '2025-03-26', serverInfo: { name, version: '1' }, capabilities: { tools: {} } });
    if (method === 'tools/list')
      return reply({ tools: [{ name: 'read', inputSchema: { type: 'object' } }] });
    if (revoke) return new Response(null, { status: 401 });
    if (params.arguments?.mode === 'read-retired') {
      entered = true;
      await hold.promise;
    }
    return reply({ content: [{ type: 'text', text: readText }] });
  },
});

type ModelPart = { type: string; text?: string; tool_use_id?: string; content?: unknown };
let modelCalls = 0;
const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.url.includes('count_tokens')) return Response.json({ input_tokens: 100 });
  if (!request.url.includes('/v1/messages')) return new Response(null, { status: 404 });
  modelCalls += 1;
  const body = await request.json() as { stream?: boolean; messages: Array<{ content: string | ModelPart[] }>; tools?: Array<{ name: string }> };
  for (const { content } of body.messages ?? []) {
    if (!Array.isArray(content)) continue;
    for (const part of content)
      if (part.type === 'tool_result' && part.tool_use_id)
        results.set(part.tool_use_id, JSON.stringify(part.content));
  }
  const last = JSON.stringify(body.messages?.at(-1)?.content ?? '');
  const turn = turns.find((marker) => last.includes(marker));
  const call = turn && !requested.has(turn) && body.tools?.some((tool) => tool.name === toolName);
  if (call) requested.add(turn);
  const block = call ? { type: 'tool_use', id: turn, name: toolName, input: { mode: turn } } : { type: 'text', text: 'Synthetic model turn complete' };
  const usage = { input_tokens: 100, output_tokens: 20 };
  const message = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model, content: [block], stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
  if (!body.stream) return Response.json(message);
  const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  return new Response([
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: call ? { ...block, input: {} } : { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify({ mode: turn }) } : { type: 'text_delta', text: block.text } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
const modelUrl = `http://127.0.0.1:${mock.port}`;
process.env.ANTHROPIC_BASE_URL = modelUrl;
const cli = process.env.VERIFY_CLAUDE;
assert(cli?.startsWith('/'), 'Select the pinned native SDK executable with VERIFY_CLAUDE');
const build = QueryOptionsBuilder.prototype.build;
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await build.apply(this, args);
  return {
    ...options,
    pathToClaudeCodeExecutable: cli,
    executable: undefined,
    sandbox: { enabled: false },
    stderr: () => { evidence.sdkStderr = Number(evidence.sdkStderr ?? 0) + 1; },
    spawnClaudeCodeProcess: (opts) => spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...opts.env, ANTHROPIC_BASE_URL: modelUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: opts.signal,
    }),
  };
};

const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { setModelsCache } = await import('../../../packages/daemon/src/lib/model-service.ts');
const { AnthropicProvider } = await import('../../../packages/daemon/src/lib/providers/anthropic-provider.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = { head: process.argv[2], pass: false };
const until = async (label: string, check: () => unknown | Promise<unknown>) => {
  const deadline = Date.now() + 12000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await Bun.sleep(50);
  }
};
try {
  app = await createDaemonApp({
    config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true },
    verbose: false,
  });
  app.settingsManager.updateGlobalSettings({ sandbox: { enabled: false } });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
    createSocket: (url) => createLocalSocket(url, join(data, 'local-rpc.credential')),
  });
  hub.registerTransport(transport);
  await transport.initialize();
  const { servers } = await hub.request<{ servers: AppMcpServer[] }>('mcp.registry.list', {});
  for (const server of servers)
    await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await hub.request('providers.create', {
    params: { providerId: 'anthropic', displayName: 'Synthetic loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 },
    credentials: { apiKey: 'sk-devproxy-test-key' },
  });
  setModelsCache(new Map([['global', new AnthropicProvider().convertSdkModels([{ value: model, displayName: 'Synthetic', description: '' }])]]));
  const { server } = await hub.request<{ server: AppMcpServer }>('mcp.registry.create', {
    name, url: fake.url, sourceType: 'http', enabled: true,
  });
  const { id } = server;
  const invoke = <T>(operation: string, input = {}) =>
    hub.request<T>('operation.invoke', { name: `mcp.registry.${operation}`, input: { id, ...input } });
  const consent = async (operation: string, input = {}) => {
    const { authorizeUrl } = await invoke<{ authorizeUrl: string }>(operation, input);
    assert(!!authorizeUrl, 'Expected fixture consent URL');
    const target = (await fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location');
    assert(!!target, 'Expected fixture callback URL');
    assert.equal((await fetch(target)).status, 200);
  };
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', {
    title: 'Synthetic OAuth session', workspacePath: join(run, 'workspace'),
    config: { model, provider: 'anthropic', permissionMode: 'bypassPermissions', operationTools: false },
  });
  const send = (content: string) => hub.request('message.send', { sessionId, content });
  const inventory = () => hub.request<{ state: string; tools: string[]; mcpServers: Array<{ name: string }> }>('session.getToolInventory', { sessionId });
  const hasTool = async () => (await inventory()).tools.includes(toolName);
  await send('Start the synthetic session');
  const agent = app.sessionManager.getSession(sessionId);
  await until('Initial SDK tool inventory missing', async () => {
    const state = await inventory();
    evidence.initial = { state: state.state, hasQuery: !!agent?.queryObject, modelCalls };
    return state.state === 'observed';
  });
  assert(agent?.queryObject);
  const query = agent.queryObject;
  assert(!(await hasTool()));
  await consent('connect', { preset: 'test' });
  await until('The running session did not gain OAuth tools on connect', hasTool);
  const config = (await agent.optionsBuilder.getEffectiveMcpServers())?.[name];
  assert.equal(config?.type, 'sdk');
  assert(!Object.hasOwn(config, 'headers'), 'OAuth SDK config must not carry registry headers');
  const read = async (marker: string) => {
    await send(marker);
    await until(`Native SDK tool result was missing for ${marker}`, () => results.has(marker));
    return results.get(marker)!;
  };
  assert((await read('read-first')).includes(readText));

  const stale = read('read-retired');
  void stale.catch(() => {});
  await until('Old-generation tool call did not reach the fake', () => entered);
  await consent('reconnect');
  hold.resolve();
  assert(!(await stale).includes(readText));
  assert((await read('read-reconnected')).includes(readText));

  await invoke('disconnect');
  await until('The running session retained OAuth tools after disconnect', async () => !(await hasTool()));
  await consent('reconnect');
  await until('The running session did not regain OAuth tools on reconnect', hasTool);
  revoke = true;
  assert(!(await read('read-revoked')).includes(readText));
  await until('The running session retained OAuth tools after invalid_grant', async () => !(await hasTool()));
  assert.equal((await invoke<{ health: string }>('status')).health, 'reconnect_needed');
  assert.equal(agent.queryObject, query);
  assert.equal(fake.authorizeScopes.length, 3);
  evidence.pass = true;
  evidence.cases = ['connect and read', 'old-generation result refused', 'reconnect and read', 'disconnect removal', 'invalid_grant removal', 'same live query', 'SDK config has no headers'];
  console.log('PASS: running native SDK session uses the OAuth proxy and reconciles the grant lifecycle');
} finally {
  hold.resolve();
  await transport?.close();
  await app?.cleanup();
  await mock.stop(true);
  await fake.stop();
  writeFileSync(join(run, 'evidence/mcp-oauth-session.json'), JSON.stringify(evidence, null, 2));
}
