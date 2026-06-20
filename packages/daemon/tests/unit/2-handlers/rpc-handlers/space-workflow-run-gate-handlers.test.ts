/**
 * Tests for Space Workflow Run Gate RPC Handlers
 *
 * Covers:
 * - spaceWorkflowRun.approveGate: approve (idempotent), reject (sets needs_attention + humanRejected),
 *   terminal state guard, missing params, event emission
 * - spaceWorkflowRun.getGateArtifacts: missing params, missing run, missing worktree path,
 *   successful artifacts retrieval with mocked git
 * - spaceWorkflowRun.getFileDiff: missing params, missing run, missing worktree path,
 *   successful diff retrieval with mocked git
 * - Persistence: gate data written to gateDataRepo (survives daemon restart via SQLite)
 */

// Ensure NODE_ENV is 'test' so the writeGateData handler is registered
// (it is gated on NODE_ENV !== 'production'; Bun defaults to 'production').
process.env.NODE_ENV = 'test';

import { describe, expect, it, mock, beforeEach, afterAll } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { Space, SpaceWorkflow, SpaceWorkflowRun } from '@neokai/shared';
import {
  setupSpaceWorkflowRunHandlers,
  type SpaceWorkflowRunTaskManagerFactory,
} from '../../../../src/lib/rpc-handlers/space-workflow-run-handlers.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import type {
  GateDataRepository,
  GateDataRecord,
} from '../../../../src/storage/repositories/gate-data-repository.ts';
import type { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import type { SpaceWorktreeManager } from '../../../../src/lib/space/managers/space-worktree-manager.ts';
import type { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import type { WorkflowRunArtifactCacheRepository } from '../../../../src/storage/repositories/workflow-run-artifact-cache-repository.ts';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';

// ─── Mock module for execFile (async) ─────────────────────────────────────────
//
// Production code uses execFile (callback-based) wrapped in a Promise.
// We mock node:child_process so git calls never touch the filesystem.
// mockExecResult is set per-test; by default returns empty string.

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;
let mockExecResult: (args: string[]) => string = () => '';

const mockExecFile = mock(
  (_cmd: string, args: string[], _opts: unknown, callback: ExecFileCallback) => {
    try {
      callback(null, mockExecResult(args), '');
    } catch (err) {
      callback(err as Error, '', '');
    }
  }
);

mock.module('node:child_process', () => ({ execFile: mockExecFile }));

// Restore the real node:child_process after this file's tests run so the
// mocked execFile doesn't leak into other files in the same Bun process
// (e.g. tests/unit/2-handlers/job-handlers/space-workflow-run-artifact.handler.test.ts
// shells out to real git and would otherwise see the stub).
afterAll(() => {
  mock.module('node:child_process', () => require('node:child_process'));
});

type RequestHandler = (data: unknown) => Promise<unknown>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();

const mockSpace: Space = {
  id: 'space-1',
  slug: 'test-space',
  workspacePath: '/tmp/test-workspace',
  name: 'Test Space',
  description: '',
  backgroundContext: '',
  instructions: '',
  sessionIds: [],
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
};

const mockWorkflow: SpaceWorkflow = {
  id: 'workflow-1',
  spaceId: 'space-1',
  name: 'Test Workflow',
  nodes: [{ id: 'step-1', name: 'Step One', agents: [{ agentId: 'agent-1', name: 'Coder' }] }],
  startNodeId: 'step-1',
  tags: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const mockRun: SpaceWorkflowRun = {
  id: 'run-1',
  spaceId: 'space-1',
  workflowId: 'workflow-1',
  title: 'Test Run',
  status: 'in_progress',
  startedAt: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const mockGateData: GateDataRecord = {
  runId: 'run-1',
  gateId: 'gate-approval',
  data: {},
  updatedAt: NOW,
};

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockInternalEventBus(): InternalEventBus<DaemonInternalEventMap> {
  return {
    publish: mock(async () => ({ delivered: 0, failures: [] })),
    publishAsync: mock(() => {}),
    subscribe: mock(() => () => {}),
    off: mock(() => {}),
    clear: mock(() => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
}

function createMockSpaceManager(space: Space | null = mockSpace): SpaceManager {
  return {
    getSpace: mock(async () => space),
  } as unknown as SpaceManager;
}

function createMockWorkflowManager(): SpaceWorkflowManager {
  return {
    listWorkflows: mock(() => [mockWorkflow]),
    getWorkflow: mock(() => mockWorkflow),
  } as unknown as SpaceWorkflowManager;
}

function createMockRunRepo(run: SpaceWorkflowRun | null = mockRun): SpaceWorkflowRunRepository {
  // Stateful mock: transitionStatus and updateRun mutate currentRun so that
  // chained calls (e.g. transitionStatus then updateRun) see the updated state.
  let currentRun = run;
  return {
    getRun: mock(() => currentRun),
    listBySpace: mock(() => (currentRun ? [currentRun] : [])),
    transitionStatus: mock((id: string, status: string) => {
      if (!currentRun) return null;
      currentRun = { ...currentRun, id, status: status as SpaceWorkflowRun['status'] };
      return currentRun;
    }),
    updateRun: mock((id: string, params: Partial<SpaceWorkflowRun>) => {
      if (!currentRun) return null;
      currentRun = { ...currentRun, id, ...params };
      return currentRun;
    }),
  } as unknown as SpaceWorkflowRunRepository;
}

function createMockGateDataRepo(existing: GateDataRecord | null = null): GateDataRepository {
  return {
    get: mock(() => existing),
    merge: mock((_runId: string, _gateId: string, partial: Record<string, unknown>) => ({
      ...mockGateData,
      data: { ...(existing?.data ?? {}), ...partial },
      updatedAt: Date.now(),
    })),
    set: mock((_runId: string, _gateId: string, data: Record<string, unknown>) => ({
      ...mockGateData,
      data,
      updatedAt: Date.now(),
    })),
  } as unknown as GateDataRepository;
}

function createMockRuntimeService(): SpaceRuntimeService {
  return {
    createOrGetRuntime: mock(async () => ({
      startWorkflowRun: mock(async () => ({ run: mockRun, tasks: [] })),
    })),
    notifyGateDataChanged: mock(async () => {}),
    notifyRunBlocked: mock(async () => {}),
    start: mock(() => {}),
    stop: mock(() => {}),
  } as unknown as SpaceRuntimeService;
}

/** Returns an empty task list — causes worktree path resolution to fall back to space.workspacePath */
function createMockSpaceTaskRepo(): SpaceTaskRepository {
  return {
    listByWorkflowRun: mock(() => []),
    getTask: mock(() => null),
  } as unknown as SpaceTaskRepository;
}

/** Returns null worktree path — causes resolution to fall back to space.workspacePath */
function createMockSpaceWorktreeManager(): SpaceWorktreeManager {
  return {
    getTaskWorktreePath: mock(async () => null),
  } as unknown as SpaceWorktreeManager;
}

// ─── Test Setup ───────────────────────────────────────────────────────────────

describe('space-workflow-run gate handlers', () => {
  let hub: MessageHub;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus;
  let runRepo: SpaceWorkflowRunRepository;
  let gateDataRepo: GateDataRepository;
  let taskManagerFactory: SpaceWorkflowRunTaskManagerFactory;

  function setup(
    opts: {
      run?: SpaceWorkflowRun | null;
      existingGateData?: GateDataRecord | null;
      space?: Space | null;
    } = {}
  ) {
    mockExecResult = () => '';
    mockExecFile.mockClear();

    const mh = createMockMessageHub();
    hub = mh.hub;
    handlers = mh.handlers;
    internalEventBus = createMockInternalEventBus();
    const resolvedRun = 'run' in opts ? opts.run : mockRun;
    runRepo = createMockRunRepo(resolvedRun ?? null);
    gateDataRepo = createMockGateDataRepo(
      'existingGateData' in opts ? opts.existingGateData : null
    );
    taskManagerFactory = mock(() => ({
      listTasksByWorkflowRun: mock(async () => []),
      cancelTask: mock(async () => {}),
    })) as unknown as SpaceWorkflowRunTaskManagerFactory;

    const resolvedSpace = 'space' in opts ? opts.space : mockSpace;

    setupSpaceWorkflowRunHandlers(
      hub,
      createMockSpaceManager(resolvedSpace),
      createMockWorkflowManager(),
      runRepo,
      gateDataRepo,
      createMockRuntimeService(),
      taskManagerFactory,
      internalEventBus,
      createMockSpaceTaskRepo(),
      createMockSpaceWorktreeManager(),
      {
        listByRun: mock(() => []),
      } as unknown as WorkflowRunArtifactRepository,
      {
        get: mock(() => null),
        upsert: mock(() => ({})),
        listByRun: mock(() => []),
        deleteByRun: mock(() => 0),
        deleteByRunTask: mock(() => 0),
      } as unknown as WorkflowRunArtifactCacheRepository,
      {
        enqueue: mock(() => ({})),
        listJobs: mock(() => []),
      } as unknown as JobQueueRepository
    );
  }

  const call = (method: string, data: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for ${method}`);
    return handler(data);
  };

  beforeEach(() => setup());

  // ─── spaceWorkflowRun.approveGate ─────────────────────────────────────

  describe('spaceWorkflowRun.approveGate', () => {
    it('throws if runId is missing', async () => {
      await expect(
        call('spaceWorkflowRun.approveGate', { gateId: 'gate-1', approved: true })
      ).rejects.toThrow('runId is required');
    });

    it('throws if gateId is missing', async () => {
      await expect(
        call('spaceWorkflowRun.approveGate', { runId: 'run-1', approved: true })
      ).rejects.toThrow('gateId is required');
    });

    it('throws if approved is missing', async () => {
      await expect(
        call('spaceWorkflowRun.approveGate', { runId: 'run-1', gateId: 'gate-1' })
      ).rejects.toThrow('approved is required');
    });

    it('throws if run not found', async () => {
      setup({ run: null });
      await expect(
        call('spaceWorkflowRun.approveGate', { runId: 'missing', gateId: 'g', approved: true })
      ).rejects.toThrow('WorkflowRun not found: missing');
    });

    it('throws if run is completed', async () => {
      setup({ run: { ...mockRun, status: 'done' } });
      await expect(
        call('spaceWorkflowRun.approveGate', { runId: 'run-1', gateId: 'g', approved: true })
      ).rejects.toThrow('Cannot modify gate on a done workflow run');
    });

    it('throws if run is cancelled', async () => {
      setup({ run: { ...mockRun, status: 'cancelled' } });
      await expect(
        call('spaceWorkflowRun.approveGate', { runId: 'run-1', gateId: 'g', approved: true })
      ).rejects.toThrow('Cannot modify gate on a cancelled workflow run');
    });

    it('throws if run is pending (invalid transition)', async () => {
      setup({ run: { ...mockRun, status: 'pending' } });
      await expect(
        call('spaceWorkflowRun.approveGate', { runId: 'run-1', gateId: 'g', approved: false })
      ).rejects.toThrow('Cannot modify gate on a pending workflow run');
    });

    it('approves gate: merges { approved: true } and emits event', async () => {
      const result = (await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: true,
      })) as { run: SpaceWorkflowRun; gateData: GateDataRecord };

      expect(gateDataRepo.merge).toHaveBeenCalledWith('run-1', 'gate-approval', {
        approved: true,
        approvedAt: expect.any(Number),
        approvalSource: 'human',
      });
      expect(result.gateData.data.approved).toBe(true);
      expect(
        (internalEventBus as unknown as { publish: ReturnType<typeof mock> }).publish
      ).toHaveBeenCalledWith(
        'space.workflowRun.updated',
        expect.objectContaining({ runId: 'run-1', spaceId: 'space-1' })
      );
    });

    it('approve is idempotent: returns existing data if already approved', async () => {
      setup({ existingGateData: { ...mockGateData, data: { approved: true, approvedAt: NOW } } });
      const result = (await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: true,
      })) as { run: SpaceWorkflowRun; gateData: GateDataRecord };

      // Should NOT call merge again for idempotent approval
      expect(gateDataRepo.merge).not.toHaveBeenCalled();
      expect(result.gateData.data.approved).toBe(true);
    });

    it('rejection: merges { approved: false } and sets run to blocked + humanRejected', async () => {
      const result = (await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: false,
        reason: 'Not ready',
      })) as { run: SpaceWorkflowRun; gateData: GateDataRecord };

      expect(gateDataRepo.merge).toHaveBeenCalledWith('run-1', 'gate-approval', {
        approved: false,
        rejectedAt: expect.any(Number),
        reason: 'Not ready',
        approvalSource: 'human',
      });
      // State machine transition to blocked (in_progress→blocked is valid)
      expect(runRepo.transitionStatus).toHaveBeenCalledWith('run-1', 'blocked');
      // failureReason written separately so it persists independently
      expect(runRepo.updateRun).toHaveBeenCalledWith('run-1', { failureReason: 'humanRejected' });
      expect(result.run.status).toBe('blocked');
      expect(result.run.failureReason).toBe('humanRejected');
      expect(
        (internalEventBus as unknown as { publish: ReturnType<typeof mock> }).publish
      ).toHaveBeenCalledWith('space.workflowRun.updated', expect.any(Object));
    });

    it('rejection with no reason stores null reason', async () => {
      await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: false,
      });

      expect(gateDataRepo.merge).toHaveBeenCalledWith('run-1', 'gate-approval', {
        approved: false,
        rejectedAt: expect.any(Number),
        reason: null,
        approvalSource: 'human',
      });
    });

    it('rejection is idempotent: returns existing state if gate data already shows rejected', async () => {
      const alreadyRejectedRun: SpaceWorkflowRun = {
        ...mockRun,
        status: 'blocked',
        failureReason: 'humanRejected',
      };
      setup({
        run: alreadyRejectedRun,
        existingGateData: { ...mockGateData, data: { approved: false, rejectedAt: NOW } },
      });

      const result = (await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: false,
      })) as { run: SpaceWorkflowRun; gateData: GateDataRecord };

      // Idempotent: no writes at all
      expect(gateDataRepo.merge).not.toHaveBeenCalled();
      expect(runRepo.updateRun).not.toHaveBeenCalled();
      expect(result.gateData.data.approved).toBe(false);
    });

    it('approve after prior rejection: transitions run back to in_progress and clears failureReason', async () => {
      const rejectedRun: SpaceWorkflowRun = {
        ...mockRun,
        status: 'blocked',
        failureReason: 'humanRejected',
      };
      setup({ run: rejectedRun });

      const result = (await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: true,
      })) as { run: SpaceWorkflowRun; gateData: GateDataRecord };

      expect(gateDataRepo.merge).toHaveBeenCalledWith('run-1', 'gate-approval', {
        approved: true,
        approvedAt: expect.any(Number),
        approvalSource: 'human',
      });
      // State machine transition back to in_progress
      expect(runRepo.transitionStatus).toHaveBeenCalledWith('run-1', 'in_progress');
      // failureReason cleared separately so the run appears clean to the UI
      expect(runRepo.updateRun).toHaveBeenCalledWith('run-1', { failureReason: null });
      expect(result.run.status).toBe('in_progress');
      // null from updateRun({ failureReason: null }) — effectively cleared
      expect(result.run.failureReason).toBeFalsy();
      expect(
        (internalEventBus as unknown as { publish: ReturnType<typeof mock> }).publish
      ).toHaveBeenCalledWith('space.workflowRun.updated', expect.any(Object));
    });

    it('rejection when run is already blocked (non-humanRejected): skips transitionStatus, sets failureReason', async () => {
      // e.g. run is blocked due to maxIterationsReached; human gate rejection
      // should override the failureReason without calling transitionStatus (which would
      // reject blocked→blocked as a no-op or invalid transition).
      const stuckRun: SpaceWorkflowRun = {
        ...mockRun,
        status: 'blocked',
        failureReason: 'maxIterationsReached',
      };
      setup({ run: stuckRun });

      const result = (await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: false,
      })) as { run: SpaceWorkflowRun; gateData: GateDataRecord };

      // transitionStatus must NOT be called since status is already blocked
      expect(runRepo.transitionStatus).not.toHaveBeenCalled();
      // Only failureReason is written
      expect(runRepo.updateRun).toHaveBeenCalledWith('run-1', { failureReason: 'humanRejected' });
      expect(result.run.status).toBe('blocked');
      expect(result.run.failureReason).toBe('humanRejected');
    });

    it('gate approval persists to gateDataRepo (survives restart)', async () => {
      // Verify merge is called — data is stored in SQLite gate_data table
      await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: true,
      });
      expect(gateDataRepo.merge).toHaveBeenCalledTimes(1);
    });

    it('approveGate emits space.gateData.updated with gate data on approval', async () => {
      await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: true,
      });
      expect(
        (internalEventBus as unknown as { publish: ReturnType<typeof mock> }).publish
      ).toHaveBeenCalledWith(
        'space.gateData.updated',
        expect.objectContaining({
          spaceId: 'space-1',
          runId: 'run-1',
          gateId: 'gate-approval',
          data: expect.objectContaining({ approved: true }),
        })
      );
    });

    it('approveGate emits space.gateData.updated with gate data on rejection', async () => {
      await call('spaceWorkflowRun.approveGate', {
        runId: 'run-1',
        gateId: 'gate-approval',
        approved: false,
        reason: 'Not ready',
      });
      expect(
        (internalEventBus as unknown as { publish: ReturnType<typeof mock> }).publish
      ).toHaveBeenCalledWith(
        'space.gateData.updated',
        expect.objectContaining({
          spaceId: 'space-1',
          runId: 'run-1',
          gateId: 'gate-approval',
          data: expect.objectContaining({ approved: false }),
        })
      );
    });
  });

  // ─── spaceWorkflowRun.getGateArtifacts ────────────────────────────────

  describe('spaceWorkflowRun.getGateArtifacts', () => {
    it('throws if runId is missing', async () => {
      await expect(call('spaceWorkflowRun.getGateArtifacts', {})).rejects.toThrow(
        'runId is required'
      );
    });

    it('throws if run not found', async () => {
      setup({ run: null });
      await expect(call('spaceWorkflowRun.getGateArtifacts', { runId: 'missing' })).rejects.toThrow(
        'WorkflowRun not found: missing'
      );
    });

    it('throws if space has no workspace path', async () => {
      setup({ space: { ...mockSpace, workspacePath: '' } });
      await expect(call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' })).rejects.toThrow(
        'No workspace path found for run: run-1'
      );
    });

    it('throws if space is not found', async () => {
      setup({ space: null });
      await expect(call('spaceWorkflowRun.getGateArtifacts', { runId: 'run-1' })).rejects.toThrow(
        'No workspace path found for run: run-1'
      );
    });

    it('returns file stats from git diff --numstat', async () => {
      // numstat returns file changes for uncommitted working tree vs HEAD
      mockExecResult = (args) => {
        if (args.includes('--numstat')) return '5\t3\tsrc/foo.ts\n2\t0\tsrc/bar.ts\n';
        return '';
      };

      const result = (await call('spaceWorkflowRun.getGateArtifacts', {
        runId: 'run-1',
      })) as {
        files: Array<{ path: string; additions: number; deletions: number }>;
        totalAdditions: number;
        totalDeletions: number;
        worktreePath: string;
      };

      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toEqual({ path: 'src/foo.ts', additions: 5, deletions: 3 });
      expect(result.files[1]).toEqual({ path: 'src/bar.ts', additions: 2, deletions: 0 });
      expect(result.totalAdditions).toBe(7);
      expect(result.totalDeletions).toBe(3);
      expect(result.worktreePath).toBe('/tmp/test-workspace');
    });

    it('returns empty file list when no changes', async () => {
      // mockExecResult already returns '' by default after setup()
      const result = (await call('spaceWorkflowRun.getGateArtifacts', {
        runId: 'run-1',
      })) as { files: Array<unknown>; totalAdditions: number; totalDeletions: number };

      expect(result.files).toHaveLength(0);
      expect(result.totalAdditions).toBe(0);
      expect(result.totalDeletions).toBe(0);
    });

    it('handles binary files (- entries in numstat)', async () => {
      mockExecResult = (args) => {
        if (args.includes('--numstat')) return '-\t-\tassets/image.png\n3\t1\tsrc/foo.ts\n';
        return '';
      };

      const result = (await call('spaceWorkflowRun.getGateArtifacts', {
        runId: 'run-1',
      })) as {
        files: Array<{ path: string; additions: number; deletions: number }>;
        totalAdditions: number;
      };

      expect(result.files).toHaveLength(2);
      // Binary file gets 0/0
      expect(result.files[0]).toEqual({ path: 'assets/image.png', additions: 0, deletions: 0 });
      expect(result.totalAdditions).toBe(3);
    });
  });

  // ─── spaceWorkflowRun.getFileDiff ─────────────────────────────────────

  describe('spaceWorkflowRun.getFileDiff', () => {
    it('throws if runId is missing', async () => {
      await expect(
        call('spaceWorkflowRun.getFileDiff', { filePath: 'src/foo.ts' })
      ).rejects.toThrow('runId is required');
    });

    it('throws if filePath is missing', async () => {
      await expect(call('spaceWorkflowRun.getFileDiff', { runId: 'run-1' })).rejects.toThrow(
        'filePath is required'
      );
    });

    it('throws if filePath is whitespace only', async () => {
      await expect(
        call('spaceWorkflowRun.getFileDiff', { runId: 'run-1', filePath: '   ' })
      ).rejects.toThrow('filePath is required');
    });

    it('throws if filePath contains path traversal (..)', async () => {
      await expect(
        call('spaceWorkflowRun.getFileDiff', {
          runId: 'run-1',
          filePath: '../../etc/passwd',
        })
      ).rejects.toThrow('filePath must be a relative path within the worktree');
    });

    it('throws if filePath is absolute', async () => {
      await expect(
        call('spaceWorkflowRun.getFileDiff', {
          runId: 'run-1',
          filePath: '/etc/passwd',
        })
      ).rejects.toThrow('filePath must be a relative path within the worktree');
    });

    it('throws if run not found', async () => {
      setup({ run: null });
      await expect(
        call('spaceWorkflowRun.getFileDiff', { runId: 'missing', filePath: 'src/foo.ts' })
      ).rejects.toThrow('WorkflowRun not found: missing');
    });

    it('throws if space has no workspace path', async () => {
      setup({ space: null });
      await expect(
        call('spaceWorkflowRun.getFileDiff', { runId: 'run-1', filePath: 'src/foo.ts' })
      ).rejects.toThrow('No workspace path found for run: run-1');
    });

    it('returns unified diff for a file', async () => {
      const unifiedDiff = [
        'diff --git a/src/foo.ts b/src/foo.ts',
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@ -1,3 +1,4 @@',
        ' const x = 1;',
        '+const y = 2;',
        ' export { x };',
        '-// old comment',
      ].join('\n');

      mockExecResult = (args) => {
        if (args.includes('merge-base')) return 'abc123\n';
        return unifiedDiff;
      };

      const result = (await call('spaceWorkflowRun.getFileDiff', {
        runId: 'run-1',
        filePath: 'src/foo.ts',
      })) as { diff: string; additions: number; deletions: number; filePath: string };

      expect(result.diff).toBe(unifiedDiff);
      expect(result.additions).toBe(1); // +const y = 2;
      expect(result.deletions).toBe(1); // -// old comment
      expect(result.filePath).toBe('src/foo.ts');
    });

    it('returns empty diff when file has no changes', async () => {
      // mockExecResult already returns '' by default
      const result = (await call('spaceWorkflowRun.getFileDiff', {
        runId: 'run-1',
        filePath: 'src/unchanged.ts',
      })) as { diff: string; additions: number; deletions: number };

      expect(result.diff).toBe('');
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
    });

    it('passes correct git args for uncommitted diff', async () => {
      mockExecResult = () => '+added line\n-removed line\n';

      await call('spaceWorkflowRun.getFileDiff', {
        runId: 'run-1',
        filePath: 'src/foo.ts',
      });

      // Find the diff call (has 'diff' and '--' separator in args)
      const calls = mockExecFile.mock.calls;
      const diffCall = calls.find(
        (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('diff') && c[1].includes('--')
      );
      expect(diffCall).toBeDefined();
      const diffArgs = diffCall![1] as string[];
      expect(diffArgs).toContain('HEAD');
      expect(diffArgs).toContain('src/foo.ts');
      // Should not use range notation (e.g. baseRef..HEAD)
      expect(diffArgs.some((a) => a.includes('..'))).toBe(false);
    });

    it('always uses HEAD-based diff (no merge-base lookup)', async () => {
      mockExecResult = () => '+new line\n';

      await call('spaceWorkflowRun.getFileDiff', {
        runId: 'run-1',
        filePath: 'src/foo.ts',
      });

      const calls = mockExecFile.mock.calls;
      // Confirm no merge-base call was made
      const mergeBaseCall = calls.find(
        (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('merge-base')
      );
      expect(mergeBaseCall).toBeUndefined();

      const diffCall = calls.find(
        (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('diff') && c[1].includes('--')
      );
      expect(diffCall).toBeDefined();
      const diffArgs = diffCall![1] as string[];
      expect(diffArgs).toContain('HEAD');
      expect(diffArgs.some((a) => a.includes('..'))).toBe(false);
    });

    it('correctly counts additions and deletions, ignoring diff header lines', async () => {
      const unifiedDiff = [
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '+added line 1',
        '+added line 2',
        '-removed line 1',
        ' unchanged line',
      ].join('\n');

      mockExecResult = () => unifiedDiff;

      const result = (await call('spaceWorkflowRun.getFileDiff', {
        runId: 'run-1',
        filePath: 'src/foo.ts',
      })) as { additions: number; deletions: number };

      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(1);
    });
  });

  // ─── spaceWorkflowRun.writeGateData ───────────────────────────────────────

  describe('spaceWorkflowRun.writeGateData', () => {
    it('throws if runId is missing', async () => {
      await expect(
        call('spaceWorkflowRun.writeGateData', { gateId: 'g1', data: {} })
      ).rejects.toThrow('runId is required');
    });

    it('throws if gateId is missing', async () => {
      await expect(
        call('spaceWorkflowRun.writeGateData', { runId: 'run-1', data: {} })
      ).rejects.toThrow('gateId is required');
    });

    it('throws if data is not an object', async () => {
      await expect(
        call('spaceWorkflowRun.writeGateData', { runId: 'run-1', gateId: 'g1', data: 'bad' })
      ).rejects.toThrow('data must be an object');
    });

    it('throws if data is an array', async () => {
      await expect(
        call('spaceWorkflowRun.writeGateData', { runId: 'run-1', gateId: 'g1', data: [] })
      ).rejects.toThrow('data must be an object');
    });

    it('throws if run not found', async () => {
      setup({ run: null });
      await expect(
        call('spaceWorkflowRun.writeGateData', { runId: 'run-1', gateId: 'g1', data: {} })
      ).rejects.toThrow('WorkflowRun not found: run-1');
    });

    it('throws if run is done (status guard)', async () => {
      setup({ run: { ...mockRun, status: 'done' } });
      await expect(
        call('spaceWorkflowRun.writeGateData', {
          runId: 'run-1',
          gateId: 'review-votes-gate',
          data: { votes: { 'Reviewer 1': 'approved' } },
        })
      ).rejects.toThrow('Cannot write gate data on a done workflow run');
    });

    it('throws if run is cancelled (status guard)', async () => {
      setup({ run: { ...mockRun, status: 'cancelled' } });
      await expect(
        call('spaceWorkflowRun.writeGateData', {
          runId: 'run-1',
          gateId: 'review-votes-gate',
          data: { votes: { 'Reviewer 1': 'approved' } },
        })
      ).rejects.toThrow('Cannot write gate data on a cancelled workflow run');
    });

    it('throws if run is pending (status guard)', async () => {
      setup({ run: { ...mockRun, status: 'pending' } });
      await expect(
        call('spaceWorkflowRun.writeGateData', {
          runId: 'run-1',
          gateId: 'review-votes-gate',
          data: { votes: { 'Reviewer 1': 'approved' } },
        })
      ).rejects.toThrow('Cannot write gate data on a pending workflow run');
    });

    it('merges gate data via gateDataRepo.merge', async () => {
      await call('spaceWorkflowRun.writeGateData', {
        runId: 'run-1',
        gateId: 'review-votes-gate',
        data: { votes: { 'Reviewer 1': 'approved' } },
      });
      expect(gateDataRepo.merge).toHaveBeenCalledWith('run-1', 'review-votes-gate', {
        votes: { 'Reviewer 1': 'approved' },
      });
    });

    it('emits space.gateData.updated with correct payload', async () => {
      await call('spaceWorkflowRun.writeGateData', {
        runId: 'run-1',
        gateId: 'review-votes-gate',
        data: { votes: { 'Reviewer 2': 'rejected' } },
      });

      expect(
        (internalEventBus as unknown as { publish: ReturnType<typeof mock> }).publish
      ).toHaveBeenCalledWith(
        'space.gateData.updated',
        expect.objectContaining({
          sessionId: 'global',
          spaceId: mockRun.spaceId,
          runId: 'run-1',
          gateId: 'review-votes-gate',
        })
      );
    });

    it('returns the updated gateData record', async () => {
      const result = (await call('spaceWorkflowRun.writeGateData', {
        runId: 'run-1',
        gateId: 'code-pr-gate',
        data: { pr_url: 'https://github.com/test/repo/pull/1' },
      })) as { gateData: { runId: string; gateId: string } };

      expect(result.gateData).toBeDefined();
      expect(result.gateData.gateId).toBe('gate-approval'); // mockGateData default id
    });
  });
});
