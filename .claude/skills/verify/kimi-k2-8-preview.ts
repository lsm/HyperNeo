import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence', 'bin'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

type SeenRequest = { path: string; model: string; effort: string | null; messages: unknown };
const seen: SeenRequest[] = [];
const mock = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.includes('/models')) return Response.json({ data: [] });
    if (url.pathname.includes('/count_tokens')) return Response.json({ input_tokens: 20 });
    const body = (await request.json().catch(() => ({}))) as {
      model?: string;
      output_config?: { effort?: string };
      messages?: unknown;
      stream?: boolean;
    };
    if (url.pathname.endsWith('/messages'))
      seen.push({
        path: url.pathname,
        model: String(body.model ?? ''),
        effort: body.output_config?.effort ?? null,
        messages: body.messages,
      });
    const message = {
      id: `msg_${crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: 'Synthetic Kimi answer.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 5 },
    };
    if (!body.stream) return Response.json(message);
    const event = (type: string, value: unknown) =>
      `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(
      [
        event('message_start', {
          type: 'message_start',
          message: { ...message, content: [], stop_reason: null },
        }),
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Synthetic Kimi answer.' },
        }),
        event('content_block_stop', { type: 'content_block_stop', index: 0 }),
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { input_tokens: 20, output_tokens: 5 },
        }),
        event('message_stop', { type: 'message_stop' }),
      ].join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  },
});
assert(![8399, 8499].includes(mock.port));
process.env.KIMI_BASE_URL = `http://127.0.0.1:${mock.port}`;

const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');

const isTurn = (request: SeenRequest) => {
  const content = (request.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content;
  if (Array.isArray(content)) return content.length > 0;
  return typeof content === 'string' && content.trim() !== '.';
};

let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = { head: process.argv[2], passed: false };
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({
        host: '127.0.0.1',
        port: 0,
        dbPath: join(run, 'data/daemon.db'),
        workspaceRoot: join(run, 'workspace'),
      }),
      disableWorktrees: true,
    },
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  const credential = readLocalCredential(join(run, 'data/local-rpc.credential'));
  transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
    createSocket: (url) =>
      new WebSocket(url, {
        headers: { authorization: `Bearer ${credential}` },
      } as unknown as string[]),
  });
  hub.registerTransport(transport);
  await transport.initialize();

  await hub.request('providers.create', {
    params: {
      providerId: 'kimi',
      displayName: 'Kimi (synthetic loopback)',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
      baseUrl: process.env.KIMI_BASE_URL,
    },
    credentials: { apiKey: 'synthetic-only' },
  });
  const listed = await hub.request<{ models: Array<Record<string, unknown>> }>('models.list', {
    provider: 'kimi',
  });
  const coding = listed.models.find((model) => model.id === 'kimi-for-coding');
  assert(coding, 'kimi-for-coding is missing from the catalogue');
  assert.equal(coding.contextWindow, 1_048_576);
  assert.deepEqual(coding.effortLevels, ['low', 'high', 'max']);
  assert.equal(coding.thinkingModes, 'granular');
  assert.match(String(coding.display_name), /K2\.8/);
  evidence.catalogue = {
    id: coding.id,
    name: coding.display_name,
    contextWindow: coding.contextWindow,
    effortLevels: coding.effortLevels,
    thinkingModes: coding.thinkingModes,
  };

  const created = await hub.request<{ sessionId: string }>('session.create', {
    workspacePath: join(run, 'workspace'),
    title: 'Kimi K2.8 preview',
    config: { model: 'kimi-for-coding', provider: 'kimi' },
  });
  await hub.request('message.send', { sessionId: created.sessionId, content: 'Say hello.' });
  const deadline = Date.now() + 60_000;
  while (!seen.some(isTurn)) {
    assert(Date.now() < deadline, 'the turn never reached the synthetic Kimi endpoint');
    await new Promise((done) => setTimeout(done, 50));
  }
  const turn = seen.find(isTurn)!;
  assert.equal(turn.model, 'kimi-for-coding');
  assert.equal(turn.effort, 'high');
  evidence.turn = { model: turn.model, effort: turn.effort, path: turn.path };
  evidence.passed = true;
} finally {
  await transport?.close();
  await app?.cleanup();
  evidence.resourcesClosed = true;
  mock.stop(true);
  writeFileSync(join(run, 'evidence/kimi-k2-8-preview.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence));
process.exit(0);
