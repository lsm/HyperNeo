import { describe, expect, test } from 'bun:test';
import type { Space, SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { ResolveAgentRecordDeps } from '../../../../src/lib/session-resolution/resolve-agent-record.ts';
import {
  type EnsureAgentSessionDeps,
  type EnsureAgentSessionReason,
  admitSpaceStage,
  admitAgentStage,
  gateEnsuredSessionStage,
  isAgentTargetLifecycleEligible,
  runEnsureAgentSession,
} from '../../../../src/lib/session/ensure-agent-session.ts';

const SPACE_ID = 'space-1';

function makeSpace(overrides: Partial<Space> = {}): Space {
  return { id: SPACE_ID, paused: false, stopped: false, status: 'active', ...overrides } as Space;
}

function makeAgent(
  id: string,
  overrides: Partial<SpaceLongHorizonAgent> = {}
): SpaceLongHorizonAgent {
  return {
    id,
    spaceId: SPACE_ID,
    handle: id,
    status: 'active',
    ...overrides,
  } as SpaceLongHorizonAgent;
}

interface ProvisionCalls {
  provisioned: string[];
}

function makeDeps(config?: {
  space?: Space | null;
  spaceReadFails?: boolean;
  longHorizonAgents?: SpaceLongHorizonAgent[];
  ensuredStatus?: string;
}): { deps: EnsureAgentSessionDeps; calls: ProvisionCalls } {
  const calls: ProvisionCalls = { provisioned: [] };
  const agents = config?.longHorizonAgents ?? [];
  const ensured = { getSessionData: () => ({ status: config?.ensuredStatus ?? 'active' }) };
  const recordDeps: ResolveAgentRecordDeps = {
    getLongHorizonAgent: (agentId) => agents.find((agent) => agent.id === agentId) ?? null,
  };
  const deps: EnsureAgentSessionDeps = {
    getSpace: async () => {
      if (config?.spaceReadFails) throw new Error('space read failed');
      return config?.space === undefined ? makeSpace() : config.space;
    },
    recordDeps,
    ensureLongHorizon: async (spaceId, agentId) => {
      calls.provisioned.push(`${spaceId}:${agentId}`);
      return ensured;
    },
  };
  return { deps, calls };
}

async function expectTargetRejected(
  deps: EnsureAgentSessionDeps,
  agentId: string,
  calls: ProvisionCalls,
  reason: EnsureAgentSessionReason = 'agent_missing'
): Promise<void> {
  expect(await runEnsureAgentSession(SPACE_ID, agentId, deps)).toBe(reason);
  expect(await isAgentTargetLifecycleEligible(SPACE_ID, agentId, deps)).toBe(false);
  expect(calls).toEqual({ provisioned: [] });
}

describe('ensure-agent-session lifecycle admission', () => {
  test('missing, paused, stopped, and archived spaces reject before provisioning', async () => {
    const spaces = [
      null,
      makeSpace({ paused: true }),
      makeSpace({ stopped: true }),
      makeSpace({ status: 'archived' }),
    ];
    for (const space of spaces) {
      const { deps, calls } = makeDeps({ space, longHorizonAgents: [makeAgent('lha-1')] });
      await expectTargetRejected(deps, 'lha-1', calls, 'space_inactive');
    }
  });

  test('a failing space read propagates the infrastructure error', async () => {
    const { deps, calls } = makeDeps({ spaceReadFails: true });
    await expect(runEnsureAgentSession(SPACE_ID, 'coordinator', deps)).rejects.toThrow(
      'space read failed'
    );
    await expect(isAgentTargetLifecycleEligible(SPACE_ID, 'coordinator', deps)).rejects.toThrow(
      'space read failed'
    );
    expect(calls.provisioned).toEqual([]);
  });

  test('a provisioning fault propagates instead of becoming an unavailable session', async () => {
    const { deps } = makeDeps({ longHorizonAgents: [makeAgent('agent-1')] });
    deps.ensureLongHorizon = async () => {
      throw new Error('provider exploded');
    };
    await expect(runEnsureAgentSession(SPACE_ID, 'agent-1', deps)).rejects.toThrow(
      'provider exploded'
    );
  });

  test('inactive canonical coordinator records reject the coordinator target', async () => {
    const statuses = ['paused', 'disabled', 'archived'] as const;
    for (const status of statuses) {
      const { deps, calls } = makeDeps({
        longHorizonAgents: [
          makeAgent(`space-lh-agent:coordinator:${SPACE_ID}`, { handle: 'coordinator', status }),
        ],
      });
      await expectTargetRejected(deps, 'coordinator', calls);
      await expectTargetRejected(deps, `space-lh-agent:coordinator:${SPACE_ID}`, calls);
    }
  });

  test('archived noncanonical coordinator rejects the coordinator target', async () => {
    const { deps, calls } = makeDeps({
      longHorizonAgents: [makeAgent('lha-alt', { handle: 'coordinator', status: 'archived' })],
    });
    await expectTargetRejected(deps, 'coordinator', calls);
  });

  test('an inactive coordinator does not block an unrelated active agent', async () => {
    const { deps, calls } = makeDeps({
      longHorizonAgents: [
        makeAgent(`space-lh-agent:coordinator:${SPACE_ID}`, {
          handle: 'coordinator',
          status: 'paused',
        }),
        makeAgent('lha-2'),
      ],
    });
    expect(await isAgentTargetLifecycleEligible(SPACE_ID, 'lha-2', deps)).toBe(true);
    expect(typeof (await runEnsureAgentSession(SPACE_ID, 'lha-2', deps))).toBe('object');
    expect(calls).toEqual({ provisioned: [`${SPACE_ID}:lha-2`] });
  });

  test('inactive long-horizon agent records reject', async () => {
    const statuses = ['paused', 'disabled', 'archived'] as const;
    for (const status of statuses) {
      const { deps, calls } = makeDeps({ longHorizonAgents: [makeAgent('lha-1', { status })] });
      await expectTargetRejected(deps, 'lha-1', calls);
    }
  });

  test('unknown targets resolve as missing and reject', async () => {
    const { deps, calls } = makeDeps({ longHorizonAgents: [makeAgent('lha-known')] });
    await expectTargetRejected(deps, 'lha-unknown', calls);
  });

  test('ensured sessions with ended or archived status reject after provisioning', async () => {
    for (const status of ['ended', 'archived']) {
      const agent = makeAgent('agent-1');
      const { deps, calls } = makeDeps({ ensuredStatus: status, longHorizonAgents: [agent] });
      expect(await runEnsureAgentSession(SPACE_ID, 'agent-1', deps)).toBe('session_unavailable');
      expect(calls.provisioned).toEqual([`${SPACE_ID}:agent-1`]);
    }
  });
});

describe('ensure-agent-session gates', () => {
  test.each([
    null,
    makeSpace({ paused: true }),
    makeSpace({ stopped: true }),
    makeSpace({ status: 'archived' }),
  ])('admitSpaceStage rejects inactive spaces', (space) => {
    expect(admitSpaceStage(space)).toEqual({ reason: 'space_inactive' });
  });
  test('admitSpaceStage accepts an active space', () => {
    const space = makeSpace();
    expect(admitSpaceStage(space)).toEqual({ value: space });
  });
  test('admitAgentStage keeps success and rejection disjoint', () => {
    expect(admitAgentStage({ kind: 'missing' })).toEqual({ reason: 'agent_missing' });
    const resolution = { kind: 'long_horizon' as const, agent: makeAgent('a') };
    expect(admitAgentStage(resolution)).toEqual({ value: resolution });
  });
  test.each([null, 'ended', 'archived', 'active'])(
    'gateEnsuredSessionStage handles %s',
    (status) => {
      const session = status === null ? null : { getSessionData: () => ({ status }) };
      expect(gateEnsuredSessionStage(session)).toEqual(
        status === 'active' ? { value: session } : { reason: 'session_unavailable' }
      );
    }
  );
  test('a repository fault propagates through lifecycle eligibility', async () => {
    const { deps } = makeDeps();
    deps.recordDeps.getLongHorizonAgent = () => {
      throw new Error('repository failed');
    };
    await expect(isAgentTargetLifecycleEligible(SPACE_ID, 'a', deps)).rejects.toThrow(
      'repository failed'
    );
  });
  test.each(['space', 'agent'])('rechecks %s eligibility after provisioning', async (changed) => {
    const agent = makeAgent('a');
    const space = makeSpace();
    const { deps } = makeDeps({ space, longHorizonAgents: [agent] });
    deps.ensureLongHorizon = async () => {
      if (changed === 'space') space.paused = true;
      else agent.status = 'paused';
      return { getSessionData: () => ({ status: 'active' }) };
    };
    expect(await runEnsureAgentSession(SPACE_ID, 'a', deps)).toBe(
      changed === 'space' ? 'space_inactive' : 'agent_missing'
    );
  });
});
