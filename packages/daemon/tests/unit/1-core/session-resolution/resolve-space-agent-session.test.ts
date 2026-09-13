import { describe, expect, test } from 'bun:test';
import type { SessionResolutionDeps } from '../../../../src/lib/session-resolution/deps';
import { resolveSpaceAgentSession } from '../../../../src/lib/session-resolution/resolve-space-agent-session';
import { agentSessionIdOf } from '../../../../src/lib/session-resolution/target';
import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
} from '../../../../src/storage/repositories/space-long-horizon-agent-repository';

interface TestSession {
  id: string;
}

function makeDeps(config?: {
  existingSessionIds?: string[];
  coordinatorId?: string;
  ensureOutcome?: 'create' | 'fail';
  getSessionError?: Error;
}): {
  deps: SessionResolutionDeps;
  getSessionCalls: string[];
  refetchCalls: string[];
  ensureCalls: Array<[string, string]>;
  getSession: (sessionId: string) => Promise<TestSession | null>;
} {
  const sessions = new Map(
    (config?.existingSessionIds ?? []).map((sessionId) => [sessionId, { id: sessionId }])
  );
  const getSessionCalls: string[] = [];
  const refetchCalls: string[] = [];
  const ensureCalls: Array<[string, string]> = [];
  const deps: SessionResolutionDeps = {
    getSession: async (sessionId) => {
      getSessionCalls.push(sessionId);
      if (config?.getSessionError !== undefined) throw config.getSessionError;
      return sessions.get(sessionId) ?? null;
    },
    ensureLongTermAgent: async (spaceId, agentId) => {
      ensureCalls.push([spaceId, agentId]);
      if (config?.ensureOutcome === 'fail') return null;
      const sessionId = agentSessionIdOf(spaceId, agentId, config?.coordinatorId);
      const session = { id: sessionId };
      sessions.set(sessionId, session);
      return session;
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
    getSession: async (sessionId: string) => {
      refetchCalls.push(sessionId);
      return sessions.get(sessionId) ?? null;
    },
  };
}

describe('resolveSpaceAgentSession', () => {
  test('finds and re-fetches an explicit reply session', async () => {
    const { deps, getSessionCalls, refetchCalls, ensureCalls, getSession } = makeDeps({
      existingSessionIds: ['reply-session'],
    });

    const outcome = await resolveSpaceAgentSession<TestSession>(
      'space-1',
      'reply-session',
      deps,
      getSession
    );

    expect(outcome).toEqual({ sessionId: 'reply-session', session: { id: 'reply-session' } });
    expect(getSessionCalls).toEqual(['reply-session']);
    expect(refetchCalls).toEqual(['reply-session']);
    expect(ensureCalls).toHaveLength(0);
  });

  test('reports the coordinator when fallback provisioning fails', async () => {
    const spaceId = 'space-1';
    const { deps, refetchCalls, ensureCalls, getSession } = makeDeps({ ensureOutcome: 'fail' });

    await expect(
      resolveSpaceAgentSession<TestSession>(spaceId, 'missing-session', deps, getSession)
    ).rejects.toThrow(
      `Session not found for Space Agent reply routing: ${coordinatorSessionId(spaceId)}; ensure_failed`
    );
    expect(ensureCalls).toEqual([[spaceId, 'coordinator']]);
    expect(refetchCalls).toHaveLength(0);
  });

  test('does not fall back when explicit reply resolution fails internally', async () => {
    const { deps, refetchCalls, ensureCalls, getSession } = makeDeps({
      getSessionError: new Error('database unavailable'),
    });

    await expect(
      resolveSpaceAgentSession<TestSession>('space-1', 'reply-session', deps, getSession)
    ).rejects.toThrow(
      'Session not found for Space Agent reply routing: reply-session; internal: database unavailable'
    );
    expect(ensureCalls).toHaveLength(0);
    expect(refetchCalls).toHaveLength(0);
  });

  test('preserves coordinator provisioning failure as the existing routing error', async () => {
    const spaceId = 'space-1';
    const { deps, ensureCalls, getSession } = makeDeps({ ensureOutcome: 'fail' });

    await expect(
      resolveSpaceAgentSession<TestSession>(spaceId, null, deps, getSession)
    ).rejects.toThrow(
      `Session not found for Space Agent reply routing: ${coordinatorSessionId(spaceId)}; ensure_failed`
    );
    expect(ensureCalls).toEqual([[spaceId, 'coordinator']]);
  });
});
