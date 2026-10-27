import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
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
raw.prepare = ((sql: string) => { if (measuring && /(?:INSERT INTO|UPDATE|DELETE FROM) space_workflow_nodes/.test(sql)) mainSql.push(sql); return prepare(sql); }) as typeof raw.prepare;
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const space = new SpaceRepository(raw).createSpace({ slug: 'node-config-fixture', name: 'Node config fixture', workspacePath: join(run, 'workspace') });
  const versions = new SpaceWorkflowDefinitionVersionRepository(raw);
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (method: string, data: unknown) => new Promise<{ workflow: SpaceWorkflow }>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 15000);
    ws!.onmessage = event => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); replies.push({ method, input: data, reply }); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const initialNodes = [
    { id: 'start', name: 'Start', agents: [{ agentId: '', templateKey: 'worker.swe', name: 'Worker' }], transitions: [{ id: 'next', target: 'Finish', label: 'Continue' }] },
    { id: 'finish', name: 'Finish', agents: [{ agentId: '', templateKey: 'worker.swe', name: 'Reviewer' }], postApproval: { targetAgent: 'Worker', instructions: 'Report results' } },
  ];
  measuring = true;
  const workflow = (await rpc('spaceWorkflow.create', { spaceId: space.id, name: 'Node config', handle: 'node-config', nodes: initialNodes, startNodeId: 'start', endNodeId: 'finish' })).workflow;
  measuring = false;
  assert.deepEqual(workflow.nodes, initialNodes);
  const editedNodes = [
    initialNodes[1],
    { id: 'middle', name: 'Middle', agents: [{ agentId: '', templateKey: 'worker.swe', name: 'Middle worker' }] },
    { ...initialNodes[0], agents: [{ ...initialNodes[0].agents[0], customPrompt: { value: 'Complete worker prompt 甲乙🙂'.repeat(3000) }, timeoutMs: 123000, resetContextPerTurn: true, toolGuards: [{ matcher: 'Bash', pattern: 'blocked-fixture', decision: 'deny', reason: 'Synthetic guard' }] }] },
  ];
  measuring = true;
  const edited = (await rpc('spaceWorkflow.update', { id: workflow.id, spaceId: space.id, nodes: editedNodes })).workflow;
  measuring = false;
  assert.deepEqual(edited.nodes, editedNodes);
  assert.equal(edited.startNodeId, 'start'); assert.equal(edited.endNodeId, 'finish');
  const version = computeDefinitionVersion(edited), saved = versions.getVersion(workflow.id, version.versionHash);
  assert.equal(saved?.payload, version.payload);
  assert.equal(createHash('sha256').update(saved!.payload).digest('hex'), version.versionHash);
  const retained = editedNodes.filter(node => node.id !== 'middle').map(({ transitions: _transitions, postApproval: _postApproval, ...node }) => node);
  measuring = true;
  const cleared = (await rpc('spaceWorkflow.update', { id: workflow.id, spaceId: space.id, nodes: retained.map(node => ({ ...node, transitions: [] })) })).workflow;
  measuring = false;
  assert.deepEqual(cleared.nodes, retained);
  const read = (await rpc('spaceWorkflow.get', { id: workflow.id, spaceId: space.id })).workflow;
  assert.deepEqual(read, cleared);
  console.log('ok: real workflow create/update/get RPC preserves node order, insertion/removal, full slot config, post-approval/transitions and immutable definition payload/hash');
} finally {
  measuring = false; ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/workflow-node-config-contract.json'), JSON.stringify({ mode, replies, mainSql, sqlHash: createHash('sha256').update(mainSql.join('\n')).digest('hex'), limitation: 'Neutral node-config extraction; node writes remain on main until a later writer slice.' }, null, 2));
}
