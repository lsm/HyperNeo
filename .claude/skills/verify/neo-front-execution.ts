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
import { neoIntakeMessage } from '../../../packages/daemon/src/lib/neo/intake.ts';
import { NeoFrontInputRepository } from '../../../packages/daemon/src/storage/repositories/neo-front-input-worker.ts';
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
const handoffId = crypto.randomUUID();
const failedDeliveryId = crypto.randomUUID();
const requests: string[] = [];
const stages = new Map<string, number>();
let exaRequests = 0;
const model = KimiProvider.MODELS.find((entry) => entry.contextWindow >= 1_000_000)!;
const fixture = createServer(async (request, response) => {
  if (request.url === '/exa-probe') {
    exaRequests++;
    response.writeHead(404).end();
    return;
  }
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
    (tool: { name: string }) => tool.name === 'mcp__front__work_on'
  );
  if (!front && app?.db.getGlobalSettings().neo?.front?.enabled === true) {
    const names = body.tools?.map((tool: { name: string }) => tool.name) ?? [];
    assert(names.some((name: string) => name.endsWith('__neo_publish')));
    assert(names.some((name: string) => name.endsWith('__neo_speech')));
    evidence.neoToolsPresent = true;
  }
  const history = JSON.stringify(body.messages);
  const active = [failedDeliveryId, handoffId, humanId].find(id => history.includes(id)) ?? humanId;
  const stage = stages.get(active) ?? 0;
  let block: Record<string, unknown> = { type: 'text', text: front ? 'Hello from Neo.' : 'Internal assistant text.' };
  if (front && stage === 0) {
    block = { type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: 'mcp__front__reply_short',
      input: { requestId: `ack-${active}`, replyTo: [active], progress: true, text: 'I will handle that.' } };
    stages.set(active, 1);
  } else if (front && active === handoffId && stage === 1) {
    block = { type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: 'mcp__front__work_on',
      input: { requestId: 'work-proof', messageIds: [handoffId] } };
    stages.set(active, 2);
  } else if (front && active === humanId && stage === 1) {
    block = { type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: 'mcp__front__reply_short',
      input: { requestId: `final-${active}`, replyTo: [active], text: 'Hello from Neo.' } };
    stages.set(active, 4);
  }
  const publish = block.type === 'tool_use';
  requests.push(front ? String(block.name ?? 'front-terminal') : 'neo-turn');
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
  assert.equal(options.mcpServers?.exa, undefined);
  return {
    ...options,
    ...(process.env.VERIFY_CLAUDE
      ? { pathToClaudeCodeExecutable: process.env.VERIFY_CLAUDE, executable: undefined }
      : {}),
  };
};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let hub: MessageHub | undefined;
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
  hub = new MessageHub({ defaultSessionId: 'global', timeout: 30_000 });
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
      ?.filter((row) =>
        row.replyTo?.includes(humanId) ||
        row.replyTo?.includes(handoffId) ||
        row.fullText === 'Single-mode reply.'
      ) ??
    [];
  const invoke = <T>(name: string, input: unknown) =>
    hub!.request<T>('operation.invoke', { name, input });
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
  const convo = await app.sessionManager.getSessionForControl(front);
  assert(convo);
  convo.mergeRuntimeMcpServers({
    exa: { type: 'http', url: `http://127.0.0.1:${port}/exa-probe` },
  });
  assert(convo.getSessionData().config.mcpServers?.exa);
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
  assert.equal(
    (await invoke<{ ok: boolean }>('neo.message.send', {
      sessionId: root,
      requestId: handoffId,
      content: 'Delegate this action to Neo.',
    })).ok,
    true
  );
  await waitFor(() => !!app!.db.getSDKMessageRepo().getMessageByStatusAndUuid(root, 'consumed', handoffId));
  await waitFor(() => app!.sessionManager.getCachedSession(root)?.getProcessingState().status === 'idle');
  const publish = async (requestId: string, replyTo: string[], fullText: string) => {
    const result = await back({
      name: 'neo.publication.publish',
      input: { requestId, verbatim: true, fullText, replyTo },
    });
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  assert.equal(new NeoFrontInputRepository(app.db.getDatabase()).get(conversationId, handoffId)?.owner, 'neo');
  const answer = await publish('neo-answer', [handoffId], 'The job is complete. All files were copied and their checksums match.');
  assert.equal(answer.accepted, true, JSON.stringify(answer));
  const later = await publish('neo-later', [handoffId], 'The review is complete. Here is the later result.');
  assert.equal(later.accepted, true, JSON.stringify(later));
  assert.equal(replies().filter(row => row.replyTo?.includes(handoffId)).length, 2);
  assert(replies().filter(row => row.replyTo?.includes(handoffId)).every(row => row.publishedBy === 'neo'));
  evidence.neoPublishedDirectly = true;
  evidence.multipleRepliesAccepted = true;
  await waitFor(() => app!.sessionManager.getCachedSession(front)?.getProcessingState().status === 'idle');
  await app.db.saveUserMessage(
    root,
    neoIntakeMessage({ sessionId: root, requestId: failedDeliveryId, content: 'Queued handoff' }),
    'deferred'
  );
  assert.equal((await invoke<{ ok: boolean }>('neo.message.send', {
    sessionId: root,
    requestId: failedDeliveryId,
    content: 'Queued handoff',
  })).ok, true);
  const outcomes = new NeoFrontInputRepository(app.db.getDatabase());
  await waitFor(() => !!outcomes.terminal(conversationId, front, failedDeliveryId));
  const failedJob = () => app!.db.getJobQueueRepo().listJobs({ queue: 'neo.front' })
    .find((job) => job.payload.messageId === failedDeliveryId);
  assert(['pending', 'processing'].includes(failedJob()?.status ?? ''));
  assert.equal(publications.list(conversationId)?.some((row) => row.replyTo?.includes(failedDeliveryId)), false);
  assert.equal(app.db.getSDKMessageRepo().getUserSendStatus(root, failedDeliveryId), 'deferred');
  assert(app.db.getSDKMessageRepo().markDeliveryFailedByUuid(root, failedDeliveryId));
  await waitFor(() => failedJob()?.status === 'completed');
  assert.deepEqual(failedJob()?.result, { delivered: true, outcome: 'answered' });
  assert.equal(publications.list(conversationId)!.some((row) => row.replyTo?.includes(failedDeliveryId)), false);
  evidence.queuedThenFailedSettled = failedJob()?.result;
  assert.equal((await invoke<{ ok: boolean }>('neo.front.set', { enabled: false })).ok, true);
  assert.equal((await publish('single-mode', [], 'Single-mode reply.')).accepted, true);
  const rows = replies();
  assert.deepEqual(rows.map((row) => row.fullText), [
    'Hello from Neo.', 'The job is complete. All files were copied and their checksums match.',
    'The review is complete. Here is the later result.', 'Single-mode reply.',
  ]);
  assert.equal(rows.filter((row) => row.replyTo?.includes(humanId)).length, 1);
  assert.equal(rows.filter((row) => row.replyTo?.includes(handoffId)).length, 2);
  assert.deepEqual(rows[0].replyTo, [humanId]);
  assert.equal(rows[0].verbatim, true);
  assert(new NeoFrontInputRepository(app.db.getDatabase()).get(conversationId, humanId)?.owner);
  evidence.humanAnswered = true;
  assert.deepEqual(rows[1].replyTo, [handoffId]);
  assert.equal(app.db.getSession(front)?.sdkSessionId, nativeId);
  assert(childSessions.has(front));
  assert(app.db.getSDKMessageRepo().getSDKMessages(front).messages.length > 0);
  assert.equal(exaRequests, 0);
  evidence.configuredExaExcluded = true;
  evidence.exaRequests = exaRequests;
  assert.equal(evidence.neoToolsPresent, true);
  evidence.passed = true;
  evidence.nativeFrontSession = nativeId;
  evidence.replies = rows.map((row) => ({ text: row.fullText, replyTo: row.replyTo, producerInput: row.producerInput }));
  evidence.requests = requests;
  evidence.normalSession = true;
  evidence.modeSwitchPreservedSession = true;
} finally {
  await transport?.close();
  hub?.cleanup();
  await app?.cleanup();
  for (const id of childSessions) releaseSessionKeyBridges(id);
  QueryOptionsBuilder.prototype.build = originalBuild;
  fixture.closeAllConnections();
  await new Promise<void>((done) => fixture.close(() => done()));
  evidence.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/neo-front-execution.json'), JSON.stringify(evidence, null, 2));
}
console.log(
  'PASS ordinary front session, terminal reply, work_on hand-off and direct Neo updates per human input'
);
