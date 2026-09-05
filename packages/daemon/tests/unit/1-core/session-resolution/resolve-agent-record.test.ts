import { describe, expect, test } from 'bun:test';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
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

function makeDeps(config?: {
  longHorizonAgents?: SpaceLongHorizonAgent[];
  coordinatorId?: string;
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

  test('coordinator-ness is data-derived — a derived-id row with a renamed handle is a regular long-horizon agent', () => {
    const renamed = makeAgent('space-lh-agent:coordinator:space-1', { handle: 'renamed' });

    expect(
      resolveAgentRecord('space-1', renamed.id, makeDeps({ longHorizonAgents: [renamed] }))
    ).toEqual({ kind: 'long_horizon', agent: renamed });
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

  test('cross-space long-horizon row resolves missing', () => {
    const elsewhere = makeAgent('shared-2', { spaceId: 'space-2', handle: 'elsewhere' });

    expect(
      resolveAgentRecord('space-1', 'shared-2', makeDeps({ longHorizonAgents: [elsewhere] }))
    ).toEqual({ kind: 'missing' });
  });

  test('unknown id resolves missing', () => {
    expect(resolveAgentRecord('space-1', 'ghost', makeDeps())).toEqual({ kind: 'missing' });
  });

  test('a migrated worker mirror resolves as a long-horizon agent', () => {
    const mirror = makeAgent('mirror-1', { templateKey: 'migration.legacy_space_agent' });

    expect(
      resolveAgentRecord('space-1', 'mirror-1', makeDeps({ longHorizonAgents: [mirror] }))
    ).toEqual({ kind: 'long_horizon', agent: mirror });
  });

  test('resolution kinds compose with agentSessionIdOf routing', () => {
    const spaceId = 'space-1';
    const coordinator = makeAgent('space-lh-agent:coordinator:space-1', { handle: 'coordinator' });
    const agent = makeAgent('lh-1');
    const deps = makeDeps({
      longHorizonAgents: [coordinator, agent],
      coordinatorId: coordinator.id,
    });

    expect(resolveAgentRecord(spaceId, 'coordinator', deps)).toEqual({
      kind: 'coordinator',
      agent: coordinator,
    });
    expect(resolveAgentRecord(spaceId, 'lh-1', deps)).toEqual({ kind: 'long_horizon', agent });
    expect(resolveAgentRecord(spaceId, 'ghost', deps)).toEqual({ kind: 'missing' });

    expect(agentSessionIdOf(spaceId, 'coordinator', coordinator.id)).toBe(
      coordinatorSessionId(spaceId)
    );
    expect(agentSessionIdOf(spaceId, agent.id, coordinator.id)).toBe('space:agent:space-1:lh-1');
  });
});
