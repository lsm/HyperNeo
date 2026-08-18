import type { Job } from '../../storage/repositories/job-queue-repository';
import type { WorkflowRunArtifactCacheRepository } from '../../storage/repositories/workflow-run-artifact-cache-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorktreeManager } from '../space/managers/space-worktree-manager';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
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
  FILE_DIFF_SIZE_LIMIT_BYTES,
} from '../space/artifact-git-ops';
import { Logger } from '../logger';

const log = new Logger('space-workflow-run-artifact-handler');

export interface SyncArtifactHandlerDeps {
  cacheRepo: WorkflowRunArtifactCacheRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  spaceTaskRepo: SpaceTaskRepository;
  spaceManager: SpaceManager;
  spaceWorktreeManager: SpaceWorktreeManager;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
}

interface SyncPayload {
  runId: string;
  taskId?: string;
  filePath?: string;
}

function emitCacheUpdated(
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  params: {
    spaceId: string;
    runId: string;
    taskId: string;
    cacheKey: string;
    status: 'ok' | 'syncing' | 'error';
  }
): void {
  internalEventBus
    .publish('space.artifactCache.updated', {
      sessionId: 'global',
      ...params,
    })
    .catch((err) => {
      log.warn('space.artifactCache.updated emit failed:', err);
    });
}

async function resolveWorktreeForJob(
  runId: string,
  taskId: string | undefined,
  deps: SyncArtifactHandlerDeps
): Promise<{ worktreePath: string | null; spaceId: string | null }> {
  const run = deps.workflowRunRepo.getRun(runId);
  if (!run) return { worktreePath: null, spaceId: null };

  if (taskId) {
    const worktreePath = await deps.spaceWorktreeManager.getTaskWorktreePath(run.spaceId, taskId);
    if (worktreePath) return { worktreePath, spaceId: run.spaceId };
  } else {
    const tasks = deps.spaceTaskRepo.listByWorkflowRun(runId);
    if (tasks.length > 0) {
      const first = await deps.spaceWorktreeManager.getTaskWorktreePath(run.spaceId, tasks[0].id);
      if (first) return { worktreePath: first, spaceId: run.spaceId };
    }
  }

  const space = await deps.spaceManager.getSpace(run.spaceId);
  return { worktreePath: space?.workspacePath ?? null, spaceId: run.spaceId };
}

async function handleSyncGateArtifacts(
  payload: SyncPayload,
  deps: SyncArtifactHandlerDeps
): Promise<Record<string, unknown>> {
  const { runId, taskId } = payload;
  const { worktreePath, spaceId } = await resolveWorktreeForJob(runId, taskId, deps);
  if (!worktreePath || !spaceId) {
    const data = {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      worktreePath: '',
      isGitRepo: false,
    };
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: CACHE_KEY_GATE_ARTIFACTS,
      status: 'error',
      data,
      error: 'Worktree path unresolved',
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId: spaceId ?? '',
      runId,
      taskId: taskId ?? '',
      cacheKey: CACHE_KEY_GATE_ARTIFACTS,
      status: 'error',
    });
    return { ok: false, reason: 'worktree-unresolved' };
  }

  if (!(await isGitRepo(worktreePath))) {
    const data = {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      worktreePath,
      isGitRepo: false,
    };
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: CACHE_KEY_GATE_ARTIFACTS,
      status: 'ok',
      data,
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId,
      runId,
      taskId: taskId ?? '',
      cacheKey: CACHE_KEY_GATE_ARTIFACTS,
      status: 'ok',
    });
    return { ok: true, isGitRepo: false };
  }

  let numstatOutput = '';
  try {
    numstatOutput = await execGit(['diff', 'HEAD', '--numstat'], worktreePath);
  } catch (err) {
    log.warn(`syncGateArtifacts git diff failed for run=${runId}:`, err);
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: CACHE_KEY_GATE_ARTIFACTS,
      status: 'error',
      data: { files: [], totalAdditions: 0, totalDeletions: 0, worktreePath, isGitRepo: true },
      error: err instanceof Error ? err.message : String(err),
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId,
      runId,
      taskId: taskId ?? '',
      cacheKey: CACHE_KEY_GATE_ARTIFACTS,
      status: 'error',
    });
    throw err;
  }

  const summary = parseNumstat(numstatOutput);
  const data = { ...summary, worktreePath, isGitRepo: true };
  deps.cacheRepo.upsert({
    runId,
    taskId,
    cacheKey: CACHE_KEY_GATE_ARTIFACTS,
    status: 'ok',
    data,
  });
  emitCacheUpdated(deps.internalEventBus, {
    spaceId,
    runId,
    taskId: taskId ?? '',
    cacheKey: CACHE_KEY_GATE_ARTIFACTS,
    status: 'ok',
  });
  return { ok: true, files: summary.files.length };
}

async function handleSyncCommits(
  payload: SyncPayload,
  deps: SyncArtifactHandlerDeps
): Promise<Record<string, unknown>> {
  const { runId, taskId } = payload;
  const { worktreePath, spaceId } = await resolveWorktreeForJob(runId, taskId, deps);
  if (!worktreePath || !spaceId) {
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: CACHE_KEY_COMMITS,
      status: 'error',
      data: { commits: [], baseRef: null, isGitRepo: false },
      error: 'Worktree path unresolved',
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId: spaceId ?? '',
      runId,
      taskId: taskId ?? '',
      cacheKey: CACHE_KEY_COMMITS,
      status: 'error',
    });
    return { ok: false, reason: 'worktree-unresolved' };
  }

  if (!(await isGitRepo(worktreePath))) {
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: CACHE_KEY_COMMITS,
      status: 'ok',
      data: { commits: [], baseRef: null, isGitRepo: false, repoUrl: null },
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId,
      runId,
      taskId: taskId ?? '',
      cacheKey: CACHE_KEY_COMMITS,
      status: 'ok',
    });
    return { ok: true, isGitRepo: false };
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
    log.warn(`syncCommits git log failed for run=${runId}:`, err);
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: CACHE_KEY_COMMITS,
      status: 'error',
      data: { commits: [], baseRef: baseRef || null, isGitRepo: true, repoUrl },
      error: err instanceof Error ? err.message : String(err),
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId,
      runId,
      taskId: taskId ?? '',
      cacheKey: CACHE_KEY_COMMITS,
      status: 'error',
    });
    throw err;
  }

  const commits = parseCommitLog(logOutput);
  deps.cacheRepo.upsert({
    runId,
    taskId,
    cacheKey: CACHE_KEY_COMMITS,
    status: 'ok',
    data: { commits, baseRef: baseRef || null, isGitRepo: true, repoUrl },
  });
  emitCacheUpdated(deps.internalEventBus, {
    spaceId,
    runId,
    taskId: taskId ?? '',
    cacheKey: CACHE_KEY_COMMITS,
    status: 'ok',
  });
  return { ok: true, commits: commits.length };
}

async function handleSyncFileDiff(
  payload: SyncPayload,
  deps: SyncArtifactHandlerDeps
): Promise<Record<string, unknown>> {
  const { runId, taskId, filePath } = payload;
  if (!filePath) throw new Error('filePath is required for syncFileDiff');
  const { worktreePath, spaceId } = await resolveWorktreeForJob(runId, taskId, deps);
  if (!worktreePath || !spaceId) {
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: fileDiffCacheKey(filePath),
      status: 'error',
      data: { diff: '', additions: 0, deletions: 0, filePath, truncated: false },
      error: 'Worktree path unresolved',
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId: spaceId ?? '',
      runId,
      taskId: taskId ?? '',
      cacheKey: fileDiffCacheKey(filePath),
      status: 'error',
    });
    return { ok: false, reason: 'worktree-unresolved' };
  }

  if (!(await isGitRepo(worktreePath))) {
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: fileDiffCacheKey(filePath),
      status: 'ok',
      data: { diff: '', additions: 0, deletions: 0, filePath, truncated: false },
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId,
      runId,
      taskId: taskId ?? '',
      cacheKey: fileDiffCacheKey(filePath),
      status: 'ok',
    });
    return { ok: true, isGitRepo: false };
  }

  let diff = '';
  try {
    diff = await execGit(['diff', 'HEAD', '--', filePath], worktreePath);
  } catch (err) {
    log.warn(`syncFileDiff git diff failed for run=${runId} file=${filePath}:`, err);
    deps.cacheRepo.upsert({
      runId,
      taskId,
      cacheKey: fileDiffCacheKey(filePath),
      status: 'error',
      data: { diff: '', additions: 0, deletions: 0, filePath, truncated: false },
      error: err instanceof Error ? err.message : String(err),
    });
    emitCacheUpdated(deps.internalEventBus, {
      spaceId,
      runId,
      taskId: taskId ?? '',
      cacheKey: fileDiffCacheKey(filePath),
      status: 'error',
    });
    throw err;
  }

  const { additions, deletions } = countDiffLines(diff);
  const truncated = diff.length > FILE_DIFF_SIZE_LIMIT_BYTES;
  const storedDiff = truncated ? diff.slice(0, FILE_DIFF_SIZE_LIMIT_BYTES) : diff;
  const data = {
    diff: storedDiff,
    additions,
    deletions,
    filePath,
    truncated,
    originalSize: diff.length,
  };
  deps.cacheRepo.upsert({
    runId,
    taskId,
    cacheKey: fileDiffCacheKey(filePath),
    status: 'ok',
    data,
  });
  emitCacheUpdated(deps.internalEventBus, {
    spaceId,
    runId,
    taskId: taskId ?? '',
    cacheKey: fileDiffCacheKey(filePath),
    status: 'ok',
  });
  return { ok: true, additions, deletions, truncated };
}

export function createSyncArtifactHandlers(deps: SyncArtifactHandlerDeps): {
  gateArtifacts: (job: Job) => Promise<Record<string, unknown>>;
  commits: (job: Job) => Promise<Record<string, unknown>>;
  fileDiff: (job: Job) => Promise<Record<string, unknown>>;
} {
  return {
    gateArtifacts: (job: Job) =>
      handleSyncGateArtifacts(job.payload as unknown as SyncPayload, deps),
    commits: (job: Job) => handleSyncCommits(job.payload as unknown as SyncPayload, deps),
    fileDiff: (job: Job) => handleSyncFileDiff(job.payload as unknown as SyncPayload, deps),
  };
}

export { handleSyncGateArtifacts, handleSyncCommits, handleSyncFileDiff };
