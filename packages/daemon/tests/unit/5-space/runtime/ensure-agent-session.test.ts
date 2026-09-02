import { describe, expect, test } from 'bun:test';
import type { Space, SpaceLongHorizonAgent, SpaceWorkerAgent } from '@hyperneo/shared';
import type { ResolveAgentRecordDeps } from '../../../../src/lib/session-resolution/resolve-agent-record.ts';
import {
  type EnsureAgentSessionDeps,
  isAgentTargetLifecycleEligible,
  runEnsureAgentSession,
} from '../../../../src/lib/space/runtime/ensure-agent-session.ts';

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

function makeWorker(id: string, overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id,
    spaceId: SPACE_ID,
    handle: id,
    status: 'active',
    ...overrides,
  } as SpaceWorkerAgent;
}

interface ProvisionCalls {
  coordinator: string[];
  provisioned: string[];
}

function makeDeps(config?: {
  space?: Space | null;
  spaceReadFails?: boolean;
  provisionFails?: boolean;
  longHorizonAgents?: SpaceLongHorizonAgent[];
  workers?: SpaceWorkerAgent[];
  ensuredStatus?: string;
}): { deps: EnsureAgentSessionDeps; calls: ProvisionCalls } {
  const calls: ProvisionCalls = { coordinator: [], provisioned: [] };
  const agents = config?.longHorizonAgents ?? [];
  const workers = config?.workers ?? [];
  const ensured = { getSessionData: () => ({ status: config?.ensuredStatus ?? 'active' }) };
  const provision = () => {
    if (config?.provisionFails) throw new Error('provision failed');
    return ensured;
  };
  const recordDeps: ResolveAgentRecordDeps = {
    getLongHorizonAgent: (agentId) => agents.find((agent) => agent.id === agentId) ?? null,
    getCoordinator: (spaceId) =>
      agents.find(
        (agent) =>
          agent.handle === 'coordinator' && agent.spaceId === spaceId && agent.status !== 'archived'
      ) ?? null,
    getCoordinatorRecord: (spaceId) =>
      agents.find((agent) => agent.handle === 'coordinator' && agent.spaceId === spaceId) ?? null,
    getWorkerAgent: (agentId) => workers.find((worker) => worker.id === agentId) ?? null,
  };
  const deps: EnsureAgentSessionDeps = {
    getSpace: async () => {
      if (config?.spaceReadFails) throw new Error('space read failed');
      return config?.space === undefined ? makeSpace() : config.space;
    },
    recordDeps,
    ensureCoordinatorSession: async (spaceId) => {
      calls.coordinator.push(spaceId);
      return provision();
    },
    ensureLongHorizonAgentSession: async (spaceId, agentId) => {
      calls.provisioned.push(`${spaceId}:${agentId}`);
      return provision();
    },
    ensureWorkerAgentSession: async (spaceId, agent) => {
      calls.provisioned.push(`${spaceId}:${agent.id}`);
      return provision();
    },
  };
  return { deps, calls };
}

async function expectTargetRejected(
  deps: EnsureAgentSessionDeps,
  agentId: string,
  calls: ProvisionCalls
): Promise<void> {
  expect(await runEnsureAgentSession(SPACE_ID, agentId, deps)).toBeNull();
  expect(await isAgentTargetLifecycleEligible(SPACE_ID, agentId, deps)).toBeFalse();
  expect(calls).toEqual({ coordinator: [], provisioned: [] });
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
      await expectTargetRejected(deps, 'lha-1', calls);
    }
  });

  test('a failing space read rejects instead of throwing', async () => {
    const { deps, calls } = makeDeps({ spaceReadFails: true });
    await expectTargetRejected(deps, 'coordinator', calls);
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
    expect(await isAgentTargetLifecycleEligible(SPACE_ID, 'lha-2', deps)).toBeTrue();
    expect(await runEnsureAgentSession(SPACE_ID, 'lha-2', deps)).not.toBeNull();
    expect(calls).toEqual({ coordinator: [], provisioned: [`${SPACE_ID}:lha-2`] });
  });

  test('inactive long-horizon agent records reject', async () => {
    const statuses = ['paused', 'disabled', 'archived'] as const;
    for (const status of statuses) {
      const { deps, calls } = makeDeps({ longHorizonAgents: [makeAgent('lha-1', { status })] });
      await expectTargetRejected(deps, 'lha-1', calls);
    }
  });

  test('inactive workers reject; active and unknown targets resolve per record', async () => {
    const paused = makeDeps({ workers: [makeWorker('w-1', { status: 'paused' })] });
    await expectTargetRejected(paused.deps, 'w-1', paused.calls);
    const archived = makeDeps({ workers: [makeWorker('w-1', { status: 'archived' })] });
    await expectTargetRejected(archived.deps, 'w-1', archived.calls);
    const unknown = makeDeps({ workers: [makeWorker('w-known')] });
    await expectTargetRejected(unknown.deps, 'lha-unknown', unknown.calls);
    const active = makeDeps({ workers: [makeWorker('w-1')] });
    expect(await isAgentTargetLifecycleEligible(SPACE_ID, 'w-1', active.deps)).toBeTrue();
    expect(await runEnsureAgentSession(SPACE_ID, 'w-1', active.deps)).not.toBeNull();
    expect(active.calls.provisioned).toEqual([`${SPACE_ID}:w-1`]);
  });

  test('a space with no coordinator record keeps the bootstrap path', async () => {
    const { deps, calls } = makeDeps();
    expect(await isAgentTargetLifecycleEligible(SPACE_ID, 'coordinator', deps)).toBeTrue();
    expect(await runEnsureAgentSession(SPACE_ID, 'coordinator', deps)).not.toBeNull();
    expect(calls.coordinator).toEqual([SPACE_ID]);
  });

  test('an active noncanonical coordinator id provisions the coordinator session', async () => {
    const { deps, calls } = makeDeps({
      longHorizonAgents: [makeAgent('lha-alt', { handle: 'coordinator' })],
    });
    expect(await runEnsureAgentSession(SPACE_ID, 'lha-alt', deps)).not.toBeNull();
    expect(calls.coordinator).toEqual([SPACE_ID]);
  });

  test('ensured sessions with ended or archived status reject after provisioning', async () => {
    for (const status of ['ended', 'archived']) {
      const { deps, calls } = makeDeps({ ensuredStatus: status });
      expect(await runEnsureAgentSession(SPACE_ID, 'coordinator', deps)).toBeNull();
      expect(calls.coordinator).toEqual([SPACE_ID]);
    }
  });

  test('a provisioning sink failure maps to null', async () => {
    const { deps } = makeDeps({ provisionFails: true });
    expect(await runEnsureAgentSession(SPACE_ID, 'coordinator', deps)).toBeNull();
  });
});
