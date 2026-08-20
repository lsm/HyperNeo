import { describe, expect, it } from 'bun:test';
import type { Space, SpaceTask, SpaceWorkerAgent } from '@hyperneo/shared';
import {
  type CustomAgentConfig,
  createCustomAgentInit,
  expandPrompt,
  type SlotOverrides,
} from '../../../../src/lib/space/agents/custom-agent';
import {
  PRESET_AGENT_TOOLS,
  SUB_SESSION_FEATURES,
} from '../../../../src/lib/space/agents/seed-agents';

function makeAgent(overrides?: Partial<SpaceWorkerAgent>): SpaceWorkerAgent {
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

describe('PRESET_AGENT_TOOLS', () => {
  it('coder has an empty permissive profile (inherits all SDK built-ins)', () => {
    const tools = PRESET_AGENT_TOOLS.coder;
    expect(tools).toEqual([]);
  });

  it('coder does not have Task/TaskOutput/TaskStop in its explicit profile', () => {
    const tools = PRESET_AGENT_TOOLS.coder;
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('TaskOutput');
    expect(tools).not.toContain('TaskStop');
  });

  it('planner has an empty permissive profile (inherits all SDK built-ins)', () => {
    const tools = PRESET_AGENT_TOOLS.planner;
    expect(tools).toEqual([]);
  });

  it('reviewer cannot Write or Edit', () => {
    const tools = PRESET_AGENT_TOOLS.reviewer;
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
  });

  it('reviewer has scoped gh Bash patterns + Cron tools for inspection, but NO bare Bash/Write/Edit', () => {
    const tools = PRESET_AGENT_TOOLS.reviewer;
    expect(tools).toContain('Read');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Glob');
    expect(tools).not.toContain('Bash');
    expect(tools).toContain('Bash(gh pr view:*)');
    expect(tools).toContain('Bash(gh pr diff:*)');
    expect(tools).toContain('Bash(gh pr checks:*)');
    expect(tools).toContain('Bash(gh api graphql:*)');
    expect(tools).toContain('CronCreate');
    expect(tools).toContain('CronDelete');
    expect(tools).toContain('CronList');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
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

  it('general has an empty permissive profile (inherits all SDK built-ins)', () => {
    const tools = PRESET_AGENT_TOOLS.general;
    expect(tools).toEqual([]);
  });
});

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

  it('reviewer denies mutation tools but keeps Bash via scoped command patterns (restrained review role)', () => {
    const config = makeConfig(PRESET_AGENT_TOOLS.reviewer);
    const init = createCustomAgentInit(config);

    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toEqual([
      'Task',
      'TaskOutput',
      'TaskStop',
      'Bash(gh pr view:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh pr checks:*)',
      'Bash(gh api graphql:*)',
      'Bash(gh api repos:*)',
      'Bash(jq:*)',
      'Bash(mktemp:*)',
      'Bash(echo:*)',
      'Bash(cat:*)',
      'Bash(test:*)',
      'Bash(head:*)',
      'Bash(tr:*)',
      'Bash(base64:*)',
      'Bash(trap:*)',
      'Bash(exit:*)',
    ]);
    expect(init.agent).toBeUndefined();
    expect(init.agents?.['general-purpose']).toBeDefined();
    expect(init.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    expect(init.disallowedTools).not.toContain('Bash');
  });

  it('qa denies mutation tools only, leaving Bash available for running tests', () => {
    const config = makeConfig(PRESET_AGENT_TOOLS.qa);
    const init = createCustomAgentInit(config);

    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toBeUndefined();
    expect(init.agent).toBeUndefined();
    expect(init.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    expect(init.disallowedTools).not.toContain('Bash');
  });

  it('coder is permissive and does not set SDK tool allowlists', () => {
    const config = makeConfig(PRESET_AGENT_TOOLS.coder);
    const init = createCustomAgentInit(config);

    expect(init.agent).toBeUndefined();
    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toBeUndefined();
    expect(init.disallowedTools).toBeUndefined();
  });

  it('agent without tools uses simple preset path (no agent key)', () => {
    const config = makeConfig(undefined);
    const init = createCustomAgentInit(config);

    expect(init.agent).toBeUndefined();
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

    expect(init.systemPrompt?.append).toBe('Base prompt\n\nSlot expansion');
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
