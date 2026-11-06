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
const writeName = 'github.watched.config.write';
let main: Database | undefined, measuring = false;
let writes = 0, nativeWritePosts = 0, mainPollingSql = 0, loseWrite = false, refuseWrite = false;
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
    if (message?.op === writeName) {
      assert.equal(message.lane, 'write');
      nativeWritePosts++;
    }
    return post(message, transfer ?? []);
  }) as typeof worker.postMessage;
  return worker;
} as unknown as typeof Worker;
Database.prototype.prepare = function (sql, ...rest) {
  const connection = this, statement = Reflect.apply(original.prepare, this, [sql, ...rest]);
  if (!/space_github_watched_repos|space_github_source_settings|space_external_event_source_configs/.test(sql)) return statement;
  return new Proxy(statement, { get(target, key) {
    const value = Reflect.get(target, key);
    if (!['get', 'run', 'all'].includes(String(key))) return typeof value === 'function' ? value.bind(target) : value;
    return (...args: unknown[]) => {
      if (measuring && connection === main) { mainPollingSql++; throw new Error('Watch polling SQL reached main'); }
      return Reflect.apply(value, target, args);
    };
  } });
};
DbGateway.prototype.run = async function (op, input) {
  if (op.name !== writeName) return original.run.call(this, op, input);
  assert.equal(op.mode, 'write');
  writes++;
  if (refuseWrite) { refuseWrite = false; throw new Error('synthetic config admission refused'); }
  const at = performance.now();
  const result = await original.run.call(this, op, input);
  metrics.push({ roundTripMs: performance.now() - at, requestBytes: Buffer.byteLength(JSON.stringify(input)), replyBytes: Buffer.byteLength(JSON.stringify(result)) });
  if (loseWrite) { loseWrite = false; throw new Error('synthetic config outcome unknown'); }
  return result;
} as typeof DbGateway.prototype.run;
ExternalEventExtensionManager.prototype.register = function (extension) {
  if (extension.sourceId === 'github') {
    const options = (extension as unknown as { options: {
      getPollIntervalMs: () => number; autoReconcileWebhooks: boolean;
    } }).options;
    options.getPollIntervalMs = () => 60_000;
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
  const space = 'synthetic-watch-polling';
  main.prepare('INSERT INTO spaces(id,slug,workspace_path,name,created_at,updated_at)VALUES(?,?,?,?,1,1)').run(space, space, join(run, 'workspace'), space);
  insertWatchedRow(main, { id: 'synthetic-watch', space_id: space, owner: 'Mixed', repo: 'Repo', polling_enabled: 1, webhook_enabled: 0, webhook_auto_registered: 0, webhook_remote_id: null });
  insertWatchedRow(main, { id: 'synthetic-sibling', space_id: space, owner: 'Sibling', repo: 'Repo', enabled: 0, polling_enabled: 1, webhook_enabled: 0, webhook_auto_registered: 0, webhook_remote_id: null });
  main.prepare('INSERT INTO space_github_source_settings(space_id,enabled,polling_intent,filter_current_user,created_at,updated_at)VALUES(?,1,1,0,1,1)').run(space);
  const store = new ExternalEventExtensionConfigStore(main);
  await store.setGlobalConfig('github', { source: 'github', globallyEnabled: true, capabilities: { rpcConfig: true, polling: false, webhooks: false } });
  transport = new WebSocketClientTransport({ createSocket: createLocalSocket, url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
  const hub = new MessageHub({ defaultSessionId: 'global' });
  hub.registerTransport(transport);
  await transport.initialize();
  const watch = (owner = 'mixed', pollingEnabled = false) => hub.request<{ watchedRepo: { id: string; pollingEnabled: boolean } }>(
    'space.github.watchRepo', { spaceId: space, owner, repo: 'REPO', pollingEnabled, webhookEnabled: false, webhookSecret: 'synthetic-rotated' });
  const read = (sql: string) => Reflect.apply(original.prepare, main!, [sql]).all() as Record<string, unknown>[];
  const rows = () => ({ watched: read('SELECT * FROM space_github_watched_repos ORDER BY id'), settings: read('SELECT * FROM space_github_source_settings ORDER BY space_id'), snapshots: read('SELECT * FROM space_external_event_source_configs ORDER BY space_id') });
  const snapshot = () => JSON.parse(String(rows().snapshots[0].settings_json));
  const before = rows();
  let previous = performance.now();
  timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - previous - 5); previous = now; }, 5);
  main.exec("CREATE TRIGGER reject_watch_snapshot BEFORE INSERT ON space_external_event_source_configs BEGIN SELECT RAISE(ABORT,'synthetic snapshot refusal'); END");
  measuring = true;
  await assert.rejects(watch(), /synthetic snapshot refusal/);
  assert.deepEqual(rows(), before);
  evidence.snapshotFailureRollsBackWatchAndIntent = true;
  main.exec('DROP TRIGGER reject_watch_snapshot');
  const first = await watch();
  assert.equal(first.watchedRepo.id, 'synthetic-watch');
  assert.equal(first.watchedRepo.pollingEnabled, false);
  assert.equal(rows().settings[0].polling_intent, 1);
  assert.equal(snapshot().pollingIntent, true);
  assert.equal(snapshot().filterCurrentUser, false);
  assert(snapshot().watchedRepos.some((row: { owner: string; enabled: boolean; pollingEnabled: boolean }) => row.owner === 'Sibling' && !row.enabled && row.pollingEnabled));
  evidence.configuredDisabledKeepsIntent = true;
  main.exec('CREATE TABLE synthetic_lock(value INTEGER); INSERT INTO synthetic_lock VALUES(0)');
  lock = new Database(app.db.getDbPath());
  lock.exec('BEGIN IMMEDIATE');
  lock.prepare('UPDATE synthetic_lock SET value=1').run();
  const posts = nativeWritePosts, at = performance.now();
  let settled = false;
  const held = watch('sibling').finally(() => { settled = true; });
  const deadline = Date.now() + 4000;
  while (nativeWritePosts === posts) { assert(Date.now() < deadline); await new Promise(done => setTimeout(done, 5)); }
  const health = performance.now();
  assert.equal((await hub.request<{ status: string }>('system.health', {})).status, 'ok');
  evidence.healthWhileWriterHeldMs = performance.now() - health;
  await new Promise(done => setTimeout(done, 1200));
  assert.equal(settled, false);
  lock.exec('ROLLBACK'); lock.close(); lock = undefined;
  const reply = await held;
  evidence.heldWriteRpcMs = performance.now() - at;
  assert.equal(reply.watchedRepo.id, 'synthetic-sibling');
  assert.equal(rows().settings[0].polling_intent, 0);
  assert.equal(snapshot().pollingIntent, false);
  evidence.lastConfiguredRowClearsIntent = true;
  const beforeLoss = nativeWritePosts;
  loseWrite = true;
  await assert.rejects(watch('mixed', true), /synthetic config outcome unknown/);
  const committed = rows();
  assert.equal(committed.settings[0].polling_intent, 1);
  assert.equal(snapshot().pollingIntent, true);
  assert(snapshot().watchedRepos.some((row: { owner: string; pollingEnabled: boolean }) => row.owner === 'Mixed' && row.pollingEnabled));
  await new Promise(done => setTimeout(done, 60));
  assert.equal(nativeWritePosts, beforeLoss + 1);
  assert.deepEqual(rows(), committed);
  evidence.unknownCommitIncludesConfigWithoutReplay = true;
  refuseWrite = true;
  await assert.rejects(watch(), /synthetic config admission refused/);
  assert.deepEqual(rows(), committed);
  assert.equal(nativeWritePosts, beforeLoss + 1);
  evidence.admissionFailurePreservesCluster = true;
  assert.equal(mainPollingSql, 0);
  assert.equal(nativeWritePosts, writes - 1);
  evidence.nativeWriterLaneObserved = nativeWritePosts > 0;
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
    evidence.mainPollingSql = mainPollingSql;
    evidence.writeRequests = writes;
    evidence.nativeWritePosts = nativeWritePosts;
    evidence.resourcesStopped = true;
    writeFileSync(join(run, 'evidence/github-watch-polling-writer.json'), JSON.stringify(evidence, null, 2));
  }
}
