import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceWorkflowRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-run-repository.ts';
import { workflowRunPinWrites } from '../../../packages/daemon/src/storage/repositories/workflow-run-pin-write.ts';
import { computeDefinitionVersion } from '../../../packages/daemon/src/lib/workflows/definition-version.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
let app = await createDaemonApp({ config, verbose: false });
let ws: WebSocket | undefined;
let blocker: ChildProcess | undefined;
const metrics: Record<string, number> = {};
const mainSql: string[] = [], replies: unknown[] = [], jobs: unknown[] = [];
let measuring = false;
const startupSql: string[] = [], startup: unknown[] = [];
let migrationActive = false;
const migrateSnapshotlessPins = SpaceWorkflowRunRepository.prototype.migrateSnapshotlessPins;
const prototypePrepare = Database.prototype.prepare;
const raw = app.db.getDatabase(), prepare = raw.prepare.bind(raw);
raw.prepare = ((sql: string) => { if (measuring && /space_workflow_definition_versions|UPDATE space_workflow_runs SET definition_version/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const space = new SpaceRepository(raw).createSpace({ slug: 'snapshot-fixture', name: 'Snapshot fixture', workspacePath: join(run, 'workspace') });
  const hooks = [{ id: 'frozen-hook', enabled: true, sourceNode: 'start', method: 'mark_complete' as const, validator: { type: 'built_in' as const, id: 'artifact_exists' as const } }];
  const workflows = new SpaceWorkflowRepository(raw), runs = new SpaceWorkflowRunRepository(raw);
  const workflow = workflows.createWorkflow({ spaceId: space.id, name: 'Frozen definition', description: 'Snapshot 甲乙🙂'.repeat(5000), nodes: [], hooks });
  const legacy = runs.createPinnedRun({ spaceId: space.id, workflowId: workflow.id, title: 'Legacy pin', rawWorkflow: workflow });
  const beforePin = legacy.definitionVersion;
  const snapshot = computeDefinitionVersion({ ...workflow, templateSnapshots: {} });
  workflows.updateWorkflow(workflow.id, { hooks: [], name: 'Edited live definition' });
  app.jobProcessor.register('verify.workflow.snapshot', async () => ({ migrated: await app.db.gateway.call(workflowRunPinWrites, 'migrateSnapshot', { runId: legacy.id, workflowId: workflow.id, spaceId: space.id, ...snapshot }) }));
  const job = app.jobQueue.enqueue({ queue: 'verify.workflow.snapshot', payload: {}, maxRetries: 0, priority: 100 });
  measuring = true;
  await app.jobProcessor.start();
  let terminal: ReturnType<typeof app.jobQueue.getJob>;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const current = app.jobQueue.getJob(job.id);
      if (current && ['completed', 'failed', 'dead'].includes(current.status)) { terminal = current; break; }
      await new Promise(done => setTimeout(done, 20));
    }
  } finally { await app.jobProcessor.stop(); measuring = false; }
  jobs.push(terminal);
  assert.equal(terminal?.status, 'completed', `Snapshot migration job must complete: ${terminal?.error}`);
  assert.deepEqual(terminal.result, { migrated: true });
  const pinned = runs.getRun(legacy.id);
  assert.equal(pinned?.definitionVersion, snapshot.versionHash);
  assert.notEqual(pinned?.definitionVersion, beforePin);
  const version = raw.prepare('SELECT payload FROM space_workflow_definition_versions WHERE workflow_id = ? AND version_hash = ?').get(workflow.id, snapshot.versionHash) as { payload: string };
  assert.equal(version.payload, snapshot.payload);
  assert.equal(createHash('sha256').update(version.payload).digest('hex'), snapshot.versionHash);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (method: string, data: unknown) => new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('Hook RPC timed out')), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); replies.push(reply); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const response = await rpc('spaceWorkflowRun.listHookStates', { runId: legacy.id });
  assert.deepEqual(response.hooks, hooks, 'RPC must use the migrated frozen definition, not the edited live workflow');
  blocker = spawn('bun', ['-e', `import { Database } from 'bun:sqlite'; const db = new Database(process.argv[1]); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 1200);`, join(run, 'data/daemon.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const released = new Promise<void>((done, fail) => { blocker!.once('error', fail); blocker!.once('exit', code => code === 0 ? done() : fail(new Error(`Lock fixture exited ${code}`))); });
  let lockOutput = '';
  await new Promise<void>((done, fail) => { blocker!.stdout!.on('data', chunk => { lockOutput += String(chunk); if (lockOutput.includes('locked')) done(); }); blocker!.once('error', fail); blocker!.once('exit', () => { if (!lockOutput.includes('locked')) fail(new Error('Lock fixture never acquired its lock')); }); });
  let lastTick = performance.now(), maxLagMs = 0;
  const interval = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - lastTick - 10); lastTick = now; }, 10);
  measuring = true;
  const writeStarted = performance.now();
  const waiting = app.db.gateway.call(workflowRunPinWrites, 'migrateSnapshot', { runId: legacy.id, workflowId: workflow.id, spaceId: space.id, ...snapshot });
  try {
    const healthStarted = performance.now();
    await rpc('system.health', {});
    metrics.healthMs = performance.now() - healthStarted;
    assert.equal(await waiting, true);
    metrics.affectedWriteMs = performance.now() - writeStarted;
    await released;
  } finally { clearInterval(interval); measuring = false; }
  metrics.maxLagMs = maxLagMs;
  metrics.payloadBytes = Buffer.byteLength(snapshot.payload);
  metrics.rssBytes = process.memoryUsage().rss;
  assert(metrics.affectedWriteMs >= 1000, 'The synthetic writer lock must actually delay the snapshot write');
  assert(metrics.healthMs < 250, 'Independent health must remain responsive while the writer waits');
  assert(maxLagMs < 1000, 'The writer lock must not block the main loop');
  assert.deepEqual(mainSql, [], 'Snapshot job and contended write must execute no target SQL on main');
  const startupLegacy = runs.createPinnedRun({ spaceId: space.id, workflowId: workflow.id, title: 'Startup legacy pin', rawWorkflow: workflow });
  assert.notEqual(startupLegacy.definitionVersion, snapshot.versionHash);
  ws.close(); await app.cleanup();
  SpaceWorkflowRunRepository.prototype.migrateSnapshotlessPins = async function (...args) {
    migrationActive = true;
    try { return await migrateSnapshotlessPins.apply(this, args); }
    finally { migrationActive = false; }
  };
  Database.prototype.prepare = function (sql, ...args) {
    if (migrationActive && /INSERT(?: OR IGNORE)? INTO space_workflow_definition_versions|UPDATE space_workflow_runs SET definition_version/.test(sql)) startupSql.push(sql);
    return prototypePrepare.call(this, sql, ...args);
  } as typeof prototypePrepare;
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  const recovered = new SpaceWorkflowRunRepository(app.db.getDatabase()).getRun(startupLegacy.id);
  assert.equal(recovered?.definitionVersion, snapshot.versionHash, 'Startup must finish snapshot migration before serving RPC');
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('Restart RPC connection failed')); });
  const recoveredHooks = await rpc('spaceWorkflowRun.listHookStates', { runId: startupLegacy.id });
  assert.deepEqual(recoveredHooks.hooks, hooks, 'Restart must preserve frozen hooks rather than the edited live definition');
  startup.push({ runId: startupLegacy.id, beforePin: startupLegacy.definitionVersion, afterPin: recovered?.definitionVersion, hooks: recoveredHooks.hooks });
  assert.deepEqual(startupSql, [], 'Startup snapshot migration writes must leave the daemon main connection');
  console.log('ok: job and startup snapshot migration use the writer; real workflow RPC serves frozen hooks after restart');
} finally {
  measuring = false; migrationActive = false; blocker?.kill(); ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  Database.prototype.prepare = prototypePrepare;
  SpaceWorkflowRunRepository.prototype.migrateSnapshotlessPins = migrateSnapshotlessPins;
  writeFileSync(join(run, 'evidence/workflow-snapshot-writer.json'), JSON.stringify({ mode, mainSql, replies, jobs, metrics, startupSql, startup }, null, 2));
}
