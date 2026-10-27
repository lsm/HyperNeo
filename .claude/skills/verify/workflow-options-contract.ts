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
  const space = new SpaceRepository(raw).createSpace({ slug: 'options-fixture', name: 'Options fixture', workspacePath: join(run, 'workspace') });
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
  const options = {
    channels: [{ from: 'Start', to: ['Finish'], label: 'Messages 甲乙' }],
    hooks: [{ id: 'handoff', enabled: true, sourceNode: 'Start', targetNode: 'Finish', method: 'send_message', validator: { kind: 'script', interpreter: 'bash', source: `printf '{"type":"allow"}'` }, authorizedCallers: [{ sourceNode: 'Start' }] }],
    layout: { start: { x: -20, y: 5.5 }, finish: { x: 30, y: 10 } },
    templateName: 'synthetic-options', templateHash: 'synthetic-hash',
    instructions: 'Preserve workflow options 甲乙🙂'.repeat(3000),
    completionAutonomyLevel: 4, postApproval: { targetAgent: 'Worker', instructions: 'Report the result' },
    disabled: true, handle: 'options-edited',
  };
  measuring = true;
  const edited = (await rpc('spaceWorkflow.update', { id: workflow.id, spaceId: space.id, ...options })).workflow;
  measuring = false;
  for (const [key, value] of Object.entries(options)) assert.deepEqual(edited[key as keyof SpaceWorkflow], value, key);
  assert.deepEqual(edited.nodes, workflow.nodes); assert.equal(edited.name, workflow.name);
  const version = computeDefinitionVersion(edited), saved = versions.getVersion(workflow.id, version.versionHash);
  assert.equal(saved?.payload, version.payload);
  assert.equal(createHash('sha256').update(saved!.payload).digest('hex'), version.versionHash);
  measuring = true;
  const omitted = (await rpc('spaceWorkflow.update', { id: workflow.id, spaceId: space.id, description: 'Only identity changed', disabled: null })).workflow;
  measuring = false;
  for (const [key, value] of Object.entries(options)) assert.deepEqual(omitted[key as keyof SpaceWorkflow], value, key);
  measuring = true;
  const cleared = (await rpc('spaceWorkflow.update', { id: workflow.id, spaceId: space.id, channels: [], hooks: [], layout: null, templateName: null, templateHash: null, instructions: null, postApproval: null, disabled: false, handle: null, completionAutonomyLevel: 1 })).workflow;
  measuring = false;
  for (const key of ['channels', 'hooks', 'layout', 'templateName', 'templateHash', 'instructions', 'postApproval', 'handle']) assert.equal(cleared[key as keyof SpaceWorkflow], undefined, key);
  assert.equal(cleared.disabled, undefined); assert.equal(cleared.completionAutonomyLevel, 1);
  assert.deepEqual(cleared.nodes, workflow.nodes);
  measuring = true;
  const nullDisabled = (await rpc('spaceWorkflow.update', { id: workflow.id, spaceId: space.id, disabled: null })).workflow;
  measuring = false;
  assert.equal(nullDisabled.disabled, undefined);
  const read = (await rpc('spaceWorkflow.get', { id: workflow.id, spaceId: space.id })).workflow;
  assert.deepEqual(read, nullDisabled); assert.deepEqual(read.nodes, workflow.nodes);
  console.log('ok: real workflow RPC preserves complete options, omitted fields, nullable clears, false/null disabled behavior, nodes and immutable version hash');
} finally {
  measuring = false; ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/workflow-options-contract.json'), JSON.stringify({ mode, replies, mainSql, sqlHash: createHash('sha256').update(mainSql.join('\n')).digest('hex'), limitation: 'Neutral options extraction characterization; workflow metadata writes remain on main until a later writer slice.' }, null, 2));
}
