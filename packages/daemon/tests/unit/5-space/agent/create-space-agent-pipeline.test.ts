import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentModelPoolEntry, SpaceAgent, SpaceAgentTemplate } from '@hyperneo/shared';
import {
  buildCreateSpaceAgentPipeline,
  type CreateSpaceAgentDeps,
  type CreateSpaceAgentInput,
  type CreateSpaceAgentRejection,
  isCreateSpaceAgentRejection,
  templateToCreateParams,
} from '../../../../src/lib/space/agents/create-space-agent-pipeline';

const MODEL_POOL: AgentModelPoolEntry[] = [
  { model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 2, weight: 3 },
];

function makeTemplate(overrides: Partial<SpaceAgentTemplate> = {}): SpaceAgentTemplate {
  return {
    key: 'researcher.v1',
    handle: 'researcher',
    displayName: 'Researcher',
    description: 'Investigates things.',
    instructions: 'Research carefully.',
    suggestedAutonomyLevel: 3,
    model: 'claude-opus-5',
    provider: 'anthropic',
    modelPool: MODEL_POOL,
    thinkingLevel: 'think16k',
    settingSources: ['user', 'project'],
    tools: ['Read', 'Grep'],
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface Harness {
  deps: CreateSpaceAgentDeps;
  created: Parameters<CreateSpaceAgentDeps['createAgent']>[0][];
  handles: string[];
  templates: Map<string, SpaceAgentTemplate>;
  spaceExists: boolean;
  sessionOwners: Map<string, string>;
  sessions: Map<string, { type: string; spaceId: string | null }>;
  displayNames: string[];
  published: SpaceAgent[];
  seeded: Array<{ agentId: string; templateKey: string }>;
}

function makeHarness(): Harness {
  const harness: Harness = {
    created: [],
    handles: [],
    templates: new Map(),
    spaceExists: true,
    sessionOwners: new Map(),
    sessions: new Map([['session-free', { type: 'space_chat', spaceId: 'space-1' }]]),
    displayNames: [],
    published: [],
    seeded: [],
    deps: {} as CreateSpaceAgentDeps,
  };

  harness.deps = {
    spaceExists: async () => harness.spaceExists,
    sessionOwner: (sessionId) => harness.sessionOwners.get(sessionId) ?? null,
    getSession: (sessionId) => harness.sessions.get(sessionId) ?? null,
    listDisplayNames: () => harness.displayNames,
    publishCreated: async (agent) => {
      harness.published.push(agent);
    },
    seedTemplateExtras: (agent, template) => {
      harness.seeded.push({ agentId: agent.id, templateKey: template.key });
    },
    getTemplate: (_spaceId, key) => harness.templates.get(key) ?? null,
    listHandles: () => harness.handles,
    createAgent: (params) => {
      harness.created.push(params);
      return {
        ...params,
        id: params.id ?? 'agent-1',
        createdAt: 1,
        updatedAt: 1,
      } as unknown as SpaceAgent;
    },
    validateTools: () => null,
    validateModel: async () => null,
    validateModelPool: async () => null,
  };

  return harness;
}

function baseInput(overrides: Partial<CreateSpaceAgentInput> = {}): CreateSpaceAgentInput {
  return { spaceId: 'space-1', displayName: 'My Agent', ...overrides };
}

async function run(
  h: Harness,
  input: CreateSpaceAgentInput
): Promise<SpaceAgent | CreateSpaceAgentRejection> {
  return buildCreateSpaceAgentPipeline(h.deps)(input);
}

function expectRejection(
  outcome: SpaceAgent | CreateSpaceAgentRejection,
  message: string | RegExp
): void {
  if (!isCreateSpaceAgentRejection(outcome)) {
    throw new Error(`expected a rejection, got agent ${outcome.id}`);
  }
  if (typeof message === 'string') expect(outcome.message).toContain(message);
  else expect(outcome.message).toMatch(message);
}

async function expectAgent(h: Harness, input: CreateSpaceAgentInput): Promise<SpaceAgent> {
  const outcome = await run(h, input);
  if (isCreateSpaceAgentRejection(outcome)) {
    throw new Error(`expected an agent, got rejection ${outcome.kind}: ${outcome.message}`);
  }
  return outcome;
}

describe('createSpaceAgent', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  describe('input validation', () => {
    test('rejects a missing spaceId', async () => {
      expectRejection(await run(h, baseInput({ spaceId: '' })), 'spaceId is required');
    });

    test('rejects a blank displayName', async () => {
      expectRejection(
        await run(h, baseInput({ displayName: '   ' })),
        'displayName cannot be blank'
      );
    });

    test('rejects a blank handle', async () => {
      expectRejection(await run(h, baseInput({ handle: '  ' })), 'handle cannot be blank');
    });

    test('rejects when neither handle nor displayName is given', async () => {
      expectRejection(
        await run(h, { spaceId: 'space-1' } as CreateSpaceAgentInput),
        'handle or displayName is required'
      );
    });

    test('rejects an unknown space', async () => {
      h.spaceExists = false;
      expectRejection(await run(h, baseInput()), 'Space not found: space-1');
    });

    test('rejects a non-string displayName instead of throwing', async () => {
      expectRejection(
        await run(h, baseInput({ displayName: 123 as unknown as string })),
        'displayName must be a string'
      );
    });

    test('rejects a non-string handle instead of throwing', async () => {
      expectRejection(
        await run(h, baseInput({ handle: 7 as unknown as string })),
        'handle must be a string'
      );
    });

    test('rejects a non-string provider instead of throwing', async () => {
      expectRejection(
        await run(h, baseInput({ provider: {} as unknown as string })),
        'provider must be a string'
      );
    });

    test('rejects tools that are not an array of strings', async () => {
      expectRejection(
        await run(h, baseInput({ tools: [1] as unknown as string[] })),
        'tools must be an array of strings'
      );
    });

    test('rejects an unknown thinkingLevel', async () => {
      expectRejection(
        await run(h, baseInput({ thinkingLevel: 'think999' as never })),
        'Invalid thinkingLevel: think999'
      );
    });

    test('rejects unknown settingSources', async () => {
      expectRejection(
        await run(h, baseInput({ settingSources: ['user', 'bogus'] as never })),
        'Invalid settingSources: bogus'
      );
    });

    test('rejects an unknown status', async () => {
      expectRejection(
        await run(h, baseInput({ status: 'retired' as never })),
        'Invalid status: retired'
      );
    });

    test('rejects an out-of-range autonomyLevel', async () => {
      expectRejection(
        await run(h, baseInput({ autonomyLevel: 9 as never })),
        'Invalid autonomyLevel: 9'
      );
    });
  });

  describe('identity', () => {
    test('slugifies the display name into a handle', async () => {
      await expectAgent(h, baseInput({ displayName: 'My Agent' }));
      expect(h.created[0].handle).toBe('my-agent');
    });

    test('honours an explicit handle', async () => {
      await expectAgent(h, baseInput({ handle: 'custom-handle' }));
      expect(h.created[0].handle).toBe('custom-handle');
    });

    test('rejects an invalid explicit handle', async () => {
      expectRejection(
        await run(h, baseInput({ handle: 'Not A Slug' })),
        'Slug must contain only lowercase letters'
      );
    });

    test('rejects a reserved handle', async () => {
      expectRejection(
        await run(h, baseInput({ handle: 'coordinator' })),
        'Handle "coordinator" is reserved'
      );
    });

    test('rejects an explicit handle already in use', async () => {
      h.handles = ['taken'];
      expectRejection(
        await run(h, baseInput({ handle: 'taken' })),
        'Handle "taken" is already in use in this space'
      );
    });

    test('slugified handles avoid collisions with existing handles', async () => {
      h.handles = ['my-agent'];
      await expectAgent(h, baseInput({ displayName: 'My Agent' }));
      expect(h.created[0].handle).not.toBe('my-agent');
    });

    test('falls back to the handle as display name when no name is given', async () => {
      await expectAgent(h, baseInput({ displayName: undefined, handle: 'solo' }));
      expect(h.created[0].displayName).toBe('solo');
    });
  });

  describe('template resolution', () => {
    test('rejects an unknown template key', async () => {
      expectRejection(
        await run(h, baseInput({ templateKey: 'missing.v1' })),
        'Template not found: missing.v1'
      );
    });

    test('copies every configuration field from the template', async () => {
      h.templates.set('researcher.v1', makeTemplate());
      await expectAgent(h, baseInput({ templateKey: 'researcher.v1' }));

      const params = h.created[0];
      expect(params.description).toBe('Investigates things.');
      expect(params.instructions).toBe('Research carefully.');
      expect(params.autonomyLevel).toBe(3);
      expect(params.model).toBe('claude-opus-5');
      expect(params.provider).toBe('anthropic');
      expect(params.modelPool).toEqual(MODEL_POOL);
      expect(params.thinkingLevel).toBe('think16k');
      expect(params.settingSources).toEqual(['user', 'project']);
      expect(params.tools).toEqual(['Read', 'Grep']);
    });

    test('explicit input overrides template values field by field', async () => {
      h.templates.set('researcher.v1', makeTemplate());
      await expectAgent(
        h,
        baseInput({
          templateKey: 'researcher.v1',
          instructions: 'Do it my way.',
          model: 'claude-sonnet-5',
        })
      );

      const params = h.created[0];
      expect(params.instructions).toBe('Do it my way.');
      expect(params.model).toBe('claude-sonnet-5');
      expect(params.provider).toBe('anthropic');
      expect(params.tools).toEqual(['Read', 'Grep']);
    });

    test('an explicit null overrides a template value rather than falling back', async () => {
      h.templates.set('researcher.v1', makeTemplate());
      await expectAgent(h, baseInput({ templateKey: 'researcher.v1', model: null }));

      expect(h.created[0].model).toBeNull();
    });

    test('takes identity from the template when none is supplied', async () => {
      h.templates.set('researcher.v1', makeTemplate());
      await expectAgent(h, {
        spaceId: 'space-1',
        templateKey: 'researcher.v1',
      });

      expect(h.created[0].handle).toBe('researcher');
      expect(h.created[0].displayName).toBe('Researcher');
    });

    test('never forwards a template reference to the repository', async () => {
      h.templates.set('researcher.v1', makeTemplate());
      await expectAgent(h, baseInput({ templateKey: 'researcher.v1' }));

      expect(h.created[0]).not.toHaveProperty('templateKey');
    });
  });

  describe('configuration validation', () => {
    test('rejects unknown tools', async () => {
      h.deps.validateTools = () => 'Unknown tool: "Nope"';
      expectRejection(await run(h, baseInput({ tools: ['Nope'] })), 'Unknown tool: "Nope"');
    });

    test('rejects an unrecognized model', async () => {
      h.deps.validateModel = async () => 'Unrecognized model: "ghost"';
      expectRejection(await run(h, baseInput({ model: 'ghost' })), 'Unrecognized model: "ghost"');
    });

    test('rejects an invalid model pool', async () => {
      h.deps.validateModelPool = async () => 'Model pool must have at least one entry with weight';
      expectRejection(
        await run(h, baseInput({ modelPool: MODEL_POOL })),
        'Model pool must have at least one entry with weight'
      );
    });

    test('skips model validation when no model is set', async () => {
      let called = false;
      h.deps.validateModel = async () => {
        called = true;
        return null;
      };
      await expectAgent(h, baseInput());
      expect(called).toBe(false);
    });

    test('skips tool validation for an empty tool list', async () => {
      let called = false;
      h.deps.validateTools = () => {
        called = true;
        return null;
      };
      await expectAgent(h, baseInput({ tools: [] }));
      expect(called).toBe(false);
    });
  });

  describe('persistence', () => {
    test('returns the created agent', async () => {
      const agent = await expectAgent(h, baseInput());
      expect(agent.id).toBe('agent-1');
    });

    test('defaults status to active and session to null', async () => {
      await expectAgent(h, baseInput());
      expect(h.created[0].status).toBe('active');
      expect(h.created[0].sessionId).toBeNull();
    });

    test('carries an explicit session binding through', async () => {
      h.sessions.set('session-7', { type: 'space_chat', spaceId: 'space-1' });
      await expectAgent(h, baseInput({ sessionId: 'session-7' }));
      expect(h.created[0].sessionId).toBe('session-7');
    });

    test('does not persist when an earlier gate rejects', async () => {
      h.spaceExists = false;
      expectRejection(await run(h, baseInput()), 'Space not found');
      expect(h.created).toHaveLength(0);
    });
  });
});

describe('templateToCreateParams', () => {
  test('falls back to defaults with no template and no input', () => {
    const params = templateToCreateParams({ spaceId: 'space-1' }, null, 'handle', 'Display');

    expect(params).toEqual({
      id: undefined,
      spaceId: 'space-1',
      handle: 'handle',
      displayName: 'Display',
      description: null,
      instructions: '',
      status: 'active',
      sessionId: null,
      autonomyLevel: null,
      model: null,
      provider: null,
      modelPool: null,
      thinkingLevel: null,
      settingSources: null,
      tools: null,
    });
  });

  test('template values fill gaps that input leaves undefined', () => {
    const params = templateToCreateParams(
      { spaceId: 'space-1', instructions: 'Mine.' },
      makeTemplate(),
      'handle',
      'Display'
    );

    expect(params.instructions).toBe('Mine.');
    expect(params.description).toBe('Investigates things.');
    expect(params.autonomyLevel).toBe(3);
  });
});

describe('template extras seeding', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  test('seeds from the resolved template after the agent is persisted', async () => {
    h.templates.set('scribe.v1', makeTemplate({ key: 'scribe.v1', handle: 'scribe' }));

    const outcome = await run(h, baseInput({ templateKey: 'scribe.v1' }));

    expect(isCreateSpaceAgentRejection(outcome)).toBe(false);
    if (isCreateSpaceAgentRejection(outcome)) return;
    expect(h.seeded).toEqual([{ agentId: outcome.id, templateKey: 'scribe.v1' }]);
  });

  test('does not seed when the agent was created without a template', async () => {
    const outcome = await run(h, baseInput());

    expect(isCreateSpaceAgentRejection(outcome)).toBe(false);
    expect(h.seeded).toEqual([]);
  });

  test('does not seed when creation is rejected', async () => {
    h.templates.set('scribe.v1', makeTemplate({ key: 'scribe.v1', handle: 'scribe' }));
    h.spaceExists = false;

    await run(h, baseInput({ templateKey: 'scribe.v1' }));

    expect(h.seeded).toEqual([]);
  });

  test('seeds before the created event is published', async () => {
    h.templates.set('scribe.v1', makeTemplate({ key: 'scribe.v1', handle: 'scribe' }));
    const order: string[] = [];
    h.deps.seedTemplateExtras = () => order.push('seed');
    h.deps.publishCreated = async () => {
      order.push('publish');
    };

    await run(h, baseInput({ templateKey: 'scribe.v1' }));

    expect(order).toEqual(['seed', 'publish']);
  });
});

describe('gate order and rejection taxonomy', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  test('a missing space is reported before an unknown template key', async () => {
    h.spaceExists = false;
    const outcome = await run(h, baseInput({ templateKey: 'missing.v1' }));

    expect(isCreateSpaceAgentRejection(outcome) && outcome.kind).toBe('space_not_found');
  });

  test('each gate reports its own rejection kind', async () => {
    const cases: Array<[string, CreateSpaceAgentInput, string]> = [
      ['blank spaceId', baseInput({ spaceId: '' }), 'invalid_request'],
      ['reserved handle', baseInput({ handle: 'coordinator' }), 'invalid_identity'],
      ['unknown template', baseInput({ templateKey: 'missing.v1' }), 'template_not_found'],
    ];

    for (const [label, input, kind] of cases) {
      const outcome = await run(h, input);
      expect(`${label}:${isCreateSpaceAgentRejection(outcome) && outcome.kind}`).toBe(
        `${label}:${kind}`
      );
    }
  });

  test('config failures report invalid_config', async () => {
    h.deps.validateTools = () => 'Unknown tool: "Nope"';
    const outcome = await run(h, baseInput({ tools: ['Nope'] }));

    expect(isCreateSpaceAgentRejection(outcome) && outcome.kind).toBe('invalid_config');
  });

  test('a rejection stops later gates from running', async () => {
    let modelChecked = false;
    h.deps.validateTools = () => 'Unknown tool: "Nope"';
    h.deps.validateModel = async () => {
      modelChecked = true;
      return null;
    };

    await run(h, baseInput({ tools: ['Nope'], model: 'claude-opus-5' }));
    expect(modelChecked).toBe(false);
  });
  describe('session binding', () => {
    test('rejects a session already bound to another agent', async () => {
      h.sessions.set('session-1', { type: 'space_chat', spaceId: 'space-1' });
      h.sessionOwners.set('session-1', 'agent-existing');
      const outcome = await run(h, baseInput({ sessionId: 'session-1' }));

      expectRejection(outcome, 'Session session-1 is already bound to agent agent-existing');
      expect(isCreateSpaceAgentRejection(outcome) && outcome.kind).toBe('session_taken');
    });

    test('does not persist when the session is taken', async () => {
      h.sessions.set('session-1', { type: 'space_chat', spaceId: 'space-1' });
      h.sessionOwners.set('session-1', 'agent-existing');
      await run(h, baseInput({ sessionId: 'session-1' }));

      expect(h.created).toHaveLength(0);
    });

    test('allows a free session', async () => {
      await expectAgent(h, baseInput({ sessionId: 'session-free' }));
      expect(h.created[0].sessionId).toBe('session-free');
    });

    test('skips the check when no session is requested', async () => {
      let checked = false;
      h.deps.sessionOwner = (sessionId) => {
        checked = true;
        return h.sessionOwners.get(sessionId) ?? null;
      };

      await expectAgent(h, baseInput());
      expect(checked).toBe(false);
    });

    test('a taken session is reported before an unknown template key', async () => {
      h.sessions.set('session-1', { type: 'space_chat', spaceId: 'space-1' });
      h.sessionOwners.set('session-1', 'agent-existing');
      const outcome = await run(
        h,
        baseInput({ sessionId: 'session-1', templateKey: 'missing.v1' })
      );

      expect(isCreateSpaceAgentRejection(outcome) && outcome.kind).toBe('session_taken');
    });
  });
  describe('review findings', () => {
    test('rejects a nonexistent session', async () => {
      const outcome = await run(h, baseInput({ sessionId: 'ghost' }));
      expectRejection(outcome, 'Session not found: ghost');
      expect(isCreateSpaceAgentRejection(outcome) && outcome.kind).toBe('session_invalid');
    });

    test('rejects a session belonging to another space', async () => {
      h.sessions.set('other', { type: 'space_chat', spaceId: 'space-2' });
      expectRejection(await run(h, baseInput({ sessionId: 'other' })), 'does not belong to space');
    });

    test('rejects a task agent session', async () => {
      h.sessions.set('task', { type: 'space_task_agent', spaceId: 'space-1' });
      expectRejection(await run(h, baseInput({ sessionId: 'task' })), 'Task agent sessions cannot');
    });

    test('rejects a duplicate display name case-insensitively', async () => {
      h.displayNames = ['My Agent'];
      expectRejection(await run(h, baseInput({ displayName: 'my agent' })), 'is already used');
    });

    test('allows a display name that only collides with an archived agent', async () => {
      h.displayNames = [];
      await expectAgent(h, baseInput({ displayName: 'My Agent' }));
      expect(h.created).toHaveLength(1);
    });

    test('generates a suffixed handle instead of failing on a reserved word', async () => {
      const agent = await expectAgent(h, baseInput({ displayName: 'Coordinator' }));
      expect(agent.handle).not.toBe('coordinator');
      expect(agent.handle.startsWith('coordinator')).toBe(true);
    });

    test('still rejects an explicitly requested reserved handle', async () => {
      expectRejection(await run(h, baseInput({ handle: 'coordinator' })), 'is reserved');
    });

    test('rejects a blank model rather than persisting an empty string', async () => {
      const outcome = await run(h, baseInput({ model: '' }));
      expectRejection(outcome, 'model cannot be blank');
      expect(isCreateSpaceAgentRejection(outcome) && outcome.kind).toBe('invalid_request');
    });

    test('rejects a blank provider', async () => {
      expectRejection(await run(h, baseInput({ provider: '' })), 'provider cannot be blank');
    });

    test('maps a repository session collision to session_taken', async () => {
      h.deps.createAgent = () => {
        throw new Error('Session session-9 is already bound to agent agent-x');
      };
      h.sessions.set('session-9', { type: 'space_chat', spaceId: 'space-1' });

      const outcome = await run(h, baseInput({ sessionId: 'session-9' }));
      expect(isCreateSpaceAgentRejection(outcome) && outcome.kind).toBe('session_taken');
    });

    test('maps a unique-handle constraint violation to invalid_identity', async () => {
      h.deps.createAgent = () => {
        throw new Error('UNIQUE constraint failed: space_long_horizon_agents.handle');
      };

      const outcome = await run(h, baseInput());
      expect(isCreateSpaceAgentRejection(outcome) && outcome.kind).toBe('invalid_identity');
    });

    test('rethrows an unrecognised persistence failure', async () => {
      h.deps.createAgent = () => {
        throw new Error('disk on fire');
      };

      await expect(run(h, baseInput())).rejects.toThrow('disk on fire');
    });

    test('publishes the created agent', async () => {
      const agent = await expectAgent(h, baseInput());
      expect(h.published.map((a) => a.id)).toEqual([agent.id]);
    });

    test('does not publish when a gate rejects', async () => {
      h.spaceExists = false;
      await run(h, baseInput());
      expect(h.published).toHaveLength(0);
    });
  });
});
