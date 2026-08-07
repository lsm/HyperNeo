/**
 * PostApprovalCompletionService — deterministic, idempotent post-approval
 * completion tail (task #868).
 *
 * Covers the regression scenarios from the task spec: task #857 shape (merged
 * PR + stalled merger → completed), resume after each checkpoint, final
 * artifact failure, mark_complete failure, concurrent reconciler (lease),
 * already-deleted branch, workspace sync warning, merged-with-stale-status,
 * and the unmerged-PR safety invariant.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import { createSpaceTables } from '../../helpers/space-test-db';
import {
  PostApprovalCompletionService,
  type PostApprovalCompletionServiceDeps,
} from '../../../../src/lib/space/runtime/post-approval-completion-service';
import type {
  PostApprovalCompletionOps,
  PrMergeFacts,
  BranchCleanupResult,
  GitOpResult,
} from '../../../../src/lib/space/runtime/post-approval-completion-ops';
import type { SpaceTask, PostApprovalProgress } from '@hyperneo/shared';

const SPACE_ID = 'space-completion';
const PR_URL = 'https://github.com/owner/repo/pull/857';
const MERGED_FACTS: PrMergeFacts = {
  state: 'MERGED',
  merged: true,
  mergeCommit: 'mc-abc',
  baseRefName: 'dev',
  headRefOid: 'head-1',
  headRefName: 'space/feat',
  isCrossRepository: false,
};

interface OpsOverrides {
  fetchPrMergeFacts?: (url: string) => Promise<PrMergeFacts | null>;
  deleteRemoteBranch?: (opts: {
    prUrl: string;
    headRefName: string;
    workspacePath?: string;
  }) => Promise<BranchCleanupResult>;
  fetchWorktree?: (opts: { worktreePath?: string; baseBranch: string }) => Promise<GitOpResult>;
  syncSpaceCheckout?: (opts: {
    workspacePath?: string;
    baseBranch: string;
  }) => Promise<GitOpResult>;
}

function makeOps(
  overrides: OpsOverrides = {}
): PostApprovalCompletionOps & { calls: Record<string, number> } {
  const calls: Record<string, number> = {
    fetchPrMergeFacts: 0,
    deleteRemoteBranch: 0,
    fetchWorktree: 0,
    syncSpaceCheckout: 0,
  };
  return {
    calls,
    fetchPrMergeFacts: async (url) => {
      calls.fetchPrMergeFacts++;
      return overrides.fetchPrMergeFacts ? overrides.fetchPrMergeFacts(url) : { ...MERGED_FACTS };
    },
    deleteRemoteBranch: async (opts) => {
      calls.deleteRemoteBranch++;
      return overrides.deleteRemoteBranch
        ? overrides.deleteRemoteBranch(opts)
        : { ok: true, detail: `deleted ${opts.headRefName}` };
    },
    fetchWorktree: async (opts) => {
      calls.fetchWorktree++;
      return overrides.fetchWorktree
        ? overrides.fetchWorktree(opts)
        : { ok: true, detail: `fetched ${opts.baseBranch}` };
    },
    syncSpaceCheckout: async (opts) => {
      calls.syncSpaceCheckout++;
      return overrides.syncSpaceCheckout
        ? overrides.syncSpaceCheckout(opts)
        : { ok: true, detail: `synced ${opts.baseBranch}` };
    },
  };
}

interface Harness {
  db: Database;
  spaceId: string;
  runId: string;
  taskRepo: SpaceTaskRepository;
  artifactRepo: WorkflowRunArtifactRepository;
  taskManager: SpaceTaskManager;
  taskId: string;
  ops: ReturnType<typeof makeOps>;
  service: PostApprovalCompletionService;
  emitted: SpaceTask[];
}

function buildHarness(optsOverrides: OpsOverrides = {}): Harness {
  const db = new Database(':memory:');
  createSpaceTables(db as any);

  const spaceRepo = new SpaceRepository(db as any);
  const space = spaceRepo.createSpace({
    workspacePath: '/ws/completion',
    slug: 'completion',
    name: 'Completion',
  });
  const spaceId = space.id;

  const workflowRunRepo = new SpaceWorkflowRunRepository(db as any);
  const run = workflowRunRepo.createRun({
    spaceId,
    workflowId: 'wf-completion',
    title: 'run',
    description: '',
  });

  const taskRepo = new SpaceTaskRepository(db as any);
  const artifactRepo = new WorkflowRunArtifactRepository(db as any);
  const taskManager = new SpaceTaskManager(db as any, spaceId);

  // Canonical PR URL artifact (a link kind:'pr'), mirroring what the end-node
  // reviewer persists before approve_task.
  artifactRepo.upsert({
    id: 'pr-link',
    runId: run.id,
    nodeId: 'reviewer',
    artifactType: 'link',
    artifactKey: 'pr',
    data: { kind: 'pr', url: PR_URL },
  });

  const task = taskRepo.createTask({ spaceId, title: 'Ship PR', description: '' });
  taskRepo.updateTask(task.id, {
    status: 'approved',
    workflowRunId: run.id,
    postApprovalSessionId: 'space:post-approval:merger',
    postApprovalStartedAt: 1000,
    approvalSource: 'agent',
  });

  const ops = makeOps(optsOverrides);
  let now = 5_000_000;
  const emitted: SpaceTask[] = [];
  const deps: PostApprovalCompletionServiceDeps = {
    taskRepo,
    artifactRepo,
    ops,
    resolveTaskManager: () => taskManager,
    resolveWorkspacePath: () => '/ws/completion',
    resolveWorktreePath: () => '/ws/completion/worktree',
    onTaskUpdated: (task) => emitted.push(task),
    now: () => now,
    generateLeaseOwner: () => 'lease-test',
  };
  const service = new PostApprovalCompletionService(deps);

  return {
    db,
    spaceId,
    runId: run.id,
    taskRepo,
    artifactRepo,
    taskManager,
    taskId: task.id,
    ops,
    service,
    emitted,
  };
}

/** Read the persisted progress blob for a task (null after done clears it). */
function progressOf(h: Harness): PostApprovalProgress | null {
  return h.taskRepo.getTask(h.taskId)?.postApprovalProgress ?? null;
}

describe('PostApprovalCompletionService', () => {
  let h: Harness;
  afterEach(() => h?.db.close());

  // ------------------------------------------------------------------------
  // Scenario 1 + 8: task #857 shape — merged PR + stalled merger → completed.
  // ------------------------------------------------------------------------
  test('merged PR with a stalled merger is driven to done exactly once (task #857 shape)', async () => {
    h = buildHarness();
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });

    expect(result.outcome).toBe('completed');
    const task = h.taskRepo.getTask(h.taskId);
    expect(task?.status).toBe('done');
    expect(task?.completedAt).toBeGreaterThan(0);
    // Exactly one terminal result artifact.
    const decisions = h.artifactRepo.listByRun(h.runId, { artifactType: 'decision' });
    const results = decisions.filter((d) => !d.data.kind && d.data.summary);
    expect(results).toHaveLength(1);
    expect(results[0]?.data.merged_pr_url).toBe(PR_URL);
    // Completion status cleared once done (exit-approved branch nulled it).
    expect(task?.postApprovalCompletionStatus).toBeNull();
    // Every deterministic side effect ran exactly once.
    expect(h.ops.calls.deleteRemoteBranch).toBe(1);
    expect(h.ops.calls.fetchWorktree).toBe(1);
    expect(h.ops.calls.syncSpaceCheckout).toBe(1);
  });

  // ------------------------------------------------------------------------
  // Scenario 9: unmerged PR is NEVER completed.
  // ------------------------------------------------------------------------
  test('unmerged/blocked PR is left in approved (never marked complete)', async () => {
    h = buildHarness({
      fetchPrMergeFacts: async () => ({ state: 'OPEN', merged: false }),
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });

    expect(result.outcome).toBe('not-merged');
    const task = h.taskRepo.getTask(h.taskId);
    expect(task?.status).toBe('approved');
    // No completion status surfaced, no result artifact, no cleanup ran.
    expect(task?.postApprovalCompletionStatus).toBeNull();
    expect(h.ops.calls.deleteRemoteBranch).toBe(0);
    const decisions = h.artifactRepo.listByRun(h.runId, { artifactType: 'decision' });
    expect(decisions.filter((d) => !d.data.kind && d.data.summary)).toHaveLength(0);
  });

  test('a historical merge_blocked head does NOT strand a merged task (P1)', async () => {
    h = buildHarness();
    // Seed a STALE expected head from a prior merge_blocked attempt (H1). The
    // workflow allows the coder to push a new approved head (H2) before the
    // successful merge — recovery must not compare against the stale H1 and
    // permanently report identity-mismatch. The canonical-PR URL identity +
    // the merger's --match-head-commit are sufficient.
    h.artifactRepo.upsert({
      id: 'blk',
      runId: h.runId,
      nodeId: 'merger',
      artifactType: 'note',
      artifactKey: 'merge-blocked',
      data: { headRefOid: 'different-head' },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
  });

  test('task not in approved is not eligible', async () => {
    h = buildHarness();
    h.taskRepo.updateTask(h.taskId, { status: 'in_progress' });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('not-eligible');
  });

  test('task with no canonical PR URL returns no-pr-url', async () => {
    h = buildHarness();
    // Remove the PR link artifact.
    h.db.prepare('DELETE FROM workflow_run_artifacts WHERE artifact_type = ?').run('link');
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('no-pr-url');
  });

  // ------------------------------------------------------------------------
  // Scenario 2: resume after each checkpoint (daemon restart mid-tail).
  // ------------------------------------------------------------------------
  test('resumes from task_marked_done when earlier checkpoints are already persisted', async () => {
    h = buildHarness();
    // Simulate a restart that left every checkpoint except task_marked_done done.
    const startedAt = 9_000_000;
    const partial: PostApprovalProgress = {
      checkpoints: {
        merge_confirmed: { status: 'done', at: startedAt },
        branch_cleanup: { status: 'done', at: startedAt },
        worktree_fetched: { status: 'done', at: startedAt },
        space_synced: { status: 'done', at: startedAt },
        audit_persisted: { status: 'done', at: startedAt },
      },
      prUrl: PR_URL,
      baseBranch: 'dev',
      mergeCommit: 'mc-abc',
      expectedHeadOid: 'head-1',
    };
    h.taskRepo.updateTask(h.taskId, { postApprovalProgress: partial });

    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
    // Resumed run must NOT re-run already-completed side effects.
    expect(h.ops.calls.deleteRemoteBranch).toBe(0);
    expect(h.ops.calls.fetchWorktree).toBe(0);
    expect(h.ops.calls.syncSpaceCheckout).toBe(0);
    expect(h.ops.calls.fetchPrMergeFacts).toBe(0);
  });

  test('resumes from branch_cleanup when only merge_confirmed is persisted', async () => {
    h = buildHarness();
    const partial: PostApprovalProgress = {
      checkpoints: { merge_confirmed: { status: 'done', at: 9_000_000 } },
      prUrl: PR_URL,
      baseBranch: 'dev',
      mergeCommit: 'mc-abc',
      expectedHeadOid: 'head-1',
      headRefName: 'space/feat',
      isCrossRepository: false,
    };
    h.taskRepo.updateTask(h.taskId, { postApprovalProgress: partial });

    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
    // merge_confirmed already done → no re-fetch; downstream ran once.
    expect(h.ops.calls.fetchPrMergeFacts).toBe(0);
    expect(h.ops.calls.deleteRemoteBranch).toBe(1);
  });

  test('a transient gh lookup failure defers and the next run completes', async () => {
    h = buildHarness();
    let failOnce = true;
    const realService = h.service;
    // Rebuild ops that fail the first lookup then succeed.
    h.ops = makeOps({
      fetchPrMergeFacts: async () => (failOnce ? ((failOnce = false), null) : { ...MERGED_FACTS }),
    });
    (realService as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.ops = h.ops;
    const r1 = await realService.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(r1.outcome).toBe('lookup-failed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
    // merge_confirmed NOT persisted on a lookup failure.
    expect(progressOf(h)?.checkpoints.merge_confirmed).toBeUndefined();

    const r2 = await realService.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(r2.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
  });

  // ------------------------------------------------------------------------
  // Scenario 3: final artifact API failure does not strand the task.
  // ------------------------------------------------------------------------
  test('final artifact upsert failure defers (never silently loses the audit)', async () => {
    h = buildHarness();
    // Wrap artifactRepo.upsert to throw on decision writes.
    const realUpsert = h.artifactRepo.upsert.bind(h.artifactRepo);
    let decisionThrows = true;
    h.artifactRepo.upsert = (params) => {
      if (decisionThrows && params.artifactType === 'decision') {
        throw new Error('artifact API timeout');
      }
      return realUpsert(params);
    };
    const r1 = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    // audit_persisted is NOT best-effort: a failed write must defer so the
    // terminal result artifact is never permanently lost (the task would
    // otherwise go done, clearing progress, with no retry path).
    expect(r1.outcome).toBe('lookup-failed');
    expect(r1.detail).toContain('audit artifact write failed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
    const after1 = progressOf(h);
    expect(after1?.checkpoints.merge_confirmed?.status).toBe('done');
    expect(after1?.checkpoints.audit_persisted).toBeUndefined();

    // Retry succeeds once the artifact write recovers.
    decisionThrows = false;
    const r2 = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(r2.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
  });

  // ------------------------------------------------------------------------
  // Scenario 4: mark_complete failure is retried on the next sweep.
  // ------------------------------------------------------------------------
  test('mark_complete failure leaves the task approved and is retried', async () => {
    h = buildHarness();
    let markCalls = 0;
    const realManager = h.taskManager;
    const failing: Pick<SpaceTaskManager, 'setTaskStatus'> = {
      setTaskStatus: async (taskId, status, opts) => {
        markCalls++;
        if (markCalls === 1) throw new Error('API timeout marking done');
        // Delegate to the real manager on retry.
        return realManager.setTaskStatus(taskId as never, status as never, opts as never);
      },
    };
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.resolveTaskManager =
      () => failing as unknown as SpaceTaskManager;

    const r1 = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(r1.outcome).toBe('lookup-failed');
    expect(r1.detail).toContain('mark_done failed');
    // Task stays approved; the task_marked_done checkpoint is NOT persisted,
    // but earlier checkpoints ARE (resume is safe).
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
    const after1 = progressOf(h);
    expect(after1?.checkpoints.merge_confirmed?.status).toBe('done');
    expect(after1?.checkpoints.audit_persisted?.status).toBe('done');
    expect(after1?.checkpoints.task_marked_done).toBeUndefined();

    const r2 = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(r2.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
  });

  // ------------------------------------------------------------------------
  // Scenario 5: concurrent reconciler — lease prevents duplicate completion.
  // ------------------------------------------------------------------------
  test('concurrent resumeCompletion calls do not duplicate the tail (lease CAS)', async () => {
    h = buildHarness();
    // Slow fetchPrMergeFacts so both calls overlap before the first completes.
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.ops = makeOps({
      fetchPrMergeFacts: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ...MERGED_FACTS };
      },
    });
    // Distinct lease owners so the CAS is exercised (not same-owner short-circuit).
    let n = 0;
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.generateLeaseOwner =
      () => `lease-${n++}`;

    const [a, b] = await Promise.all([
      h.service.resumeCompletion(h.taskId, { source: 'reconciler' }),
      h.service.resumeCompletion(h.taskId, { source: 'reconciler' }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toContain('completed');
    expect(outcomes).toContain('lease-held');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
  });

  // ------------------------------------------------------------------------
  // Scenario 6: already-deleted branch is idempotent success.
  // ------------------------------------------------------------------------
  test('already-deleted remote branch is treated as success', async () => {
    h = buildHarness({
      deleteRemoteBranch: async (opts) => ({
        ok: true,
        alreadyGone: true,
        detail: `branch ${opts.headRefName} already absent`,
      }),
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
  });

  test('forked PR branch cleanup is skipped (kept in fork)', async () => {
    h = buildHarness({
      fetchPrMergeFacts: async () => ({ ...MERGED_FACTS, isCrossRepository: true }),
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
    expect(h.ops.calls.deleteRemoteBranch).toBe(0); // fork → skipped
  });

  // ------------------------------------------------------------------------
  // Scenario 7: workspace sync warning — failure records a warning, task completes.
  // ------------------------------------------------------------------------
  test('workspace sync failure records a non-result warning and still completes', async () => {
    h = buildHarness({
      syncSpaceCheckout: async () => ({ ok: false, detail: 'space checkout diverged' }),
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
    // A NON-result warning note artifact exists (never a terminal result).
    const notes = h.artifactRepo.listByRun(h.runId, { artifactType: 'note' });
    const warning = notes.find(
      (n) => n.data.kind === 'cleanup_warning' && String(n.data.summary).includes('sync')
    );
    expect(warning).toBeTruthy();
    // Still exactly one terminal result.
    const decisions = h.artifactRepo.listByRun(h.runId, { artifactType: 'decision' });
    expect(decisions.filter((d) => !d.data.kind && d.data.summary)).toHaveLength(1);
  });

  test('branch cleanup failure records a warning and still completes', async () => {
    h = buildHarness({
      deleteRemoteBranch: async (opts) => ({ ok: false, detail: `protected: ${opts.headRefName}` }),
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
    const notes = h.artifactRepo.listByRun(h.runId, { artifactType: 'note' });
    expect(notes.some((n) => n.data.kind === 'cleanup_warning')).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Surfacing: completion status is set while in flight.
  // ------------------------------------------------------------------------
  test('surfaces "completion recovery" status once the merge is confirmed', async () => {
    h = buildHarness({
      fetchPrMergeFacts: async () => {
        // Assert the status is set mid-tail (after merge confirmed, before done).
        const mid = h.taskRepo.getTask(h.taskId);
        expect(mid?.postApprovalCompletionStatus).toBe('completion recovery');
        return { ...MERGED_FACTS };
      },
    });
    // fetchPrMergeFacts runs BEFORE the status is set (it's what confirms the
    // merge), so the assertion above fires on the SECOND checkpoint instead.
    // Wrap deleteRemoteBranch to assert after merge_confirmed persisted.
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.ops = makeOps({
      fetchPrMergeFacts: async () => ({ ...MERGED_FACTS }),
      deleteRemoteBranch: async (opts) => {
        const mid = h.taskRepo.getTask(h.taskId);
        expect(mid?.postApprovalCompletionStatus).toBe('completion recovery');
        return { ok: true, detail: `deleted ${opts.headRefName}` };
      },
    });
    await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
  });

  // ------------------------------------------------------------------------
  // P2 (review): emit space.task.updated for in-flight status + done.
  // ------------------------------------------------------------------------
  test('emits task updates for the in-flight status and the done transition', async () => {
    h = buildHarness();
    await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    const statuses = h.emitted.map((t) => t.status);
    // At least one emit while still approved (finalizing/recovery status) and
    // a final emit once done.
    expect(statuses).toContain('approved');
    expect(statuses).toContain('done');
    const finalEmit = h.emitted[h.emitted.length - 1]!;
    expect(finalEmit.status).toBe('done');
  });

  test('does not emit an in-flight status when the PR is not merged', async () => {
    h = buildHarness({ fetchPrMergeFacts: async () => ({ state: 'OPEN', merged: false }) });
    await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    // No done emit, and no approved emit carrying the completion status.
    expect(h.emitted.some((t) => t.status === 'done')).toBe(false);
    expect(h.emitted.some((t) => t.postApprovalCompletionStatus)).toBe(false);
  });

  // ------------------------------------------------------------------------
  // P2 (review): reopen-and-remerge refreshes the stable audit artifact.
  // ------------------------------------------------------------------------
  test('reopen + remerge refreshes the stable result artifact (no stale summary)', async () => {
    h = buildHarness();
    await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    const PR_URL_2 = 'https://github.com/owner/repo/pull/999';
    // Simulate reopen: clear completion state, point the canonical PR at a new URL.
    h.taskRepo.updateTask(h.taskId, {
      status: 'approved',
      completedAt: null,
      postApprovalProgress: null,
      postApprovalCompletionStatus: null,
    });
    h.artifactRepo.upsert({
      id: 'pr-link-2',
      runId: h.runId,
      nodeId: 'reviewer',
      artifactType: 'link',
      artifactKey: 'pr',
      data: { kind: 'pr', url: PR_URL_2 },
    });
    // The newer PR link wins canonical resolution (most recently updated).
    h.artifactRepo.upsert({
      id: 'pr-link',
      runId: h.runId,
      nodeId: 'reviewer',
      artifactType: 'link',
      artifactKey: 'pr',
      data: { kind: 'pr', url: PR_URL_2 },
    });

    await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('done');
    // Exactly one stable completion artifact, refreshed to the new PR URL.
    const decisions = h.artifactRepo.listByRun(h.runId, { artifactType: 'decision' });
    const stable = decisions.filter((d) => !d.data.kind && d.data.summary);
    expect(stable.every((d) => d.data.merged_pr_url === PR_URL_2)).toBe(true);
  });

  // ------------------------------------------------------------------------
  // P1 (review r2): abort if the task changed (cancel/reopen) before done.
  // ------------------------------------------------------------------------
  test('aborts the done transition if the task was cancelled mid-tail', async () => {
    h = buildHarness({
      syncSpaceCheckout: async () => {
        // Simulate a concurrent user cancel during the awaited sync step.
        h.taskRepo.updateTask(h.taskId, { status: 'cancelled' });
        return { ok: true, detail: 'synced' };
      },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('not-eligible');
    // The explicit cancel is NOT overwritten to done.
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('cancelled');
  });

  test('aborts if the completion lease was lost before done', async () => {
    h = buildHarness({
      // After sync, forcibly clear our lease (e.g. it self-expired and was
      // re-claimed) so the pre-done revalidation sees we no longer own it.
      syncSpaceCheckout: async () => {
        h.taskRepo.updateTask(h.taskId, {
          postApprovalCompletionLeaseOwner: 'someone-else',
          postApprovalCompletionLeaseExpiresAt: 999_999_999,
        });
        return { ok: true, detail: 'synced' };
      },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('not-eligible');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
  });

  test('aborts the tail when the lease is lost mid-way (heartbeat renewal)', async () => {
    h = buildHarness({
      // The branch-delete await outlasts the lease TTL; another owner claims
      // it. The renewal before worktree_fetched must detect the lost lease and
      // abort instead of continuing destructive steps.
      deleteRemoteBranch: async (opts) => {
        h.taskRepo.updateTask(h.taskId, {
          postApprovalCompletionLeaseOwner: 'someone-else',
          postApprovalCompletionLeaseExpiresAt: 999_999_999,
        });
        return { ok: true, detail: `deleted ${opts.headRefName}` };
      },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('not-eligible');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
    // merge_confirmed was persisted before the lease was stolen; branch_cleanup
    // is NOT persisted (the lease was stolen during the delete, so the guarded
    // write is skipped — a later reclaim redoes the idempotent delete).
    const after = progressOf(h);
    expect(after?.checkpoints.merge_confirmed?.status).toBe('done');
    expect(after?.checkpoints.branch_cleanup).toBeUndefined();
    expect(after?.checkpoints.worktree_fetched).toBeUndefined();
  });

  test('progress writes are skipped once the task leaves approved (no stale resurrection)', async () => {
    h = buildHarness({
      // Simulate a cancel landing during the branch-delete await: setTaskStatus
      // flips status to cancelled AND (exit-approved branch) clears completion
      // fields. The service must not write stale progress back afterward.
      deleteRemoteBranch: async (opts) => {
        h.taskRepo.updateTask(h.taskId, {
          status: 'cancelled',
          postApprovalProgress: null,
        });
        return { ok: true, detail: `deleted ${opts.headRefName}` };
      },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    // The pre-done revalidation aborts; no stale progress is written back onto
    // the cancelled task (so a later reapproval starts a fresh tail).
    expect(result.outcome).toBe('not-eligible');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('cancelled');
    expect(progressOf(h)).toBeNull();
  });

  // ------------------------------------------------------------------------
  // P1 (review r2): service rechecks space lifecycle after the lease claim.
  // ------------------------------------------------------------------------
  test('service refuses to complete a task in a stopped space', async () => {
    h = buildHarness();
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.isSpaceRecoverable =
      () => false;
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('not-eligible');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
    // Lease released (not held).
    expect(h.taskRepo.getTask(h.taskId)?.postApprovalCompletionLeaseOwner).toBeNull();
  });

  // ------------------------------------------------------------------------
  // P2 (review r2): reset checkpoints when the canonical PR changes.
  // ------------------------------------------------------------------------
  test('resets prior checkpoints when the canonical PR changes', async () => {
    h = buildHarness();
    // A prior partial run confirmed a DIFFERENT PR.
    h.taskRepo.updateTask(h.taskId, {
      postApprovalProgress: {
        checkpoints: { merge_confirmed: { status: 'done', at: 1 } },
        prUrl: 'https://github.com/owner/repo/pull/OLD',
        baseBranch: 'dev',
        mergeCommit: 'old-mc',
        expectedHeadOid: 'old-head',
        headRefName: 'old',
        isCrossRepository: false,
      },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
    // merge_confirmed was reset → the lookup re-ran for the new PR.
    expect(h.ops.calls.fetchPrMergeFacts).toBe(1);
  });

  // ------------------------------------------------------------------------
  // P2 (review r2): distinct warning-artifact keys per cleanup operation.
  // ------------------------------------------------------------------------
  test('records distinct warning artifacts per cleanup operation', async () => {
    h = buildHarness({
      deleteRemoteBranch: async (opts) => ({ ok: false, detail: `protected ${opts.headRefName}` }),
      syncSpaceCheckout: async () => ({ ok: false, detail: 'diverged' }),
    });
    await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    const notes = h.artifactRepo.listByRun(h.runId, { artifactType: 'note' });
    const keys = notes.map((n) => n.artifactKey).sort();
    expect(keys).toContain('post-approval-warning-branch_cleanup');
    expect(keys).toContain('post-approval-warning-space_synced');
  });

  // ------------------------------------------------------------------------
  // P1 (review r4): recheck space lifecycle after the gh lookup.
  // ------------------------------------------------------------------------
  test('aborts destructive steps if the space stops mid-tail (after the lookup)', async () => {
    h = buildHarness();
    let spaceStopped = false;
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.isSpaceRecoverable =
      () => !spaceStopped;
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.ops = makeOps({
      fetchPrMergeFacts: async () => ({ ...MERGED_FACTS }),
      deleteRemoteBranch: async (opts) => {
        // A stop lands during the branch-delete step (after the lookup).
        spaceStopped = true;
        return { ok: true, detail: `deleted ${opts.headRefName}` };
      },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    // branch_cleanup ran, then the reassert before worktree_fetched sees the
    // stop → abort. The task stays approved (destructive sync never runs).
    expect(result.outcome).toBe('not-eligible');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
    expect((result as { detail?: string }).detail).toContain('space stopped');
  });

  // ------------------------------------------------------------------------
  // P1 (review r5): restrict recovery to the merger route.
  // ------------------------------------------------------------------------
  test('a non-merger post-approval route is never completed by the merge tail', async () => {
    h = buildHarness();
    (
      h.service as unknown as { deps: PostApprovalCompletionServiceDeps }
    ).deps.resolvePostApprovalTargetAgent = () => 'release-publisher';
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('not-eligible');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
    expect(h.ops.calls.deleteRemoteBranch).toBe(0); // no destructive steps
  });

  test('a merger route (targetAgent "merger") is recovered normally', async () => {
    h = buildHarness();
    (
      h.service as unknown as { deps: PostApprovalCompletionServiceDeps }
    ).deps.resolvePostApprovalTargetAgent = () => 'merger';
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('completed');
  });

  // ------------------------------------------------------------------------
  // P2 (review r5): recheck merger liveness after the awaited gh lookup.
  // ------------------------------------------------------------------------
  test('aborts if the merger reactivates during the lookup', async () => {
    h = buildHarness();
    let active = false;
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.mergerLivenessProbe =
      {
        isSessionActivelyProcessing: () => active,
        isSessionInMemory: () => true,
      };
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.ops = makeOps({
      fetchPrMergeFacts: async () => {
        // The idle merger reactivates while the lookup is pending.
        active = true;
        return { ...MERGED_FACTS };
      },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('not-eligible');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
    expect(h.ops.calls.deleteRemoteBranch).toBe(0); // deferred to the active merger
  });

  // ------------------------------------------------------------------------
  // P1 (review r5): recheck space lifecycle before the terminal done write.
  // ------------------------------------------------------------------------
  test('aborts the done transition if the space stops during syncSpaceCheckout', async () => {
    h = buildHarness();
    let spaceStopped = false;
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.isSpaceRecoverable =
      () => !spaceStopped;
    (h.service as unknown as { deps: PostApprovalCompletionServiceDeps }).deps.ops = makeOps({
      fetchPrMergeFacts: async () => ({ ...MERGED_FACTS }),
      syncSpaceCheckout: async () => {
        spaceStopped = true; // stop lands during the final destructive step
        return { ok: true, detail: 'synced' };
      },
    });
    const result = await h.service.resumeCompletion(h.taskId, { source: 'reconciler' });
    expect(result.outcome).toBe('not-eligible');
    expect(h.taskRepo.getTask(h.taskId)?.status).toBe('approved');
  });
});
