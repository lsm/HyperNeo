/**
 * Space Workflow Run RPC Handlers
 *
 * RPC handlers for SpaceWorkflowRun lifecycle:
 * - spaceWorkflowRun.start          - Creates a run and triggers first step task creation
 * - spaceWorkflowRun.list           - Lists runs for a space (optional status filter)
 * - spaceWorkflowRun.get            - Gets a run by ID
 * - spaceWorkflowRun.cancel         - Cancels a run and all pending tasks
 * - spaceWorkflowRun.markFailed     - Marks a run as blocked with a specific failure reason
 * - spaceWorkflowRun.getGateArtifacts   - Returns uncommitted files and diff summary for a run's worktree
 * - spaceWorkflowRun.getFileDiff        - Returns unified diff for a specific uncommitted file
 * - spaceWorkflowRun.getCommits         - Returns git commits between branch point and HEAD with per-commit stats
 * - spaceWorkflowRun.getCommitFileDiff  - Returns unified diff for a specific file in a specific commit
 *
 * Artifact-git RPCs (`getGateArtifacts`, `getFileDiff`, `getCommits`,
 * `getCommitFileDiff`) are cache-first: the handler reads the most recent row
 * from `workflow_run_artifact_cache` and returns it synchronously; if the row
 * is missing or stale, a background sync job is enqueued that refreshes the
 * cache and emits `space.artifactCache.updated` for the frontend.
 */

import { isAbsolute } from 'node:path';
import type { MessageHub } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository';
import type { WorkflowRunArtifactCacheRepository } from '../../storage/repositories/workflow-run-artifact-cache-repository';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { WorkflowHookStateRepository } from '../../storage/repositories/workflow-hook-state-repository';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import type { SpaceTaskManager } from '../space/managers/space-task-manager';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorktreeManager } from '../space/managers/space-worktree-manager';
import { getWorkflowRunExecutionStatusLabel } from '@hyperneo/shared';
import type { WorkflowRunFailureReason, WorkflowRunStatus } from '@hyperneo/shared';
import {
  QUEUED_RETRYABLE_ACTION_STATE_KEY,
  triggerRetryableHookAction,
} from '../space/runtime/workflow-hook-engine';
import {
  execGit,
  isGitRepo,
  parseNumstat,
  parseCommitLog,
  countDiffLines,
  getDiffBaseRef,
  getGitRemoteUrl,
  normalizeGithubUrl,
  CACHE_KEY_GATE_ARTIFACTS,
  CACHE_KEY_COMMITS,
  COMMIT_LOG_FORMAT,
  fileDiffCacheKey,
  commitFilesCacheKey,
  commitFileDiffCacheKey,
  FILE_DIFF_SIZE_LIMIT_BYTES,
} from '../space/artifact-git-ops';
import {
  SPACE_WORKFLOW_RUN_SYNC_GATE_ARTIFACTS,
  SPACE_WORKFLOW_RUN_SYNC_COMMITS,
  SPACE_WORKFLOW_RUN_SYNC_FILE_DIFF,
} from '../job-queue-constants';
import { Logger } from '../logger';

const log = new Logger('space-workflow-run-handlers');

function workflowRunAttemptLabel(status: WorkflowRunStatus): string {
  return getWorkflowRunExecutionStatusLabel(status).toLowerCase();
}

/**
 * Cache freshness window. Anything older is treated as stale and triggers a
 * refresh enqueue (but the old data is still returned synchronously so the UI
 * has something to render).
 */
const CACHE_STALE_AFTER_MS = 30_000;

/**
 * Best-effort enqueue helper. We look for an existing pending OR processing job
 * for the same queue + payload shape before enqueuing, so repeated panel opens
 * don't stack dozens of duplicate sync jobs — including the case where a sync
 * is already in-flight (status `processing`) when the panel re-opens.
 */
function enqueueSyncOnce(
  jobQueue: JobQueueRepository,
  queue: string,
  payload: Record<string, unknown>
): void {
  try {
    const inFlight = jobQueue.listJobs({
      queue,
      status: ['pending', 'processing'],
      limit: 20,
    });
    const match = inFlight.find((j) => {
      for (const [k, v] of Object.entries(payload)) {
        if (j.payload?.[k] !== v) return false;
      }
      return true;
    });
    if (match) return;
    jobQueue.enqueue({ queue, payload, runAt: Date.now() });
  } catch (err) {
    log.warn(`Failed to enqueue ${queue} sync job:`, err);
  }
}

function isCacheFresh(syncedAt: number, now: number = Date.now()): boolean {
  return now - syncedAt < CACHE_STALE_AFTER_MS;
}

/**
 * Resolve the git worktree path for a workflow run.
 *
 * Resolution order:
 * 1. If `taskId` is provided, use that task's worktree directly.
 * 2. Otherwise, look up all tasks for the run and use the first one's worktree.
 *    (Logs a warning when a run has multiple tasks — only first task is shown.)
 * 3. Falls back to the space's root `workspacePath` when no task worktree exists.
 *
 * @returns The resolved path, or null if no path can be determined.
 */
async function resolveWorktreePath(
  runId: string,
  spaceId: string,
  spaceManager: SpaceManager,
  spaceTaskRepo: SpaceTaskRepository,
  spaceWorktreeManager: SpaceWorktreeManager,
  taskId?: string
): Promise<string | null> {
  // If the caller provided a specific taskId, use that task's worktree directly.
  if (taskId) {
    const taskWorktreePath = await spaceWorktreeManager.getTaskWorktreePath(spaceId, taskId);
    if (taskWorktreePath) {
      return taskWorktreePath;
    }
    log.warn(
      `resolveWorktreePath: no worktree found for taskId=${taskId}, falling back to root workspace`
    );
  } else {
    // No taskId provided: look up tasks for the run and use the first one's worktree.
    const tasks = spaceTaskRepo.listByWorkflowRun(runId);
    if (tasks.length > 0) {
      if (tasks.length > 1) {
        log.warn(
          `resolveWorktreePath: run ${runId} has ${tasks.length} tasks — showing artifacts for task ${tasks[0].id} only. Pass taskId to target a specific task.`
        );
      }
      const firstTaskWorktreePath = await spaceWorktreeManager.getTaskWorktreePath(
        spaceId,
        tasks[0].id
      );
      if (firstTaskWorktreePath) {
        return firstTaskWorktreePath;
      }
      log.warn(
        `resolveWorktreePath: no worktree found for task ${tasks[0].id} in run ${runId}, falling back to root workspace`
      );
    } else {
      log.warn(
        `resolveWorktreePath: no tasks found for run ${runId}, falling back to root workspace`
      );
    }
  }

  // Fallback: use the root workspace path from the space.
  const space = await spaceManager.getSpace(spaceId);
  return space?.workspacePath ?? null;
}

/** Factory that creates a SpaceTaskManager bound to a specific spaceId. */
export type SpaceWorkflowRunTaskManagerFactory = (spaceId: string) => SpaceTaskManager;

export function setupSpaceWorkflowRunHandlers(
  messageHub: MessageHub,
  spaceManager: SpaceManager,
  spaceWorkflowManager: SpaceWorkflowManager,
  workflowRunRepo: SpaceWorkflowRunRepository,
  spaceRuntimeService: SpaceRuntimeService,
  taskManagerFactory: SpaceWorkflowRunTaskManagerFactory,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceTaskRepo: SpaceTaskRepository,
  spaceWorktreeManager: SpaceWorktreeManager,
  artifactRepo: WorkflowRunArtifactRepository,
  artifactCacheRepo: WorkflowRunArtifactCacheRepository,
  jobQueue: JobQueueRepository,
  hookStateRepo: WorkflowHookStateRepository
): void {
  // ─── spaceWorkflowRun.start ──────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflowRun.start', async (data) => {
    const params = data as {
      spaceId: string;
      workflowId?: string;
      title: string;
      description?: string;
    };

    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.title || params.title.trim() === '') throw new Error('title is required');

    // Early space validation — ensures "Space not found" surfaces before workflow
    // resolution. Without this check, listWorkflows() would return [] for a
    // nonexistent spaceId, yielding a misleading "No workflows found" error.
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    // Resolve workflow: explicit workflowId or auto-select. Prefer a
    // `default`-tagged workflow (the stable Coding template) so upgraded spaces
    // — where the new stable template is seeded after the historical rows —
    // switch their auto-started runs to it rather than staying on the oldest
    // row by created_at. Fall back to the first workflow for spaces without a
    // default-tagged workflow.
    let workflowId = params.workflowId;
    if (!workflowId) {
      const workflows = spaceWorkflowManager
        .listWorkflows(params.spaceId)
        .filter((w) => !w.disabled);
      if (workflows.length === 0) {
        throw new Error(`No workflows found for space: ${params.spaceId}`);
      }
      // Prefer a `default`-tagged workflow; when several exist (e.g. duplicate
      // legacy rows awaiting cleanup), tie-break by most-recently-updated — the
      // same deterministic scoring as selectDeterministicWorkflowFallback — so an
      // auto-start does not silently pick an obsolete/customized oldest duplicate.
      const canonicalDefaults = workflows.filter(
        (w) => w.templateName === 'Coding' && (w.tags ?? []).includes('default')
      );
      const defaultWorkflows =
        canonicalDefaults.length > 0
          ? canonicalDefaults
          : workflows.filter((w) => (w.tags ?? []).includes('default'));
      const preferred =
        defaultWorkflows.length > 0
          ? [...defaultWorkflows].sort((a, b) => b.updatedAt - a.updatedAt)[0]
          : workflows[0];
      workflowId = preferred.id;
    } else {
      // Validate provided workflow exists and belongs to this space
      const workflow = spaceWorkflowManager.getWorkflow(workflowId);
      if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
      if (workflow.spaceId !== params.spaceId) throw new Error(`Workflow not found: ${workflowId}`);
      if (workflow.disabled) throw new Error(`Workflow is disabled: ${workflowId}`);
    }

    // Get or create the runtime for this space (validates space, starts runtime if needed)
    const runtime = await spaceRuntimeService.createOrGetRuntime(params.spaceId);

    // Create the run and initial task via the runtime
    const { run } = await runtime.startWorkflowRun(
      params.spaceId,
      workflowId,
      params.title,
      params.description
    );

    return { run };
  });

  // ─── spaceWorkflowRun.list ───────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflowRun.list', async (data) => {
    const params = data as { spaceId: string; status?: WorkflowRunStatus };

    if (!params.spaceId) throw new Error('spaceId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    let runs = workflowRunRepo.listBySpace(params.spaceId);
    if (params.status) {
      runs = runs.filter((r) => r.status === params.status);
    }

    return { runs };
  });

  // ─── spaceWorkflowRun.get ────────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflowRun.get', async (data) => {
    const params = data as { id: string; spaceId?: string };

    if (!params.id) throw new Error('id is required');

    const run = workflowRunRepo.getRun(params.id);
    if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

    // Optional ownership check — if spaceId is provided, reject cross-space access
    if (params.spaceId && run.spaceId !== params.spaceId) {
      throw new Error(`WorkflowRun not found: ${params.id}`);
    }

    return { run };
  });

  // ─── spaceWorkflowRun.resume ─────────────────────────────────────────────
  //
  // Resumes a run that is in blocked state after a human has resolved the
  // blocking issue. Transitions blocked → in_progress so the tick loop
  // will resume processing on the next cycle.
  messageHub.onRequest('spaceWorkflowRun.resume', async (data) => {
    const params = data as { id: string };

    if (!params.id) throw new Error('id is required');

    const run = workflowRunRepo.getRun(params.id);
    if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

    if (run.status !== 'blocked') {
      throw new Error(
        `Cannot resume run ${params.id}: expected status 'blocked', got '${run.status}'`
      );
    }

    // blocked → in_progress (human resolved the blocking issue)
    const updated = workflowRunRepo.transitionStatus(params.id, 'in_progress');
    // Sweep the PR-event auto-subscription so subsequent PR events do not
    // keep re-evaluating gates for an active run that only needed the
    // subscription while it was blocked.
    spaceRuntimeService.notifyRunResumed(params.id);

    internalEventBus
      .publish('space.workflowRun.updated', {
        sessionId: 'global',
        spaceId: run.spaceId,
        runId: run.id,
        run: updated,
      })
      .catch((err) => {
        log.warn('Failed to emit space.workflowRun.updated:', err);
      });

    return { run: updated };
  });

  // ─── spaceWorkflowRun.markFailed ─────────────────────────────────────────
  //
  // Transitions a run to blocked with a specific failureReason.
  // Production RPC called by the Space Agent when it detects an unrecoverable
  // failure in a task agent session: e.g. agentCrash (unexpected termination),
  // maxIterationsReached, or nodeTimeout. Also used in integration tests to
  // exercise the blocked path without a real LLM session.
  messageHub.onRequest('spaceWorkflowRun.markFailed', async (data) => {
    const params = data as {
      id: string;
      failureReason: WorkflowRunFailureReason;
      reason?: string;
    };

    if (!params.id) throw new Error('id is required');
    if (!params.failureReason) throw new Error('failureReason is required');

    const run = workflowRunRepo.getRun(params.id);
    if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

    if (run.status === 'done' || run.status === 'cancelled') {
      throw new Error(
        `Cannot mark a ${workflowRunAttemptLabel(run.status)} workflow run as failed`
      );
    }
    if (run.status === 'blocked') {
      // Already in blocked — just update failureReason
      const updated =
        workflowRunRepo.updateRun(params.id, { failureReason: params.failureReason }) ?? run;

      internalEventBus
        .publish('space.workflowRun.updated', {
          sessionId: 'global',
          spaceId: run.spaceId,
          runId: run.id,
          run: updated,
        })
        .catch((err) => {
          log.warn('Failed to emit space.workflowRun.updated:', err);
        });

      return { run: updated };
    }

    // Transition to blocked then set failureReason
    workflowRunRepo.transitionStatus(params.id, 'blocked');
    const updated =
      workflowRunRepo.updateRun(params.id, { failureReason: params.failureReason }) ?? run;

    internalEventBus
      .publish('space.workflowRun.updated', {
        sessionId: 'global',
        spaceId: run.spaceId,
        runId: run.id,
        run: updated,
      })
      .catch((err) => {
        log.warn('Failed to emit space.workflowRun.updated:', err);
      });

    return { run: updated };
  });

  // ─── spaceWorkflowRun.cancel ─────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflowRun.cancel', async (data) => {
    const params = data as { id: string };

    if (!params.id) throw new Error('id is required');

    const run = workflowRunRepo.getRun(params.id);
    if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

    if (run.status === 'cancelled') {
      return { success: true };
    }
    if (run.status === 'done') {
      throw new Error('Cannot cancel a succeeded workflow run');
    }

    await spaceRuntimeService.cancelWorkflowRun(run.spaceId, run.id);

    return { success: true };
  });

  // ─── spaceWorkflowRun.getGateArtifacts ───────────────────────────────────
  //
  // Cache-first: returns the most recent cache row for CACHE_KEY_GATE_ARTIFACTS
  // immediately and enqueues a background sync job if the row is missing or
  // stale. Frontend receives `space.artifactCache.updated` when the refresh
  // completes.
  messageHub.onRequest('spaceWorkflowRun.getGateArtifacts', async (data) => {
    const params = data as { runId: string; taskId?: string };

    if (!params.runId) throw new Error('runId is required');

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    const taskId = params.taskId ?? '';
    const cached = artifactCacheRepo.get(params.runId, CACHE_KEY_GATE_ARTIFACTS, taskId);

    if (!cached || !isCacheFresh(cached.syncedAt)) {
      enqueueSyncOnce(jobQueue, SPACE_WORKFLOW_RUN_SYNC_GATE_ARTIFACTS, {
        runId: params.runId,
        taskId: params.taskId,
      });
    }

    if (cached && cached.status !== 'error') {
      return {
        ...cached.data,
        cached: true,
        syncedAt: cached.syncedAt,
        status: cached.status,
      };
    }

    // Cache miss or previous failure — fall back to a synchronous probe so the
    // panel has something to render on first-load. The background job will
    // overwrite with the authoritative row shortly.
    const worktreePath = await resolveWorktreePath(
      run.id,
      run.spaceId,
      spaceManager,
      spaceTaskRepo,
      spaceWorktreeManager,
      params.taskId
    );
    if (!worktreePath) {
      throw new Error(`No workspace path found for run: ${params.runId}`);
    }

    if (!(await isGitRepo(worktreePath))) {
      return { files: [], totalAdditions: 0, totalDeletions: 0, worktreePath, isGitRepo: false };
    }

    let numstatOutput = '';
    try {
      numstatOutput = await execGit(['diff', 'HEAD', '--numstat'], worktreePath);
    } catch (err) {
      log.warn('git diff HEAD --numstat failed:', err);
    }

    const summary = parseNumstat(numstatOutput);
    return { ...summary, worktreePath, isGitRepo: true };
  });

  // ─── spaceWorkflowRun.getFileDiff ────────────────────────────────────────
  //
  // Cache-first: returns the cached file diff (up to FILE_DIFF_SIZE_LIMIT_BYTES)
  // and enqueues a background sync if the row is missing or stale. Large diffs
  // are stored truncated; callers can detect `truncated: true` and request a
  // full-file read if needed.
  messageHub.onRequest('spaceWorkflowRun.getFileDiff', async (data) => {
    const params = data as { runId: string; filePath: string; taskId?: string };

    if (!params.runId) throw new Error('runId is required');
    if (!params.filePath || params.filePath.trim() === '') {
      throw new Error('filePath is required');
    }
    if (params.filePath.includes('..') || isAbsolute(params.filePath)) {
      throw new Error('filePath must be a relative path within the worktree');
    }

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    const taskId = params.taskId ?? '';
    const cacheKey = fileDiffCacheKey(params.filePath);
    const cached = artifactCacheRepo.get(params.runId, cacheKey, taskId);

    if (!cached || !isCacheFresh(cached.syncedAt)) {
      enqueueSyncOnce(jobQueue, SPACE_WORKFLOW_RUN_SYNC_FILE_DIFF, {
        runId: params.runId,
        taskId: params.taskId,
        filePath: params.filePath,
      });
    }

    if (cached && cached.status !== 'error') {
      return {
        ...cached.data,
        cached: true,
        syncedAt: cached.syncedAt,
        status: cached.status,
      };
    }

    const worktreePath = await resolveWorktreePath(
      run.id,
      run.spaceId,
      spaceManager,
      spaceTaskRepo,
      spaceWorktreeManager,
      params.taskId
    );
    if (!worktreePath) {
      throw new Error(`No workspace path found for run: ${params.runId}`);
    }

    if (!(await isGitRepo(worktreePath))) {
      return { diff: '', additions: 0, deletions: 0, filePath: params.filePath };
    }

    let diff = '';
    try {
      diff = await execGit(['diff', 'HEAD', '--', params.filePath], worktreePath);
    } catch (err) {
      log.warn('git diff HEAD for file failed:', err);
    }

    const { additions, deletions } = countDiffLines(diff);
    const truncated = diff.length > FILE_DIFF_SIZE_LIMIT_BYTES;
    const returnedDiff = truncated ? diff.slice(0, FILE_DIFF_SIZE_LIMIT_BYTES) : diff;

    return {
      diff: returnedDiff,
      additions,
      deletions,
      filePath: params.filePath,
      truncated,
      originalSize: diff.length,
    };
  });

  // ─── spaceWorkflowRun.getCommits ─────────────────────────────────────────
  //
  // Cache-first: returns the cached CACHE_KEY_COMMITS row and enqueues a
  // background sync if stale/missing.
  messageHub.onRequest('spaceWorkflowRun.getCommits', async (data) => {
    const params = data as { runId: string; taskId?: string };
    if (!params.runId) throw new Error('runId is required');

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    const taskId = params.taskId ?? '';
    const cached = artifactCacheRepo.get(params.runId, CACHE_KEY_COMMITS, taskId);

    if (!cached || !isCacheFresh(cached.syncedAt)) {
      enqueueSyncOnce(jobQueue, SPACE_WORKFLOW_RUN_SYNC_COMMITS, {
        runId: params.runId,
        taskId: params.taskId,
      });
    }

    if (cached && cached.status !== 'error') {
      return {
        ...cached.data,
        cached: true,
        syncedAt: cached.syncedAt,
        status: cached.status,
      };
    }

    const worktreePath = await resolveWorktreePath(
      run.id,
      run.spaceId,
      spaceManager,
      spaceTaskRepo,
      spaceWorktreeManager,
      params.taskId
    );
    if (!worktreePath) throw new Error(`No workspace path found for run: ${params.runId}`);

    if (!(await isGitRepo(worktreePath))) {
      return { commits: [], baseRef: null, isGitRepo: false, repoUrl: null };
    }

    const [baseRef, rawRemoteUrl] = await Promise.all([
      getDiffBaseRef(worktreePath),
      getGitRemoteUrl(worktreePath),
    ]);
    const repoUrl = rawRemoteUrl ? normalizeGithubUrl(rawRemoteUrl) : null;
    const range = baseRef ? `${baseRef}..HEAD` : '';

    let logOutput = '';
    try {
      const args = ['log', COMMIT_LOG_FORMAT, '--numstat'];
      if (range) args.push(range);
      logOutput = await execGit(args, worktreePath);
    } catch (err) {
      log.warn('git log --numstat failed:', err);
    }

    const commits = parseCommitLog(logOutput);
    return { commits, baseRef: baseRef || null, isGitRepo: true, repoUrl };
  });

  // ─── spaceWorkflowRun.getCommitFiles ─────────────────────────────────────
  //
  // Cache-first: reads from the commitFiles:<sha> cache key. Falls back to a
  // sync probe on cache miss since these rows are only refreshed on demand
  // (commit history is immutable — no background sync job needed).
  messageHub.onRequest('spaceWorkflowRun.getCommitFiles', async (data) => {
    const params = data as { runId: string; taskId?: string; commitSha: string };
    if (!params.runId) throw new Error('runId is required');
    if (!params.commitSha || !/^[0-9a-f]{4,64}$/i.test(params.commitSha)) {
      throw new Error('commitSha must be a valid git sha');
    }

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    const taskId = params.taskId ?? '';
    const cacheKey = commitFilesCacheKey(params.commitSha);
    const cached = artifactCacheRepo.get(params.runId, cacheKey, taskId);
    if (cached && cached.status === 'ok') {
      return { ...cached.data, cached: true, syncedAt: cached.syncedAt };
    }

    const worktreePath = await resolveWorktreePath(
      run.id,
      run.spaceId,
      spaceManager,
      spaceTaskRepo,
      spaceWorktreeManager,
      params.taskId
    );
    if (!worktreePath) throw new Error(`No workspace path found for run: ${params.runId}`);

    if (!(await isGitRepo(worktreePath))) {
      return { files: [] };
    }

    let numstatOutput = '';
    try {
      numstatOutput = await execGit(
        ['diff-tree', '--numstat', '-r', params.commitSha],
        worktreePath
      );
    } catch (err) {
      log.warn('git diff-tree --numstat failed:', err);
    }

    const summary = parseNumstat(numstatOutput);
    const payload = { files: summary.files };
    // Commit file lists are immutable — cache indefinitely on first read.
    try {
      artifactCacheRepo.upsert({
        runId: params.runId,
        taskId,
        cacheKey,
        status: 'ok',
        data: payload,
      });
    } catch (err) {
      log.warn('Failed to persist commitFiles cache:', err);
    }
    return payload;
  });

  // ─── spaceWorkflowRun.getCommitFileDiff ──────────────────────────────────
  //
  // Cache-first: reads from the commitFileDiff:<sha>:<path> cache key. Commit
  // contents are immutable so there's no staleness concern — the row is
  // populated lazily on first request and reused forever.
  messageHub.onRequest('spaceWorkflowRun.getCommitFileDiff', async (data) => {
    const params = data as {
      runId: string;
      taskId?: string;
      commitSha: string;
      filePath: string;
    };
    if (!params.runId) throw new Error('runId is required');
    if (!params.commitSha || !/^[0-9a-f]{4,64}$/i.test(params.commitSha)) {
      throw new Error('commitSha must be a valid git sha');
    }
    if (!params.filePath || params.filePath.trim() === '') {
      throw new Error('filePath is required');
    }
    if (params.filePath.includes('..') || isAbsolute(params.filePath)) {
      throw new Error('filePath must be a relative path within the worktree');
    }

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    const taskId = params.taskId ?? '';
    const cacheKey = commitFileDiffCacheKey(params.commitSha, params.filePath);
    const cached = artifactCacheRepo.get(params.runId, cacheKey, taskId);
    if (cached && cached.status === 'ok') {
      return { ...cached.data, cached: true, syncedAt: cached.syncedAt };
    }

    const worktreePath = await resolveWorktreePath(
      run.id,
      run.spaceId,
      spaceManager,
      spaceTaskRepo,
      spaceWorktreeManager,
      params.taskId
    );
    if (!worktreePath) throw new Error(`No workspace path found for run: ${params.runId}`);

    if (!(await isGitRepo(worktreePath))) {
      return { diff: '', additions: 0, deletions: 0, filePath: params.filePath };
    }

    let diff = '';
    try {
      diff = await execGit(['show', params.commitSha, '--', params.filePath], worktreePath);
    } catch (err) {
      log.warn('git show for commit file failed:', err);
    }

    const { additions, deletions } = countDiffLines(diff);
    const truncated = diff.length > FILE_DIFF_SIZE_LIMIT_BYTES;
    const returnedDiff = truncated ? diff.slice(0, FILE_DIFF_SIZE_LIMIT_BYTES) : diff;
    const payload = {
      diff: returnedDiff,
      additions,
      deletions,
      filePath: params.filePath,
      truncated,
      originalSize: diff.length,
    };
    try {
      artifactCacheRepo.upsert({
        runId: params.runId,
        taskId,
        cacheKey,
        status: 'ok',
        data: payload,
      });
    } catch (err) {
      log.warn('Failed to persist commitFileDiff cache:', err);
    }
    return payload;
  });

  // ─── spaceWorkflowRun.listArtifacts ─────────────────────────────────────
  messageHub.onRequest('spaceWorkflowRun.listArtifacts', async (data) => {
    const params = data as {
      runId: string;
      nodeId?: string;
      artifactType?: string;
    };
    if (!params.runId) throw new Error('runId is required');
    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);
    const artifacts = artifactRepo.listByRun(params.runId, {
      nodeId: params.nodeId,
      artifactType: params.artifactType,
    });
    return { artifacts };
  });

  // ─── spaceWorkflowRun.listHookStates ────────────────────────────────────
  //
  // Returns all hook state snapshots for a workflow run, paired with the
  // workflow's hook definitions so the UI can render labels and configs.
  messageHub.onRequest('spaceWorkflowRun.listHookStates', async (data) => {
    const params = data as { runId: string };
    if (!params.runId) throw new Error('runId is required');

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    // Run-scoped: hook-definition banners must reflect the run's pinned definition, so a
    // live hook edit can't leave a blocked pinned hook without UI resume controls.
    const workflow = spaceWorkflowManager.getWorkflowForRun(run);
    const hookStates = hookStateRepo.listByRun(params.runId);

    return {
      hookStates,
      hooks: workflow?.hooks ?? [],
    };
  });

  // These RPC paths update hook state directly via hookStateRepo (bypassing
  // workflow-hook-engine's persistStateUpdate), so the runtime's
  // onHookStateUpdated trigger — which re-materializes topicFrom interests when
  // a link-bearing write lands — never fires. A human approving/retrying a hook
  // whose state still carries a stale pr_url must not leave the derived
  // subscription pointing at the superseded PR: the write bumps updated_at
  // (which resolvePrimaryLinkUrl ranks as freshness), so without invalidation
  // the next cache miss would re-rank the stale hook above the newer artifact.
  // Fire the same invalidate + materialize + conditional replay the engine path
  // uses, only when the pre-write state carried a link field.
  const refreshTopicFromAfterHookWrite = (
    runId: string,
    baseLocalState: Record<string, unknown>
  ) => {
    const linkBearing = 'prUrl' in baseLocalState || 'pr_url' in baseLocalState;
    if (!linkBearing) return;
    try {
      spaceRuntimeService.invalidatePrimaryLinkForRun(runId);
      if (spaceRuntimeService.materializeRunTopicFromInterests(runId)) {
        spaceRuntimeService.replayRetainedEventsForMaterialization(runId);
      }
    } catch (err) {
      // Best-effort: the hook write already committed; a refresh failure must
      // not fail the RPC.
      log.warn(
        `approveHook/retryHook: topicFrom refresh failed for ${runId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // ─── spaceWorkflowRun.approveHook ───────────────────────────────────────
  //
  // Writes a human approval decision into a hook's local state.
  // Idempotent: repeated approvals are no-ops. Rejection stamps
  // `humanApproved: false` so validators can surface the reason.
  messageHub.onRequest('spaceWorkflowRun.approveHook', async (data) => {
    const params = data as {
      runId: string;
      hookId: string;
      approved: boolean;
      reason?: string;
    };

    if (!params.runId) throw new Error('runId is required');
    if (!params.hookId) throw new Error('hookId is required');
    if (params.approved === undefined || params.approved === null) {
      throw new Error('approved is required');
    }

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
      throw new Error(
        `Cannot modify hook on a ${workflowRunAttemptLabel(run.status)} workflow run`
      );
    }

    const existing = hookStateRepo.get(params.runId, params.hookId);
    const baseVersion = existing?.version ?? 0;
    const baseLocalState = existing?.localState ?? {};

    const rejectionReason = params.reason?.trim() || 'Rejected by human';
    const updateResult = hookStateRepo.update(params.runId, params.hookId, {
      expectedVersion: baseVersion,
      localState: {
        ...baseLocalState,
        humanApproved: params.approved,
        humanApprovedAt: Date.now(),
        humanRejectionReason: params.approved ? undefined : rejectionReason,
      },
      lastResult: params.approved
        ? {
            type: 'allow',
            message: 'Approved by human',
          }
        : {
            type: 'block',
            reason: rejectionReason,
            message: 'Rejected by human',
          },
      retryCount: 0,
      nextRetryAt: null,
    });

    if (!updateResult) {
      throw new Error('Hook state update failed due to version conflict');
    }

    refreshTopicFromAfterHookWrite(params.runId, baseLocalState);

    internalEventBus
      .publish('space.hookState.updated', {
        sessionId: 'global',
        spaceId: run.spaceId,
        runId: params.runId,
        hookId: params.hookId,
        hookState: updateResult,
      })
      .catch((err) => {
        log.warn('Failed to emit space.hookState.updated:', err);
      });

    return { hookState: updateResult };
  });

  // ─── spaceWorkflowRun.retryHook ─────────────────────────────────────────
  //
  // Clears retry backoff for a retryable_block hook so the next action
  // re-executes the hook chain immediately.
  messageHub.onRequest('spaceWorkflowRun.retryHook', async (data) => {
    const params = data as { runId: string; hookId: string };

    if (!params.runId) throw new Error('runId is required');
    if (!params.hookId) throw new Error('hookId is required');

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    if (run.status === 'done' || run.status === 'cancelled' || run.status === 'pending') {
      throw new Error(`Cannot retry hook on a ${workflowRunAttemptLabel(run.status)} workflow run`);
    }

    const existing = hookStateRepo.get(params.runId, params.hookId);
    const baseVersion = existing?.version ?? 0;
    const queuedAction = existing?.localState?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
    const queuedActionKey =
      queuedAction && typeof queuedAction === 'object'
        ? (queuedAction as Record<string, unknown>).actionKey
        : undefined;
    const updateResult = hookStateRepo.update(params.runId, params.hookId, {
      expectedVersion: baseVersion,
      localState: {
        ...existing?.localState,
        [QUEUED_RETRYABLE_ACTION_STATE_KEY]: null,
      },
      lastResult: {
        type: 'allow',
        message: 'Retry requested by human',
      },
      retryCount: 0,
      nextRetryAt: null,
    });

    if (!updateResult) {
      throw new Error('Hook state update failed due to version conflict');
    }

    refreshTopicFromAfterHookWrite(params.runId, existing?.localState ?? {});

    if (typeof queuedActionKey === 'string') {
      triggerRetryableHookAction(queuedActionKey);
    }

    internalEventBus
      .publish('space.hookState.updated', {
        sessionId: 'global',
        spaceId: run.spaceId,
        runId: params.runId,
        hookId: params.hookId,
        hookState: updateResult,
      })
      .catch((err) => {
        log.warn('Failed to emit space.hookState.updated:', err);
      });

    return { hookState: updateResult };
  });
}
