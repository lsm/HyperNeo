import { describe, expect, test } from 'bun:test';
import type {
  SessionResolutionDeps,
  WorkerExecutionSession,
  WorkerTaskPhase,
} from '../../../../src/lib/session-resolution/deps';
import {
  crashHandler,
  ensureSession,
  ensureStage,
  findStage,
} from '../../../../src/lib/session-resolution/ensure-session';
import type { SessionTarget } from '../../../../src/lib/session-resolution/target';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';

const SPACE_ID = 'space-1';
const TASK_ID = 'task-1';
const AGENT_NAME = 'coder';
const AGENT_ONE = 'agent-1';
const agentSessionId = longTermAgentSessionId(SPACE_ID, AGENT_ONE);

interface DepsLog {
  getSession: string[];
  rehydrateSubSession: string[];
  getCoordinator: number;
  ensureLongTermAgent: Array<[spaceId: string, agentId: string]>;
  listWorkerExecutions: number;
  getTaskSpaceId: number;
  activateTaskAgent: number;
  spawnPostApprovalWorker: Array<[taskId: string, agentName: string, workflowNodeId?: string]>;
}

function makeDeps(
  handlers: {
    getSession?: (sessionId: string) => unknown;
    rehydrateSubSession?: (sessionId: string) => unknown;
    getCoordinator?: () => { id: string } | null;
    ensureLongTermAgent?: (spaceId: string, agentId: string) => unknown;
    listWorkerExecutions?: () => WorkerExecutionSession[];
    readWorkerTaskPhase?: () => WorkerTaskPhase;
    getTaskSpaceId?: () => string | null;
    activateTaskAgent?: () => boolean;
    spawnPostApprovalWorker?: (
      taskId: string,
      agentName: string,
      workflowNodeId?: string
    ) => string | null;
    getPostApprovalWorkerSession?: () => {
      sessionId: string;
      agentName: string;
      nodeId?: string | null;
    } | null;
  } = {}
): { deps: SessionResolutionDeps; log: DepsLog } {
  const log: DepsLog = {
    getSession: [],
    rehydrateSubSession: [],
    getCoordinator: 0,
    ensureLongTermAgent: [],
    listWorkerExecutions: 0,
    getTaskSpaceId: 0,
    activateTaskAgent: 0,
    spawnPostApprovalWorker: [],
  };
  const deps: SessionResolutionDeps = {
    getSession: async (sessionId) => {
      log.getSession.push(sessionId);
      return handlers.getSession ? handlers.getSession(sessionId) : null;
    },
    rehydrateSubSession: async (sessionId) => {
      log.rehydrateSubSession.push(sessionId);
      return handlers.rehydrateSubSession ? handlers.rehydrateSubSession(sessionId) : null;
    },
    getCoordinator: async () => {
      log.getCoordinator += 1;
      return handlers.getCoordinator ? handlers.getCoordinator() : null;
    },
    ensureLongTermAgent: async (spaceId, agentId) => {
      log.ensureLongTermAgent.push([spaceId, agentId]);
      return handlers.ensureLongTermAgent ? handlers.ensureLongTermAgent(spaceId, agentId) : null;
    },
    listWorkerExecutions: () => {
      log.listWorkerExecutions += 1;
      return handlers.listWorkerExecutions ? handlers.listWorkerExecutions() : [];
    },
    readWorkerTaskPhase: () =>
      handlers.readWorkerTaskPhase ? handlers.readWorkerTaskPhase() : 'run_active',
    getTaskSpaceId: async () => {
      log.getTaskSpaceId += 1;
      return handlers.getTaskSpaceId ? handlers.getTaskSpaceId() : null;
    },
    activateTaskAgent: async () => {
      log.activateTaskAgent += 1;
      return handlers.activateTaskAgent ? handlers.activateTaskAgent() : false;
    },
    spawnPostApprovalWorker: async (taskId, agentName, workflowNodeId) => {
      log.spawnPostApprovalWorker.push([taskId, agentName, workflowNodeId]);
      return handlers.spawnPostApprovalWorker
        ? handlers.spawnPostApprovalWorker(taskId, agentName, workflowNodeId)
        : null;
    },
    getPostApprovalWorkerSession: () =>
      handlers.getPostApprovalWorkerSession ? handlers.getPostApprovalWorkerSession() : null,
  };
  return { deps, log };
}

const row = (sessionId: string | null, status: string): WorkerExecutionSession => ({
  sessionId,
  status,
});

const sessionTarget = (sessionId = 'sess-1'): SessionTarget => ({ kind: 'session', sessionId });
const agentTarget = (
  overrides: Partial<{ spaceId: string; agentId: string }> = {}
): SessionTarget => ({
  kind: 'agent',
  spaceId: SPACE_ID,
  agentId: 'agent-1',
  ...overrides,
});
const workerTarget = (
  overrides: Partial<{ taskId: string; agentName: string }> = {}
): SessionTarget => ({
  kind: 'worker',
  taskId: TASK_ID,
  agentName: AGENT_NAME,
  ...overrides,
});

describe('findStage', () => {
  test('session kind found via getSession resolves created:false', async () => {
    const { deps, log } = makeDeps({ getSession: (id) => (id === 'sess-1' ? { id } : null) });
    expect(await findStage(sessionTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: 'sess-1',
      created: false,
    });
    expect(log.getSession).toEqual(['sess-1']);
    expect(log.ensureLongTermAgent).toEqual([]);
  });

  test('session kind found via rehydrate resolves created:false', async () => {
    const { deps, log } = makeDeps({ rehydrateSubSession: () => ({ id: 'sess-1' }) });
    expect(await findStage(sessionTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: 'sess-1',
      created: false,
    });
    expect(log.getSession).toEqual(['sess-1']);
    expect(log.rehydrateSubSession).toEqual(['sess-1']);
  });

  test('session kind missed writes no outcome and never creates', async () => {
    const { deps, log } = makeDeps();
    expect(await findStage(sessionTarget(), deps)).toBeUndefined();
    expect(log.getSession).toEqual(['sess-1']);
    expect(log.rehydrateSubSession).toEqual(['sess-1']);
    expect(log.ensureLongTermAgent).toEqual([]);
    expect(log.activateTaskAgent).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([]);
  });

  test('agent kind found resolves the deterministic id created:false', async () => {
    const { deps, log } = makeDeps({ getSession: (id) => (id === agentSessionId ? { id } : null) });
    expect(await findStage(agentTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: agentSessionId,
      created: false,
    });
    expect(log.getSession).toEqual([agentSessionId]);
    expect(log.getCoordinator).toBe(1);
  });

  test('agent kind missed writes no outcome and never creates', async () => {
    const { deps, log } = makeDeps();
    expect(await findStage(agentTarget(), deps)).toBeUndefined();
    expect(log.getSession).toEqual([agentSessionId]);
    expect(log.ensureLongTermAgent).toEqual([]);
    expect(log.activateTaskAgent).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([]);
  });

  test('worker kind passes through with no lookup of any kind', async () => {
    const { deps, log } = makeDeps();
    expect(await findStage(workerTarget(), deps)).toBeUndefined();
    expect(log.getSession).toEqual([]);
    expect(log.rehydrateSubSession).toEqual([]);
    expect(log.getCoordinator).toBe(0);
    expect(log.ensureLongTermAgent).toEqual([]);
    expect(log.listWorkerExecutions).toBe(0);
    expect(log.getTaskSpaceId).toBe(0);
    expect(log.activateTaskAgent).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([]);
  });
});

describe('ensureStage', () => {
  test('session kind returns unresolved not_found with no dep calls', async () => {
    const { deps, log } = makeDeps();
    expect(await ensureStage(sessionTarget(), deps)).toEqual({
      kind: 'unresolved',
      reason: 'not_found',
    });
    expect(log.getSession).toEqual([]);
    expect(log.rehydrateSubSession).toEqual([]);
    expect(log.getCoordinator).toBe(0);
    expect(log.ensureLongTermAgent).toEqual([]);
    expect(log.listWorkerExecutions).toBe(0);
    expect(log.getTaskSpaceId).toBe(0);
    expect(log.activateTaskAgent).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([]);
  });

  test('agent kind delegates to the arm and resolves an existing session created:false', async () => {
    const { deps, log } = makeDeps({ getSession: (id) => (id === agentSessionId ? { id } : null) });
    expect(await ensureStage(agentTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: agentSessionId,
      created: false,
    });
    expect(log.ensureLongTermAgent).toEqual([]);
  });

  test('agent kind delegates to the arm and creates a missing session', async () => {
    const { deps, log } = makeDeps({
      ensureLongTermAgent: () => ({ id: agentSessionId }),
    });
    expect(await ensureStage(agentTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: agentSessionId,
      created: true,
    });
    expect(log.ensureLongTermAgent).toEqual([[SPACE_ID, 'agent-1']]);
  });

  test('agent kind surfaces the arm ensure_failed outcome', async () => {
    const { deps, log } = makeDeps({ ensureLongTermAgent: () => null });
    expect(await ensureStage(agentTarget(), deps)).toEqual({
      kind: 'unresolved',
      reason: 'ensure_failed',
    });
    expect(log.ensureLongTermAgent).toEqual([[SPACE_ID, 'agent-1']]);
  });

  test('worker kind delegates to the worker arm find', async () => {
    const { deps, log } = makeDeps({
      listWorkerExecutions: () => [row('s-live', 'running')],
      rehydrateSubSession: (id) => ({ id }),
    });
    expect(await ensureStage(workerTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: 's-live',
      created: false,
    });
    expect(log.listWorkerExecutions).toBe(1);
    expect(log.activateTaskAgent).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([]);
  });

  test('worker kind delegates to the post-approval arm on the post-approval phase', async () => {
    const { deps, log } = makeDeps({
      readWorkerTaskPhase: () => 'post_approval',
      getPostApprovalWorkerSession: () => null,
      spawnPostApprovalWorker: () => 'spawned-1',
    });
    expect(await ensureStage(workerTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: 'spawned-1',
      created: true,
    });
    expect(log.listWorkerExecutions).toBe(0);
    expect(log.getTaskSpaceId).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([[TASK_ID, AGENT_NAME, undefined]]);
  });
});

describe('crashHandler', () => {
  test('maps an Error to the internal reason channel', () => {
    expect(crashHandler(new Error('boom'))).toEqual({
      kind: 'unresolved',
      reason: 'internal: boom',
    });
  });

  test('maps a non-Error throw to its string form', () => {
    expect(crashHandler('nope')).toEqual({ kind: 'unresolved', reason: 'internal: nope' });
  });
});

describe('ensureSession', () => {
  test('session kind found resolves created:false and ensureStage never runs', async () => {
    const { deps, log } = makeDeps({
      getSession: (id) => (id === 'sess-1' ? { id } : null),
      ensureLongTermAgent: () => {
        throw new Error('must not create');
      },
      activateTaskAgent: () => {
        throw new Error('must not activate');
      },
      spawnPostApprovalWorker: () => {
        throw new Error('must not spawn');
      },
    });
    expect(await ensureSession(sessionTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: 'sess-1',
      created: false,
    });
    expect(log.getSession).toEqual(['sess-1']);
    expect(log.ensureLongTermAgent).toEqual([]);
    expect(log.activateTaskAgent).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([]);
  });

  test('session kind missed resolves not_found and no create dep is ever called', async () => {
    const { deps, log } = makeDeps({
      ensureLongTermAgent: () => {
        throw new Error('must not create');
      },
      activateTaskAgent: () => {
        throw new Error('must not activate');
      },
      spawnPostApprovalWorker: () => {
        throw new Error('must not spawn');
      },
    });
    expect(await ensureSession(sessionTarget('sess-gone'), deps)).toEqual({
      kind: 'unresolved',
      reason: 'not_found',
    });
    expect(log.getSession).toEqual(['sess-gone']);
    expect(log.rehydrateSubSession).toEqual(['sess-gone']);
    expect(log.ensureLongTermAgent).toEqual([]);
    expect(log.activateTaskAgent).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([]);
  });

  test('agent kind found by the door find is never clobbered by the ensure arm', async () => {
    const { deps, log } = makeDeps({
      getSession: (id) => (id === agentSessionId ? { id } : null),
      ensureLongTermAgent: () => {
        throw new Error('must not create');
      },
    });
    expect(await ensureSession(agentTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: agentSessionId,
      created: false,
    });
    expect(log.getSession).toEqual([agentSessionId]);
    expect(log.ensureLongTermAgent).toEqual([]);
  });

  test('agent kind missed by the find flows into the arm and creates', async () => {
    const { deps, log } = makeDeps({
      ensureLongTermAgent: () => ({ id: agentSessionId }),
    });
    expect(await ensureSession(agentTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: agentSessionId,
      created: true,
    });
    expect(log.getSession).toEqual([agentSessionId, agentSessionId]);
    expect(log.ensureLongTermAgent).toEqual([[SPACE_ID, 'agent-1']]);
  });

  test('agent kind arm failure surfaces ensure_failed', async () => {
    const { deps } = makeDeps({ ensureLongTermAgent: () => null });
    expect(await ensureSession(agentTarget(), deps)).toEqual({
      kind: 'unresolved',
      reason: 'ensure_failed',
    });
  });

  test('worker kind delegates to the worker arm which runs its own find once', async () => {
    const { deps, log } = makeDeps({
      listWorkerExecutions: () => [row('s-live', 'running')],
      rehydrateSubSession: (id) => ({ id }),
    });
    expect(await ensureSession(workerTarget(), deps)).toEqual({
      kind: 'resolved',
      sessionId: 's-live',
      created: false,
    });
    expect(log.listWorkerExecutions).toBe(1);
    expect(log.getSession).toEqual([]);
    expect(log.getCoordinator).toBe(0);
    expect(log.activateTaskAgent).toBe(0);
    expect(log.spawnPostApprovalWorker).toEqual([]);
  });

  test('a findStage crash resolves through the internal reason channel', async () => {
    const { deps } = makeDeps({
      getSession: () => {
        throw new Error('lookup exploded');
      },
    });
    expect(await ensureSession(sessionTarget(), deps)).toEqual({
      kind: 'unresolved',
      reason: 'internal: lookup exploded',
    });
  });

  test('an ensureStage crash resolves through the internal reason channel', async () => {
    const { deps } = makeDeps({
      listWorkerExecutions: () => {
        throw new Error('executions exploded');
      },
    });
    expect(await ensureSession(workerTarget(), deps)).toEqual({
      kind: 'unresolved',
      reason: 'internal: executions exploded',
    });
  });
});
