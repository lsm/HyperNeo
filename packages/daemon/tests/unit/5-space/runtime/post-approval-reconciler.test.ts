/**
 * PostApprovalReconciler — eligibility, throttling, cooldowns (task #868).
 *
 * The deterministic tail is exhaustively covered by the completion-service
 * tests; these tests focus on the reconciler's scan predicate: which `approved`
 * tasks get resumed, how the throttle/cooldowns bound GitHub traffic, and that
 * a live merger is never raced.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { createSpaceTables } from '../../helpers/space-test-db';
import { PostApprovalReconciler } from '../../../../src/lib/space/runtime/post-approval-reconciler';
import type { PostApprovalCompletionResult } from '../../../../src/lib/space/runtime/post-approval-completion-service';
import type { PrMergeFacts } from '../../../../src/lib/space/runtime/post-approval-completion-ops';
import type { SpaceTask } from '@hyperneo/shared';

const PR_URL = 'https://github.com/owner/repo/pull/1';
const MERGED: PrMergeFacts = {
  state: 'MERGED',
  merged: true,
  mergeCommit: 'mc',
  baseRefName: 'dev',
  headRefOid: 'h',
  headRefName: 'feat',
  isCrossRepository: false,
};

interface Harness {
  db: Database;
  taskRepo: SpaceTaskRepository;
  artifactRepo: WorkflowRunArtifactRepository;
  resumed: string[];
  completed: SpaceTask[];
  setMerged(url: string, facts: PrMergeFacts | null): void;
  seedTask(): SpaceTask;
  build(stale: (t: SpaceTask, now: number) => boolean): PostApprovalReconciler;
}

function buildHarness(): Harness {
  const db = new Database(':memory:');
  createSpaceTables(db as any);
  const spaceRepo = new SpaceRepository(db as any);
  const space = spaceRepo.createSpace({ workspacePath: '/ws', slug: 'rec', name: 'Rec' });
  const runRepo = new SpaceWorkflowRunRepository(db as any);
  const taskRepo = new SpaceTaskRepository(db as any);
  const artifactRepo = new WorkflowRunArtifactRepository(db as any);

  const resumed: string[] = [];
  const completed: SpaceTask[] = [];
  const factsByUrl = new Map<string, PrMergeFacts | null>([[PR_URL, { ...MERGED }]]);

  let clock = 1_000_000;

  const serviceStub = {
    resumeCompletion: async (taskId: string): Promise<PostApprovalCompletionResult> => {
      resumed.push(taskId);
      taskRepo.updateTask(taskId, { status: 'done', completedAt: clock });
      const task = taskRepo.getTask(taskId);
      if (task) completed.push(task);
      return { outcome: 'completed', taskId, prUrl: PR_URL, task: task ?? undefined };
    },
  };

  const opsStub = {
    fetchPrMergeFacts: async (url: string) => factsByUrl.get(url) ?? null,
    deleteRemoteBranch: async () => ({ ok: true, detail: 'x' }),
    fetchWorktree: async () => ({ ok: true, detail: 'x' }),
    syncSpaceCheckout: async () => ({ ok: true, detail: 'x' }),
  };

  function build(stale: (t: SpaceTask, now: number) => boolean): PostApprovalReconciler {
    return new PostApprovalReconciler({
      taskRepo,
      artifactRepo,
      ops: opsStub as never,
      service: serviceStub as never,
      isMergerStale: stale,
      onTaskCompleted: (t) => completed.push(t),
      now: () => clock,
      intervalMs: 1000,
      notMergedCooldownMs: 5000,
      lookupFailedCooldownMs: 1000,
      completedCooldownMs: 5000,
      noPrUrlCooldownMs: 5000,
    });
  }

  function seedTask(): SpaceTask {
    const run = runRepo.createRun({
      spaceId: space.id,
      workflowId: 'wf',
      title: 'r',
      description: '',
    });
    artifactRepo.upsert({
      id: `pr-${run.id}`,
      runId: run.id,
      nodeId: 'reviewer',
      artifactType: 'link',
      artifactKey: 'pr',
      data: { kind: 'pr', url: PR_URL },
    });
    const task = taskRepo.createTask({ spaceId: space.id, title: 'T', description: '' });
    taskRepo.updateTask(task.id, {
      status: 'approved',
      workflowRunId: run.id,
      postApprovalSessionId: 'merger-1',
      postApprovalStartedAt: 0,
    });
    return taskRepo.getTask(task.id)!;
  }

  return {
    db,
    taskRepo,
    artifactRepo,
    resumed,
    completed,
    setMerged: (url, facts) => factsByUrl.set(url, facts),
    seedTask,
    build,
  };
}

describe('PostApprovalReconciler', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });
  afterEach(() => h.db.close());

  test('merged PR + stale merger → resumed and completed', async () => {
    const task = h.seedTask();
    const rec = h.build(() => true);
    const res = await rec.runRecovery({ force: true });
    expect(res?.completed).toBe(1);
    expect(h.resumed).toEqual([task.id]);
    expect(h.taskRepo.getTask(task.id)?.status).toBe('done');
  });

  test('unmerged PR is never resumed (left approved)', async () => {
    const task = h.seedTask();
    h.setMerged(PR_URL, { state: 'OPEN', merged: false });
    const rec = h.build(() => true);
    const res = await rec.runRecovery({ force: true });
    expect(res?.notMerged).toBe(1);
    expect(res?.resumed).toBe(0);
    expect(h.taskRepo.getTask(task.id)?.status).toBe('approved');
  });

  test('live (non-stale) merger is not raced', async () => {
    const task = h.seedTask();
    const rec = h.build(() => false); // merger alive + within grace
    const res = await rec.runRecovery({ force: true });
    expect(res?.deferred).toBe(1);
    expect(res?.resumed).toBe(0);
    expect(h.taskRepo.getTask(task.id)?.status).toBe('approved');
  });

  test('throttle: second call within interval is a no-op', async () => {
    h.seedTask();
    const rec = h.build(() => true);
    const first = await rec.runRecovery({ force: true });
    expect(first?.completed).toBe(1);
    const second = await rec.runRecovery(); // not forced, within interval
    expect(second).toBeNull();
  });

  test('lookup failure enters a short cooldown (deferred, not completed)', async () => {
    const task = h.seedTask();
    h.setMerged(PR_URL, null); // gh lookup fails
    const rec = h.build(() => true);
    const res = await rec.runRecovery({ force: true });
    expect(res?.deferred).toBe(1);
    expect(h.taskRepo.getTask(task.id)?.status).toBe('approved');
  });

  test('completed task enters a cooldown so it is not re-touched', async () => {
    const task = h.seedTask();
    const rec = h.build(() => true);
    await rec.runRecovery({ force: true });
    expect(h.taskRepo.getTask(task.id)?.status).toBe('done');
    // The task is now done → listApprovedTasks no longer returns it.
    const again = await rec.runRecovery({ force: true });
    expect(again?.resumed).toBe(0);
  });
});
