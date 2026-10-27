import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
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
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
const mainSql: string[] = [], replies: unknown[] = [], jobs: unknown[] = [];
let measuring = false;
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
  const response = await new Promise<Record<string, unknown>>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('Hook RPC timed out')), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); replies.push(reply); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'spaceWorkflowRun.listHookStates', data: { runId: legacy.id }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  assert.deepEqual(response.hooks, hooks, 'RPC must use the migrated frozen definition, not the edited live workflow');
  assert.deepEqual(mainSql, [], 'Snapshot job must execute no target SQL on main');
  console.log('ok: daemon job migrates the pin; real workflow RPC serves the frozen hooks; full Unicode payload hash survives');
} finally {
  measuring = false; ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/workflow-snapshot-writer.json'), JSON.stringify({ mode, mainSql, replies, jobs }, null, 2));
}
