import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { frontSessionId } from '../../../packages/daemon/src/lib/neo/front-mode.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { KimiProvider } from '../../../packages/daemon/src/lib/providers/kimi-provider.ts';
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
  const repo = new NeoRepository(app.db.getDatabase());
  repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  assert.equal(repo.conversationId(), conversationId);
  await app.db.updateGlobalSettings({
    neo: { preferences: preference, front: { enabled: false, model: preference } },
  });
  const invoke = <T>(name: string, input: unknown) =>
    hub.request<T>('operation.invoke', { name, input });
  const enabled = await invoke<{ ok: boolean }>('neo.front.set', { enabled: true });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  const id = frontSessionId(conversationId);
  const front = app.db.getSession(id);
  assert(front);
  assert(existsSync(front.workspacePath));
  assert.deepEqual(front.config.toolSelection, { version: 1, choices: {} });
  assert(front.config.disallowedTools?.includes('mcp__exa'));
  const intake = await invoke<{ ok: boolean }>('neo.message.send', {
    sessionId: root,
    requestId: crypto.randomUUID(),
    content: 'Check the synthetic status.',
  });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  assert.equal(app.db.getJobQueueRepo().listJobs({ queue: 'neo.front' }).length, 1);
  assert.equal((await invoke<{ ok: boolean }>('neo.front.set', { enabled: true })).ok, true);
  assert.equal(app.db.getSession(id)?.createdAt, front.createdAt);
  Object.assign(observed, { passed: true, port: app.server.port, enabled, intake, frontId: id });
} finally {
  hub.cleanup();
  await transport.close();
  await app.cleanup();
  observed.resourcesClosed = true;
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
}
console.log(JSON.stringify(observed));
