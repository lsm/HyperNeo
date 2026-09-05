import { describe, expect, test } from 'bun:test';
import type { SessionResolutionDeps } from '../../../../src/lib/session-resolution/deps';
import { resolveAgentDeliverySession } from '../../../../src/lib/session-resolution/resolve-agent-delivery-session';
import { agentSessionIdOf } from '../../../../src/lib/session-resolution/target';
import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
} from '../../../../src/storage/repositories/space-long-horizon-agent-repository';

interface TestSession {
  id: string;
  generation: number;
}

function makeDeps(config?: {
  coordinatorId?: string;
  existing?: TestSession;
  ensured?: TestSession;
}): {
  deps: SessionResolutionDeps;
  getSessionCalls: string[];
  refetchCalls: string[];
  ensureCalls: Array<[string, string]>;
  getSession: (sessionId: string) => Promise<TestSession | null>;
} {
  const sessions = new Map<string, TestSession>();
  if (config?.existing) sessions.set(config.existing.id, config.existing);
  const getSessionCalls: string[] = [];
  const refetchCalls: string[] = [];
  const ensureCalls: Array<[string, string]> = [];
  const deps: SessionResolutionDeps = {
    getSession: async (sessionId) => {
      getSessionCalls.push(sessionId);
      return sessions.get(sessionId) ?? null;
    },
    ensureLongTermAgent: async (spaceId, agentId) => {
      ensureCalls.push([spaceId, agentId]);
      if (!config?.ensured) return null;
      sessions.set(agentSessionIdOf(spaceId, agentId, config.coordinatorId), config.ensured);
      return config.ensured;
    },
    rehydrateSubSession: async () => null,
    getCoordinator: async () =>
      config?.coordinatorId === undefined ? null : { id: config.coordinatorId },
    isAgentTargetLifecycleEligible: async () => true,
    listWorkerExecutions: () => [],
    readWorkerTaskPhase: () => 'run_active',
    getTaskSpaceId: async () => null,
    activateTaskAgent: async () => false,
    spawnPostApprovalWorker: async () => null,
    getPostApprovalWorkerSession: () => null,
  };
  return {
    deps,
    getSessionCalls,
    refetchCalls,
    ensureCalls,
    getSession: async (sessionId) => {
      refetchCalls.push(sessionId);
      return sessions.get(sessionId) ?? null;
    },
  };
}

describe('resolveAgentDeliverySession', () => {
  test('finds, preserves provisioning side effects, and re-fetches the Session object', async () => {
    const sessionId = agentSessionIdOf('space-1', 'agent-1');
    const existing = { id: sessionId, generation: 1 };
    const fresh = { id: sessionId, generation: 2 };
    const { deps, getSessionCalls, refetchCalls, ensureCalls } = makeDeps({ existing });

    const session = await resolveAgentDeliverySession('space-1', 'agent-1', deps, async (id) => {
      refetchCalls.push(id);
      return fresh;
    });

    expect(session).toBe(fresh);
    expect(getSessionCalls).toEqual([sessionId]);
    expect(refetchCalls).toEqual([sessionId]);
    expect(ensureCalls).toEqual([['space-1', 'agent-1']]);
  });

  test('creates a missing coordinator and maps its row id to the coordinator session', async () => {
    const spaceId = 'space-1';
    const coordinatorId = coordinatorLongHorizonAgentId(spaceId);
    const sessionId = coordinatorSessionId(spaceId);
    const ensured = { id: sessionId, generation: 1 };
    const { deps, getSessionCalls, refetchCalls, ensureCalls, getSession } = makeDeps({
      coordinatorId,
      ensured,
    });

    const session = await resolveAgentDeliverySession(spaceId, coordinatorId, deps, getSession);

    expect(session).toBe(ensured);
    expect(getSessionCalls).toEqual([sessionId, sessionId]);
    expect(refetchCalls).toEqual([sessionId]);
    expect(ensureCalls).toEqual([[spaceId, coordinatorId]]);
  });

  test('returns null without re-fetching when provisioning fails', async () => {
    const { deps, refetchCalls, ensureCalls, getSession } = makeDeps();

    const session = await resolveAgentDeliverySession('space-1', 'agent-1', deps, getSession);

    expect(session).toBeNull();
    expect(refetchCalls).toHaveLength(0);
    expect(ensureCalls).toEqual([['space-1', 'agent-1']]);
  });
});
