import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { AnthropicProvider } from '../../../packages/daemon/src/lib/providers/anthropic-provider.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const run = resolve(process.argv.at(-1)!);
const feature = process.argv[2] === 'context';
const contexts: Array<{ event: string; source?: string; context: string }> = [];
let activeHook = 0;
let mainReads = 0;
const originalBuild = QueryOptionsBuilder.prototype.build;
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
const evidence: Record<string, unknown> = {
  pass: false,
  feature,
  markers,
  hooks,
  requests,
  errors,
  contexts,
};
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
  const db = app.db.getDatabase();
  const prepare = db.prepare.bind(db);
  if (feature) {
    const ask = prepare(
      'INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES(?,?,?,?,1,1)'
    );
    const todo = prepare(
      "INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,approved_at,depends_on,created_at,updated_at) VALUES(?,?,0,?,'Observed','todo',1,'[]',1,1)"
    );
    for (let i = 0; i < 12; i++) {
      ask.run(`context-${i}`, sessionId, `Synthetic plan ${i}`, 'Synthetic request');
      todo.run(`step-${i}`, `context-${i}`, `Synthetic step ${i}`);
    }
    db.prepare = ((sql: string) => {
      if (activeHook > 0 && /\bFROM neo_(asks|todos|questions)\b/i.test(sql)) mainReads++;
      return prepare(sql);
    }) as typeof db.prepare;
  }
  QueryOptionsBuilder.prototype.build = async function (...args) {
    builds++;
    const options = await originalBuild.apply(this, args);
    if (feature) {
      for (const event of ['SessionStart', 'UserPromptSubmit'] as const)
        for (const entry of options.hooks?.[event] ?? [])
          entry.hooks = entry.hooks.map((callback) => async (input, tool, config) => {
            activeHook++;
            try {
              const output = await callback(input, tool, config);
              const context =
                'hookSpecificOutput' in output
                  ? (output.hookSpecificOutput?.additionalContext ?? '')
                  : '';
              contexts.push({
                event,
                source: 'source' in input ? input.source : undefined,
                context,
              });
              return output;
            } finally {
              activeHook--;
            }
          });
    }
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
      hooks: feature
        ? options.hooks
        : {
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
  const send = async (marker: string) => {
    const previous = await hub.request<{ sdkMessages: SDKMessage[] }>('message.sdkMessages', {
      sessionId,
    });
    const known = new Set(
      previous.sdkMessages
        .filter((message) => message.type === 'result')
        .map((message) => message.uuid)
    );
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
        (message) => message.type === 'result' && !message.is_error && !known.has(message.uuid)
      ).length;
      if (!completed) return false;
      results += completed;
      evidence.results = results;
      return true;
    });
  };
  for (const marker of markers) {
    if (feature && marker === markers[1])
      prepare("UPDATE neo_todos SET title = 'Changed step' WHERE id = 'step-0'").run();
    await send(marker);
  }
  if (feature) {
    const start = contexts.find((row) => row.event === 'SessionStart') ?? contexts[0];
    for (let i = 0; i < 12; i++)
      assert(start?.context.includes(`Ask context-${i} `), 'Startup context missed an open plan');
    const prompts = contexts.filter((row) => row.event === 'UserPromptSubmit');
    if (contexts.some((row) => row.event === 'SessionStart')) assert.equal(prompts[0]?.context, '');
    assert(prompts[1]?.context.includes('Changed step'));
    assert(!prompts[1]?.context.includes('Ask context-11 '));
    assert.equal(prompts[2]?.context, '');
    assert(
      requests.some((body) => JSON.stringify(body).includes('Changed step')),
      'Changed context never reached the model'
    );
    assert(
      requests.some((body) => JSON.stringify(body).includes('Ask context-11 ')),
      'Full digest never reached the model'
    );
    const beforeCompact = contexts.length;
    const compactRequests = requests.length;
    await agent.messageQueue.enqueue('/compact', true, { durable: true });
    await wait(async () => {
      const { sdkMessages } = await hub.request<{ sdkMessages: SDKMessage[] }>(
        'message.sdkMessages',
        { sessionId }
      );
      return sdkMessages.some(
        (message) => message.type === 'system' && message.subtype === 'compact_boundary'
      );
    });
    await send('AFTER_REAL_COMPACTION');
    assert(
      contexts
        .slice(beforeCompact)
        .some((row) => row.source === 'compact' && row.context.includes('Ask context-11 ')),
      'Native compact hook did not rehydrate the plans'
    );
    assert(
      requests
        .slice(compactRequests)
        .some(
          (body) =>
            JSON.stringify(body).includes('AFTER_REAL_COMPACTION') &&
            JSON.stringify(body).includes('Ask context-11 ')
        ),
      'Rehydrated compact digest did not reach the model'
    );
    const beforeRestart = contexts.length;
    const restartRequests = requests.length;
    const reset = await hub.request<{ success: boolean }>('session.resetQuery', {
      sessionId,
      restartQuery: true,
    });
    assert(reset.success);
    await send('AFTER_QUERY_RESTART');
    assert(
      contexts
        .slice(beforeRestart)
        .some(
          (row) => row.context.includes('Open plans') && row.context.includes('Ask context-11 ')
        ),
      'Native restart input did not rehydrate the plans'
    );
    assert(
      requests
        .slice(restartRequests)
        .some(
          (body) =>
            JSON.stringify(body).includes('AFTER_QUERY_RESTART') &&
            JSON.stringify(body).includes('Ask context-11 ')
        ),
      'Restart digest did not reach the model'
    );
    evidence.mainReads = mainReads;
    assert.equal(mainReads, 0, 'Plan hooks read target tables on the main thread');
  }
  Object.assign(evidence, {
    builds,
    results,
    sessionId,
    daemonPort: app.server.port,
    modelPort: address.port,
  });
  if (!feature) {
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
  }
  evidence.pass = true;
  console.log(
    feature
      ? 'PASS: native startup, change-only prompt, compaction and restart plan context reached the model through the DB gateway'
      : 'PASS: native UserPromptSubmit fired for all three inputs on one HyperNeo streaming query and delivered every hook context to the loopback model'
  );
} finally {
  evidence.builds = builds;
  evidence.mainReads = mainReads;
  QueryOptionsBuilder.prototype.build = originalBuild;
  await transport.close();
  hub.cleanup();
  await app.cleanup();
  fixture.closeAllConnections();
  await new Promise<void>((done) => fixture.close(() => done()));
  writeFileSync(join(run, 'evidence/stream-hook.json'), JSON.stringify(evidence, null, 2));
}
