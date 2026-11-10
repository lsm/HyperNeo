import '../../../packages/daemon/tests/unit/helpers/register-space-schema.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { ExternalEventExtensionManager } from '../../../packages/daemon/src/lib/external-events/extension-manager.ts';
import { ExternalEventExtensionConfigStore } from '../../../packages/daemon/src/lib/external-events/extension-config-store.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { DbGateway } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { JobQueueProcessor } from '../../../packages/daemon/src/storage/job-queue-processor.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { insertWatchedRow } from '../../../packages/daemon/tests/unit/helpers/github-watched-read-fixture.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(process.env[key], undefined);
for (const name of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
const original = { prepare: Database.prototype.prepare, run: DbGateway.prototype.run,
  register: ExternalEventExtensionManager.prototype.register, start: JobQueueProcessor.prototype.start, fetch: globalThis.fetch, Worker: globalThis.Worker };
const processors = new Set<JobQueueProcessor>();
const readName = 'github.watched.lookup.read';
let main: Database | undefined, measuring = false, validationPending = false;
let reads = 0, nativeReadPosts = 0, mainValidationReads = 0, remainingMainLookups = 0, loseRead = false;
const metrics: { roundTripMs: number; requestBytes: number; replyBytes: number }[] = [];
const evidence: Record<string, unknown> = { pass: false };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let lock: Database | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let maxLag = 0;
globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
  const worker = new original.Worker(url, options);
  const post = worker.postMessage.bind(worker);
  worker.postMessage = ((message: { op?: string; lane?: string }, transfer?: Transferable[]) => {
    if (message?.op === readName) {
      assert.equal(message.lane, 'read');
      nativeReadPosts++;
    }
    return post(message, transfer ?? []);
  }) as typeof worker.postMessage;
  return worker;
} as unknown as typeof Worker;
Database.prototype.prepare = function (sql, ...rest) {
  const connection = this, statement = Reflect.apply(original.prepare, this, [sql, ...rest]);
  if (!/SELECT \* FROM space_github_watched_repos WHERE space_id = \? AND lower\(owner\)/.test(sql)) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key !== 'get') return typeof value === 'function' ? value.bind(target) : value;
    return (...args: unknown[]) => {
      if (measuring && connection === main) {
        if (validationPending) { mainValidationReads++; throw new Error('Validation lookup reached main'); }
        remainingMainLookups++;
      }
      return Reflect.apply(value, target, args);
    };
  } });
};
DbGateway.prototype.run = async function (op, input) {
  if (op.name !== readName) return original.run.call(this, op, input);
  assert.equal(op.mode, 'read');
  reads++;
  const at = performance.now();
  const result = await original.run.call(this, op, input);
  metrics.push({ roundTripMs: performance.now() - at, requestBytes: Buffer.byteLength(JSON.stringify(input)), replyBytes: Buffer.byteLength(JSON.stringify(result)) });
  if (loseRead) { loseRead = false; throw new Error('synthetic validation receipt lost'); }
  validationPending = false;
  return result;
} as typeof DbGateway.prototype.run;
ExternalEventExtensionManager.prototype.register = function (extension) {
  if (extension.sourceId === 'github') {
    const options = (extension as unknown as { options: {
      getPollIntervalMs: () => number; autoReconcileWebhooks: boolean;
    } }).options;
    options.getPollIntervalMs = () => 0;
    options.autoReconcileWebhooks = false;
  }
  return original.register.call(this, extension);
};
JobQueueProcessor.prototype.start = function () { processors.add(this); return original.start.call(this); };
globalThis.fetch = (() => { throw new Error('External HTTP refused'); }) as typeof fetch;
try {
  app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true }, verbose: false });
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map(p => p.stop()));
  main = app.db.getDatabase();
  await waitForSdkBodyCopy(main);
  const space = 'synthetic-watch-validation';
  main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,1,1)').run(space, space, join(run, 'workspace'), space);
  insertWatchedRow(main, { id: 'synthetic-watch', space_id: space, owner: 'Mixed', repo: 'Repo', polling_enabled: 0, webhook_enabled: 0, webhook_auto_registered: 0, webhook_remote_id: null });
  const store = new ExternalEventExtensionConfigStore(main);
  await store.setGlobalConfig('github', { source: 'github', globallyEnabled: true, capabilities: { rpcConfig: true, polling: false, webhooks: false } });
  transport = new WebSocketClientTransport({ createSocket: createLocalSocket, url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerTransport(transport);
  await transport.initialize();
  const watch = (pollingEnabled: boolean) => {
    validationPending = true;
    return hub.request<{ watchedRepo: { id: string; owner: string; pollingEnabled: boolean; webhookSecret?: string } }>('space.github.watchRepo', { spaceId: space, owner: 'mixed', repo: 'REPO', pollingEnabled, webhookEnabled: false });
  };
  const rows = () => main!.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all();
  const before = rows();
  let previous = performance.now();
  timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - previous - 5); previous = now; }, 5);
  main.exec('CREATE TABLE synthetic_lock(value INTEGER); INSERT INTO synthetic_lock VALUES(0)');
  lock = new Database(app.db.getDbPath());
  lock.exec('BEGIN IMMEDIATE');
  lock.prepare('UPDATE synthetic_lock SET value=1').run();
  measuring = true;
  const at = performance.now();
  await assert.rejects(watch(true), /GitHub polling is disabled globally/);
  evidence.validationRpcWhileWriterHeldMs = performance.now() - at;
  const health = performance.now();
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
  evidence.healthWhileWriterHeldMs = performance.now() - health;
  assert.deepEqual(rows(), before);
  evidence.readsDuringHeldWriter = reads;
  lock.exec('ROLLBACK'); lock.close(); lock = undefined;
  const reply = await watch(false);
  assert.equal(reply.watchedRepo.id, 'synthetic-watch');
  assert.equal(reply.watchedRepo.owner, 'Mixed');
  assert.equal(reply.watchedRepo.pollingEnabled, false);
  assert.equal(reply.watchedRepo.webhookSecret, 'configured');
  evidence.caseAndSanitizedReceipt = true;
  const saved = rows(), beforeFailure = reads;
  loseRead = true;
  await assert.rejects(watch(false), /synthetic validation receipt lost/);
  await new Promise(done => setTimeout(done, 60));
  assert.equal(reads, beforeFailure + 1);
  assert.deepEqual(rows(), saved);
  evidence.lostReadReceiptHasNoFallbackOrMutation = true;
  assert.equal(mainValidationReads, 0);
  assert.equal(nativeReadPosts, reads);
  evidence.nativeReadLaneObserved = nativeReadPosts > 0;
  assert.equal(remainingMainLookups, 0);
  evidence.remainingMainLookups = remainingMainLookups;
  evidence.latencyTargetsMet = Number(evidence.validationRpcWhileWriterHeldMs) < 250 &&
    Number(evidence.healthWhileWriterHeldMs) < 250 && maxLag < 1000;
  evidence.maxLoopLagMs = maxLag;
  evidence.metrics = metrics;
  evidence.rssBytes = process.memoryUsage().rss;
  evidence.pass = true;
} finally {
  measuring = false;
  if (timer) clearInterval(timer);
  if (lock) { lock.exec('ROLLBACK'); lock.close(); }
  try { await transport?.close(); await Promise.all([...processors].map(p => p.stop())); await app?.cleanup(); }
  finally {
    Object.assign(Database.prototype, { prepare: original.prepare });
    DbGateway.prototype.run = original.run;
    ExternalEventExtensionManager.prototype.register = original.register;
    JobQueueProcessor.prototype.start = original.start;
    globalThis.fetch = original.fetch;
    globalThis.Worker = original.Worker;
    evidence.mainValidationReads = mainValidationReads;
    evidence.readRequests = reads;
    evidence.nativeReadPosts = nativeReadPosts;
    evidence.resourcesStopped = true;
    writeFileSync(join(run, 'evidence/github-watch-validation-reader.json'), JSON.stringify(evidence, null, 2));
  }
}
