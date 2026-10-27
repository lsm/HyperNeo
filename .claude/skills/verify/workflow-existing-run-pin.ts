import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceWorkflowRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-run-repository.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
const mainSql: string[] = [];
const replies: unknown[] = [];
const timings: unknown[] = [];
const prepare = Database.prototype.prepare;
let measuring = false;
let pinActive = false;
const pinExistingRun = SpaceWorkflowRunRepository.prototype.pinExistingRun;
SpaceWorkflowRunRepository.prototype.pinExistingRun = async function (...args) {
  pinActive = true;
  const started = performance.now();
  try { const result = await pinExistingRun.apply(this, args); timings.push({ durationMs: performance.now() - started, result }); return result; }
  finally { pinActive = false; }
};
Database.prototype.prepare = function (sql, ...args) {
  if (measuring && pinActive && /space_workflow_definition_versions|UPDATE space_workflow_runs SET definition_version/.test(sql)) mainSql.push(sql);
  return prepare.call(this, sql, ...args);
} as typeof prepare;
try {
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const raw = app.db.getDatabase();
  const space = new SpaceRepository(raw).createSpace({ slug: 'pin-fixture', name: 'Pin fixture', workspacePath: join(run, 'workspace') });
  const workflow = new SpaceWorkflowRepository(raw).createWorkflow({ spaceId: space.id, name: 'Original definition', description: 'Frozen definition 甲乙🙂'.repeat(5000), nodes: [] });
  const pending = new SpaceWorkflowRunRepository(raw).createRun({ spaceId: space.id, workflowId: workflow.id, title: 'Legacy run' });
  assert.equal(pending.definitionVersion, null);
  await app.cleanup(); app = undefined;
  measuring = true;
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  measuring = false;
  const runs = new SpaceWorkflowRunRepository(app.db.getDatabase());
  const pinned = runs.getRun(pending.id);
  assert(pinned?.definitionVersion, 'Startup must pin the legacy run before serving RPC');
  const versions = app.db.getDatabase().prepare('SELECT payload FROM space_workflow_definition_versions WHERE workflow_id = ? AND version_hash = ?').get(workflow.id, pinned.definitionVersion) as { payload: string };
  assert.equal(JSON.parse(versions.payload).name, 'Original definition');
  assert.equal(JSON.parse(versions.payload).description, workflow.description);
  assert.equal(createHash('sha256').update(versions.payload).digest('hex'), pinned.definitionVersion);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (method: string, data: unknown) => new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); replies.push({ method, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  assert.deepEqual(await rpc('spaceWorkflowRun.listHookStates', { runId: pending.id }), { hookStates: [], hooks: [] });
  const firstPin = pinned.definitionVersion;
  measuring = true;
  const changed = await runs.pinExistingRun(pending.id, { ...workflow, name: 'Must not replace the pin' });
  measuring = false;
  assert.equal(changed, false);
  assert.equal(runs.getRun(pending.id)?.definitionVersion, firstPin);
  if (mode === 'verify') assert.deepEqual(mainSql, [], 'Existing-run pin SQL must be absent on the daemon main connection');
  else assert(mainSql.length > 0, 'Baseline must expose existing-run pin SQL on main');
  console.log('ok: startup pins the legacy run; real workflow RPC reads its definition; retry preserves the pin');
} finally {
  measuring = false; ws?.close(); await app?.cleanup();
  Database.prototype.prepare = prepare;
  SpaceWorkflowRunRepository.prototype.pinExistingRun = pinExistingRun;
  globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/workflow-existing-run-pin.json'), JSON.stringify({ mode, mainSql, replies, timings }, null, 2));
}
