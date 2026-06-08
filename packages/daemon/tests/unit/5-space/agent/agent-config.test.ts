/**
 * Tool Access and Sub-Session Features Unit Tests
 *
 * Verifies tool access per preset agent and that sub-session features are
 * correctly applied to worker agent init configs.
 */

import { describe, it, expect } from 'bun:test';
import {
  PRESET_AGENT_TOOLS,
  SUB_SESSION_FEATURES,
} from '../../../../src/lib/space/agents/seed-agents';
import {
  createCustomAgentInit,
  expandPrompt,
  type SlotOverrides,
  type CustomAgentConfig,
} from '../../../../src/lib/space/agents/custom-agent';
import type { SpaceAgent, Space, SpaceTask } from '@neokai/shared';

// ============================================================================
// Test fixtures
// ============================================================================

function makeAgent(overrides?: Partial<SpaceAgent>): SpaceAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'TestAgent',
    customPrompt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSpace(overrides?: Partial<Space>): Space {
  return {
    id: 'space-1',
    workspacePath: '/workspace/project',
    name: 'Test Space',
    description: 'A test space',
    backgroundContext: '',
    instructions: '',
    sessionIds: [],
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeTask(overrides?: Partial<SpaceTask>): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    title: 'Test task',
    description: 'A test task',
    status: 'open',
    priority: 'normal',
    dependsOn: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeConfig(tools?: string[]): CustomAgentConfig {
  return {
    customAgent: makeAgent({ tools, name: 'TestAgent' }),
    task: makeTask(),
    workflowRun: null,
    space: makeSpace(),
    sessionId: 'session-test',
    workspacePath: '/workspace/project',
  };
}

// ============================================================================
// Tool access per preset agent
// ============================================================================

describe('PRESET_AGENT_TOOLS', () => {
  it('coder has full tool access (Read, Write, Edit, Bash, Grep, Glob)', () => {
    const tools = PRESET_AGENT_TOOLS.coder;
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('Bash');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Glob');
  });

  it('coder does not have Task/TaskOutput/TaskStop', () => {
    const tools = PRESET_AGENT_TOOLS.coder;
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('TaskOutput');
    expect(tools).not.toContain('TaskStop');
  });

  it('planner has full tool access', () => {
    const tools = PRESET_AGENT_TOOLS.planner;
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('Bash');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Glob');
  });

  it('reviewer cannot Write or Edit', () => {
    const tools = PRESET_AGENT_TOOLS.reviewer;
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
  });

  it('reviewer has read-only tools', () => {
    const tools = PRESET_AGENT_TOOLS.reviewer;
    expect(tools).toContain('Read');
    expect(tools).toContain('Bash');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Glob');
  });

  it('qa cannot Write or Edit', () => {
    const tools = PRESET_AGENT_TOOLS.qa;
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
  });

  it('qa has read-only + bash tools for running tests', () => {
    const tools = PRESET_AGENT_TOOLS.qa;
    expect(tools).toContain('Read');
    expect(tools).toContain('Bash');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Glob');
  });

  it('general has full coding toolset', () => {
    const tools = PRESET_AGENT_TOOLS.general;
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('Read');
    expect(tools).toContain('Bash');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Glob');
  });
});

// ============================================================================
// Sub-session features
// ============================================================================

describe('SUB_SESSION_FEATURES', () => {
  it('disables all UI features for sub-session agents', () => {
    expect(SUB_SESSION_FEATURES).toEqual({
      rewind: false,
      worktree: false,
      coordinator: false,
      archive: false,
      sessionInfo: false,
    });
  });
});

// ============================================================================
// expandPrompt — append-only composition
// ============================================================================

describe('expandPrompt', () => {
  it('returns base when no expansion is provided', () => {
    expect(expandPrompt('base prompt', undefined)).toBe('base prompt');
  });

  it('returns empty string when base and expansion are both absent', () => {
    expect(expandPrompt(undefined, undefined)).toBe('');
    expect(expandPrompt(null, undefined)).toBe('');
    expect(expandPrompt('', undefined)).toBe('');
  });

  it('appends expansion to base with double newline', () => {
    expect(expandPrompt('base', 'additional')).toBe('base\n\nadditional');
  });

  it('returns expansion only when base is empty', () => {
    expect(expandPrompt('', 'additional')).toBe('additional');
    expect(expandPrompt(null, 'additional')).toBe('additional');
    expect(expandPrompt(undefined, 'additional')).toBe('additional');
  });

  it('trims whitespace from both base and expansion value', () => {
    expect(expandPrompt('  base  ', '  extra  ')).toBe('base\n\nextra');
  });

  it('handles multiline values', () => {
    const result = expandPrompt('base', 'line1\nline2\nline3');
    expect(result).toBe('base\n\nline1\nline2\nline3');
  });

  it('expands on top of non-empty base', () => {
    const base = 'Follow TDD principles.\nWrite tests first.';
    const result = expandPrompt(base, 'Use bun:test for all tests.');
    expect(result).toBe(
      'Follow TDD principles.\nWrite tests first.\n\nUse bun:test for all tests.'
    );
  });

  it('returns base when expansion is blank', () => {
    expect(expandPrompt('base', '')).toBe('base');
    expect(expandPrompt('base', '   ')).toBe('base');
  });

  it('returns empty string when base is empty and expansion is blank', () => {
    expect(expandPrompt('', '')).toBe('');
    expect(expandPrompt('', '   ')).toBe('');
  });

  it('handles expansion with only whitespace base', () => {
    expect(expandPrompt('   ', 'value')).toBe('value');
  });

  it('preserves trimmed base when expansion is undefined', () => {
    expect(expandPrompt('  exact  spacing  ', undefined)).toBe('exact  spacing');
  });

  it('handles unicode content', () => {
    expect(expandPrompt('English base', '日本語の指示')).toBe('English base\n\n日本語の指示');
  });

  it('handles very long values', () => {
    const longValue = 'x'.repeat(10000);
    const result = expandPrompt('base', longValue);
    expect(result).toBe(`base\n\n${longValue}`);
    expect(result.length).toBe(10006);
  });

  it('handles expand with null base', () => {
    expect(expandPrompt(null, 'some text')).toBe('some text');
  });

  it('trims padded expansion', () => {
    expect(expandPrompt('base', '\n\n  padded  \n\n')).toBe('base\n\npadded');
  });

  it('with only whitespace base and expansion', () => {
    expect(expandPrompt('   ', 'value')).toBe('value');
  });
});

// ============================================================================
// createCustomAgentInit applies sub-session features
// ============================================================================

describe('createCustomAgentInit — sub-session features', () => {
  it('applies SUB_SESSION_FEATURES for agent with tools', () => {
    const init = createCustomAgentInit(makeConfig(PRESET_AGENT_TOOLS.coder));
    expect(init.features).toEqual(SUB_SESSION_FEATURES);
  });

  it('applies SUB_SESSION_FEATURES for agent with restricted tools', () => {
    const init = createCustomAgentInit(makeConfig(PRESET_AGENT_TOOLS.reviewer));
    expect(init.features).toEqual(SUB_SESSION_FEATURES);
  });

  it('applies SUB_SESSION_FEATURES for agent without tools', () => {
    const init = createCustomAgentInit(makeConfig(undefined));
    expect(init.features).toEqual(SUB_SESSION_FEATURES);
  });

  it('reviewer init uses agents pattern, restricting tools via disallowedTools', () => {
    const config = makeConfig(PRESET_AGENT_TOOLS.reviewer);
    const init = createCustomAgentInit(config);

    // When tools are specified, the agents pattern is used
    expect(init.agent).toBeDefined();
    expect(init.agents).toBeDefined();

    // The agent definition must NOT set `tools` — an AgentDefinition.tools
    // allowlist would exclude MCP tools. The built-in restriction is applied
    // via `disallowedTools` instead.
    const agentKey = init.agent as string;
    const agentDef = init.agents![agentKey];
    expect(agentDef.tools).toBeUndefined();
    expect(agentDef.disallowedTools).toContain('Write');
    expect(agentDef.disallowedTools).toContain('Edit');
  });

  it('qa init uses agents pattern, restricting tools via disallowedTools', () => {
    const config = makeConfig(PRESET_AGENT_TOOLS.qa);
    const init = createCustomAgentInit(config);

    expect(init.agent).toBeDefined();
    expect(init.agents).toBeDefined();

    const agentKey = init.agent as string;
    const agentDef = init.agents![agentKey];
    expect(agentDef.tools).toBeUndefined();
    expect(agentDef.disallowedTools).toContain('Write');
    expect(agentDef.disallowedTools).toContain('Edit');
  });

  it('coder init uses agents pattern with full tools', () => {
    const config = makeConfig(PRESET_AGENT_TOOLS.coder);
    const init = createCustomAgentInit(config);

    expect(init.agent).toBeDefined();
    expect(init.agents).toBeDefined();

    const agentKey = init.agent as string;
    const agentDef = init.agents![agentKey];
    expect(agentDef.tools).toBeUndefined();
    expect(agentDef.disallowedTools).not.toContain('Write');
    expect(agentDef.disallowedTools).not.toContain('Edit');
  });

  it('agent without tools uses simple preset path (no agent key)', () => {
    const config = makeConfig(undefined);
    const init = createCustomAgentInit(config);

    expect(init.agent).toBeUndefined();
    expect(init.agents).toBeUndefined();
  });

  it('applies customPrompt slot expansion in system prompt', () => {
    const config = makeConfig(PRESET_AGENT_TOOLS.coder);
    config.customAgent = makeAgent({
      customPrompt: 'Base prompt',
      tools: PRESET_AGENT_TOOLS.coder,
    });
    config.slotOverrides = {
      customPrompt: 'Slot expansion',
    };
    const init = createCustomAgentInit(config);

    // tools path — check agent prompt contains expanded text
    if (init.agent && init.agents) {
      const agentKey = init.agent as string;
      const agentDef = init.agents![agentKey];
      expect(agentDef.prompt).toBe('Base prompt\n\nSlot expansion');
    }
  });

  it('applies customPrompt expansion in non-tools system prompt path', () => {
    const config = makeConfig(undefined);
    config.customAgent = makeAgent({
      customPrompt: 'Base prompt',
      tools: undefined,
    });
    config.slotOverrides = {
      customPrompt: 'Expanded context',
    };
    const init = createCustomAgentInit(config);

    if (init.systemPrompt && 'append' in init.systemPrompt) {
      expect(init.systemPrompt.append).toBe('Base prompt\n\nExpanded context');
    }
  });
});

// ============================================================================
// SlotOverrides interface
// ============================================================================

describe('SlotOverrides interface', () => {
  it('accepts customPrompt as string', () => {
    const overrides: SlotOverrides = {
      customPrompt: 'extra context',
    };
    expect(expandPrompt('base prompt', overrides.customPrompt)).toBe(
      'base prompt\n\nextra context'
    );
  });

  it('returns base when SlotOverrides.customPrompt is undefined', () => {
    const overrides: SlotOverrides = {};
    expect(expandPrompt('base prompt', overrides.customPrompt)).toBe('base prompt');
  });
});
