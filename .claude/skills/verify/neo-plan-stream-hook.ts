import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { AnthropicProvider } from '../../../packages/daemon/src/lib/providers/anthropic-provider.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { SDKMessage } from '../../../packages/shared/src/sdk/sdk.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(process.env[key], undefined);
assert(!existsSync(join(run, 'data/daemon.db')));
for (const name of ['workspace', 'bin', 'evidence'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
process.env.HYPERNEO_USE_DEV_PROXY = '0';
const markers = ['STREAM_INPUT_ONE', 'STREAM_INPUT_TWO', 'STREAM_INPUT_THREE'];
const hooks: Array<{ prompt: string; session: string }> = [];
const requests: unknown[] = [];
const errors: string[] = [];
let builds = 0;
const evidence: Record<string, unknown> = { pass: false, markers, hooks, requests, errors };
const fixture = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  res.setHeader('content-type', 'application/json');
  if (req.url?.includes('count_tokens')) return res.end('{"input_tokens":1000}');
  if (req.url?.endsWith('/models')) return res.end('{"data":[],"has_more":false}');
  if (!req.url?.startsWith('/v1/messages')) {
    res.statusCode = 404;
    return res.end('{}');
  }
  requests.push(body);
  const message = {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text: 'STREAM_TURN_FINISHED' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 20 },
  };
  if (!body.stream) return res.end(JSON.stringify(message));
  res.setHeader('content-type', 'text/event-stream');
  const event = (type: string, data: unknown) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  event('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null },
  });
  event('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'STREAM_TURN_FINISHED' },
  });
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  event('message_stop', { type: 'message_stop' });
  res.end();
});
await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
const address = fixture.address();
assert(address && typeof address !== 'string');
assert(![8399, 8499].includes(address.port));
const base = `http://127.0.0.1:${address.port}`;
const app = await createDaemonApp({
  config: {
    ...getConfig({
      port: 0,
      host: '127.0.0.1',
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: join(run, 'workspace'),
    }),
    disableGoalProcessing: true,
    disableWorktrees: true,
  },
  verbose: false,
});
assert(![8399, 8499].includes(app.server.port));
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
});
hub.registerTransport(transport);
const wait = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 60000;
  while (!(await check())) {
    assert(Date.now() < deadline, 'Native SDK did not finish its streamed input');
    await new Promise((done) => setTimeout(done, 100));
  }
};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  app.settingsManager.updateGlobalSettings({ sandbox: { enabled: false } });
  await transport.connect();
  const registry = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of registry.servers)
    await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await hub.request('providers.create', {
    params: {
      providerId: 'anthropic',
      displayName: 'Synthetic loopback',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    },
    credentials: { apiKey: 'sk-synthetic-loopback-only' },
  });
  const model = 'claude-haiku-4-5-20251001';
  setModelsCache(
    new Map([
      [
        'global',
        new AnthropicProvider().convertSdkModels([
          { value: model, displayName: 'Synthetic model', description: '' },
        ]),
      ],
    ])
  );
  const call = (name: string, input: unknown = {}) =>
    hub.request<Record<string, unknown>>('operation.invoke', { name, input });
  await call('neo.preferences.set', { model, provider: 'anthropic', thinkingLevel: 'off' });
  const { sessionId } = await call('neo.open');
  assert(typeof sessionId === 'string');
  const agent = await app.sessionManager.getSessionForControl(sessionId);
  assert(agent);
  const build = agent.optionsBuilder.build.bind(agent.optionsBuilder);
  agent.optionsBuilder.build = async (...args) => {
    builds++;
    const options = await build(...args);
    return {
      ...options,
      sandbox: { enabled: false },
      debugFile: join(run, 'sdk-debug.log'),
      stderr: (data) => {
        errors.push(data);
        options.stderr?.(data);
      },
      spawnClaudeCodeProcess: (opts) =>
        spawn(opts.command, opts.args, {
          cwd: opts.cwd,
          env: { ...opts.env, ANTHROPIC_BASE_URL: base },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: opts.signal,
        }),
      hooks: {
        ...options.hooks,
        UserPromptSubmit: [
          {
            hooks: [
              async (input) => {
                assert.equal(input.hook_event_name, 'UserPromptSubmit');
                const prompt = (input as { prompt: string }).prompt;
                hooks.push({ prompt, session: input.session_id });
                const marker = markers.find((value) => prompt.includes(value));
                return {
                  hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit' as const,
                    additionalContext: `STREAM_HOOK_CONTEXT_${marker ?? 'other'}`,
                  },
                };
              },
            ],
          },
        ],
      },
    };
  };
  let results = 0;
  for (const marker of markers) {
    const receipt = await call('neo.message.send', {
      sessionId,
      requestId: crypto.randomUUID(),
      content: marker,
    });
    assert.equal(receipt.ok, true);
    await wait(async () => {
      const { sdkMessages } = await hub.request<{ sdkMessages: SDKMessage[] }>(
        'message.sdkMessages',
        { sessionId }
      );
      const completed = sdkMessages.filter(
        (message) => message.type === 'result' && !message.is_error
      ).length;
      if (completed <= results) return false;
      results = completed;
      return true;
    });
  }
  Object.assign(evidence, {
    builds,
    results,
    sessionId,
    daemonPort: app.server.port,
    modelPort: address.port,
  });
  assert.equal(builds, 1, 'Inputs did not share HyperNeo’s ongoing SDK stream');
  for (const marker of markers) {
    assert.equal(
      hooks.filter((hook) => hook.prompt.includes(marker)).length,
      1,
      `UserPromptSubmit must fire once for ${marker}`
    );
    assert(
      requests.some((body) => JSON.stringify(body).includes(`STREAM_HOOK_CONTEXT_${marker}`)),
      `Hook context did not reach the model for ${marker}`
    );
  }
  assert.equal(new Set(hooks.map((hook) => hook.session)).size, 1);
  evidence.pass = true;
  console.log(
    'PASS: native UserPromptSubmit fired for all three inputs on one HyperNeo streaming query and delivered every hook context to the loopback model'
  );
} finally {
  evidence.builds = builds;
  await transport.close();
  hub.cleanup();
  await app.cleanup();
  fixture.closeAllConnections();
  await new Promise<void>((done) => fixture.close(() => done()));
  writeFileSync(join(run, 'evidence/stream-hook.json'), JSON.stringify(evidence, null, 2));
}
