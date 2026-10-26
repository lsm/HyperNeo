import { strict as assert } from 'node:assert';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport, type ModelInfo } from '../../../packages/shared/src/mod.ts';
import type { Query, SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { getSessionContextModelInfo, setModelsCache } from '../../../packages/daemon/src/lib/model-service.ts';
import { AnthropicProvider } from '../../../packages/daemon/src/lib/providers/anthropic-provider.ts';
import { getProviderRegistry } from '../../../packages/daemon/src/lib/providers/registry.ts';
import { ContextFetcher } from '../../../packages/daemon/src/lib/agent/context-fetcher.ts';
import { buildProviderSettings } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { enforceContextBudget } from '../../../packages/daemon/src/lib/agent/context-budget-enforcement.ts';
import { Logger } from '../../../packages/daemon/src/lib/logger.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['data', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync(new URL('./gh-stub.sh', import.meta.url), join(run, 'bin/gh'));
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const preference = { model: 'fixture-million', provider: 'anthropic', thinkingLevel: 'off' };
const model = { id: preference.model, name: 'Synthetic million', provider: preference.provider, available: true, contextWindow: 1_000_000, autoCompactPercent: 80 } as ModelInfo;
const config = { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableGoalProcessing: true, disableWorktrees: true };
let app = await createDaemonApp({ config, verbose: false });
const evidence: Record<string, unknown> = {};
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
try {
  assert.notEqual(app.server.port, 8399);
  setModelsCache(new Map([['global', [model]]]));
  hub.registerTransport(transport); await transport.initialize();
  const call = (name: string, input: unknown = {}) => hub.request<Record<string, unknown>>('operation.invoke', { name, input });
  evidence.legacySave = await call('neo.preferences.set', preference);
  const opened = await call('neo.open');
  const sessionId = String(opened.sessionId);
  const live = await app.sessionManager.getSessionForControl(sessionId); assert(live);
  const info = () => getSessionContextModelInfo(live.getSessionData());
  assert.equal((await info())?.autoCompactPercent, 80);
  await live.stateManager.setProcessing('synthetic-busy-state');
  evidence.savedWhileBusy = await call('neo.preferences.set', { ...preference, autoCompactPercent: 70 });
  evidence.busyMetadata = await info();
  assert.equal((await info())?.autoCompactPercent, 80);
  await live.stateManager.setIdle();
  evidence.idleMetadata = await info();
  assert.equal((await info())?.autoCompactPercent, 70);
  evidence.snapshot = await call('neo.snapshot');
  assert.equal((evidence.snapshot as { preferences: { autoCompactPercent: number } }).preferences.autoCompactPercent, 70);
  getProviderRegistry().register(new AnthropicProvider({}));
  const sdkOptions = await live.optionsBuilder.build();
  evidence.builtSdkWindow = sdkOptions.settings?.autoCompactWindow;
  evidence.builtSdkEnvWindow = sdkOptions.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  assert.equal(evidence.builtSdkWindow, 733_000);
  assert.equal(evidence.builtSdkEnvWindow, '733000');
  const sdkUsage = { model: model.id, totalTokens: 710_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: 71, categories: [{ name: 'Autocompact buffer', tokens: 33_000 }], memoryFiles: [], mcpTools: [], agents: [], gridRows: [], apiUsage: null, isAutoCompactEnabled: true, autoCompactThreshold: 900_000 } as SDKControlGetContextUsageResponse;
  evidence.context = await new ContextFetcher(sessionId).fetch({ getContextUsage: async () => sdkUsage } as unknown as Query, await info());
  assert.equal((evidence.context as { autoCompactThreshold: number }).autoCompactThreshold, 700_000);
  evidence.sdkSettings = buildProviderSettings('anthropic', 1_000_000, model.id, (await info())?.autoCompactPercent, (await info())?.autoCompactPercentOverride);
  assert.equal((evidence.sdkSettings as { autoCompactWindow: number }).autoCompactWindow, 733_000);
  const context = evidence.context as NonNullable<ReturnType<typeof live.getContextInfo>>;
  const budget = { sessionId, providerId: 'anthropic', reason: 'model-switch' as const, contextInfo: context, fallbackContextWindow: 1_000_000, clearedDeadCompaction: false, limitRecoveryPending: false, contextTracker: live.contextTracker, messageQueue: live.messageQueue, stateManager: live.stateManager, logger: new Logger('NeoCompactProof') };
  evidence.belowBudget = enforceContextBudget({ ...budget, contextInfo: { ...context, totalUsed: 699_999 } }).compactionEnqueued;
  assert.equal(evidence.belowBudget, false);
  evidence.atBudget = enforceContextBudget({ ...budget, contextInfo: { ...context, totalUsed: 700_000 } }).compactionEnqueued;
  assert.equal(evidence.atBudget, true);
  assert.equal(live.messageQueue.hasOutstandingInternalCompaction(), true);
  evidence.actualCompactionPending = live.messageQueue.hasOutstandingInternalCompaction();
  assert.equal(buildProviderSettings('anthropic', 1_000_000, model.id, 80), undefined);
  const ordinary = await app.sessionManager.createSession({ workspacePath: run, config: preference });
  const ordinaryLive = await app.sessionManager.getSessionForControl(ordinary); assert(ordinaryLive);
  await ordinaryLive.stateManager.setIdle();
  assert.equal((await ordinaryLive.optionsBuilder.build()).settings?.autoCompactWindow, undefined);
  evidence.ordinaryMetadata = await getSessionContextModelInfo(ordinaryLive.getSessionData());
  assert.equal((evidence.ordinaryMetadata as ModelInfo).autoCompactPercent, 80);
  await ordinaryLive.stateManager.setProcessing('ordinary-busy-setting');
  await hub.request('session.update', { sessionId: ordinary, config: { autoCompactPercent: 70 } });
  assert.equal((await getSessionContextModelInfo(ordinaryLive.getSessionData()))?.autoCompactPercent, 80);
  await ordinaryLive.stateManager.setIdle();
  const ordinaryInfo = await getSessionContextModelInfo(ordinaryLive.getSessionData());
  assert.equal(ordinaryInfo?.autoCompactPercent, 70);
  assert.equal((await ordinaryLive.optionsBuilder.build()).settings?.autoCompactWindow, 733_000);
  const ordinaryContext = await new ContextFetcher(ordinary).fetch({ getContextUsage: async () => sdkUsage } as unknown as Query, ordinaryInfo);
  assert.equal(ordinaryContext?.autoCompactThreshold, 700_000);
  evidence.ordinaryExplicit = { info: ordinaryInfo, threshold: ordinaryContext?.autoCompactThreshold };

  const small = { id: 'fixture-small', name: 'Synthetic small', provider: 'anthropic', available: true, contextWindow: 200_000, autoCompactPercent: 80 } as ModelInfo;
  setModelsCache(new Map([['global', [model, small]]]));
  await live.stateManager.setProcessing('model-switch-pending-save');
  evidence.pendingSwitchSave = await call('neo.preferences.set', {
    model: small.id,
    provider: 'anthropic',
    thinkingLevel: 'off',
    fallbacks: [{ model: model.id, provider: 'anthropic', thinkingLevel: 'off', autoCompactPercent: 70 }],
  });
  evidence.whileSwitchPending = {
    model: live.getSessionData().config.model,
    percent: (await info())?.autoCompactPercent,
  };
  assert.equal(live.getSessionData().config.model, model.id);
  assert.equal((await info())?.autoCompactPercent, 70);
  await live.stateManager.setIdle();
  evidence.afterSwitchLanded = {
    model: live.getSessionData().config.model,
    percent: (await info())?.autoCompactPercent,
    pending: live.getSessionData().metadata.pendingAutoCompactPercent,
  };
  assert.equal(live.getSessionData().config.model, small.id);
  assert.equal((await info())?.autoCompactPercent, 80);
  assert.equal(live.getSessionData().metadata.pendingAutoCompactPercent, undefined);

  const repo = new NeoRepository(app.db.getDatabase());
  const project = 'synthetic-project';
  repo.saveProject({ id: project, title: 'Synthetic project', summary: '', context: '' }, 0);
  const projectOpened = await call('neo.open', { projectId: project });
  assert.equal(projectOpened.sessionId, sessionId);
  evidence.projectSession = projectOpened.sessionId;
  for (const [input, expected] of [[1, 10], [101, 100]]) {
    const saved = await call('neo.preferences.set', { ...preference, autoCompactPercent: input });
    assert.equal((saved.preferences as { autoCompactPercent: number }).autoCompactPercent, expected);
  }
  for (const autoCompactPercent of [70.5, '70', null]) {
    await assert.rejects(call('neo.preferences.set', { ...preference, autoCompactPercent }));
  }
  await call('neo.preferences.set', { ...preference, autoCompactPercent: 70 });
  for (const target of [live, ordinaryLive]) {
    await target.stateManager.setIdle();
    await hub.request('session.update', { sessionId: target.getSessionData().id, config: { autoCompactPercent: 80 } });
    await target.stateManager.setProcessing('setting-pending-at-restart');
    await hub.request('session.update', { sessionId: target.getSessionData().id, config: { autoCompactPercent: 70 } });
    assert.equal(target.getSessionData().config.autoCompactPercent, 80);
    assert.equal(target.getSessionData().metadata.pendingAutoCompactPercent, 70);
  }
  evidence.beforeRestart = app.db.getGlobalSettings().neo?.preferences;
  await transport.close(); await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  setModelsCache(new Map([['global', [model]]]));
  const restored = await app.sessionManager.getSessionForControl(sessionId); assert(restored);
  evidence.afterRestart = await getSessionContextModelInfo(restored.getSessionData());
  assert.equal((evidence.afterRestart as ModelInfo).autoCompactPercent, 70);
  const ordinaryRestored = await app.sessionManager.getSessionForControl(ordinary); assert(ordinaryRestored);
  assert.equal((await getSessionContextModelInfo(ordinaryRestored.getSessionData()))?.autoCompactPercent, 70);
  assert.equal(restored.getSessionData().metadata.pendingAutoCompactPercent, undefined);
  assert.equal(ordinaryRestored.getSessionData().metadata.pendingAutoCompactPercent, undefined);
  evidence.ordinaryAfterRestart = await getSessionContextModelInfo(ordinaryRestored.getSessionData());
  evidence.health = { port: app.server.port, persistedPreference: app.db.getGlobalSettings().neo?.preferences };
  console.log(`PASS public Neo percentage save/snapshot, busy deferral, idle threshold/reserve, ordinary default + explicit setting parity, project identity and restart. ${run}/evidence/observed.json`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await transport.close(); await app.cleanup(); setModelsCache(new Map());
}
