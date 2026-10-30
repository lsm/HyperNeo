import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query, type HookInput } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
const full = process.argv.includes('--full');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
for (const name of ['gh', 'security', 'open', 'claude']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const captures: unknown[] = [];
let role = '', step = 0;
const model = 'claude-haiku-4-5-20251001';
const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body = await request.json() as { stream?: boolean; messages?: unknown[] };
  if (request.url.includes('/count_tokens')) return Response.json({ input_tokens: 50 });
  captures.push({ role, messages: body.messages });
  const command = step++ === 0;
  const block = command ? { type: 'tool_use', id: `bash-${role}`, name: 'Bash', input: { command: full && role === 'root' ? 'printf "CAP=%s MAX=%s\\n" "$BASH_DEFAULT_TIMEOUT_MS" "$BASH_MAX_TIMEOUT_MS"; sleep 125; printf COMMAND_COMPLETED' : 'printf "CAP=%s MAX=%s\\n" "$BASH_DEFAULT_TIMEOUT_MS" "$BASH_MAX_TIMEOUT_MS"; sleep 1; printf COMMAND_COMPLETED', timeout: 600000 } } : { type: 'text', text: 'Native Bash result received.' };
  const usage = { input_tokens: 50, output_tokens: 10 };
  const message = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model, content: [block], stop_reason: command ? 'tool_use' : 'end_turn', stop_sequence: null, usage };
  if (!body.stream) return Response.json(message);
  const event = (type: string, value: unknown) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  return new Response([
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: command ? { ...block, input: {} } : { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: command ? { type: 'input_json_delta', partial_json: JSON.stringify('input' in block ? block.input : {}) } : { type: 'text_delta', text: 'Native Bash result received.' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage }),
    event('message_stop', { type: 'message_stop' }),
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
assert.notEqual(mock.port, 8399);
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let stream: ReturnType<typeof query> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = { full, cases: [] };
try {
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const hub = new MessageHub({defaultSessionId:'global'});
  transport = new WebSocketClientTransport({url:`ws://127.0.0.1:${app.server.port}/ws`,autoReconnect:false});
  hub.registerTransport(transport); await transport.initialize();
  await hub.request('providers.create', {params:{providerId:'anthropic',displayName:'Synthetic loopback',kind:'built_in',authType:'api_key',isEnabled:true,isDefault:true,sortOrder:0},credentials:{apiKey:'sk-devproxy-test-key'}});
  await waitForSdkBodyCopy(app.db.getDatabase());
  await app.settingsManager.updateGlobalSettings({ settingSources: [], env: { BASH_DEFAULT_TIMEOUT_MS: '600000', BASH_MAX_TIMEOUT_MS: '600000' } });
  for (role of ['root', 'worker']) {
    step = 0;
    const session = { id: role === 'root' ? `neo:${crypto.randomUUID()}` : crypto.randomUUID(), title: `Synthetic ${role}`, workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { model, provider:'anthropic', queryMode: 'manual', sdkToolsPreset: ['Bash'], allowedTools: ['Bash'], permissionMode: 'bypassPermissions' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } } satisfies import('../../../packages/shared/src/mod.ts').Session;
    await app.db.createSession(session);
    if (role === 'root') new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: session.id, kind: 'neo', projectId: null });
    const options = await new QueryOptionsBuilder({ session, db: app.db, settingsManager: app.settingsManager }).build();
    const hooks: HookInput[] = [];
    for (const event of ['PostToolUse', 'PostToolUseFailure'] as const) options.hooks![event] = [...options.hooks?.[event] ?? [], { hooks: [async input => { hooks.push(input); return {}; }] }];
    options.env = { ...options.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`, ANTHROPIC_API_KEY: 'sk-devproxy-test-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    options.settingSources = [];
    options.stderr = data => writeFileSync(join(run, 'evidence/sdk-stderr.log'), data, { flag: 'a' });
    const started = Date.now();
    stream = query({ prompt: 'Run the scripted local Bash probe once and read its result.', options });
    const deadline = setTimeout(() => stream?.close(), 150000);
    try {
      for await (const event of stream) writeFileSync(join(run, `evidence/${role}-events.jsonl`), JSON.stringify(event) + '\n', { flag: 'a' });
    } finally { clearTimeout(deadline); stream.close(); stream = undefined; }
    const own = captures.filter(capture => (capture as {role: string}).role === role);
    const result = { role, env: { default: options.env.BASH_DEFAULT_TIMEOUT_MS, max: options.env.BASH_MAX_TIMEOUT_MS }, elapsed: Date.now() - started, hooks, requests: own };
    (evidence.cases as unknown[]).push(result);
    if (role === 'root') {
      assert.equal(options.env.BASH_DEFAULT_TIMEOUT_MS, '120000');
      assert.equal(options.env.BASH_MAX_TIMEOUT_MS, '120000');
      assert(JSON.stringify(own).includes('CAP=120000 MAX=120000'));
      if (full) {
        assert(hooks.some(input => input.hook_event_name === 'PostToolUseFailure' && /Command timed out after/.test(input.error)));
        assert(JSON.stringify(own).includes('This command hit the 2-minute limit and was stopped; its outcome is unknown.'));
        assert(!JSON.stringify(own).includes('COMMAND_COMPLETED\\n'));
        assert(result.elapsed >= 120000 && result.elapsed < 145000);
      }
    } else {
      assert.equal(options.env.BASH_MAX_TIMEOUT_MS, '600000');
      assert(JSON.stringify(own).includes('CAP=600000 MAX=600000'));
      assert(!JSON.stringify(own).includes('This command hit the 2-minute limit'));
    }
  }
  evidence.passed = true;
} catch (error) { evidence.error = String(error); throw error; }
finally {
  stream?.close();
  await transport?.close();
  await app?.cleanup();
  await mock.stop(true);
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/neo-bash-cap.json'), JSON.stringify(evidence, null, 2));
}
console.log('PASS: actual SDK Bash receives coordinator-only cap; full mode observes native timeout and model context');
