import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { SpaceRepository } from '../../../packages/daemon/src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../packages/daemon/src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../packages/daemon/src/storage/repositories/space-workflow-run-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'workspace'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: Record<string, unknown> = {};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  const space = new SpaceRepository(db).createSpace({ name: 'Synthetic', slug: 'synthetic', workspacePath: join(run, 'workspace') });
  const task = new SpaceTaskRepository(db).createTask({ spaceId: space.id, title: 'Synthetic task' });
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId: space.id, name: 'Synthetic workflow' });
  const workflowRun = new SpaceWorkflowRunRepository(db).createRun({ spaceId: space.id, workflowId: workflow.id, title: 'Synthetic run' });
  db.prepare('UPDATE space_tasks SET workflow_run_id=? WHERE id=?').run(workflowRun.id, task.id);
  const registry = app.sessionManager.getOperationRegistry();
  const caller = { source: 'mcp', role: 'workflow_worker', sessionId: 'synthetic-sender' } as const;
  const invoke = (input: object, actor = caller) => invokeOperation(registry, 'task.message.send', input, actor);
  const input = { spaceId: space.id, taskId: task.id, message: 'Synthetic message' };
  const missingTarget = await invoke(input);
  const missingNode = await invoke({ ...input, nodeId: 'absent-node' });
  const missingTask = await invoke({ ...input, taskId: 'absent-task', nodeId: 'absent-node' });
  assert.match(JSON.stringify(missingTarget), /Target agent is required/);
  assert.match(JSON.stringify(missingNode), /Node not found/);
  assert.match(JSON.stringify(missingTask), /Task not found/);
  evidence.results = { missingTarget, missingNode, missingTask };
  evidence.verified = true;
  console.log('task.message.send: three real daemon operation refusals observed');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
