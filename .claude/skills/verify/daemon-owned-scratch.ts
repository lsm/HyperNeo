import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { installClaudeNativeWrites } from '../../../packages/daemon/src/lib/drivers/claude-native-writes.ts';
import { AgentChildProcessRepository } from '../../../packages/daemon/src/storage/repositories/agent-child-process-repository.ts';
import { workerWorkLocations } from '../../../packages/daemon/src/lib/work-locations.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: Record<string, unknown> = {};
const install: (root: string, roots: string[], daemonOwned?: boolean) => Promise<void> = installClaudeNativeWrites;
const ownerPath = (root: string) => join(run, 'data/work/scratch-owners', `${basename(workerWorkLocations(root).scratch)}.json`);
async function fixture(name: string, owned = true) {
  const root = join(run, 'workers', name);
  mkdirSync(join(root, '.git'), { recursive: true });
  await install(root, [root], owned);
  writeFileSync(join(workerWorkLocations(root).scratch, 'synthetic-temp.txt'), name);
  return root;
}
const config = () => getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
async function rpc(method: string, data: unknown) {
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  return await new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${method} timed out`)), 30000);
    ws!.onmessage = (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== id && response.requestId !== id) return;
      clearTimeout(timer); done(response);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}

try {
  app = await createDaemonApp({ config: config(), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const sdk = await fixture('sdk');
  const desktop = await fixture('desktop', false);
  assert(existsSync(ownerPath(sdk)), 'SDK scratch must have an authoritative owner record');
  assert(!existsSync(ownerPath(desktop)), 'Desktop scratch must remain unclaimed');
  const now = new Date().toISOString();
  await app.db.createSession({ id: 'synthetic-scratch', title: 'Scratch proof', workspacePath: sdk, createdAt: now, lastActiveAt: now, status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const reply = await rpc('session.archive', { sessionId: 'synthetic-scratch', confirmed: true });
  assert(!reply.error, JSON.stringify(reply));
  assert(!existsSync(workerWorkLocations(sdk).scratch));
  evidence.archive = reply;
  ws.close(); ws = undefined;
  const shutdown = await fixture('shutdown');
  const childLive = await fixture('child-live');
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(exited.status, 0);
  const childOwnerPath = ownerPath(childLive);
  const childOwner = JSON.parse(readFileSync(childOwnerPath, 'utf8'));
  childOwner.pid = exited.pid;
  childOwner.createdAt = Date.now() - 25 * 60 * 60 * 1000;
  writeFileSync(childOwnerPath, JSON.stringify(childOwner));
  const renewed = await fixture('renewed-live-child');
  const renewedPath = ownerPath(renewed);
  const renewedOwner = JSON.parse(readFileSync(renewedPath, 'utf8'));
  renewedOwner.pid = exited.pid;
  renewedOwner.createdAt = Date.now() - 25 * 60 * 60 * 1000;
  writeFileSync(renewedPath, JSON.stringify(renewedOwner));
  await install(renewed, [renewed], true);
  await new AgentChildProcessRepository(app.db.getDatabase()).record({ pid: process.pid, daemonPid: exited.pid, sessionId: 'synthetic-live-child', command: 'synthetic-proof', startedAt: Date.now() });
  await app.cleanup(); app = undefined;
  assert(!existsSync(workerWorkLocations(shutdown).scratch), 'daemon shutdown must remove its own scratch');
  assert(existsSync(workerWorkLocations(desktop).scratch), 'daemon shutdown must retain Desktop scratch');
  assert(existsSync(workerWorkLocations(renewed).scratch), 'shutdown must preserve renewed scratch with a live child of its previous owner');
  evidence.shutdown = { ownRemoved: true, desktopRetained: true, previousOwnerChildRetained: true };
  const stale = await fixture('stale');
  const recent = await fixture('recent');
  const live = await fixture('live');
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(dead.status, 0);
  for (const root of [stale, recent, live]) {
    const path = ownerPath(root);
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    owner.pid = root === live ? process.pid : dead.pid;
    owner.createdAt = Date.now() - (root === recent ? 1000 : 25 * 60 * 60 * 1000);
    writeFileSync(path, JSON.stringify(owner));
  }
  app = await createDaemonApp({ config: config(), verbose: false });
  await app.jobProcessor.stop();
  assert(!existsSync(workerWorkLocations(stale).scratch), 'startup must reclaim old scratch with a dead owner');
  assert(existsSync(workerWorkLocations(recent).scratch), 'startup must retain recent scratch');
  assert(existsSync(workerWorkLocations(live).scratch), 'startup must retain scratch with a live owner');
  assert(existsSync(workerWorkLocations(desktop).scratch), 'startup must retain unmarked Desktop scratch');
  assert(existsSync(workerWorkLocations(childLive).scratch), 'startup must retain scratch with a live recorded SDK child');
  evidence.startup = { liveSdkChildRetained: true, staleDeadRemoved: true, recentRetained: true, liveRetained: true, desktopRetained: true };
  await app.cleanup(); app = undefined;
  const blocked = await fixture('cleanup-boundary-unavailable');
  const blockedOwner = JSON.parse(readFileSync(ownerPath(blocked), 'utf8'));
  blockedOwner.pid = dead.pid;
  blockedOwner.createdAt = Date.now() - 25 * 60 * 60 * 1000;
  const leaseBefore = JSON.stringify(blockedOwner);
  writeFileSync(ownerPath(blocked), leaseBefore);
  const originalSpawn = Bun.spawn;
  const originalError = console.error;
  const diagnostics: string[] = [];
  console.error = (...args: unknown[]) => {
    diagnostics.push(args.map(String).join(' '));
    originalError(...args);
  };
  Bun.spawn = ((args, options) => {
    if (Array.isArray(args) && args.includes('worker-runtime-cleanup')) {
      args = [...args];
      args[args.indexOf('/bin/sh') + 2] = "printf 'synthetic scratch boundary unavailable' >&2; exit 23";
    }
    return originalSpawn(args, options);
  }) as typeof Bun.spawn;
  try {
    app = await createDaemonApp({ config: config(), verbose: true });
    await app.jobProcessor.stop();
  } catch (error) {
    evidence.cleanupFailure = { startupAborted: true, error: String(error) };
    throw error;
  } finally {
    Bun.spawn = originalSpawn;
    console.error = originalError;
  }
  assert(existsSync(workerWorkLocations(blocked).scratch), 'failed cleanup must retain its scratch');
  assert.equal(readFileSync(ownerPath(blocked), 'utf8'), leaseBefore, 'failed cleanup must retain its lease unchanged');
  assert(diagnostics.some((line) => line.includes('synthetic scratch boundary unavailable')), 'startup must log the cleanup failure');
  const health = await rpc('system.health', {});
  assert(!health.error, JSON.stringify(health));
  assert.equal((health.data as { status?: string }).status, 'ok');
  ws!.close(); ws = undefined;
  evidence.cleanupFailure = { scratchRetained: true, leaseRetained: true, diagnostics, health };
  const shutdownRoots = [await fixture('shutdown-one'), await fixture('shutdown-two')].sort((a, b) => ownerPath(a).localeCompare(ownerPath(b)));
  const [shutdownBlocked, shutdownHealthy] = shutdownRoots;
  const shutdownLease = readFileSync(ownerPath(shutdownBlocked), 'utf8');
  const shutdownErrors = diagnostics;
  const raw = app.db.getDatabase();
  Bun.spawn = ((args, options) => {
    if (Array.isArray(args) && args.includes('worker-runtime-cleanup') && args.includes(workerWorkLocations(shutdownBlocked).scratch)) {
      args = [...args];
      args[args.indexOf('/bin/sh') + 2] = "printf 'synthetic shutdown boundary unavailable' >&2; exit 23";
    }
    return originalSpawn(args, options);
  }) as typeof Bun.spawn;
  let shutdownError: unknown;
  try { await app.cleanup(); } catch (error) { shutdownError = String(error); }
  finally { Bun.spawn = originalSpawn; console.error = originalError; app = undefined; }
  let databaseClosed = false;
  try { raw.query('SELECT 1').get(); } catch { databaseClosed = true; }
  evidence.shutdownFailure = { shutdownError, databaseClosed, shutdownErrors, healthyRemoved: !existsSync(workerWorkLocations(shutdownHealthy).scratch) };
  assert.equal(shutdownError, undefined, 'scratch failure must not abort graceful shutdown');
  assert(databaseClosed, 'shutdown must close its database after scratch failure');
  assert(!existsSync(workerWorkLocations(shutdownHealthy).scratch), 'one failed lease must not strand healthy leases');
  assert(existsSync(workerWorkLocations(shutdownBlocked).scratch));
  assert.equal(readFileSync(ownerPath(shutdownBlocked), 'utf8'), shutdownLease);
  assert(shutdownErrors.some((line) => line.includes('synthetic shutdown boundary unavailable')));
  app = await createDaemonApp({ config: config(), verbose: false });
  await app.jobProcessor.stop();
  assert(!existsSync(workerWorkLocations(blocked).scratch), 'next startup must retry retained scratch');
  assert(!existsSync(ownerPath(blocked)), 'successful retry must remove the retained lease');
  evidence.cleanupRetry = { scratchRemoved: true, leaseRemoved: true };
  evidence.passed = true;
  console.log('PASS archive RPC, ownership guards, nonfatal startup/shutdown cleanup, database close and retry');
} finally {
  ws?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/daemon-owned-scratch.json'), JSON.stringify(evidence, null, 2));
}
process.exit(0);
