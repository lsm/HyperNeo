import { strict as assert } from 'node:assert';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MessageHub,
  WebSocketClientTransport,
  type ModelInfo,
} from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'data'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
copyFileSync(new URL('./gh-stub.sh', import.meta.url), join(run, 'bin/gh'));
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const fallback = {
  model: 'fixture-fallback',
  provider: 'glm' as const,
  thinkingLevel: 'think8k' as const,
};
const primary = {
  model: 'fixture-primary',
  provider: 'anthropic',
  thinkingLevel: 'think24k' as const,
};
const models = [fallback, primary].map((m) => ({
  id: m.model,
  name: m.model,
  provider: m.provider,
  available: true,
  thinkingModes: 'granular',
  effortLevels: ['low', 'medium', 'high'],
})) as ModelInfo[];
const app = await createDaemonApp({
  config: {
    ...getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: run,
    }),
    disableGoalProcessing: true,
    disableWorktrees: true,
  },
  verbose: false,
});
const evidence: Record<string, unknown> = {};
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
});
try {
  assert.notEqual(app.server.port, 8399);
  app.settingsManager.updateGlobalSettings({ neo: { preferences: fallback } });
  setModelsCache(new Map([['global', models]]));
  hub.registerTransport(transport);
  await transport.initialize();
  const call = (name: string, input: unknown = {}) =>
    hub.request<Record<string, unknown>>('operation.invoke', { name, input });
  const opened = await call('neo.open');
  const sessionId = String(opened.sessionId);
  const live = await app.sessionManager.getSessionForControl(sessionId);
  assert(live);
  const pair = () => {
    const { model, provider, thinkingLevel } = app.db.getSession(sessionId)!.config;
    return { model, provider, thinkingLevel };
  };
  assert.deepEqual(pair(), fallback);
  await live.stateManager.setProcessing('synthetic-busy-state');
  evidence.busyState = live.getProcessingState();
  evidence.preferenceReply = await call('neo.preferences.set', primary);
  assert.equal(evidence.preferenceReply && (evidence.preferenceReply as { ok: boolean }).ok, true);
  evidence.pending = live.getSessionData().metadata?.pendingModelSwitch;
  assert.equal((evidence.pending as { model: string }).model, primary.model);
  evidence.whilePending = pair();
  assert.deepEqual(evidence.whilePending, fallback);
  assert.deepEqual(
    {
      model: live.getSessionData().config.model,
      provider: live.getSessionData().config.provider,
      thinkingLevel: live.getSessionData().config.thinkingLevel,
    },
    fallback
  );
  setModelsCache(new Map([['global', models.filter((m) => m.provider === 'glm')]]));
  await live.stateManager.setIdle();
  evidence.afterLateRefusal = pair();
  evidence.remainingPending = live.getSessionData().metadata?.pendingModelSwitch ?? null;
  assert.deepEqual(evidence.afterLateRefusal, fallback);
  assert.equal(evidence.remainingPending, null);
  setModelsCache(new Map([['global', models]]));
  evidence.retryReply = await call('neo.preferences.set', primary);
  evidence.afterSuccessfulRetry = pair();
  assert.deepEqual(evidence.afterSuccessfulRetry, primary);
  evidence.saved = app.db.getGlobalSettings().neo?.preferences;
  assert.deepEqual(evidence.saved, primary);
  evidence.health = await hub.request('system.health', {});
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  writeFileSync(join(run, 'observed.json'), JSON.stringify(evidence, null, 2));
  await transport.close();
  await app.cleanup();
  setModelsCache(new Map());
}
