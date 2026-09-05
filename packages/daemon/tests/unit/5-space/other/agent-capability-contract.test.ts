import { describe, expect, test } from 'bun:test';
import type { Space, SpaceTask } from '@hyperneo/shared';
import { DENIABLE_TOOLS, isScopedBashToolEntry } from '@hyperneo/shared';
import {
  createCustomAgentInit,
  resolveAgentInit,
} from '../../../../src/lib/space/agents/custom-agent';
import { PRESET_AGENT_TOOLS } from '../../../../src/lib/space/agents/seed-agents';
import { deriveWorkerDisallowedTools } from '../../../../src/lib/space/agents/tool-policy';

describe('deriveWorkerDisallowedTools — shared tool-policy resolver', () => {
  test('empty / null / undefined profile is permissive: no built-ins denied', () => {
    expect(deriveWorkerDisallowedTools([])).toEqual([]);
    expect(deriveWorkerDisallowedTools(null)).toEqual([]);
    expect(deriveWorkerDisallowedTools(undefined)).toEqual([]);
  });

  test('a profile that omits every deniable tool denies exactly the shared DENIABLE_TOOLS set', () => {
    expect(deriveWorkerDisallowedTools(['Read', 'Grep', 'Glob'])).toEqual([...DENIABLE_TOOLS]);
  });

  test('a profile listing every deniable tool denies nothing', () => {
    expect(deriveWorkerDisallowedTools([...DENIABLE_TOOLS, 'Read'])).toEqual([]);
  });

  test('only deniable tools absent from the profile are denied; present ones pass through', () => {
    expect(deriveWorkerDisallowedTools(['Read', 'Bash', 'Grep'])).toEqual([
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
    ]);
  });

  test('non-deniable profile entries do not affect the denial set', () => {
    expect(deriveWorkerDisallowedTools(['Read', 'Grep', 'Task', 'Skill', 'ToolSearch'])).toEqual([
      ...DENIABLE_TOOLS,
    ]);
  });

  test('a permissive (empty) profile denies nothing — not even auxMutators', () => {
    expect(deriveWorkerDisallowedTools([], { auxMutators: ['Workflow'] })).toEqual([]);
    expect(deriveWorkerDisallowedTools(null, { auxMutators: ['Workflow'] })).toEqual([]);
  });

  test('auxMutators are denied in addition to the deniable built-ins, built-ins first', () => {
    const denied = deriveWorkerDisallowedTools(['Read'], {
      auxMutators: ['Workflow', 'CronCreate'],
    });
    expect(denied.slice(0, DENIABLE_TOOLS.length)).toEqual([...DENIABLE_TOOLS]);
    expect(denied.slice(DENIABLE_TOOLS.length)).toEqual(['Workflow', 'CronCreate']);
  });

  test('scoped Bash command patterns keep Bash available instead of denying it wholesale', () => {
    const denied = deriveWorkerDisallowedTools(['Read', 'Bash(gh pr view:*)', 'Grep']);
    expect(denied).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  });

  test('a profile with neither bare Bash nor scoped Bash entries still denies Bash', () => {
    const denied = deriveWorkerDisallowedTools(['Read', 'Grep', 'Glob']);
    expect(denied).toEqual([...DENIABLE_TOOLS]);
  });
});

describe('effective runtime capability vs declared profile (worker presets)', () => {
  function effectiveDeniableTools(profile: readonly string[] | null | undefined): string[] {
    const denied = new Set(deriveWorkerDisallowedTools(profile));
    return DENIABLE_TOOLS.filter((t) => !denied.has(t));
  }

  test('Coder declares an empty profile yet inherits every deniable tool at runtime', () => {
    const profile = PRESET_AGENT_TOOLS.coder;
    expect(profile).toEqual([]);
    expect(effectiveDeniableTools(profile)).toEqual([...DENIABLE_TOOLS]);
  });

  test('every permissive preset inherits the full deniable set at runtime', () => {
    const permissive = {
      coder: PRESET_AGENT_TOOLS.coder,
      general: PRESET_AGENT_TOOLS.general,
      planner: PRESET_AGENT_TOOLS.planner,
      research: PRESET_AGENT_TOOLS.research,
    };
    for (const [name, profile] of Object.entries(permissive)) {
      expect(profile, `${name} profile`).toEqual([]);
      expect(effectiveDeniableTools(profile), `${name} runtime`).toEqual([...DENIABLE_TOOLS]);
    }
  });

  test('Reviewer keeps Bash via scoped command patterns but denies write/edit deniable tools', () => {
    const profile = PRESET_AGENT_TOOLS.reviewer;
    const effective = new Set(effectiveDeniableTools(profile));
    expect(effective.has('Bash')).toBe(true);
    expect(effective.has('Write')).toBe(false);
    expect(effective.has('Edit')).toBe(false);
    expect(effective.has('MultiEdit')).toBe(false);
    expect(effective.has('NotebookEdit')).toBe(false);
    expect(profile.some((tool) => tool.startsWith('Bash('))).toBe(true);
    expect(profile).not.toContain('Bash');
  });

  test('QA keeps Bash, denies the write/edit deniable tools', () => {
    const effective = new Set(effectiveDeniableTools(PRESET_AGENT_TOOLS.qa));
    expect(effective.has('Bash')).toBe(true);
    expect(effective.has('Write')).toBe(false);
    expect(effective.has('Edit')).toBe(false);
  });

  test('capability consistency invariant holds for every preset', () => {
    for (const [name, profile] of Object.entries(PRESET_AGENT_TOOLS)) {
      const permissive = !profile || profile.length === 0;
      const listed = new Set(profile);
      const hasScopedBash = profile.some((tool) => isScopedBashToolEntry(tool));
      const denied = new Set(deriveWorkerDisallowedTools(profile));
      for (const tool of DENIABLE_TOOLS) {
        const availableAtRuntime = !denied.has(tool);
        const intendedAvailable =
          permissive || listed.has(tool) || (tool === 'Bash' && hasScopedBash);
        expect({ preset: name, tool, availableAtRuntime, intendedAvailable }).toEqual({
          preset: name,
          tool,
          availableAtRuntime: intendedAvailable,
          intendedAvailable,
        });
      }
    }
  });
});

describe('shared resolver via createCustomAgentInit', () => {
  function workerInit(tools: string[]) {
    return createCustomAgentInit({
      customAgent: {
        id: 'a1',
        spaceId: 's1',
        handle: 'a1',
        displayName: 'A',
        templateKey: null,
        status: 'active',
        sessionId: null,
        instructions: '',
        autonomyLevel: null,
        model: null,
        thinkingLevel: null,
        provider: null,
        settingSources: null,
        toolPermissions: tools.length > 0 ? { tools } : {},
        createdAt: 1,
        updatedAt: 1,
      },
      task: {
        id: 't1',
        spaceId: 's1',
        taskNumber: 1,
        title: 'T',
        description: '',
        status: 'open',
        priority: 'normal',
        dependsOn: [],
        createdAt: 1,
        updatedAt: 1,
      },
      space: {
        id: 's1',
        name: 'S',
        description: '',
        workspacePath: '/tmp',
        backgroundContext: '',
        instructions: '',
        sessionIds: [],
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      },
      sessionId: 'sess',
      workspacePath: '/tmp',
      workflowRun: null,
      workflow: null,
    });
  }

  test('the unified production path (createCustomAgentInit) delegates to the shared resolver', () => {
    const permissive = workerInit([]);
    expect(permissive.disallowedTools).toBeUndefined();
    expect(permissive.disallowedTools ?? []).toEqual(deriveWorkerDisallowedTools([]));

    const profile = ['Read', 'Bash'];
    expect(workerInit(profile).disallowedTools ?? []).toEqual(deriveWorkerDisallowedTools(profile));
  });

  test('the reviewer preset forwards scoped Bash entries into allowedTools and keeps Bash undenied', () => {
    const init = workerInit(PRESET_AGENT_TOOLS.reviewer);
    const allowed = new Set(init.allowedTools ?? []);
    expect(allowed.has('Task')).toBe(true);
    expect(allowed.has('TaskOutput')).toBe(true);
    expect(allowed.has('TaskStop')).toBe(true);
    expect(allowed.has('Bash(gh pr view:*)')).toBe(true);
    expect(allowed.has('Bash(gh api graphql:*)')).toBe(true);
    expect(allowed.has('Bash(jq:*)')).toBe(true);
    expect(
      init.allowedTools?.every((tool) => !tool.startsWith('Bash') || isScopedBashToolEntry(tool))
    ).toBe(true);
    expect(init.disallowedTools ?? []).not.toContain('Bash');
    expect(init.disallowedTools ?? []).toContain('Write');
    expect(init.disallowedTools ?? []).toContain('Edit');
  });
});

describe('task-scoped agent resolution', () => {
  const space: Partial<Space> = { id: 'space-a' };

  test('resolveAgentInit includes the task id in the agent not-found error', () => {
    const task: Partial<SpaceTask> = { id: 'task-42' };
    expect(() =>
      resolveAgentInit({
        task: task as SpaceTask,
        space: space as Space,
        agent: null,
        sessionId: 'sess',
        workspacePath: '/tmp',
        agentId: 'no-such-agent',
      })
    ).toThrow('Agent not found: no-such-agent (task: task-42)');
  });
});
