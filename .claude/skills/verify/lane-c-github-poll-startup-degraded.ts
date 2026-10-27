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
const { DbGateway } = await import('../../../packages/daemon/src/storage/db-gateway/db-gateway.ts');
const { GitHubService } = await import('../../../packages/daemon/src/lib/github/github-service.ts');
const call = DbGateway.prototype.call;
const serviceStart = GitHubService.prototype.start;
const timeout = globalThis.setTimeout;
let attempts = 0;
let retryTick: (() => void) | undefined;
let retryDelay = 0;
DbGateway.prototype.call = function (...args) {
  if (args[0].name === 'jobs.refreshGitHubPolling') {
    attempts++;
    if (attempts === 1) return Promise.reject(new Error('synthetic startup admission rejected')) as never;
  }
  return Reflect.apply(call, this, args);
};
GitHubService.prototype.start = function () {
  (this as unknown as { githubToken: string }).githubToken = 'synthetic-transport-only';
  return Reflect.apply(serviceStart, this, []);
};
globalThis.setTimeout = ((callback, delay, ...args) => {
  const caller = (new Error().stack ?? '').split('\n')[2] ?? '';
  if (/github-service\.ts/.test(caller)) {
    retryDelay = Number(delay);
    const held = timeout(() => {}, 86_400_000);
    retryTick = () => { clearTimeout(held); callback(...args); };
    return held;
  }
  return timeout(callback, delay, ...args);
}) as typeof setTimeout;
try {
  JobQueueProcessor.prototype.start = function () { processors.add(this); return start.call(this); };
  try {
    app = await createDaemonApp({ config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true, disableGoalProcessing: true,
    }, verbose: false });
  } catch (error) {
    evidence.startupError = String(error);
    throw error;
  } finally {
    JobQueueProcessor.prototype.start = start;
  }
  evidence.startResolved = true;
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((owned) => owned.stop()));
  const repo = app.jobQueue;
  const raw = app.db.getDatabase();
  raw.prepare("UPDATE job_queue SET run_at = ? WHERE status = 'pending'").run(Date.now() + 86_400_000);
  assert(app.gitHubService);
  assert.equal(attempts, 1);
  assert.equal(app.gitHubService.pollRefreshDegraded, true);
  assert(retryTick, 'startup must schedule its next polling interval');
  assert.equal(retryDelay, 120_000);
  evidence.degradedAtStartup = app.gitHubService.pollRefreshDegraded;
  evidence.retryDelay = retryDelay;
  evidence.initial = repo.listJobs({ queue: 'github.poll' });
  assert.deepEqual(evidence.initial, []);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  hub.registerTransport(transport);
  await transport.initialize();
  const prepare = raw.prepare;
  let mainSqlAttempts = 0;
  raw.prepare = (...args) => {
    if (/\bjob_queue\b/i.test(args[0]) && /\/(?:github\/github-service|repositories\/github-poll-refresh-write)\.ts/.test(new Error().stack ?? '')) {
      mainSqlAttempts++;
      throw new Error('startup recovery job SQL reached main connection');
    }
    return Reflect.apply(prepare, raw, args);
  };
  try {
    evidence.healthBefore = await hub.request('system.health', {});
    retryTick();
    const deadline = Date.now() + 5_000;
    while ((app.gitHubService.pollRefreshDegraded || repo.listJobs({ queue: 'github.poll', status: 'pending' }).length === 0) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const admitted = repo.listJobs({ queue: 'github.poll', status: 'pending' });
    evidence.admitted = admitted;
    evidence.degradedAfterTick = app.gitHubService.pollRefreshDegraded;
    evidence.attempts = attempts;
    evidence.warnings = warnings;
    assert.equal(attempts, 2);
    assert.equal(app.gitHubService.pollRefreshDegraded, false);
    assert.equal(admitted.length, 1);
    assert.deepEqual(admitted[0].payload, {});
    assert.equal(admitted[0].maxRetries, 3);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /synthetic startup admission rejected/);
    await app.jobProcessor.tick();
    const completedBy = Date.now() + 5_000;
    while (repo.getJob(admitted[0].id)?.status === 'processing' && Date.now() < completedBy) await new Promise((resolve) => setTimeout(resolve, 10));
    evidence.completed = repo.getJob(admitted[0].id);
    assert.equal(repo.getJob(admitted[0].id)?.status, 'completed');
    assert.equal(repo.getJob(admitted[0].id)?.result?.polled, true);
    evidence.healthAfter = await hub.request('system.health', {});
    assert.equal(mainSqlAttempts, 0);
  } finally {
    evidence.mainSqlAttempts = mainSqlAttempts;
    raw.prepare = prepare;
  }
} finally {
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await Promise.all([...processors].map((owned) => owned.stop()));
  await app?.cleanup();
  DbGateway.prototype.call = call;
  GitHubService.prototype.start = serviceStart;
  globalThis.setTimeout = timeout;
  Logger.prototype.warn = warn;
  globalThis.fetch = originalFetch;
  for (const restore of providerRestores.reverse()) restore();
  writeFileSync(join(run, 'evidence/github-poll-startup-degraded.json'), JSON.stringify(evidence, null, 2));
  if (!app) process.exit(1);
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
}
console.log('ok actual daemon startup resolves degraded, a controlled next poll tick admits durably, and its registered job completes');
