import { releaseSessionKeyBridges } from '../../../packages/daemon/src/lib/providers/provider-key-bridge.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { KimiProvider } from '../../../packages/daemon/src/lib/providers/kimi-provider.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { frontSessionId } from '../../../packages/daemon/src/lib/neo/front-mode.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const name of ['workspace', 'bin', 'evidence', 'sdk'])
  mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.CLAUDE_CONFIG_DIR = join(run, 'sdk');
process.env.TEST_SDK_SESSION_DIR = join(run, 'sdk');
const humanId = crypto.randomUUID();
const requests: string[] = [];
const model = KimiProvider.MODELS.find((entry) => entry.contextWindow >= 1_000_000)!;
const fixture = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  if (request.url?.includes('count_tokens')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: model.id }] }));
    return;
  }
  const body = JSON.parse(raw);
  const last = body.messages?.at(-1);
  const content = JSON.stringify(last?.content ?? '');
  const front = body.tools?.some(
    (tool: { name: string }) => tool.name === 'mcp__front__publication_publish'
  );
  const backResult = content.includes('BACK_RESULT_PROOF');
  const publish =
    front && !content.includes('tool_result') && (content.includes('Human message') || backResult);
  requests.push(publish ? (backResult ? 'front-result-tool' : 'front-chat-tool') : 'internal-text');
  const block = publish
    ? {
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID()}`,
        name: 'mcp__front__publication_publish',
        input: {
          requestId: backResult ? 'result-proof' : 'chat-proof',
          verbatim: true,
          fullText: backResult ? 'The job is complete.' : 'Hello from Neo.',
          replyTo: [humanId],
        },
      }
    : { type: 'text', text: 'Internal assistant text.' };
  const message = {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [block],
    stop_reason: publish ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
  if (!body.stream) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(message));
    return;
  }
  response.setHeader('content-type', 'text/event-stream');
  const emit = (event: string, data: unknown) =>
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null },
  });
  emit('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: publish ? { ...block, input: {} } : { type: 'text', text: '' },
  });
  emit('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: publish
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text },
  });
  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  emit('message_stop', { type: 'message_stop' });
  response.end();
});
await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
const port = (fixture.address() as { port: number }).port;
assert(![8399, 8499].includes(port));
const originalBuild = QueryOptionsBuilder.prototype.build;
const childSessions = new Set<string>();
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await originalBuild.apply(this, args);
  childSessions.add(options.env?.HYPERNEO_SESSION_ID!);
  return {
    ...options,
    ...(process.env.VERIFY_CLAUDE
      ? { pathToClaudeCodeExecutable: process.env.VERIFY_CLAUDE, executable: undefined }
      : {}),
  };
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
const evidence: Record<string, unknown> = {};
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 90_000;
  while (!check() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  assert(check(), 'condition did not complete');
}
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({
        port: 0,
        host: '127.0.0.1',
        dbPath: join(run, 'data/daemon.db'),
        workspaceRoot: join(run, 'workspace'),
      }),
      disableWorktrees: true,
    },
    verbose: false,
  });
  const hub = new MessageHub({ defaultSessionId: 'global', timeout: 30_000 });
  transport = new WebSocketClientTransport({
    createSocket: createLocalSocket,
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
  });
  hub.registerTransport(transport);
  await transport.initialize();
  const registry = await hub.request<{ servers: { id: string; enabled: boolean }[] }>(
    'mcp.registry.list',
    {}
  );
  for (const server of registry.servers)
    if (server.enabled)
      await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  getProviderRegistry().unregister('kimi');
  getProviderRegistry().register(
    new KimiProvider(
      { KIMI_BASE_URL: `http://127.0.0.1:${port}`, KIMI_API_KEY: 'synthetic-loopback-only' },
      undefined,
      async () => new Response(JSON.stringify({ data: [{ id: model.id }] }))
    )
  );
  setModelsCache(new Map([['global', [model]]]));
  const conversationId = crypto.randomUUID();
  const root = `neo:${conversationId}`;
  const front = frontSessionId(conversationId);
  await app.db.createSession({
    id: root,
    title: 'Synthetic Neo',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { provider: 'kimi', model: model.id, queryMode: 'manual', thinkingLevel: 'off' },
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
  repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  assert.equal(repo.conversationId(), conversationId);
  const publications = new NeoPublicationRepository(app.db.getDatabase());
  const replies = () =>
    publications
      .list(conversationId)
      ?.filter((row) => row.replyTo?.includes(humanId) || row.fullText === 'Single-mode reply.') ??
    [];
  const invoke = <T>(name: string, input: unknown) =>
    hub.request<T>('operation.invoke', { name, input });
  assert.equal(
    (
      await invoke<{ ok: boolean }>('neo.front.model.set', {
        provider: 'kimi',
        model: model.id,
        thinkingLevel: 'off',
      })
    ).ok,
    true
  );
  assert.equal((await invoke<{ ok: boolean }>('neo.front.set', { enabled: true })).ok, true);
  assert.equal(app.db.getSession(front)?.config.queryMode, 'immediate');
  assert.equal(
    (
      await invoke<{ ok: boolean }>('neo.message.send', {
        sessionId: root,
        requestId: humanId,
        content: 'Hello from the human',
      })
    ).ok,
    true
  );
  await waitFor(() => replies().length === 1);
  await waitFor(
    () => app!.sessionManager.getCachedSession(front)?.getProcessingState().status === 'idle'
  );
  const nativeId = app.db.getSession(front)?.sdkSessionId;
  assert(nativeId);
  const back = createOperationMcpHandler(app.sessionManager.getOperationRegistry(), () => ({
    source: 'mcp',
    role: 'neo',
    sessionId: root,
  }));
  const rejected = await back({
    name: 'neo.publication.publish',
    input: { requestId: 'back-direct', verbatim: true, fullText: 'Back must be refused.' },
  });
  assert(JSON.stringify(rejected).includes('dual_model_front_required'));
  const forwarded = await back({
    name: 'message.send',
    input: {
      to: front,
      text: `BACK_RESULT_PROOF for human message ${humanId}: the job is complete.`,
      idempotencyKey: 'back-result-proof',
    },
  });
  assert(JSON.stringify(forwarded).includes('accepted'));
  await waitFor(() => replies().length === 2);
  await back({
    name: 'message.send',
    input: {
      to: front,
      text: `BACK_RESULT_PROOF for human message ${humanId}: the job is complete.`,
      idempotencyKey: 'back-result-proof',
    },
  });
  await waitFor(
    () => app!.sessionManager.getCachedSession(front)?.getProcessingState().status === 'idle'
  );
  assert.equal((await invoke<{ ok: boolean }>('neo.front.set', { enabled: false })).ok, true);
  const restored = await back({
    name: 'neo.publication.publish',
    input: { requestId: 'single-mode', verbatim: true, fullText: 'Single-mode reply.' },
  });
  const restoredValue = JSON.parse((restored.content[0] as { text: string }).text);
  assert.equal(restoredValue.accepted, true, JSON.stringify(restoredValue));
  const rows = replies();
  assert.deepEqual(
    rows.map((row) => row.fullText),
    ['Hello from Neo.', 'The job is complete.', 'Single-mode reply.']
  );
  assert.deepEqual(rows[0].replyTo, [humanId]);
  assert.deepEqual(rows[1].replyTo, [humanId]);
  assert.equal(app.db.getSession(front)?.sdkSessionId, nativeId);
  assert(childSessions.has(front));
  assert(app.db.getSDKMessageRepo().getSDKMessages(front).messages.length > 0);
  evidence.passed = true;
  evidence.nativeFrontSession = nativeId;
  evidence.replies = rows.map((row) => ({ text: row.fullText, replyTo: row.replyTo }));
  evidence.requests = requests;
  evidence.normalSession = true;
  evidence.modeSwitchPreservedSession = true;
} finally {
  transport?.close();
  await app?.cleanup();
  for (const id of childSessions) releaseSessionKeyBridges(id);
  QueryOptionsBuilder.prototype.build = originalBuild;
  fixture.closeAllConnections();
  await new Promise<void>((done) => fixture.close(() => done()));
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/neo-front-execution.json'), JSON.stringify(evidence, null, 2));
}
console.log(
  'PASS ordinary Front session, tool-only publication, Back handoff, mode gate and session continuity'
);
