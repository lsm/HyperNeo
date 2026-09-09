import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentModelPoolEntry, SpaceAgent } from '@hyperneo/shared';
import type { SpaceAgentRejection } from '../../../../src/lib/space/agents/create-space-agent-pipeline';
import {
  buildUpdateSpaceAgentPipeline,
  type UpdateSpaceAgentDeps,
  type UpdateSpaceAgentInput,
} from '../../../../src/lib/space/agents/update-space-agent-pipeline';

const MODEL_POOL: AgentModelPoolEntry[] = [
  { model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 2, weight: 3 },
];

function makeAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    handle: 'researcher',
    displayName: 'Researcher',
    description: null,
    instructions: 'Research.',
    status: 'active',
    sessionId: null,
    autonomyLevel: null,
    model: null,
    provider: null,
    modelPool: null,
    thinkingLevel: null,
    settingSources: null,
    tools: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface Harness {
  deps: UpdateSpaceAgentDeps;
  agent: SpaceAgent;
  applied: Array<{ id: string; changes: unknown }>;
  published: SpaceAgent[];
  handles: string[];
  displayNames: string[];
  sessions: Map<string, { type: string; spaceId: string | null }>;
  sessionOwners: Map<string, string>;
}

function makeHarness(agent = makeAgent()): Harness {
  const h: Harness = {
    deps: {} as UpdateSpaceAgentDeps,
    agent,
    applied: [],
    published: [],
    handles: [agent.handle],
    displayNames: [agent.displayName],
    sessions: new Map([['session-free', { type: 'space_chat', spaceId: 'space-1' }]]),
    sessionOwners: new Map(),
  };

  h.deps = {
    getAgent: (id) => (id === h.agent.id ? h.agent : null),
    getSession: (id) => h.sessions.get(id) ?? null,
    sessionOwner: (id) => h.sessionOwners.get(id) ?? null,
    listHandles: () => h.handles,
    listDisplayNames: () => h.displayNames,
    applyUpdate: (id, changes) => {
      h.applied.push({ id, changes });
      return { ...h.agent, ...(changes as Partial<SpaceAgent>) } as SpaceAgent;
    },
    publishUpdated: async (a) => {
      h.published.push(a);
    },
    validateTools: () => null,
    validateModel: async () => null,
    validateModelPool: async () => null,
  };

  return h;
}

async function run(h: Harness, input: UpdateSpaceAgentInput) {
  return buildUpdateSpaceAgentPipeline(h.deps)(input);
}

function isRejection(x: SpaceAgent | SpaceAgentRejection): x is SpaceAgentRejection {
  return 'kind' in x;
}

function expectKind(outcome: SpaceAgent | SpaceAgentRejection, kind: string, message?: string) {
  if (!isRejection(outcome)) throw new Error(`expected rejection, got agent ${outcome.id}`);
  expect(outcome.kind).toBe(kind as SpaceAgentRejection['kind']);
  if (message) expect(outcome.message).toContain(message);
}

describe('updateSpaceAgent', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  describe('target', () => {
    test('rejects a missing id', async () => {
      expectKind(await run(h, { id: '' }), 'invalid_request', 'id is required');
    });

    test('rejects an unknown agent', async () => {
      expectKind(await run(h, { id: 'ghost' }), 'agent_not_found', 'Agent not found: ghost');
    });

    test('does not forward id as an updatable field', async () => {
      await run(h, { id: 'agent-1', displayName: 'Renamed' });
      expect(h.applied[0].changes).not.toHaveProperty('id');
    });
  });

  describe('blank fields', () => {
    test.each([
      ['displayName', { displayName: '  ' }, 'displayName cannot be blank'],
      ['handle', { handle: ' ' }, 'handle cannot be blank'],
      ['model', { model: '' }, 'model cannot be blank'],
      ['provider', { provider: '' }, 'provider cannot be blank'],
    ])('rejects a blank %s', async (_label, changes, message) => {
      expectKind(await run(h, { id: 'agent-1', ...changes }), 'invalid_request', message);
    });

    test('accepts null to clear model', async () => {
      const outcome = await run(h, { id: 'agent-1', model: null });
      expect(isRejection(outcome)).toBe(false);
    });
  });

  describe('session changes', () => {
    test('rejects a nonexistent session', async () => {
      expectKind(await run(h, { id: 'agent-1', sessionId: 'ghost' }), 'session_invalid');
    });

    test('rejects a session from another space', async () => {
      h.sessions.set('other', { type: 'space_chat', spaceId: 'space-2' });
      expectKind(
        await run(h, { id: 'agent-1', sessionId: 'other' }),
        'session_invalid',
        'does not belong to space'
      );
    });

    test('rejects a task agent session', async () => {
      h.sessions.set('task', { type: 'space_task_agent', spaceId: 'space-1' });
      expectKind(await run(h, { id: 'agent-1', sessionId: 'task' }), 'session_invalid');
    });

    test('rejects a session owned by another agent', async () => {
      h.sessionOwners.set('session-free', 'agent-other');
      expectKind(await run(h, { id: 'agent-1', sessionId: 'session-free' }), 'session_taken');
    });

    test('allows rebinding a session this agent already owns', async () => {
      h.sessionOwners.set('session-free', 'agent-1');
      const outcome = await run(h, { id: 'agent-1', sessionId: 'session-free' });
      expect(isRejection(outcome)).toBe(false);
    });

    test('skips validation when clearing the session', async () => {
      const outcome = await run(h, { id: 'agent-1', sessionId: null });
      expect(isRejection(outcome)).toBe(false);
    });

    test('skips validation when the session is unchanged', async () => {
      h = makeHarness(makeAgent({ sessionId: 'gone-stale' }));
      const outcome = await run(h, { id: 'agent-1', sessionId: 'gone-stale' });
      expect(isRejection(outcome)).toBe(false);
    });
  });

  describe('identity changes', () => {
    test('rejects an invalid handle', async () => {
      expectKind(await run(h, { id: 'agent-1', handle: 'Not A Slug' }), 'invalid_identity');
    });

    test('rejects a reserved handle', async () => {
      expectKind(
        await run(h, { id: 'agent-1', handle: 'coordinator' }),
        'invalid_identity',
        'is reserved'
      );
    });

    test('rejects a handle held by another agent', async () => {
      h.handles = ['researcher', 'taken'];
      expectKind(
        await run(h, { id: 'agent-1', handle: 'taken' }),
        'invalid_identity',
        'already in use'
      );
    });

    test('allows keeping the same handle', async () => {
      const outcome = await run(h, { id: 'agent-1', handle: 'researcher' });
      expect(isRejection(outcome)).toBe(false);
    });

    test('rejects a display name held by another agent, case-insensitively', async () => {
      h.displayNames = ['Researcher', 'Taken Name'];
      expectKind(
        await run(h, { id: 'agent-1', displayName: 'taken name' }),
        'invalid_identity',
        'already used'
      );
    });

    test('allows renaming to a different case of its own name', async () => {
      const outcome = await run(h, { id: 'agent-1', displayName: 'RESEARCHER' });
      expect(isRejection(outcome)).toBe(false);
    });
  });

  describe('config changes', () => {
    test('rejects unknown tools', async () => {
      h.deps.validateTools = () => 'Unknown tool: "Nope"';
      expectKind(await run(h, { id: 'agent-1', tools: ['Nope'] }), 'invalid_config');
    });

    test('rejects an unrecognised model', async () => {
      h.deps.validateModel = async () => 'Unrecognized model: "ghost"';
      expectKind(await run(h, { id: 'agent-1', model: 'ghost' }), 'invalid_config');
    });

    test('validates a new model against the existing provider', async () => {
      h = makeHarness(makeAgent({ provider: 'anthropic' }));
      let seen: string | null = 'unset';
      h.deps.validateModel = async (_model, provider) => {
        seen = provider;
        return null;
      };

      await run(h, { id: 'agent-1', model: 'claude-opus-5' });
      expect(seen).toBe('anthropic');
    });

    test('rejects an invalid model pool', async () => {
      h.deps.validateModelPool = async () => 'Model pool must have at least one entry';
      expectKind(await run(h, { id: 'agent-1', modelPool: MODEL_POOL }), 'invalid_config');
    });

    test('skips config validation when nothing config-related changes', async () => {
      let called = false;
      h.deps.validateModel = async () => {
        called = true;
        return null;
      };
      await run(h, { id: 'agent-1', instructions: 'New instructions.' });
      expect(called).toBe(false);
    });
  });

  describe('persistence', () => {
    test('applies and returns the updated agent', async () => {
      const outcome = await run(h, { id: 'agent-1', displayName: 'Renamed' });
      expect(isRejection(outcome)).toBe(false);
      expect((outcome as SpaceAgent).displayName).toBe('Renamed');
    });

    test('maps a repository session collision to session_taken', async () => {
      h.deps.applyUpdate = () => {
        throw new Error('Session session-9 is already bound to agent agent-x');
      };
      expectKind(await run(h, { id: 'agent-1', instructions: 'x' }), 'session_taken');
    });

    test('maps a migrated mirror refusal to invalid_request', async () => {
      h.deps.applyUpdate = () => {
        throw new Error('Agent agent-1 is a migrated worker mirror and is not owned by X');
      };
      expectKind(await run(h, { id: 'agent-1', instructions: 'x' }), 'invalid_request');
    });

    test('rethrows an unrecognised persistence failure', async () => {
      h.deps.applyUpdate = () => {
        throw new Error('disk on fire');
      };
      await expect(run(h, { id: 'agent-1', instructions: 'x' })).rejects.toThrow('disk on fire');
    });

    test('treats a vanished row as agent_not_found', async () => {
      h.deps.applyUpdate = () => null;
      expectKind(await run(h, { id: 'agent-1', instructions: 'x' }), 'agent_not_found');
    });

    test('publishes the updated agent', async () => {
      await run(h, { id: 'agent-1', displayName: 'Renamed' });
      expect(h.published).toHaveLength(1);
    });

    test('does not apply or publish when a gate rejects', async () => {
      await run(h, { id: 'agent-1', handle: 'coordinator' });
      expect(h.applied).toHaveLength(0);
      expect(h.published).toHaveLength(0);
    });
  });
});
