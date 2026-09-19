import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/workflows/workflow-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import {
  ORPHANED_IN_PROGRESS_GRACE_MS,
  selectOrphanedInProgressTasks,
} from '../../../../src/lib/tasks/orphaned-task-recovery.ts';
import { availableTaskSlots } from '../../../../src/lib/tasks/capacity.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { seedUnifiedAgentMirror } from '../../helpers/seed-unified-agent';

describe('orphaned in_progress task recovery', () => {
  const SPACE_ID = 'space-orphan-recovery';
  const AGENT_ID = 'agent-orphan-recovery';
  const START_NODE_ID = 'start-node';
  const NOW = 1_800_000_000_000;

  let db: BunDatabase;
  let taskRepo: SpaceTaskRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    db.prepare(
      `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
         allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
         VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', 1, ?, ?)`
    ).run(SPACE_ID, '/tmp/orphan-recovery-ws', 'Orphans', SPACE_ID, Date.now(), Date.now());
    seedUnifiedAgentMirror(db, { id: AGENT_ID, spaceId: SPACE_ID, name: 'Worker' });

    taskRepo = new SpaceTaskRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    spaceManager = new SpaceManager(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function addWorkflow(): void {
    workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Delivery',
      description: 'Delivery workflow',
      nodes: [{ id: START_NODE_ID, name: 'Step', agentId: AGENT_ID }],
      startNodeId: START_NODE_ID,
      tags: ['default'],
      completionAutonomyLevel: 3,
    });
  }

  function buildRuntime(): SpaceRuntime {
    return new SpaceRuntime({
      db,
      spaceManager,
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
    });
  }

  function orphanedTask(startedMsAgo: number): SpaceTask {
    const task = taskRepo.createTask({ spaceId: SPACE_ID, title: 'Stuck', description: '' });
    taskRepo.updateTask(task.id, { status: 'in_progress', startedAt: Date.now() - startedMsAgo });
    return taskRepo.getTask(task.id)!;
  }

  function candidate(overrides: Partial<SpaceTask>, hasDirectAttempt = false) {
    return {
      task: {
        id: 't',
        spaceId: SPACE_ID,
        status: 'in_progress',
        startedAt: NOW - ORPHANED_IN_PROGRESS_GRACE_MS,
        workflowRunId: null,
        taskAgentSessionId: null,
        archivedAt: null,
        updatedAt: NOW,
        ...overrides,
      } as SpaceTask,
      hasDirectAttempt,
    };
  }

  test('a task in_progress past the grace window with no run, session or attempt is selected', () => {
    expect(selectOrphanedInProgressTasks([candidate({})], NOW)).toHaveLength(1);
  });

  test('a task still inside the grace window is left alone', () => {
    const fresh = candidate({ startedAt: NOW - ORPHANED_IN_PROGRESS_GRACE_MS + 1 });
    expect(selectOrphanedInProgressTasks([fresh], NOW)).toEqual([]);
  });

  test('a run, an agent session or a live direct attempt each protect the task', () => {
    expect(selectOrphanedInProgressTasks([candidate({ workflowRunId: 'run-1' })], NOW)).toEqual([]);
    expect(
      selectOrphanedInProgressTasks([candidate({ taskAgentSessionId: 'session-1' })], NOW)
    ).toEqual([]);
    expect(selectOrphanedInProgressTasks([candidate({}, true)], NOW)).toEqual([]);
    expect(selectOrphanedInProgressTasks([candidate({ status: 'review' })], NOW)).toEqual([]);
  });

  test('a tick reopens the orphan and releases the concurrency slot it held', async () => {
    const stuck = orphanedTask(ORPHANED_IN_PROGRESS_GRACE_MS + 60_000);
    const space = new SpaceRepository(db).getSpace(SPACE_ID)!;
    expect(availableTaskSlots(space, taskRepo.listBySpace(SPACE_ID))).toBe(0);

    await buildRuntime().executeTick();

    const reopened = taskRepo.getTask(stuck.id)!;
    expect(reopened.status).toBe('open');
    expect(reopened.startedAt).toBeNull();
    expect(availableTaskSlots(space, taskRepo.listBySpace(SPACE_ID))).toBe(1);
  });

  test('the reopened task then starts a real workflow run on the same tick', async () => {
    addWorkflow();
    const stuck = orphanedTask(ORPHANED_IN_PROGRESS_GRACE_MS + 60_000);

    await buildRuntime().executeTick();

    const started = taskRepo.getTask(stuck.id)!;
    expect(started.status).toBe('in_progress');
    expect(started.workflowRunId).toBeTruthy();
    expect(workflowRunRepo.getRun(started.workflowRunId!)?.spaceId).toBe(SPACE_ID);
  });

  test('a task inside the grace window survives a tick untouched', async () => {
    const recent = orphanedTask(1_000);

    await buildRuntime().executeTick();

    expect(taskRepo.getTask(recent.id)?.status).toBe('in_progress');
  });
});
