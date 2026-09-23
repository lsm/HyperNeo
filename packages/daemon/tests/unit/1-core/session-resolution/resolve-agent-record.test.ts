import { describe, expect, test } from 'bun:test';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import { longTermAgentSessionId } from '../../helpers/legacy-agent-session-id';
import {
  resolveAgentRecord,
  type ResolveAgentRecordDeps,
} from '../../../../src/lib/session-resolution/resolve-agent-record';

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
}): ResolveAgentRecordDeps {
  const longHorizonAgents = config?.longHorizonAgents ?? [];
  return {
    getLongHorizonAgent: (agentId) =>
      longHorizonAgents.find((agent) => agent.id === agentId) ?? null,
  };
}

describe('resolveAgentRecord', () => {
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

  test('coordinator alias forms resolve nothing — only the row id resolves', () => {
    const coordinator = makeAgent('space-lh-agent:coordinator:space-1', { handle: 'coordinator' });
    const deps = makeDeps({ longHorizonAgents: [coordinator] });

    expect(resolveAgentRecord('space-1', 'coordinator', deps)).toEqual({ kind: 'missing' });
    expect(resolveAgentRecord('space-1', 'coordinator:space-1', deps)).toEqual({ kind: 'missing' });
    expect(resolveAgentRecord('space-1', coordinator.id, deps)).toEqual({
      kind: 'long_horizon',
      agent: coordinator,
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
});
