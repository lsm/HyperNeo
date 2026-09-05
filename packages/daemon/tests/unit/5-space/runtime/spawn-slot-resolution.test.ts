import { describe, expect, test } from 'bun:test';
import type {
  McpServerConfig,
  SpaceAgentTemplate,
  SpaceTask,
  SpaceWorkerAgent,
  SpaceWorkflow,
  WorkflowNode,
} from '@hyperneo/shared';
import type { AgentSessionInit } from '../../../../src/lib/agent/agent-session';
import { buildExecutionBaseSessionId } from '../../../../src/lib/session/sub-session-identity';
import { synthesizeWorkflowAgentTemplate } from '../../../../src/lib/space/agents/workflow-agent-template-synthesis';
import type { NodeAgentTemplateSource } from '../../../../src/lib/space/runtime/spawn-slot-resolution';
import {
  assembleNodeAgentSessionInit,
  findAvailableSessionId,
  resolveNodeAgentConfig,
  resolveSpawnWorkspace,
  resolveTaskWorkspace,
  resolveWorkflowNodeSlot,
  storedTemplateToNodeAgentSource,
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

function makeAgent(overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'Registry Agent',
    handle: 'registry-agent',
    customPrompt: 'Registry base contract',
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
    expect(config?.agent.name).toBe('coder');
    expect(config?.agent.handle).toBe('coder');
    expect(config?.agent.customPrompt).toBe('Template base contract');
    expect(config?.agent.tools).toEqual(['Read', 'Bash']);
    expect(config?.agent.templateName).toBe('coder.default');
    expect(config?.agent.templateHash).toBeNull();
  });

  test('per-node role name, model, and thinking level override the template fields', () => {
    const config = resolveNodeAgentConfig(
      makeTemplate({ model: 'template-model', thinkingLevel: 'think8k' }),
      { name: 'implementer', model: 'override-model', thinkingLevel: 'think32k' },
      []
    );

    expect(config?.agent.name).toBe('implementer');
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

  test('leaves model and thinking level undefined when neither template nor node sets them', () => {
    const config = resolveNodeAgentConfig(makeTemplate(), { name: 'coder' }, []);

    expect(config?.agent.model).toBeUndefined();
    expect(config?.agent.thinkingLevel).toBeUndefined();
    expect(config?.agent.provider).toBeUndefined();
  });

  test('falls back to the template display name when the node sets no role name', () => {
    const config = resolveNodeAgentConfig(makeTemplate(), {}, []);

    expect(config?.agent.name).toBe('Coder');
  });

  test('filters non-string tool permissions entries and leaves tools unset when absent', () => {
    const noisy = resolveNodeAgentConfig(
      makeTemplate({ toolPermissions: { tools: ['Read', 42, null] as unknown[] } }),
      {},
      []
    );
    expect(noisy?.agent.tools).toEqual(['Read']);

    const bare = resolveNodeAgentConfig(makeTemplate(), {}, []);
    expect(bare?.agent.tools).toBeUndefined();
  });
});

describe('resolveNodeAgentConfig: legacy agentId fallback', () => {
  test('resolves the registry agent by id when no template is set', () => {
    const agent = makeAgent({ templateName: 'legacy.origin' });
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

    expect(config?.agent.name).toBe('coder');
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
    expect(agent.name).toBe('Registry Agent');
  });
});

describe('storedTemplateToNodeAgentSource', () => {
  function makeStoredTemplate(overrides: Partial<SpaceAgentTemplate> = {}): SpaceAgentTemplate {
    return {
      key: 'migrated.registry-agent',
      handle: 'registry-agent',
      displayName: 'Registry Agent',
      description: 'Does the work',
      instructions: 'Be thorough',
      suggestedAutonomyLevel: 3,
      model: 'claude-x',
      provider: 'anthropic',
      modelPool: [{ model: 'claude-x', maxConcurrent: 2, weight: 1 }],
      thinkingLevel: 'think8k',
      settingSources: ['user'],
      tools: ['Read', 'Bash(gh pr view:*)'],
      createdAt: 100,
      updatedAt: 200,
      ...overrides,
    };
  }

  test('maps a stored template onto the spawn template source shape', () => {
    const source = storedTemplateToNodeAgentSource(makeStoredTemplate());

    expect(source.key).toBe('migrated.registry-agent');
    expect(source.handle).toBe('registry-agent');
    expect(source.displayName).toBe('Registry Agent');
    expect(source.description).toBe('Does the work');
    expect(source.instructions).toBe('Be thorough');
    expect(source.suggestedAutonomyLevel).toBe(3);
    expect(source.model).toBe('claude-x');
    expect(source.provider).toBe('anthropic');
    expect(source.modelPool).toEqual([{ model: 'claude-x', maxConcurrent: 2, weight: 1 }]);
    expect(source.thinkingLevel).toBe('think8k');
    expect(source.settingSources).toEqual(['user']);
    expect(source.toolPermissions).toEqual({ tools: ['Read', 'Bash(gh pr view:*)'] });
  });

  test('normalizes absent nullable fields to undefined and empty permissions', () => {
    const source = storedTemplateToNodeAgentSource(
      makeStoredTemplate({
        model: null,
        provider: null,
        modelPool: null,
        thinkingLevel: null,
        settingSources: null,
        tools: null,
      })
    );

    expect(source.model).toBeUndefined();
    expect(source.provider).toBeUndefined();
    expect(source.modelPool).toBeNull();
    expect(source.thinkingLevel).toBeUndefined();
    expect(source.settingSources).toBeUndefined();
    expect(source.toolPermissions).toEqual({});
  });

  test('resolves through the template branch with the stored fields intact', () => {
    const config = resolveNodeAgentConfig(
      storedTemplateToNodeAgentSource(makeStoredTemplate()),
      { name: 'coder' },
      []
    );

    expect(config?.source).toBe('template');
    expect(config?.templateKey).toBe('migrated.registry-agent');
    expect(config?.agent.customPrompt).toBe('Be thorough');
    expect(config?.agent.model).toBe('claude-x');
    expect(config?.agent.provider).toBe('anthropic');
    expect(config?.agent.thinkingLevel).toBe('think8k');
    expect(config?.agent.settingSources).toEqual(['user']);
    expect(config?.agent.tools).toEqual(['Read', 'Bash(gh pr view:*)']);
    expect(config?.agent.modelPool).toEqual([{ model: 'claude-x', maxConcurrent: 2, weight: 1 }]);
  });
});

describe('resolveNodeAgentConfig: migrated template equivalence pin', () => {
  const agent = makeAgent({
    name: 'Registry Agent',
    handle: 'registry-agent',
    description: 'Does the work',
    customPrompt: 'Be thorough',
    model: 'claude-x',
    provider: 'anthropic',
    thinkingLevel: 'think8k',
    settingSources: ['user'],
    tools: ['Read'],
    modelPool: [{ model: 'claude-x', maxConcurrent: 2, weight: 1 }],
  });

  function templateFromAgent(): NodeAgentTemplateSource {
    const stored = storedTemplateToNodeAgentSource({
      key: 'migrated.registry-agent',
      handle: 'registry-agent',
      displayName: 'Registry Agent',
      description: 'Does the work',
      instructions: 'Be thorough',
      suggestedAutonomyLevel: 2,
      model: 'claude-x',
      provider: 'anthropic',
      modelPool: [{ model: 'claude-x', maxConcurrent: 2, weight: 1 }],
      thinkingLevel: 'think8k',
      settingSources: ['user'],
      tools: ['Read'],
      createdAt: 0,
      updatedAt: 0,
    });
    return stored;
  }

  test('a synthesized template resolves the same spawn fields as the registry agent', () => {
    const viaTemplate = resolveNodeAgentConfig(templateFromAgent(), { name: 'coder' }, []);
    const viaAgent = resolveNodeAgentConfig(null, { agentId: 'agent-1', name: 'coder' }, [agent]);

    expect(viaTemplate?.agent.name).toBe(viaAgent?.agent.name);
    expect(viaTemplate?.agent.customPrompt).toBe(viaAgent?.agent.customPrompt);
    expect(viaTemplate?.agent.model).toBe(viaAgent?.agent.model);
    expect(viaTemplate?.agent.provider).toBe(viaAgent?.agent.provider);
    expect(viaTemplate?.agent.thinkingLevel).toBe(viaAgent?.agent.thinkingLevel);
    expect(viaTemplate?.agent.settingSources).toEqual(viaAgent?.agent.settingSources);
    expect(viaTemplate?.agent.tools).toEqual(viaAgent?.agent.tools);
    expect(viaTemplate?.agent.modelPool).toEqual(viaAgent?.agent.modelPool);
    expect(viaTemplate?.agent.description).toBe(viaAgent?.agent.description);
  });

  test('the synthesized template marks the spawn as template-sourced under the migrated key', () => {
    const viaTemplate = resolveNodeAgentConfig(templateFromAgent(), { name: 'coder' }, []);

    expect(viaTemplate?.source).toBe('template');
    expect(viaTemplate?.templateKey).toBe('migrated.registry-agent');
    expect(viaTemplate?.agent.id).toBe('template:migrated.registry-agent');
  });

  test('synthesizing from the agent produces exactly the template the pin resolves', () => {
    const params = synthesizeWorkflowAgentTemplate(
      {
        id: agent.id,
        handle: agent.handle,
        displayName: agent.name,
        description: agent.description,
        instructions: agent.customPrompt,
        model: agent.model ?? null,
        provider: agent.provider ?? null,
        thinkingLevel: agent.thinkingLevel ?? null,
        settingSources: agent.settingSources ?? null,
        tools: agent.tools ?? null,
        modelPool: agent.modelPool ?? null,
      },
      'migrated.registry-agent'
    );

    expect(params.instructions).toBe('Be thorough');
    expect(params.model).toBe('claude-x');
    expect(params.modelPool).toEqual([{ model: 'claude-x', maxConcurrent: 2, weight: 1 }]);
    expect(params.tools).toEqual(['Read']);
  });
});
