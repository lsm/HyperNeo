import { describe, expect, test } from 'bun:test';
import type {
  McpServerConfig,
  SpaceAgentTemplate,
  SpaceLongHorizonAgent,
  SpaceTask,
  SpaceWorkflow,
  WorkflowNode,
} from '@hyperneo/shared';
import type { AgentSessionInit } from '../../../../src/lib/agent/agent-session';
import { buildExecutionBaseSessionId } from '../../../../src/lib/session/sub-session-identity';
import type { NodeAgentTemplateSource } from '../../../../src/lib/space/runtime/spawn-slot-resolution';
import {
  assembleNodeAgentSessionInit,
  findAvailableSessionId,
  resolveNodeAgentConfig,
  resolveSlotCustomPrompt,
  resolveSpawnWorkspace,
  resolveTaskWorkspace,
  resolveWorkflowNodeSlot,
  spaceAgentTemplateToNodeSource,
} from '../../../../src/lib/space/runtime/spawn-slot-resolution';

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-coder',
    name: 'coder',
    agents: [{ agentId: 'agent-coder', name: 'coder' }],
    ...overrides,
  } as unknown as WorkflowNode;
}

function makeWorkflow(nodes: WorkflowNode[]): SpaceWorkflow {
  return { nodes } as unknown as SpaceWorkflow;
}

describe('resolveWorkflowNodeSlot', () => {
  test('resolves the sole slot of a single-agent node regardless of the execution agent name', () => {
    const resolution = resolveWorkflowNodeSlot(makeWorkflow([makeNode()]), 'node-coder', 'other');
    expect(resolution?.slot).toEqual({ agentId: 'agent-coder', name: 'coder' });
    expect(resolution?.node.id).toBe('node-coder');
  });

  test('resolves a multi-agent node slot by name', () => {
    const node = makeNode({
      agents: [
        { agentId: 'agent-a', name: 'alice' },
        { agentId: 'agent-b', name: 'bob' },
      ],
    });
    const resolution = resolveWorkflowNodeSlot(makeWorkflow([node]), 'node-coder', 'bob');
    expect(resolution?.slot).toEqual({ agentId: 'agent-b', name: 'bob' });
  });

  test('returns null for a multi-agent node when the execution agent name is absent', () => {
    const node = makeNode({
      agents: [
        { agentId: 'agent-a', name: 'alice' },
        { agentId: 'agent-b', name: 'bob' },
      ],
    });
    expect(resolveWorkflowNodeSlot(makeWorkflow([node]), 'node-coder', 'carol')).toBeNull();
  });

  test('returns null when the resolved slot has no agent id', () => {
    const node = makeNode({ agents: [{ agentId: null, name: 'coder' }] });
    expect(resolveWorkflowNodeSlot(makeWorkflow([node]), 'node-coder', 'coder')).toBeNull();
  });

  test('returns null when the node is absent from the workflow', () => {
    expect(resolveWorkflowNodeSlot(makeWorkflow([makeNode()]), 'node-gone', 'coder')).toBeNull();
  });

  test('returns null for a null or undefined workflow', () => {
    expect(resolveWorkflowNodeSlot(null, 'node-coder', 'coder')).toBeNull();
    expect(resolveWorkflowNodeSlot(undefined, 'node-coder', 'coder')).toBeNull();
  });

  test('returns null when the node has no agents and no legacy agent id', () => {
    const node = makeNode({ agents: [] });
    expect(resolveWorkflowNodeSlot(makeWorkflow([node]), 'node-coder', 'coder')).toBeNull();
  });

  test('resolves the legacy single-agent shape through the node-level agent id', () => {
    const node = {
      id: 'node-legacy',
      name: 'legacy',
      agents: [],
      agentId: 'agent-legacy',
    } as unknown as WorkflowNode;
    const resolution = resolveWorkflowNodeSlot(makeWorkflow([node]), 'node-legacy', 'anyone');
    expect(resolution?.slot).toEqual({ agentId: 'agent-legacy', name: 'legacy' });
  });

  test('resolves a template-only slot', () => {
    const node = makeNode({
      agents: [{ agentId: '', templateKey: 'coder.default', name: 'coder' }],
    });
    const resolution = resolveWorkflowNodeSlot(makeWorkflow([node]), 'node-coder', 'coder');
    expect(resolution?.slot).toEqual({
      agentId: '',
      templateKey: 'coder.default',
      name: 'coder',
    });
  });
});

describe('buildExecutionBaseSessionId', () => {
  test('assembles the execution-scoped session id', () => {
    expect(buildExecutionBaseSessionId('space-1', 'task-9', 'exec-7')).toBe(
      'space:space-1:task:task-9:exec:exec-7'
    );
  });
});

describe('findAvailableSessionId', () => {
  test('returns the base id when it is not taken', () => {
    expect(findAvailableSessionId('base', () => false)).toBe('base');
  });

  test('suffixes with the first free attempt number', () => {
    expect(findAvailableSessionId('base', (candidate) => candidate === 'base')).toBe('base:1');
    expect(findAvailableSessionId('base', (candidate) => candidate !== 'base:2')).toBe('base:2');
  });

  test('throws after exhausting 100 attempts', () => {
    expect(() => findAvailableSessionId('base', () => true)).toThrow(
      'Could not find available session ID for base "base" after 100 attempts'
    );
  });
});

describe('resolveTaskWorkspace', () => {
  test('resolves to the task workspace when present', () => {
    expect(
      resolveTaskWorkspace({ workspacePath: '/space' }, {
        workspacePath: '/task/override',
      } as SpaceTask)
    ).toBe('/task/override');
  });

  test('falls back to the space workspace when the task has none', () => {
    expect(resolveTaskWorkspace({ workspacePath: '/space' }, {} as SpaceTask)).toBe('/space');
  });

  test('treats a null task workspace as absent and falls back to the space workspace', () => {
    expect(
      resolveTaskWorkspace({ workspacePath: '/space' }, { workspacePath: null } as SpaceTask)
    ).toBe('/space');
  });

  test('treats a blank task workspace as absent and falls back to the space workspace', () => {
    expect(
      resolveTaskWorkspace({ workspacePath: '/space' }, { workspacePath: '' } as SpaceTask)
    ).toBe('/space');
  });

  test('treats a whitespace-only task workspace as absent and falls back to the space workspace', () => {
    expect(
      resolveTaskWorkspace({ workspacePath: '/space' }, { workspacePath: '   ' } as SpaceTask)
    ).toBe('/space');
  });

  test('preserves nonblank paths with leading or trailing spaces verbatim', () => {
    expect(
      resolveTaskWorkspace({ workspacePath: '/space' }, {
        workspacePath: '/repos/project ',
      } as SpaceTask)
    ).toBe('/repos/project ');
  });
});

describe('resolveSpawnWorkspace', () => {
  test('reuses the cached task worktree without creating one', () => {
    expect(
      resolveSpawnWorkspace({
        cachedTaskWorktreePath: '/wt/task-9',
        hasWorktreeManager: true,
        spaceWorkspacePath: '/space',
      })
    ).toEqual({ workspacePath: '/wt/task-9', createWorktree: false });
  });

  test('falls back to the space workspace and creates a worktree when uncached with a manager', () => {
    expect(
      resolveSpawnWorkspace({
        cachedTaskWorktreePath: undefined,
        hasWorktreeManager: true,
        spaceWorkspacePath: '/space',
      })
    ).toEqual({ workspacePath: '/space', createWorktree: true });
  });

  test('falls back to the space workspace without creating a worktree when no manager exists', () => {
    expect(
      resolveSpawnWorkspace({
        cachedTaskWorktreePath: undefined,
        hasWorktreeManager: false,
        spaceWorkspacePath: '/space',
      })
    ).toEqual({ workspacePath: '/space', createWorktree: false });
  });
});

describe('assembleNodeAgentSessionInit', () => {
  const baseInit: AgentSessionInit = {
    sessionId: 'session-1',
    workspacePath: '/wt/task-9',
    model: 'm1',
    mcpServers: { existing: { type: 'stdio', command: 'x' } as McpServerConfig },
  };
  const nodeAgentServers = {
    'node-agent': { type: 'stdio', command: 'node-agent' } as unknown as McpServerConfig,
  };
  const memoryServers = {
    'agent-memory': { type: 'stdio', command: 'memory' } as McpServerConfig,
  };

  test('passes base init fields through unchanged and applies the title', () => {
    const init = assembleNodeAgentSessionInit({
      baseInit: baseInit,
      title: 'Task #9: Pin',
      nodeAgentMcpServers: nodeAgentServers,
      agentMemoryMcpServers: memoryServers,
    });
    expect(init.sessionId).toBe('session-1');
    expect(init.workspacePath).toBe('/wt/task-9');
    expect(init.model).toBe('m1');
    expect(init.title).toBe('Task #9: Pin');
  });

  test('merges the node-agent server and memory servers over the base mcp servers', () => {
    const init = assembleNodeAgentSessionInit({
      baseInit: baseInit,
      title: 't',
      nodeAgentMcpServers: nodeAgentServers,
      agentMemoryMcpServers: memoryServers,
    });
    expect(init.mcpServers).toEqual({
      existing: baseInit.mcpServers?.existing,
      ...nodeAgentServers,
      'agent-memory': memoryServers['agent-memory'],
    });
  });

  test('spreads memory servers after the node-agent server (memory wins a key collision)', () => {
    const init = assembleNodeAgentSessionInit({
      baseInit: baseInit,
      title: 't',
      nodeAgentMcpServers: nodeAgentServers,
      agentMemoryMcpServers: { 'node-agent': memoryServers['agent-memory'] },
    });
    expect(init.mcpServers?.['node-agent']).toBe(memoryServers['agent-memory']);
  });

  test('builds the mcp server map from nothing when the base init has none', () => {
    const init = assembleNodeAgentSessionInit({
      baseInit: { sessionId: 'session-1', workspacePath: '/wt' },
      title: 't',
      nodeAgentMcpServers: nodeAgentServers,
      agentMemoryMcpServers: memoryServers,
    });
    expect(init.mcpServers).toEqual({
      ...nodeAgentServers,
      'agent-memory': memoryServers['agent-memory'],
    });
  });
});

function makeTemplate(overrides: Partial<NodeAgentTemplateSource> = {}): NodeAgentTemplateSource {
  return {
    key: 'coder.default',
    handle: 'coder',
    displayName: 'Coder',
    description: 'Writes the assigned work.',
    instructions: 'Template base contract',
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [],
    reminderDefaults: [],
    ownershipPatterns: [],
    toolPermissions: {},
    ...overrides,
  };
}

function makeAgent(overrides: Partial<SpaceLongHorizonAgent> = {}): SpaceLongHorizonAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    handle: 'registry-agent',
    displayName: 'Registry Agent',
    templateKey: null,
    status: 'active',
    sessionId: null,
    instructions: 'Registry base contract',
    autonomyLevel: null,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: {},
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe('resolveNodeAgentConfig: template source', () => {
  test('builds an ephemeral spawn config from template fields', () => {
    const config = resolveNodeAgentConfig(
      makeTemplate({ toolPermissions: { tools: ['Read', 'Bash'] } }),
      { name: 'coder' },
      []
    );

    expect(config?.source).toBe('template');
    expect(config?.templateKey).toBe('coder.default');
    expect(config?.agent.id).toBe('template:coder.default');
    expect(config?.agent.spaceId).toBe('');
    expect(config?.agent.displayName).toBe('coder');
    expect(config?.agent.handle).toBe('coder');
    expect(config?.agent.instructions).toBe('Template base contract');
    expect(config?.agent.toolPermissions).toEqual({ tools: ['Read', 'Bash'] });
    expect(config?.agent.templateKey).toBe('coder.default');
    expect(config?.agent.status).toBe('active');
  });

  test('per-node role name, model, and thinking level override the template fields', () => {
    const config = resolveNodeAgentConfig(
      makeTemplate({ model: 'template-model', thinkingLevel: 'think8k' }),
      { name: 'implementer', model: 'override-model', thinkingLevel: 'think32k' },
      []
    );

    expect(config?.agent.displayName).toBe('implementer');
    expect(config?.agent.model).toBe('override-model');
    expect(config?.agent.thinkingLevel).toBe('think32k');
  });

  test('keeps template model, provider, thinking level, and setting sources when unoverridden', () => {
    const config = resolveNodeAgentConfig(
      makeTemplate({
        model: 'template-model',
        provider: 'anthropic',
        thinkingLevel: 'think8k',
        settingSources: ['project'],
      }),
      { name: 'coder' },
      []
    );

    expect(config?.agent.model).toBe('template-model');
    expect(config?.agent.provider).toBe('anthropic');
    expect(config?.agent.thinkingLevel).toBe('think8k');
    expect(config?.agent.settingSources).toEqual(['project']);
  });

  test('leaves model and thinking level null when neither template nor node sets them', () => {
    const config = resolveNodeAgentConfig(makeTemplate(), { name: 'coder' }, []);

    expect(config?.agent.model).toBeNull();
    expect(config?.agent.thinkingLevel).toBeNull();
    expect(config?.agent.provider).toBeNull();
  });

  test('falls back to the template display name when the node sets no role name', () => {
    const config = resolveNodeAgentConfig(makeTemplate(), {}, []);

    expect(config?.agent.displayName).toBe('Coder');
  });

  test('carries tool permissions verbatim and defaults to empty permissions when absent', () => {
    const noisy = resolveNodeAgentConfig(
      makeTemplate({ toolPermissions: { tools: ['Read', 42, null] as unknown[] } }),
      {},
      []
    );
    expect(noisy?.agent.toolPermissions).toEqual({ tools: ['Read', 42, null] });

    const bare = resolveNodeAgentConfig(makeTemplate(), {}, []);
    expect(bare?.agent.toolPermissions).toEqual({});
  });
});

describe('resolveNodeAgentConfig: legacy agentId fallback', () => {
  test('resolves the registry agent by id when no template is set', () => {
    const agent = makeAgent({ templateKey: 'legacy.origin' });
    const config = resolveNodeAgentConfig(null, { agentId: 'agent-1' }, [agent]);

    expect(config?.source).toBe('agent');
    expect(config?.templateKey).toBe('legacy.origin');
    expect(config?.agent).toEqual(agent);
  });

  test('applies per-node role name, model, and thinking level over the registry agent', () => {
    const config = resolveNodeAgentConfig(
      undefined,
      {
        agentId: 'agent-1',
        name: 'coder',
        model: 'override-model',
        thinkingLevel: 'think16k',
      },
      [makeAgent({ model: 'agent-model', thinkingLevel: 'think8k' })]
    );

    expect(config?.agent.displayName).toBe('coder');
    expect(config?.agent.model).toBe('override-model');
    expect(config?.agent.thinkingLevel).toBe('think16k');
  });

  test('keeps the registry agent own model and thinking level when the node sets none', () => {
    const config = resolveNodeAgentConfig(null, { agentId: 'agent-1' }, [
      makeAgent({ model: 'agent-model', thinkingLevel: 'think8k' }),
    ]);

    expect(config?.agent.model).toBe('agent-model');
    expect(config?.agent.thinkingLevel).toBe('think8k');
  });

  test('reports a null template key for registry agents without a template', () => {
    const config = resolveNodeAgentConfig(null, { agentId: 'agent-1' }, [makeAgent()]);

    expect(config?.templateKey).toBeNull();
  });

  test('prefers the template when both a template and a legacy agentId are present', () => {
    const config = resolveNodeAgentConfig(makeTemplate(), { agentId: 'agent-1' }, [makeAgent()]);

    expect(config?.source).toBe('template');
    expect(config?.templateKey).toBe('coder.default');
    expect(config?.agent.id).toBe('template:coder.default');
  });

  test('returns null when the agentId matches no registered agent', () => {
    expect(resolveNodeAgentConfig(null, { agentId: 'agent-gone' }, [makeAgent()])).toBeNull();
  });

  test('returns null when there is neither a template nor an agentId', () => {
    expect(resolveNodeAgentConfig(null, {}, [makeAgent()])).toBeNull();
    expect(resolveNodeAgentConfig(undefined, {}, [])).toBeNull();
  });

  test('does not mutate the registry agent record', () => {
    const agent = makeAgent({ model: 'agent-model' });
    resolveNodeAgentConfig(null, { agentId: 'agent-1', model: 'override-model' }, [agent]);

    expect(agent.model).toBe('agent-model');
    expect(agent.displayName).toBe('Registry Agent');
  });
});

function makeStoredTemplate(overrides: Partial<SpaceAgentTemplate> = {}): SpaceAgentTemplate {
  return {
    key: 'migrated.agent.agent-1',
    handle: 'registry-agent',
    displayName: 'Registry Agent',
    description: 'Synthesized from a registry agent.',
    instructions: 'Stored template contract',
    suggestedAutonomyLevel: 2,
    model: 'stored-model',
    provider: 'anthropic',
    modelPool: null,
    thinkingLevel: 'think8k',
    settingSources: ['project'],
    tools: ['Read', 'Grep'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('spaceAgentTemplateToNodeSource', () => {
  test('maps a stored agent template onto a node template source', () => {
    const source = spaceAgentTemplateToNodeSource(makeStoredTemplate());

    expect(source.key).toBe('migrated.agent.agent-1');
    expect(source.handle).toBe('registry-agent');
    expect(source.displayName).toBe('Registry Agent');
    expect(source.description).toBe('Synthesized from a registry agent.');
    expect(source.instructions).toBe('Stored template contract');
    expect(source.suggestedAutonomyLevel).toBe(2);
    expect(source.model).toBe('stored-model');
    expect(source.provider).toBe('anthropic');
    expect(source.thinkingLevel).toBe('think8k');
    expect(source.settingSources).toEqual(['project']);
    expect(source.toolPermissions).toEqual({ tools: ['Read', 'Grep'] });
    expect(source.suggestedEventSubscriptions).toEqual([]);
    expect(source.reminderDefaults).toEqual([]);
    expect(source.ownershipPatterns).toEqual([]);
  });

  test('normalizes null template columns to undefined and empty tool permissions', () => {
    const source = spaceAgentTemplateToNodeSource(
      makeStoredTemplate({
        model: null,
        provider: null,
        thinkingLevel: null,
        settingSources: null,
        tools: null,
      })
    );

    expect(source.model).toBeUndefined();
    expect(source.provider).toBeUndefined();
    expect(source.thinkingLevel).toBeUndefined();
    expect(source.settingSources).toBeUndefined();
    expect(source.toolPermissions).toEqual({});
  });

  test('feeds resolveNodeAgentConfig to spawn from a stored template', () => {
    const config = resolveNodeAgentConfig(
      spaceAgentTemplateToNodeSource(makeStoredTemplate()),
      { name: 'coder' },
      []
    );

    expect(config?.source).toBe('template');
    expect(config?.templateKey).toBe('migrated.agent.agent-1');
    expect(config?.agent.id).toBe('template:migrated.agent.agent-1');
    expect(config?.agent.instructions).toBe('Stored template contract');
    expect(config?.agent.model).toBe('stored-model');
    expect(config?.agent.toolPermissions).toEqual({ tools: ['Read', 'Grep'] });
  });

  test('carries a stored model pool onto the ephemeral spawn agent', () => {
    const pool = [{ model: 'claude-sonnet-5', maxConcurrent: 2, weight: 3 }];
    const config = resolveNodeAgentConfig(
      spaceAgentTemplateToNodeSource(makeStoredTemplate({ modelPool: pool })),
      { name: 'coder' },
      []
    );

    expect(config?.agent.modelPool).toEqual(pool);
  });

  test('leaves the spawn model pool unset when the stored template has none', () => {
    const config = resolveNodeAgentConfig(
      spaceAgentTemplateToNodeSource(makeStoredTemplate({ modelPool: null })),
      { name: 'coder' },
      []
    );

    expect(config?.agent.modelPool).toBeUndefined();
  });
});

describe('resolveSlotCustomPrompt', () => {
  test('returns the direct custom prompt when set', () => {
    const slot = { agentId: 'a', name: 'coder', customPrompt: { value: 'direct' } };
    expect(resolveSlotCustomPrompt(slot as never)).toBe('direct');
  });

  test('merges legacy system prompt and instructions fields', () => {
    const slot = {
      agentId: 'a',
      name: 'coder',
      systemPrompt: { value: 'system part' },
      instructions: { value: 'instructions part' },
    };
    expect(resolveSlotCustomPrompt(slot as never)).toBe('system part\n\ninstructions part');
  });

  test('uses whichever legacy field is present alone', () => {
    expect(
      resolveSlotCustomPrompt({
        agentId: 'a',
        name: 'coder',
        instructions: { value: 'only instructions' },
      } as never)
    ).toBe('only instructions');
    expect(
      resolveSlotCustomPrompt({
        agentId: 'a',
        name: 'coder',
        systemPrompt: { value: '  ' },
      } as never)
    ).toBeUndefined();
  });

  test('returns undefined when replaceAgentPrompt is set without a custom prompt', () => {
    const slot = {
      agentId: 'a',
      name: 'coder',
      replaceAgentPrompt: true,
      systemPrompt: { value: 'ignored legacy' },
    };
    expect(resolveSlotCustomPrompt(slot as never)).toBeUndefined();
  });
});
