import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceWorkflowRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowDefinitionVersionRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-definition-version-repository.ts';
import { computeDefinitionVersion } from '../../../packages/daemon/src/lib/workflows/definition-version.ts';
import type { SpaceWorkflow } from '../../../packages/shared/src/types/space.ts';

const [mode, directory] = process.argv.slice(2), run = resolve(directory);
assert.equal(mode, 'verify');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP forbidden'); }) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
const replies: unknown[] = [], mainSql: string[] = [];
let measuring = false;
const raw = app.db.getDatabase(), prepare = raw.prepare.bind(raw);
raw.prepare = ((sql: string) => { if (measuring && /^UPDATE space_workflows SET/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const space = new SpaceRepository(raw).createSpace({ slug: 'identity-fixture', name: 'Identity fixture', workspacePath: join(run, 'workspace') });
  const workflows = new SpaceWorkflowRepository(raw), versions = new SpaceWorkflowDefinitionVersionRepository(raw);
  const workflow = workflows.createWorkflow({ spaceId: space.id, name: 'Original', handle: 'original', description: 'Initial description', nodes: [
    { id: 'start', name: 'Start', agents: [{ agentId: '', templateKey: 'worker.swe', name: 'Worker' }] },
    { id: 'finish', name: 'Finish', agents: [{ agentId: '', templateKey: 'worker.swe', name: 'Worker' }] },
  ], startNodeId: 'start', endNodeId: 'finish', tags: ['initial'] });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (method: string, data: unknown) => new Promise<{ workflow: SpaceWorkflow }>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); replies.push({ method, input: data, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const description = 'Full identity description 甲乙🙂'.repeat(3000);
  measuring = true;
  const edited = (await rpc('spaceWorkflow.update', { id: workflow.id, spaceId: space.id, name: '  Edited  ', description, startNodeId: 'finish', endNodeId: 'start', tags: ['alpha', 'βeta'] })).workflow;
  measuring = false;
  assert.equal(edited.name, 'Edited'); assert.equal(edited.description, description);
  assert.equal(edited.startNodeId, 'finish'); assert.equal(edited.endNodeId, 'start');
  assert.deepEqual(edited.tags, ['alpha', 'βeta']); assert.deepEqual(edited.nodes, workflow.nodes);
  assert(edited.updatedAt > workflow.updatedAt);
  const version = computeDefinitionVersion(edited), saved = versions.getVersion(workflow.id, version.versionHash);
  assert.equal(saved?.payload, version.payload);
  assert.equal(createHash('sha256').update(saved!.payload).digest('hex'), version.versionHash);
  measuring = true;
  const cleared = (await rpc('spaceWorkflow.update', { id: workflow.id, spaceId: space.id, description: null, tags: null })).workflow;
  measuring = false;
  assert.equal(cleared.name, 'Edited'); assert.equal(cleared.description, undefined);
  assert.deepEqual(cleared.tags, []); assert.equal(cleared.startNodeId, 'finish'); assert.equal(cleared.endNodeId, 'start');
  const read = (await rpc('spaceWorkflow.get', { id: workflow.id, spaceId: space.id })).workflow;
  assert.deepEqual(read, cleared); assert.deepEqual(read.nodes, workflow.nodes);
  console.log('ok: real workflow RPC preserves trimmed identity, complete Unicode description, endpoints, nullable clears, nodes and immutable version hash');
} finally {
  measuring = false; ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/workflow-identity-contract.json'), JSON.stringify({ mode, replies, mainSql, sqlHash: createHash('sha256').update(mainSql.join('\n')).digest('hex'), limitation: 'Neutral extraction characterization; workflow metadata writes remain on main until a later writer slice.' }, null, 2));
}
