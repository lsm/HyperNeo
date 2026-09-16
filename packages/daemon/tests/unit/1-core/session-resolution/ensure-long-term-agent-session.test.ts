import { describe, expect, test } from 'bun:test';
import type { SessionResolutionDeps } from '../../../../src/lib/session-resolution/deps';
import { ensureLongTermAgentSession } from '../../../../src/lib/session-resolution/ensure-long-term-agent-session';
import {
  agentSessionIdOf,
  type SessionTargetAgent,
} from '../../../../src/lib/session-resolution/target';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';

function makeDeps(config?: { existingSessionIds?: string[]; ensureOutcome?: 'create' | 'fail' }): {
  deps: SessionResolutionDeps;
  ensureCalls: Array<[string, string]>;
} {
  const sessions = new Set(config?.existingSessionIds ?? []);
  const ensureCalls: Array<[string, string]> = [];
  const deps: SessionResolutionDeps = {
    getSession: async (sessionId) => (sessions.has(sessionId) ? { id: sessionId } : null),
    ensureLongTermAgent: async (spaceId, agentId) => {
      ensureCalls.push([spaceId, agentId]);
      if (config?.ensureOutcome === 'fail') return null;
      const sessionId = agentSessionIdOf(spaceId, agentId, config?.coordinatorId);
      sessions.add(sessionId);
      return { id: sessionId };
    },
    rehydrateSubSession: async () => null,
    isAgentTargetLifecycleEligible: async () => true,
    listWorkerExecutions: () => [],
    readWorkerTaskPhase: () => 'run_active',
    getTaskSpaceId: async () => null,
    activateTaskAgent: async () => false,
    spawnPostApprovalWorker: async () => null,
    getPostApprovalWorkerSession: () => null,
  };
  return { deps, ensureCalls };
}

describe('ensureLongTermAgentSession', () => {
  test('existing session resolves as not created without calling ensureLongTermAgent', async () => {
    const spaceId = 'space-1';
    const agentId = 'agent-1';
    const sessionId = longTermAgentSessionId(spaceId, agentId);
    const { deps, ensureCalls } = makeDeps({ existingSessionIds: [sessionId] });
    const target: SessionTargetAgent = { kind: 'agent', spaceId, agentId };

    const outcome = await ensureLongTermAgentSession(target, deps);

    expect(outcome).toEqual({ kind: 'resolved', sessionId, created: false });
    expect(ensureCalls).toHaveLength(0);
  });

  test('missing plain agent calls ensureLongTermAgent with (spaceId, agentId) and resolves the deterministic long-term id as created', async () => {
    const spaceId = 'space-1';
    const agentId = 'agent-1';
    const { deps, ensureCalls } = makeDeps();
    const target: SessionTargetAgent = { kind: 'agent', spaceId, agentId };

    const outcome = await ensureLongTermAgentSession(target, deps);

    expect(outcome).toEqual({
      kind: 'resolved',
      sessionId: longTermAgentSessionId(spaceId, agentId),
      created: true,
    });
    expect(ensureCalls).toEqual([[spaceId, agentId]]);
  });

  test('noncanonical coordinator id does not capture regular agent ids', async () => {
    const spaceId = 'space-1';
    const agentId = 'agent-1';
    const { deps } = makeDeps({ coordinatorId: 'coordinator-alt' });
    const target: SessionTargetAgent = { kind: 'agent', spaceId, agentId };

    const outcome = await ensureLongTermAgentSession(target, deps);

    expect(outcome).toEqual({
      kind: 'resolved',
      sessionId: longTermAgentSessionId(spaceId, agentId),
      created: true,
    });
  });

  test('null from ensureLongTermAgent reports unresolved ensure_failed', async () => {
    const { deps, ensureCalls } = makeDeps({ ensureOutcome: 'fail' });
    const target: SessionTargetAgent = { kind: 'agent', spaceId: 'space-1', agentId: 'agent-1' };

    const outcome = await ensureLongTermAgentSession(target, deps);

    expect(outcome).toEqual({ kind: 'unresolved', reason: 'ensure_failed' });
    expect(ensureCalls).toEqual([['space-1', 'agent-1']]);
  });

  test('second call after a create resolves the same id as not created', async () => {
    const spaceId = 'space-1';
    const agentId = 'agent-1';
    const sessionId = longTermAgentSessionId(spaceId, agentId);
    const { deps, ensureCalls } = makeDeps();
    const target: SessionTargetAgent = { kind: 'agent', spaceId, agentId };

    const first = await ensureLongTermAgentSession(target, deps);
    const second = await ensureLongTermAgentSession(target, deps);

    expect(first).toEqual({ kind: 'resolved', sessionId, created: true });
    expect(second).toEqual({ kind: 'resolved', sessionId, created: false });
    expect(ensureCalls).toHaveLength(1);
  });
});
