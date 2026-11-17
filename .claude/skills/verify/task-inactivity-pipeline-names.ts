import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { SpaceTaskRepository } from '../../../packages/daemon/src/storage/repositories/space-task-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../packages/daemon/src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
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
const replies: { operation: string; data: unknown }[] = [];
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const space = new SpaceRepository(app.db.getDatabase()).createSpace({ slug: 'schedule-fixture', name: 'Schedules', workspacePath: join(run, 'workspace') });
  const db = app.db.getDatabase();
  const task = new SpaceTaskRepository(db).createTask({ spaceId: space.id, title: 'RPC proof', status: 'open' });
  const agent = new SpaceLongHorizonAgentRepository(db).create({ spaceId: space.id, handle: 'watcher' });
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const invoke = (operation: string, input: object) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { ws!.removeEventListener('message', listener); fail(new Error(`RPC timeout: ${operation}`)); }, 15000);
    const listener = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); ws!.removeEventListener('message', listener);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else { replies.push({ operation, data: reply.data }); done(reply.data); }
    };
    ws!.addEventListener('message', listener);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: operation, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const calls: [string, object][] = [
    ['task.workerSession.handoff', { taskId: 'missing' }],
    ['task.member.list', { taskId: 'missing' }],
    ['task.member.list', { taskId: task.id }],
    ['task.retry', { taskId: 'missing' }],
    ['task.preferredWorkflow.set', { taskId: 'missing', workflowId: null }],
    ['task.start', { taskId: 'missing', requestKey: 'proof' }],
    ['inactivity.config.get', { spaceId: space.id, agentId: 'missing' }],
    ['inactivity.config.get', { spaceId: space.id, agentId: agent.id }],
    ['inactivity.config.set', { spaceId: space.id, agentId: agent.id, enabled: false }],
    ['inactivity.config.get', { spaceId: space.id, agentId: agent.id }],
    ['inactivity.scan.run', { spaceId: space.id, agentId: agent.id }],
  ];
  for (const [operation, input] of calls) await invoke(operation, input);
  assert.equal(replies.length, calls.length);
  assert.equal(replies[0].data, 'task_not_found');
  assert.equal(replies[1].data, null);
  assert.deepEqual(replies[2].data, { taskId: task.id, workflowRunId: null, members: [] });
  assert.equal(replies[3].data, 'task_not_found');
  assert.equal(replies[4].data, null);
  assert.deepEqual(replies[5].data, { accepted: false, reason: 'direct_start_unavailable' });
  assert.equal(replies[6].data, 'agent_unknown');
  assert.deepEqual(replies[7].data, { config: null, degraded: false, scope: { spaceId: space.id } });
  assert.equal((replies[8].data as { enabled: boolean }).enabled, false);
  assert.deepEqual((replies[9].data as { config: unknown }).config, replies[8].data);
  assert.deepEqual(replies[10].data, { started: true, scope: { spaceId: space.id } });
  console.log(`ok: ${replies.length} authenticated task and inactivity RPC replies`);
} finally {
  ws?.close(); await app.cleanup(); globalThis.fetch = originalFetch;
  writeFileSync(join(run, 'evidence/task-inactivity-pipeline-names.json'), JSON.stringify(replies, null, 2));
}
