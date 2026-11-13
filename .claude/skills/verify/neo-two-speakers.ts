import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { frontSessionId } from '../../../packages/daemon/src/lib/neo/front-mode.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { KimiProvider } from '../../../packages/daemon/src/lib/providers/kimi-provider.ts';
import type { Job } from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import type { UUID } from 'node:crypto';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const name of ['workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  createSocket: createLocalSocket,
  autoReconnect: false,
});
hub.registerTransport(transport);
const observed: Record<string, unknown> = { head: process.argv[2], passed: false };
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.jobProcessor.stop();
  await transport.initialize();
  const model = KimiProvider.MODELS.find((entry) => entry.contextWindow >= 1_000_000)!;
  setModelsCache(new Map([['global', [model]]]));
  const preference = { provider: 'kimi', model: model.id, thinkingLevel: 'off' as const };
  const conversationId = crypto.randomUUID();
  const root = `neo:${conversationId}`;
  await app.db.createSession({
    id: root,
    title: 'Synthetic Neo',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { ...preference, queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  new NeoRepository(app.db.getDatabase()).reserveBinding({
    sessionId: root,
    kind: 'neo',
    projectId: null,
  });
  await app.db.updateGlobalSettings({
    neo: { preferences: preference, front: { enabled: false, model: preference } },
  });
  const invoke = <T>(name: string, input: unknown) =>
    hub.request<T>('operation.invoke', { name, input });
  const front = frontSessionId(conversationId);
  const queue = app.db.getJobQueueRepo();
  const handler = (
    app.jobProcessor as unknown as { handlers: Map<string, { handler: (job: Job) => unknown }> }
  ).handlers.get('neo.front')!.handler;
  const send = async (requestId: string, content: string) => {
    assert.equal((await invoke<{ ok: boolean }>('neo.message.send', {
      sessionId: root,
      requestId,
      content,
    })).ok, true);
    const job = queue.listJobs({ queue: 'neo.front' }).find((row) => row.payload.messageId === requestId)!;
    await handler(job);
    return job;
  };
  const owner = (messageId: string) =>
    (
      app.db
        .getDatabase()
        .prepare('SELECT owner FROM neo_front_inputs WHERE conversation_id = ? AND message_id = ?')
        .get(conversationId, messageId) as { owner: string | null }
    ).owner;
  assert.equal((await invoke<{ ok: boolean }>('neo.front.set', { enabled: true })).ok, true);
  const id = crypto.randomUUID();
  const job = await send(id, 'Check the build and tell me.');
  const convo = app.sessionManager.getCachedSession(front) ?? (await app.sessionManager.getSessionForControl(front));
  assert(convo);
  const tools = (
    convo.getSessionData().config.mcpServers as Record<
      string,
      { instance: { _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> }> } }
    >
  ).front.instance._registeredTools;
  const call = async (name: string, input: unknown) =>
    JSON.parse((await tools[name].handler(input, {})).content[0].text);
  await app.db.saveUserMessage(
    front,
    { type: 'user', uuid: id as UUID, session_id: front, parent_tool_use_id: null, message: { role: 'user', content: 'Check the build and tell me.' } },
    'submitted'
  );
  const handoff = await call('reply', { requestId: 'ack', replyTo: [id], text: 'I will check the build.' });
  assert.equal(handoff.accepted, true, JSON.stringify(handoff));
  assert.equal(handoff.started, true, JSON.stringify(handoff));
  assert.equal(owner(id), 'neo');
  assert.equal(app.db.getSDKMessageRepo().getDeliveryMessageIdsByUuids(root, [id]).length, 1);
  const delivered = JSON.stringify(app.db.getSDKMessageRepo().getMessageByUuid(root, id));
  assert(delivered.includes('<already-said>') && delivered.includes('I will check the build.'), delivered);
  const again = await call('reply', { requestId: 'work-2', replyTo: [id], text: 'Checking.' });
  assert.equal(again.accepted, true, JSON.stringify(again));
  assert.equal(again.started, true, JSON.stringify(again));
  const frontFinal = await call('reply', { requestId: 'final', replyTo: [id], text: 'The build passed.' });
  assert.equal(frontFinal.accepted, true, JSON.stringify(frontFinal));
  assert(app.db.getSDKMessageRepo().markDeliveryConsumedByUuid(root, id));
  const back = createOperationMcpHandler(app.sessionManager.getOperationRegistry(), () => ({
    source: 'mcp',
    role: 'neo',
    sessionId: root,
  }));
  const published = await back({
    name: 'neo.publication.publish',
    input: { requestId: 'neo-answer', text: 'The build passed on dev.', replyTo: [id] },
  });
  const receipt = JSON.parse((published.content[0] as { text: string }).text);
  assert.equal(receipt.accepted, true, JSON.stringify(receipt));
  const rows = app.db
    .getDatabase()
    .prepare('SELECT payload_json AS payload FROM neo_publications WHERE conversation_id = ? ORDER BY sequence')
    .all(conversationId)
    .map((row) => JSON.parse((row as { payload: string }).payload) as { fullText: string; replyTo?: string[]; publishedBy?: string });
  const answer = rows.find((row) => row.fullText === 'The build passed on dev.');
  assert.deepEqual(answer?.replyTo, [id]);
  assert.equal(answer?.publishedBy, 'neo');
  const spoken = await back({ name: 'neo.speech.say', input: { requestId: 'neo-speech', text: 'The build passed.' } });
  const speech = JSON.parse((spoken.content[0] as { text: string }).text);
  assert.notEqual(speech.reason, 'neo_speech_not_available', JSON.stringify(speech));
  const settled = await handler(job);
  assert.deepEqual(settled, { delivered: true, outcome: 'handed_off' });
  Object.assign(observed, {
    passed: true,
    port: app.server.port,
    frontId: front,
    handoff,
    alreadySaid: delivered.includes('<already-said>'),
    secondHandoff: again,
    frontFinal,
    neoPublish: receipt,
    neoAnswer: answer,
    neoSpeech: speech,
    settled,
    owner: owner(id),
    publications: rows.map((row) => ({ text: row.fullText, replyTo: row.replyTo ?? [], publishedBy: row.publishedBy ?? null })),
  });
} finally {
  hub.cleanup();
  await transport.close();
  await app.cleanup();
  observed.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
}
console.log(JSON.stringify(observed));
