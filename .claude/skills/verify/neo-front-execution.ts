import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '../../../packages/shared/src/mod.ts';
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const network = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  return network(input, init);
}) as typeof fetch;
const sdkPath = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', resolve('packages/daemon'));
const sdk = await import(sdkPath);
const makeServer = sdk.createSdkMcpServer;
let tools: Array<{ name: string; handler: (input: object, extra: object) => Promise<unknown> }> =
  [];
const calls: string[] = [];
const nativeIds: string[] = [];
mock.module(sdkPath, () => ({
  ...sdk,
  createSdkMcpServer(options: Parameters<typeof sdk.createSdkMcpServer>[0]) {
    if (options.name === 'front') tools = options.tools as typeof tools;
    return makeServer(options);
  },
  query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) =>
    (async function* () {
      assert.equal(options.persistSession, true);
      assert.equal(options.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '90');
      assert.deepEqual(options.thinking, { type: 'enabled', budgetTokens: 24000 });
      const nativeId = options.resume ?? options.sessionId!;
      nativeIds.push(nativeId);
      yield { type: 'system', subtype: 'init', session_id: nativeId };
      assert.deepEqual(options.tools, []);
      assert.equal(options.strictMcpConfig, true);
      assert.deepEqual(
        options.allowedTools,
        ['projects_read', 'asks_read', 'cards_read', 'todos_read', 'neo_send'].map(
          (name) => `mcp__front__${name}`
        )
      );
      let words = '';
      for await (const message of prompt)
        words =
          typeof message.message.content === 'string'
            ? message.message.content
            : message.message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join(' ');
      calls.push(words);
      let kind = 'chat',
        text = 'Hello from the front.';
      if (words.includes('status')) {
        const lookup = await tools
          .find((tool) => tool.name === 'todos_read')!
          .handler({ id: 'todo-fixture' }, {});
        assert(JSON.stringify(lookup).includes('done'));
        kind = 'status';
        text = 'The fixture todo is done.';
      }
      if (words.includes('Book')) {
        kind = 'defer';
        text = 'Let me check.';
      }
      yield {
        type: 'assistant',
        uuid: crypto.randomUUID(), session_id: nativeId, parent_tool_use_id: null,
        message: { id: crypto.randomUUID(), role: 'assistant', type: 'message', model: 'front-fixture', content: [{ type: 'text', text: JSON.stringify({ kind, text }) }] },
      };
      yield { type: 'result', subtype: 'success', uuid: crypto.randomUUID(), session_id: nativeId, duration_ms: 1, is_error: false };
    })(),
}));
const resolver = await import('../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts');
mock.module('../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts', () => ({
  ...resolver,
  awaitSDKCliPath: async () => 'synthetic-sdk',
}));
const { getProviderService } = await import('../../../packages/daemon/src/lib/provider-service.ts');
getProviderService().getIsolatedEnvForModel = async (provider, model) => {
  assert.equal(provider, 'glm');
  assert.equal(model, 'front-fixture');
  return {};
};
const audio = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, '/v1/audio/speech');
    await request.json();
    return new Response(new Uint8Array(7680), { headers: { 'Content-Type': 'audio/pcm' } });
  },
});
assert(![8399, 8499].includes(audio.port));
process.env.HYPERNEO_SPEECH_URL = `http://127.0.0.1:${audio.port}`;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { NeoRepository } = await import(
  '../../../packages/daemon/src/storage/repositories/neo-repository.ts'
);
const { NeoPublicationRepository } = await import(
  '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts'
);
const { setModelsCache } = await import('../../../packages/daemon/src/lib/model-service.ts');
const { createLocalSocket } = await import(
  '../../../packages/daemon/src/lib/pairing/local-credential.ts'
);
const { MessageHub, WebSocketClientTransport } = await import(
  '../../../packages/shared/src/mod.ts'
);
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: run,
    }),
    disableWorktrees: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  createSocket: (url) => createLocalSocket(url, join(run, 'data/local-rpc.credential')),
});
hub.registerTransport(transport);
const events: Array<{ type: string; id: string; text?: string }> = [];
hub.onEvent('neo.speech', (event) => events.push(event as (typeof events)[number]));
const observed: Record<string, unknown> = {
  head: process.argv[2],
  passed: false,
  modelTransport: 'scripted SDK query',
  audioTransport: 'loopback PCM',
};
const wait = async (check: () => boolean) => {
  const deadline = Date.now() + 15000;
  while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
  assert(check(), 'fixture deadline');
};
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.jobProcessor.stop();
  await transport.connect();
  const conversationId = '10000000-0000-4000-8000-000000000001';
  const sessionId = `neo:${conversationId}`;
  await app.db.createSession({
    id: sessionId,
    title: 'Front execution fixture',
    workspacePath: run,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  const repo = new NeoRepository(app.db.getDatabase());
  repo.reserveBinding({ sessionId, kind: 'neo', projectId: null });
  assert.equal(repo.conversationId(), conversationId);
  const publications = new NeoPublicationRepository(app.db.getDatabase());
  const queue = app.db.getJobQueueRepo();
  const invoke = <T>(name: string, input: unknown) =>
    hub.request<T>('operation.invoke', { name, input });
  const send = async (content: string, inputMode: 'text' | 'live_voice' = 'text') => {
    const requestId = crypto.randomUUID();
    assert.equal(
      (
        await invoke<{ ok: boolean }>('neo.message.send', {
          sessionId,
          requestId,
          content,
          inputMode,
        })
      ).ok,
      true
    );
    return requestId;
  };
  const off = await send('Hello while off');
  assert.equal(queue.listJobs({ queue: 'neo.front' }).length, 0);
  assert.equal(calls.length, 0);
  assert.equal(publications.list(conversationId)?.length ?? 0, 0);
  setModelsCache(
    new Map([
      [
        'global',
        [
          {
            id: 'front-fixture',
            name: 'Front fixture',
            provider: 'glm',
            available: true,
          } as ModelInfo,
        ],
      ],
    ])
  );
  assert.equal(
    (
      await invoke<{ ok: boolean }>('neo.front.model.set', {
        model: 'front-fixture',
        provider: 'glm',
        thinkingLevel: 'think24k',
      })
    ).ok,
    true
  );
  assert.equal((await invoke<{ ok: boolean }>('neo.front.set', { enabled: true })).ok, true);
  const textId = await send('Hello by text');
  await wait(() => (publications.list(conversationId)?.length ?? 0) === 1);
  assert.equal(events.length, 0);
  const repeated = queue.enqueue({
    queue: 'neo.front',
    payload: { conversationId, messageId: textId },
  });
  await wait(() => queue.getJob(repeated.id)?.status === 'completed');
  assert.equal(calls.length, 1);
  assert.equal(publications.list(conversationId)?.length, 1);
  assert.equal(
    (await invoke<{ ok: boolean }>('neo.speech.listen', { sessionId, enabled: true, audio: true }))
      .ok,
    true
  );
  const voiceId = await send('Hello by voice', 'live_voice');
  await wait(() => events.some((event) => event.type === 'end'));
  assert(events.some((event) => event.type === 'audio'));
  const spoken = events.find((event) => event.type === 'say')!;
  assert.equal(spoken.text, 'Hello from the front.');
  for (const state of ['playing', 'played'])
    assert.equal(
      (await invoke<{ ok: boolean }>('neo.speech.ack', { sessionId, id: spoken.id, state })).ok,
      true
    );
  const retryVoice = queue.enqueue({
    queue: 'neo.front',
    payload: { conversationId, messageId: voiceId },
  });
  await wait(() => queue.getJob(retryVoice.id)?.status === 'completed');
  assert.equal(events.filter((event) => event.type === 'say').length, 1);
  await invoke('neo.speech.listen', { sessionId, enabled: false });
  app.db
    .getDatabase()
    .prepare(
      "INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES ('ask-fixture',?,'Fixture','Fixture','open',1,1)"
    )
    .run(sessionId);
  app.db
    .getDatabase()
    .prepare(
      "INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES ('todo-fixture','ask-fixture',0,'Fixture','Done','done',1,1)"
    )
    .run();
  const statusId = await send('What is the fixture status?');
  await wait(() => (publications.list(conversationId)?.length ?? 0) === 3);
  const actionId = await send('Book the appointment');
  await wait(() => (publications.list(conversationId)?.length ?? 0) === 4);
  const visible = await invoke<{
    ok: boolean;
    items: Array<{ fullText: string; replyTo?: string[] }>;
  }>('neo.publication.read', { conversationId, limit: 100 });
  assert(visible.ok);
  assert.deepEqual(
    visible.items.map((item) => item.fullText),
    ['Hello from the front.', 'Hello from the front.', 'The fixture todo is done.', 'Let me check.']
  );
  assert.deepEqual(
    visible.items.map((item) => item.replyTo?.[0]),
    [textId, voiceId, statusId, actionId]
  );
  for (const id of [off, textId, voiceId, statusId, actionId])
    assert.equal(
      app.db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(sessionId, [id]).length,
      1
    );
  assert.equal(
    (
      app.db
        .getDatabase()
        .prepare('SELECT COUNT(*) AS n FROM neo_front_inputs WHERE owner IS NOT NULL')
        .get() as { n: number }
    ).n,
    0
  );
  await invoke('neo.front.set', { enabled: false });
  const frontId = nativeIds[0];
  assert.equal(new Set(nativeIds).size, 1);
  assert.equal(app.db.getSession(frontId)?.title, 'Convo');
  assert.equal(app.db.getSession(frontId)?.sdkSessionId, frontId);
  assert.equal(app.db.getSession(frontId)?.metadata.executionProjectPath, app.db.getSession(sessionId)?.workspacePath);
  assert.equal(app.db.getSession(frontId)?.workspacePath, run);
  assert.equal(app.db.getSDKMessageRepo().getUserMessages(frontId).length, 4);
  assert.equal((app.db.getDatabase().prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='assistant'").get(frontId) as {n:number}).n, 4);
  assert.equal((app.db.getDatabase().prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='result' AND is_terminal=1").get(frontId) as {n:number}).n, 4);
  observed.frontSession = { turns: 4, resumedNativeSessions: new Set(nativeIds).size, visibleReplies: 4 };
  observed.textReplies = 4;
  observed.voiceSay = events.filter((event) => event.type === 'say').length;
  observed.audioChunks = events.filter((event) => event.type === 'audio').length;
  observed.coordinatorInputs = 5;
  observed.modelCalls = calls.length;
  observed.switchOff = true;
  observed.passed = true;
} finally {
  await transport.close();
  await app.cleanup();
  audio.stop(true);
  globalThis.fetch = network;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
}
console.log(JSON.stringify(observed));
