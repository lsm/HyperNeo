import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { WorkflowRunArtifactCacheRepository } from '../../../../src/storage/repositories/workflow-run-artifact-cache-repository';
import {
  createSyncArtifactHandlers,
  handleSyncGateArtifacts,
  handleSyncCommits,
  handleSyncFileDiff,
} from '../../../../src/lib/job-handlers/space-workflow-run-artifact.handler';
import { invalidateDiffBaseRef } from '../../../../src/lib/space/artifact-git-ops';
import { createSpaceTables } from '../../helpers/space-test-db';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type { SpaceWorktreeManager } from '../../../../src/lib/space/managers/space-worktree-manager';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';

const RUN_ID = 'run-1';
const SPACE_ID = 'space-1';
const TASK_ID = 'task-1';

function makeRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: root });
  return root;
}

function makeDeps(overrides: {
  worktreePath: string | null;
  db: Database;
  publish?: ReturnType<typeof mock>;
}) {
  const cacheRepo = new WorkflowRunArtifactCacheRepository(overrides.db);
  const workflowRunRepo = {
    getRun: mock(() => ({
      id: RUN_ID,
      spaceId: SPACE_ID,
      workflowId: 'wf-1',
      title: 'Run 1',
      status: 'in_progress',
      startedAt: null,
      completedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  } as unknown as SpaceWorkflowRunRepository;
  const spaceTaskRepo = {
    listByWorkflowRun: mock(() => [
      {
        id: TASK_ID,
        spaceId: SPACE_ID,
        taskNumber: 1,
        title: 'Task 1',
        status: 'open',
        workflowRunId: RUN_ID,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]),
    getTask: mock(() => null),
  } as unknown as SpaceTaskRepository;
  const spaceManager = {
    getSpace: mock(async () => ({
      id: SPACE_ID,
      slug: 'space',
      workspacePath: overrides.worktreePath ?? '',
      name: 'Space',
      description: '',
      backgroundContext: '',
      instructions: '',
      sessionIds: [],
      status: 'active' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  } as unknown as SpaceManager;
  const spaceWorktreeManager = {
    getTaskWorktreePath: mock(async () => overrides.worktreePath),
  } as unknown as SpaceWorktreeManager;
  const publish = overrides.publish ?? mock(async () => ({ delivered: 0, failures: [] }));
  const internalEventBus = {
    publish,
    publishAsync: mock(() => {}),
    subscribe: mock(() => () => {}),
    off: mock(() => {}),
    clear: mock(() => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;

  return {
    deps: {
      cacheRepo,
      workflowRunRepo,
      spaceTaskRepo,
      spaceManager,
      spaceWorktreeManager,
      internalEventBus,
    },
    publish,
    cacheRepo,
  };
}

describe('space-workflow-run-artifact.handler', () => {
  let db: Database;
  let tempRoot: string;
  let repoPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      'INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(SPACE_ID, 'space', '/tmp/test-ws', 'Space', now, now);
    db.prepare(
      'INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run('wf-1', SPACE_ID, 'Workflow', now, now);
    db.prepare(
      'INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(RUN_ID, SPACE_ID, 'wf-1', 'Run 1', now, now);

    tempRoot = mkdtempSync(join(tmpdir(), 'hyperneo-artifact-handler-'));
    repoPath = makeRepo(tempRoot);
    invalidateDiffBaseRef();
  });

  afterEach(() => {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
    invalidateDiffBaseRef();
  });

  describe('handleSyncGateArtifacts', () => {
    it('writes an ok cache row and emits when git diff succeeds', async () => {
      writeFileSync(join(repoPath, 'README.md'), 'hello\nnew line\n');
      const { deps, publish, cacheRepo } = makeDeps({ worktreePath: repoPath, db });

      const result = await handleSyncGateArtifacts({ runId: RUN_ID, taskId: TASK_ID }, deps);

      expect(result).toMatchObject({ ok: true });
      const row = cacheRepo.get(RUN_ID, 'gateArtifacts', TASK_ID);
      expect(row?.status).toBe('ok');
      expect(row?.data).toMatchObject({ isGitRepo: true });
      const data = row?.data as { files: unknown[] };
      expect(data.files.length).toBeGreaterThan(0);
      expect(publish).toHaveBeenCalledWith(
        'space.artifactCache.updated',
        expect.objectContaining({
          runId: RUN_ID,
          taskId: TASK_ID,
          cacheKey: 'gateArtifacts',
          status: 'ok',
        })
      );
    });

    it('writes an ok isGitRepo=false row when the worktree is not a git repo', async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), 'hyperneo-not-git-'));
      try {
        const { deps, cacheRepo } = makeDeps({ worktreePath: nonGitDir, db });
        const result = await handleSyncGateArtifacts({ runId: RUN_ID }, deps);
        expect(result).toMatchObject({ ok: true, isGitRepo: false });

        const row = cacheRepo.get(RUN_ID, 'gateArtifacts');
        expect(row?.status).toBe('ok');
        expect(row?.data).toMatchObject({ isGitRepo: false });
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });

    it('writes an error cache row when no worktree can be resolved', async () => {
      const { deps, cacheRepo } = makeDeps({ worktreePath: null, db });
      (deps.spaceManager.getSpace as ReturnType<typeof mock>).mockImplementation(async () => ({
        id: SPACE_ID,
        slug: 'space',
        workspacePath: '',
        name: 'Space',
        description: '',
        backgroundContext: '',
        instructions: '',
        sessionIds: [],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));

      const result = await handleSyncGateArtifacts({ runId: RUN_ID }, deps);
      expect(result).toMatchObject({ ok: false, reason: 'worktree-unresolved' });

      const row = cacheRepo.get(RUN_ID, 'gateArtifacts');
      expect(row?.status).toBe('error');
      expect(row?.error).toBe('Worktree path unresolved');
    });
  });

  describe('handleSyncCommits', () => {
    it('writes an ok cache row with the commits list', async () => {
      const { deps, cacheRepo } = makeDeps({ worktreePath: repoPath, db });
      const result = await handleSyncCommits({ runId: RUN_ID }, deps);
      expect(result).toMatchObject({ ok: true });

      const row = cacheRepo.get(RUN_ID, 'commits');
      expect(row?.status).toBe('ok');
      expect(row?.data).toMatchObject({ isGitRepo: true });
    });

    it('writes isGitRepo=false when the worktree is not a repo', async () => {
      const nonGitDir = mkdtempSync(join(tmpdir(), 'hyperneo-not-git-'));
      try {
        const { deps, cacheRepo } = makeDeps({ worktreePath: nonGitDir, db });
        await handleSyncCommits({ runId: RUN_ID }, deps);
        const row = cacheRepo.get(RUN_ID, 'commits');
        expect(row?.data).toMatchObject({ isGitRepo: false });
      } finally {
        rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('handleSyncFileDiff', () => {
    it('throws when filePath is missing', async () => {
      const { deps } = makeDeps({ worktreePath: repoPath, db });
      await expect(handleSyncFileDiff({ runId: RUN_ID }, deps)).rejects.toThrow(
        'filePath is required'
      );
    });

    it('writes an ok cache row with the diff payload', async () => {
      writeFileSync(join(repoPath, 'README.md'), 'hello\nadded line\n');
      const { deps, cacheRepo } = makeDeps({ worktreePath: repoPath, db });

      const result = await handleSyncFileDiff({ runId: RUN_ID, filePath: 'README.md' }, deps);
      expect(result).toMatchObject({ ok: true });

      const row = cacheRepo.get(RUN_ID, 'fileDiff:README.md');
      expect(row?.status).toBe('ok');
      const data = row?.data as {
        diff: string;
        additions: number;
        deletions: number;
        truncated: boolean;
      };
      expect(data.filePath).toBe('README.md');
      expect(data.diff.length).toBeGreaterThan(0);
      expect(data.truncated).toBe(false);
    });

    it('writes an error row with reason=worktree-unresolved when no worktree', async () => {
      const { deps, cacheRepo } = makeDeps({ worktreePath: null, db });
      (deps.spaceManager.getSpace as ReturnType<typeof mock>).mockImplementation(async () => ({
        id: SPACE_ID,
        slug: 'space',
        workspacePath: '',
        name: 'Space',
        description: '',
        backgroundContext: '',
        instructions: '',
        sessionIds: [],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }));

      const result = await handleSyncFileDiff({ runId: RUN_ID, filePath: 'README.md' }, deps);
      expect(result).toMatchObject({ ok: false, reason: 'worktree-unresolved' });

      const row = cacheRepo.get(RUN_ID, 'fileDiff:README.md');
      expect(row?.status).toBe('error');
    });
  });

  describe('createSyncArtifactHandlers factory', () => {
    it('returns handlers keyed by queue name', async () => {
      const { deps } = makeDeps({ worktreePath: repoPath, db });
      const handlers = createSyncArtifactHandlers(deps);
      expect(typeof handlers.gateArtifacts).toBe('function');
      expect(typeof handlers.commits).toBe('function');
      expect(typeof handlers.fileDiff).toBe('function');

      const fakeJob: Job = {
        id: 'j1',
        queue: 'spaceWorkflowRun.syncGateArtifacts',
        status: 'processing',
        payload: { runId: RUN_ID, taskId: TASK_ID },
        result: null,
        error: null,
        priority: 0,
        maxRetries: 3,
        retryCount: 0,
        runAt: Date.now(),
        createdAt: Date.now(),
        startedAt: Date.now(),
        completedAt: null,
      };
      const res = await handlers.gateArtifacts(fakeJob);
      expect(res).toMatchObject({ ok: true });
    });
  });
});
