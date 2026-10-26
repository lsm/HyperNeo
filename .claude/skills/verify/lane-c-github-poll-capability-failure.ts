import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { initializeProviders } = await import('../../../packages/daemon/src/lib/providers/factory.ts');
const { getDataDir } = await import('../../../packages/daemon/src/lib/data-dir.ts');
const { Logger } = await import('../../../packages/daemon/src/lib/logger.ts');
assert.equal(resolve(getDataDir()), join(run, 'data'));
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
const registry = initializeProviders();
const providerRestores: Array<() => void> = [];
for (const provider of registry.getAll()) {
  const available = provider.isAvailable;
  const models = provider.getModels;
  provider.isAvailable = () => provider.id === 'anthropic';
  provider.getModels = async () => [];
  providerRestores.push(() => { provider.isAvailable = available; provider.getModels = models; });
}
const anthropic = registry.get('anthropic')!;
const credentials = anthropic.getCredentials;
anthropic.getCredentials = () => ({ type: 'api_key', apiKey: 'synthetic-auth-gate-fixture' });
providerRestores.push(() => { anthropic.getCredentials = credentials; });
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
const start = JobQueueProcessor.prototype.start;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
const evidence: Record<string, unknown> = { syntheticAuthGate: true, providerDiscoveryStubbed: true };
const warnings: string[] = [];
const warn = Logger.prototype.warn;
const originalFetch = globalThis.fetch;
Logger.prototype.warn = function (...args) {
  if (String(args[0]).includes('GitHub polling refresh persistence failed')) warnings.push(args.map(String).join(' '));
  return Reflect.apply(warn, this, args);
};
globalThis.fetch = (() => { throw new Error('External HTTP refused by retry fixture'); }) as typeof fetch;
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true, disableGoalProcessing: true,
    }, verbose: false });
  } finally {
    JobQueueProcessor.prototype.start = start;
  }
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((owned) => owned.stop()));
  const repo = app.jobQueue;
  const raw = app.db.getDatabase();
  raw.prepare("UPDATE job_queue SET run_at = ? WHERE status = 'pending'").run(Date.now() + 86_400_000);
  assert(app.gitHubService, 'actual app GitHub service must exist under the synthetic auth gate');
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) assert.equal(process.env[key], undefined);
  const first = repo.enqueue({ queue: 'github.poll', payload: {}, runAt: Date.now() + 60_000 });
  const foreign = repo.enqueue({ queue: 'synthetic.foreign', payload: {} });
  const extension = app.extensionManager.getExtension('github') as unknown as { refreshPollingInterval: () => Promise<void> };
  assert(extension);
  const refreshInterval = extension.refreshPollingInterval;
  let extensionRefreshes = 0;
  extension.refreshPollingInterval = async function () { extensionRefreshes++; return Reflect.apply(refreshInterval, this, []); };
  const capability = () => JSON.parse((raw.prepare("SELECT capabilities_json FROM external_event_extension_configs WHERE source = 'github'").get() as { capabilities_json: string }).capabilities_json).polling;
  assert.equal(capability(), true);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\bjob_queue\b/i.test(args[0]) && /\/(?:github\/github-service|repositories\/github-poll-refresh-write)\.ts/.test(new Error().stack ?? '')) {
      mainSqlAttempts++;
      throw new Error('GitHub poll refresh retry SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  const gateway = app.db.gateway;
  const call = gateway.call;
  let attempts = 0;
  let successfulReceipts = 0;
  gateway.call = (...args) => {
    if (args[0].name === 'jobs.refreshGitHubPolling') {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('synthetic refresh admission failure')) as never;
      return Reflect.apply(call, gateway, args).then((receipt: unknown) => { successfulReceipts++; return receipt; }) as never;
    }
    return Reflect.apply(call, gateway, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    const update = () => hub.request<{ success: boolean }>('settings.global.update', { updates: { githubPollingInterval: 0 } });
    evidence.firstReply = await update();
    await hub.request('system.health', {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.afterFailure = repo.listJobs({ queue: 'github.poll' });
    evidence.noAutomaticReplay = attempts === 1;
    evidence.pollingCapabilityAfterFailure = capability();
    evidence.extensionRefreshesAfterFailure = extensionRefreshes;
    evidence.persistedInterval = app.settingsManager.getGlobalSettings().githubPollingInterval;
    assert.equal(evidence.persistedInterval, 0);
    assert.equal(capability(), false, 'failed job bookkeeping must not suppress committed polling capability synchronization');
    assert.equal(extensionRefreshes, 1, 'extension interval refresh must run independently');
    evidence.sameValueReply = await update();
    const deadline = Date.now() + 500;
    while ((repo.getJob(first.id) || successfulReceipts === 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.afterSameValue = repo.listJobs({ queue: 'github.poll' });
    evidence.warnings = warnings;
    evidence.successfulReceipts = successfulReceipts;
    evidence.attemptsAfterSameValue = attempts;
    await update();
    await hub.request('system.health', {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.attemptsAfterSuccessMemo = attempts;
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(attempts, 2, 'actual app subscription must retry the same setting after a failed receipt, then memoize success');
    assert.equal(evidence.noAutomaticReplay, true);
    assert.equal(successfulReceipts, 1);
    assert.deepEqual(evidence.afterFailure, [first]);
    assert.deepEqual(evidence.afterSameValue, []);
    assert.equal(warnings.length, 1, 'the swallowed subscriber failure must be logged once');
    assert.match(warnings[0], /synthetic refresh admission failure/);
    assert.deepEqual(repo.getJob(foreign.id), foreign);
    assert.equal(mainSqlAttempts, 0);
  } finally {
    extension.refreshPollingInterval = refreshInterval;
    gateway.call = call;
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await Promise.all([...processors].map((owned) => owned.stop()));
  await app?.cleanup();
  Logger.prototype.warn = warn;
  globalThis.fetch = originalFetch;
  for (const restore of providerRestores.reverse()) restore();
  writeFileSync(join(run, 'evidence/github-poll-capability-failure.json'), JSON.stringify(evidence, null, 2));
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok failed poll bookkeeping does not suppress capability synchronization or extension interval refresh');
