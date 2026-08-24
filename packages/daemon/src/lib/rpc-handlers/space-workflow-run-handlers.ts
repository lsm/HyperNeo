import { isAbsolute } from 'node:path';
import type { MessageHub } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository.ts';
import type { WorkflowRunArtifactCacheRepository } from '../../storage/repositories/workflow-run-artifact-cache-repository.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { WorkflowHookStateRepository } from '../../storage/repositories/workflow-hook-state-repository.ts';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import type { SpaceTaskManager } from '../space/managers/space-task-manager.ts';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import type { SpaceWorktreeManager } from '../space/managers/space-worktree-manager.ts';
import { getWorkflowRunExecutionStatusLabel } from '@hyperneo/shared';
import type { WorkflowRunFailureReason, WorkflowRunStatus } from '@hyperneo/shared';
import {
  QUEUED_RETRYABLE_ACTION_STATE_KEY,
  triggerRetryableHookAction,
} from '../space/runtime/workflow-hook-engine.ts';
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
} from '../space/artifact-git-ops.ts';
import {
  SPACE_WORKFLOW_RUN_SYNC_GATE_ARTIFACTS,
  SPACE_WORKFLOW_RUN_SYNC_COMMITS,
  SPACE_WORKFLOW_RUN_SYNC_FILE_DIFF,
} from '../job-queue-constants.ts';
import { Logger } from '../logger.ts';

const log = new Logger('space-workflow-run-handlers');

function workflowRunAttemptLabel(status: WorkflowRunStatus): string {
  return getWorkflowRunExecutionStatusLabel(status).toLowerCase();
}

const CACHE_STALE_AFTER_MS = 30_000;

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

async function resolveWorktreePath(
  runId: string,
  spaceId: string,
  spaceManager: SpaceManager,
  spaceTaskRepo: SpaceTaskRepository,
  spaceWorktreeManager: SpaceWorktreeManager,
  taskId?: string
): Promise<string | null> {
  if (taskId) {
    const taskWorktreePath = await spaceWorktreeManager.getTaskWorktreePath(spaceId, taskId);
    if (taskWorktreePath) {
      return taskWorktreePath;
    }
    log.warn(
      `resolveWorktreePath: no worktree found for taskId=${taskId}, falling back to root workspace`
    );
  } else {
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

  const space = await spaceManager.getSpace(spaceId);
  return space?.workspacePath ?? null;
}

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
  messageHub.onRequest('spaceWorkflowRun.start', async (data) => {
    const params = data as {
      spaceId: string;
      workflowId?: string;
      title: string;
      description?: string;
    };

    if (!params.spaceId) throw new Error('spaceId is required');
    if (!params.title || params.title.trim() === '') throw new Error('title is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    let workflowId = params.workflowId;
    if (!workflowId) {
      const workflows = spaceWorkflowManager
        .listWorkflows(params.spaceId)
        .filter((w) => !w.disabled);
      if (workflows.length === 0) {
        throw new Error(`No workflows found for space: ${params.spaceId}`);
      }
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
      const workflow = spaceWorkflowManager.getWorkflow(workflowId);
      if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
      if (workflow.spaceId !== params.spaceId) throw new Error(`Workflow not found: ${workflowId}`);
      if (workflow.disabled) throw new Error(`Workflow is disabled: ${workflowId}`);
    }

    const runtime = await spaceRuntimeService.createOrGetRuntime(params.spaceId);

    const { run } = await runtime.startWorkflowRun(
      params.spaceId,
      workflowId,
      params.title,
      params.description
    );

    return { run };
  });

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

  messageHub.onRequest('spaceWorkflowRun.get', async (data) => {
    const params = data as { id: string; spaceId?: string };

    if (!params.id) throw new Error('id is required');

    const run = workflowRunRepo.getRun(params.id);
    if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

    if (params.spaceId && run.spaceId !== params.spaceId) {
      throw new Error(`WorkflowRun not found: ${params.id}`);
    }

    return { run };
  });

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

    const updated = workflowRunRepo.transitionStatus(params.id, 'in_progress');
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

  messageHub.onRequest('spaceWorkflowRun.listHookStates', async (data) => {
    const params = data as { runId: string };
    if (!params.runId) throw new Error('runId is required');

    const run = workflowRunRepo.getRun(params.runId);
    if (!run) throw new Error(`WorkflowRun not found: ${params.runId}`);

    const workflow = spaceWorkflowManager.getWorkflowForRun(run);
    const hookStates = hookStateRepo.listByRun(params.runId);

    return {
      hookStates,
      hooks: workflow?.hooks ?? [],
    };
  });

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
