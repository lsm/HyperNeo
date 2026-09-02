import { describe, expect, test } from 'bun:test';
import type { SpaceLongHorizonAgent, SpaceWorkerAgent } from '@hyperneo/shared';
import { agentSessionIdOf } from '../../../../src/lib/session-resolution/target';
import {
  resolveAgentRecord,
  type ResolveAgentRecordDeps,
} from '../../../../src/lib/session-resolution/resolve-agent-record';
import { coordinatorSessionId } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';

function makeAgent(
  id: string,
  overrides: Partial<SpaceLongHorizonAgent> = {}
): SpaceLongHorizonAgent {
  return {
    id,
    spaceId: 'space-1',
    handle: id,
    displayName: id,
    templateKey: null,
    status: 'active',
    sessionId: null,
    instructions: '',
    autonomyLevel: null,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeWorker(id: string, overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name: `Worker ${id}`,
    handle: id,
    customPrompt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SpaceWorkerAgent;
}

function makeDeps(config?: {
  longHorizonAgents?: SpaceLongHorizonAgent[];
  coordinatorId?: string;
  workers?: SpaceWorkerAgent[];
}): ResolveAgentRecordDeps {
  const longHorizonAgents = config?.longHorizonAgents ?? [];
  const coordinatorRecord = (spaceId: string) =>
    longHorizonAgents.find(
      (agent) => agent.handle === 'coordinator' && agent.spaceId === spaceId
    ) ?? null;
  return {
    getLongHorizonAgent: (agentId) =>
      longHorizonAgents.find((agent) => agent.id === agentId) ?? null,
    getCoordinator: (spaceId) => {
      const record = coordinatorRecord(spaceId);
      return record != null && record.status !== 'archived' ? record : null;
    },
    getCoordinatorRecord: coordinatorRecord,
    getWorkerAgent: (agentId) =>
      (config?.workers ?? []).find((agent) => agent.id === agentId) ?? null,
  };
}

describe('resolveAgentRecord', () => {
  test("bare 'coordinator' alias resolves the coordinator record from getCoordinator", () => {
    const coordinator = makeAgent('space-lh-agent:coordinator:space-1', { handle: 'coordinator' });
    const deps = makeDeps({ longHorizonAgents: [coordinator], coordinatorId: coordinator.id });

    expect(resolveAgentRecord('space-1', 'coordinator', deps)).toEqual({
      kind: 'coordinator',
      agent: coordinator,
    });
  });

  test("bare 'coordinator' alias stays coordinator with no coordinator row on disk", () => {
    const deps = makeDeps();

    expect(resolveAgentRecord('space-1', 'coordinator', deps)).toEqual({
      kind: 'coordinator',
      agent: null,
    });
  });

  test("'coordinator:<spaceId>' alias resolves the same way as the bare alias", () => {
    const coordinator = makeAgent('discovered-coordinator', { handle: 'coordinator' });
    const deps = makeDeps({ longHorizonAgents: [coordinator], coordinatorId: coordinator.id });

    expect(resolveAgentRecord('space-1', 'coordinator:space-1', deps)).toEqual({
      kind: 'coordinator',
      agent: coordinator,
    });
  });

  test('stable derived coordinator id resolves the coordinator kind', () => {
    const coordinator = makeAgent('space-lh-agent:coordinator:space-1', { handle: 'coordinator' });

    expect(
      resolveAgentRecord('space-1', coordinator.id, makeDeps({ longHorizonAgents: [coordinator] }))
    ).toEqual({ kind: 'coordinator', agent: coordinator });
  });

  test('inactive coordinator row found by id resolves missing, matching the routing branch', () => {
    const coordinator = makeAgent('space-lh-agent:coordinator:space-1', {
      handle: 'coordinator',
      status: 'paused',
    });

    expect(
      resolveAgentRecord('space-1', coordinator.id, makeDeps({ longHorizonAgents: [coordinator] }))
    ).toEqual({ kind: 'missing' });
  });

  test('inactive coordinator row resolves missing through every alias form', () => {
    const coordinator = makeAgent('discovered-coordinator', {
      handle: 'coordinator',
      status: 'paused',
    });
    const deps = makeDeps({ longHorizonAgents: [coordinator], coordinatorId: coordinator.id });

    expect(resolveAgentRecord('space-1', 'coordinator', deps)).toEqual({ kind: 'missing' });
    expect(resolveAgentRecord('space-1', 'coordinator:space-1', deps)).toEqual({ kind: 'missing' });
  });

  test('archived coordinator row resolves missing through every alias form', () => {
    const coordinator = makeAgent('space-lh-agent:coordinator:space-1', {
      handle: 'coordinator',
      status: 'archived',
    });
    const deps = makeDeps({ longHorizonAgents: [coordinator] });

    expect(resolveAgentRecord('space-1', 'coordinator', deps)).toEqual({ kind: 'missing' });
    expect(resolveAgentRecord('space-1', 'coordinator:space-1', deps)).toEqual({ kind: 'missing' });
  });

  test('alias with no coordinator row at any status still resolves the coordinator kind', () => {
    const deps = makeDeps({ longHorizonAgents: [makeAgent('lh-1')] });

    expect(resolveAgentRecord('space-1', 'coordinator', deps)).toEqual({
      kind: 'coordinator',
      agent: null,
    });
    expect(resolveAgentRecord('space-1', 'coordinator:space-1', deps)).toEqual({
      kind: 'coordinator',
      agent: null,
    });
  });

  test('coordinator discovered by handle resolves the coordinator kind', () => {
    const discovered = makeAgent('legacy-coordinator-row', { handle: 'coordinator' });
    const deps = makeDeps({ longHorizonAgents: [discovered], coordinatorId: discovered.id });

    expect(resolveAgentRecord('space-1', discovered.id, deps)).toEqual({
      kind: 'coordinator',
      agent: discovered,
    });
  });

  test('plain long-horizon agent in the space resolves long_horizon', () => {
    const agent = makeAgent('lh-1', { handle: 'researcher' });

    expect(resolveAgentRecord('space-1', 'lh-1', makeDeps({ longHorizonAgents: [agent] }))).toEqual(
      {
        kind: 'long_horizon',
        agent,
      }
    );
  });

  test('inactive non-coordinator long-horizon row resolves missing, matching the inner routing gate', () => {
    for (const status of ['paused', 'disabled', 'archived'] as const) {
      const agent = makeAgent('lh-1', { handle: 'researcher', status });

      expect(
        resolveAgentRecord('space-1', 'lh-1', makeDeps({ longHorizonAgents: [agent] }))
      ).toEqual({ kind: 'missing' });
    }
  });

  test('long-horizon row wins over a same-id worker row', () => {
    const overlay = makeAgent('shared-1', { handle: 'overlay' });
    const worker = makeWorker('shared-1');
    const deps = makeDeps({ longHorizonAgents: [overlay], workers: [worker] });

    expect(resolveAgentRecord('space-1', 'shared-1', deps)).toEqual({
      kind: 'long_horizon',
      agent: overlay,
    });
  });

  test('cross-space long-horizon row falls through to the worker family', () => {
    const elsewhere = makeAgent('shared-2', { spaceId: 'space-2', handle: 'elsewhere' });
    const worker = makeWorker('shared-2');
    const deps = makeDeps({ longHorizonAgents: [elsewhere], workers: [worker] });

    expect(resolveAgentRecord('space-1', 'shared-2', deps)).toEqual({
      kind: 'worker',
      agent: worker,
    });
  });

  test('worker-only id resolves worker', () => {
    const worker = makeWorker('worker-1', { name: 'Worker Name' });

    expect(resolveAgentRecord('space-1', 'worker-1', makeDeps({ workers: [worker] }))).toEqual({
      kind: 'worker',
      agent: worker,
    });
  });

  test('unknown id resolves missing', () => {
    expect(resolveAgentRecord('space-1', 'ghost', makeDeps())).toEqual({ kind: 'missing' });
  });

  test('cross-space worker resolves missing', () => {
    const worker = makeWorker('worker-1', { spaceId: 'space-2' });

    expect(resolveAgentRecord('space-1', 'worker-1', makeDeps({ workers: [worker] }))).toEqual({
      kind: 'missing',
    });
  });

  test('resolution kinds compose with agentSessionIdOf routing', () => {
    const spaceId = 'space-1';
    const coordinator = makeAgent('space-lh-agent:coordinator:space-1', { handle: 'coordinator' });
    const agent = makeAgent('lh-1');
    const worker = makeWorker('worker-1');
    const deps = makeDeps({
      longHorizonAgents: [coordinator, agent],
      coordinatorId: coordinator.id,
      workers: [worker],
    });

    expect(resolveAgentRecord(spaceId, 'coordinator', deps)).toEqual({
      kind: 'coordinator',
      agent: coordinator,
    });
    expect(resolveAgentRecord(spaceId, 'lh-1', deps)).toEqual({ kind: 'long_horizon', agent });
    expect(resolveAgentRecord(spaceId, 'worker-1', deps)).toEqual({
      kind: 'worker',
      agent: worker,
    });
    expect(resolveAgentRecord(spaceId, 'ghost', deps)).toEqual({ kind: 'missing' });

    expect(agentSessionIdOf(spaceId, 'coordinator', coordinator.id)).toBe(
      coordinatorSessionId(spaceId)
    );
    expect(agentSessionIdOf(spaceId, agent.id, coordinator.id)).toBe('space:agent:space-1:lh-1');
    expect(agentSessionIdOf(spaceId, worker.id, coordinator.id)).toBe(
      'space:agent:space-1:worker-1'
    );
  });
});
