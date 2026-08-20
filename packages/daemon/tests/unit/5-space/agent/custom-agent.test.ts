import { describe, expect, it, mock } from 'bun:test';
import type {
  EvolutionLesson,
  Space,
  SpaceGoal,
  SpaceTask,
  SpaceWorkerAgent,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import {
  buildCustomAgentSystemPrompt,
  buildCustomAgentTaskMessage,
  type CustomAgentConfig,
  createCustomAgentInit,
  expandPrompt,
  resolveAgentInit,
  resolveCustomAgentPrompt,
  type SlotOverrides,
} from '../../../../src/lib/space/agents/custom-agent';
import { REVIEWER_SYSTEM_CONTRACT } from '../../../../src/lib/space/agents/system-contracts';
import type { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { CODING_WORKFLOW } from '../../../../src/lib/space/workflows/built-in-workflows.ts';

function makeAgent(overrides?: Partial<SpaceWorkerAgent>): SpaceWorkerAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'Test Agent',
    customPrompt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSpace(overrides?: Partial<Space>): Space {
  return {
    id: 'space-1',
    name: 'Test Space',
    description: 'Space description',
    workspacePath: '/workspace/project',
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
    taskNumber: 1,
    title: 'Implement feature X',
    description: 'Add feature X to the codebase',
    status: 'open',
    priority: 'normal',
    dependsOn: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeGoal(overrides?: Partial<SpaceGoal>): SpaceGoal {
  return {
    id: 'goal-1',
    spaceId: 'space-1',
    title: 'Improve onboarding',
    description: 'Make first-run smoother',
    status: 'active',
    type: 'recurring',
    priority: 'high',
    labels: ['product'],
    metrics: { activated: 10 },
    summary: 'Initial state',
    progress: 35,
    nextSteps: ['Audit current flow'],
    preferredWorkflowId: null,
    taskScheduleId: null,
    autoTriggerNext: false,
    pendingNextRun: false,
    activeTaskId: null,
    lastTaskId: null,
    lastCheckInAt: null,
    nextCheckInAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

function makeLesson(overrides?: Partial<EvolutionLesson>): EvolutionLesson {
  return {
    id: 'lesson-1',
    scopeId: 'scope-1',
    status: 'active',
    appliesTo: ['review'],
    rule: 'Run focused review before broad refactor',
    why: 'Focused reviews caught regressions faster',
    evidenceEpisodeIds: ['episode-1'],
    confidence: 0.8,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeWorkflowRun(overrides?: Partial<SpaceWorkflowRun>): SpaceWorkflowRun {
  return {
    id: 'run-1',
    spaceId: 'space-1',
    workflowId: 'wf-1',
    title: 'Workflow Run',
    status: 'in_progress',
    startedAt: null,
    completedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeWorkflow(overrides?: Partial<SpaceWorkflow>): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Coding Workflow',
    description: 'Visible workflow description',
    nodes: [
      {
        id: 'node-1',
        name: 'Plan',
        agents: [
          {
            agentId: 'agent-1',
            name: 'Coder',
            customPrompt: { value: 'Write a plan' },
          },
        ],
      },
      { id: 'node-2', name: 'Code', agents: [{ agentId: 'agent-1', name: 'Coder' }] },
    ],
    startNodeId: 'node-1',
    channels: [
      {
        id: 'ch-plan-to-code',
        from: 'Plan',
        to: 'Code',
        label: 'Plan → Code',
        gateId: 'plan-ready-gate',
      },
      {
        id: 'ch-code-to-plan',
        from: 'Code',
        to: 'Plan',
        label: 'Code → Plan (feedback)',
        maxCycles: 3,
      },
    ],
    gates: [
      {
        id: 'plan-ready-gate',
        label: 'PR Ready',
        description: 'Planner has opened a plan PR',
        fields: [
          {
            name: 'pr_url',
            type: 'string',
            writers: ['Plan'],
            check: { op: 'exists' },
          },
        ],
        resetOnCycle: false,
      },
      {
        id: 'code-pr-gate',
        label: 'Code PR',
        description: 'Coder has opened a code PR',
        fields: [
          {
            name: 'pr_url',
            type: 'string',
            writers: ['Code'],
            check: { op: 'exists' },
          },
        ],
        resetOnCycle: false,
      },
    ],
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<CustomAgentConfig>): CustomAgentConfig {
  return {
    customAgent: makeAgent(),
    task: makeTask(),
    workflowRun: null,
    workflow: null,
    space: makeSpace(),
    sessionId: 'session-1',
    workspacePath: '/workspace/project',
    ...overrides,
  };
}

describe('buildCustomAgentSystemPrompt', () => {
  it('returns only trimmed visible prompt text', () => {
    expect(buildCustomAgentSystemPrompt(makeAgent({ customPrompt: '  Visible prompt  ' }))).toBe(
      'Visible prompt'
    );
  });

  it('returns empty string when no prompt is configured', () => {
    expect(buildCustomAgentSystemPrompt(makeAgent({ customPrompt: null }))).toBe('');
  });
});

describe('resolveCustomAgentPrompt', () => {
  it('resolves workflow node overrides before the persisted agent prompt', () => {
    const resolved = resolveCustomAgentPrompt(makeAgent({ customPrompt: 'Base prompt' }), {
      customPrompt: 'Node override',
    });

    expect(resolved.value).toBe('Base prompt\n\nNode override');
    expect(resolved.source).toBe('workflow_node_custom_prompt');
    expect(resolved.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not substitute the generic reviewer prompt when no prompt is configured', () => {
    const resolved = resolveCustomAgentPrompt(makeAgent({ name: 'Reviewer', customPrompt: null }));

    expect(resolved.value).toBe('');
    expect(resolved.source).toBe('empty');
    expect(resolved.value).not.toContain(
      'You are an expert code reviewer. You review pull requests'
    );
  });

  it('replaces the agent base prompt when replaceAgentPrompt is true', () => {
    const resolved = resolveCustomAgentPrompt(makeAgent({ customPrompt: 'Agent base prompt' }), {
      customPrompt: 'Slot-only prompt',
      replaceAgentPrompt: true,
    });

    expect(resolved.value).toBe('Slot-only prompt');
    expect(resolved.value).not.toContain('Agent base prompt');
    expect(resolved.source).toBe('workflow_node_replaced_prompt');
    expect(resolved.hash).toBe(
      resolveCustomAgentPrompt(makeAgent({ customPrompt: null }), {
        customPrompt: 'Slot-only prompt',
        replaceAgentPrompt: true,
      }).hash
    );
    expect(resolved.hash).not.toBe(
      resolveCustomAgentPrompt(makeAgent({ customPrompt: 'Agent base prompt' }), {
        customPrompt: 'Slot-only prompt',
      }).hash
    );
  });

  it('returns an empty value when replaceAgentPrompt is true but the slot prompt is empty', () => {
    const resolved = resolveCustomAgentPrompt(makeAgent({ customPrompt: 'Agent base prompt' }), {
      customPrompt: '   ',
      replaceAgentPrompt: true,
    });

    expect(resolved.value).toBe('');
    expect(resolved.source).toBe('empty');
  });

  it('is byte-identical to append when replaceAgentPrompt is false or unset', () => {
    const agent = makeAgent({ customPrompt: 'Base prompt' });
    const append = resolveCustomAgentPrompt(agent, { customPrompt: 'Slot expansion' });
    const explicitFalse = resolveCustomAgentPrompt(agent, {
      customPrompt: 'Slot expansion',
      replaceAgentPrompt: false,
    });
    const unset = resolveCustomAgentPrompt(agent, { customPrompt: 'Slot expansion' });

    expect(explicitFalse).toEqual(append);
    expect(unset).toEqual(append);
    expect(append.source).toBe('workflow_node_custom_prompt');
  });
});

describe('buildCustomAgentTaskMessage', () => {
  it('includes factual task, runtime location, role, previous work, project context, and instructions', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        task: makeTask({
          title: 'Ship auth flow',
          description: 'Implement auth flow',
          priority: 'high',
        }),
        workflowRun: makeWorkflowRun({ title: 'Auth rollout', description: 'Production' }),
        workflow: makeWorkflow({ instructions: 'Use conventional commits.' }),
        space: makeSpace({
          backgroundContext: 'Monorepo project',
          instructions: 'Run tests before finishing.',
        }),
        workspacePath: '/workspaces/auth',
        previousTaskSummaries: ['Task 0: added login page'],
        nodeId: 'node-1',
        agentSlotName: 'Coder',
      })
    );

    expect(message).toContain('## Your Task');
    expect(message).toContain('Ship auth flow');
    expect(message).toContain('Implement auth flow');
    expect(message).toContain('**Priority:** high');

    expect(message).toContain('## Runtime Location');
    expect(message).toContain('- Worktree: /workspaces/auth');

    expect(message).toContain('## Your Role in This Workflow');
    expect(message).toContain('- Node: Plan');
    expect(message).toContain('- Peers: Code');

    expect(message).toContain('## Previous Work on This Goal');
    expect(message).toContain('- Task 0: added login page');

    expect(message).toContain('## Project Context');
    expect(message).toContain('Monorepo project');

    expect(message).toContain('## Standing Instructions');
    expect(message).toContain('Run tests before finishing.');
    expect(message).toContain('Use conventional commits.');
  });

  it('renders task description in the first 500 characters (action-first ordering)', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        task: makeTask({
          title: 'Ship auth flow',
          description: 'Implement passwordless auth end-to-end.',
        }),
        workflow: makeWorkflow(),
        workflowRun: makeWorkflowRun(),
        space: makeSpace({
          backgroundContext: 'A'.repeat(5000),
          instructions: 'B'.repeat(5000),
        }),
      })
    );

    const head = message.slice(0, 500);
    expect(head).toContain('Implement passwordless auth end-to-end.');
  });

  it('labels the Verification section implementer-facing in the delivered description', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        task: makeTask({
          description:
            'Implement the scoped-bash change.\n\n## Verification\n\n`./scripts/test-daemon.sh` and `bun run check`.',
        }),
      })
    );

    expect(message).toContain(
      '## Verification (for the implementer; the reviewer validates by reading, CI validates by running)'
    );
    expect(message).not.toMatch(/^## Verification$/m);
  });

  it('leaves descriptions without a Verification heading unchanged', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        task: makeTask({
          description: 'Plain description with no verification footer.',
        }),
      })
    );

    expect(message).toContain('Plain description with no verification footer.');
    expect(message).not.toContain('for the implementer; the reviewer validates by reading');
  });

  it('renders linked goal state when provided', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        goal: makeGoal(),
      })
    );

    expect(message).toContain('## Linked Goal');
    expect(message).toContain('Improve onboarding');
    expect(message).not.toContain('**Progress:**');
    expect(message).toContain('**Metrics:** {"activated":10}');
    expect(message).toContain('- Audit current flow');
    expect(message).toContain(
      'mark_complete goal_update with a concise summary, metrics, and next steps.'
    );
  });

  it('renders active scope lessons in task message', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        relevantScopeLessons: [
          makeLesson(),
          makeLesson({
            id: 'lesson-2',
            appliesTo: [],
            rule: 'Keep changes surgical',
            why: 'Smaller diffs review faster',
          }),
        ],
      })
    );

    expect(message).toContain('## Relevant Scope Lessons');
    expect(message).toContain('- Run focused review before broad refactor [review]');
    expect(message).toContain('  Why: Focused reviews caught regressions faster');
    expect(message).toContain('- Keep changes surgical');
    expect(message).toContain('  Why: Smaller diffs review faster');
  });

  it('scopes channels to the current node', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        workflow: makeWorkflow(),
        workflowRun: makeWorkflowRun(),
        nodeId: 'node-1',
        agentSlotName: 'Coder',
      })
    );

    expect(message).toContain('Channels from this node:');
    expect(message).toContain('Code (Plan → Code)');
    expect(message).not.toContain('Plan (Code → Plan');
  });

  it('does not contain node UUIDs', () => {
    const workflow = makeWorkflow();
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        workflow,
        workflowRun: makeWorkflowRun(),
        nodeId: 'node-1',
      })
    );

    for (const node of workflow.nodes) {
      expect(message).not.toContain(`id: \`${node.id}\``);
      expect(message).not.toContain(node.id);
    }
  });

  it('omits Your Role section when workflow or node are absent', () => {
    const messageNoWorkflow = buildCustomAgentTaskMessage(makeConfig());
    expect(messageNoWorkflow).not.toContain('## Your Role in This Workflow');

    const messageUnknownNode = buildCustomAgentTaskMessage(
      makeConfig({
        workflow: makeWorkflow(),
        workflowRun: makeWorkflowRun(),
        nodeId: 'does-not-exist',
      })
    );
    expect(messageUnknownNode).not.toContain('## Your Role in This Workflow');
  });

  it('cleanly omits missing sections (no empty headers)', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        space: makeSpace({ backgroundContext: '', instructions: '' }),
      })
    );

    expect(message).not.toContain('## Relevant Scope Lessons');
    expect(message).not.toContain('## Previous Work on This Goal');
    expect(message).not.toContain('## Project Context');
    expect(message).not.toContain('## Standing Instructions');
    expect(message).toContain('## Your Task');
  });

  it('omits channels/gates sub-lines when current node has none', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'solo', name: 'Solo', agents: [{ agentId: 'agent-1', name: 'Solo' }] }],
      startNodeId: 'solo',
      channels: [],
      gates: [],
    });

    const message = buildCustomAgentTaskMessage(
      makeConfig({
        workflow,
        workflowRun: makeWorkflowRun(),
        nodeId: 'solo',
        agentSlotName: 'Solo',
      })
    );

    expect(message).toContain('- Node: Solo');
    expect(message).not.toContain('- Peers:');
    expect(message).not.toContain('Channels from this node:');
    expect(message).not.toContain('Gates you can write:');
  });

  it('preserves dynamic task context sections without total caps', () => {
    const previousTaskSummaries = Array.from(
      { length: 20 },
      (_, i) => `Task ${i}: ${'x'.repeat(120)}`
    );
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        previousTaskSummaries,
        relevantMemories: Array.from({ length: 5 }, (_, i) => ({
          rank: i + 1,
          memory: {
            spaceId: 'space-1',
            key: `memory-${i}`,
            content: 'm'.repeat(400),
            tags: ['tag'],
            createdBySession: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            accessCount: 0,
            lastAccessedAt: null,
          },
        })),
        space: makeSpace({
          backgroundContext: 'Project context '.repeat(200),
          instructions: 'Mandatory instruction '.repeat(200),
        }),
        workflow: makeWorkflow({ instructions: 'Workflow instruction '.repeat(200) }),
      })
    );

    const previousBlock = message.slice(
      message.indexOf('## Previous Work on This Goal'),
      message.indexOf('## Core Memories')
    );
    for (const summary of previousTaskSummaries) expect(previousBlock).toContain(summary);
    expect(previousBlock).not.toContain('older summaries omitted');

    const memoryBlock = message.slice(
      message.indexOf('## Relevant Memories'),
      message.indexOf('## Project Context')
    );
    expect(memoryBlock).toContain('memory-0');
    expect(memoryBlock).toContain('memory-4');
    expect(memoryBlock).not.toContain('memories omitted');

    const projectBlock = message.slice(
      message.indexOf('## Project Context'),
      message.indexOf('## Standing Instructions')
    );
    expect(projectBlock).toContain('Project context '.repeat(200).trim());
    expect(projectBlock).not.toContain(
      '[truncated; ask the Space Agent for full context if needed]'
    );

    const standingBlock = message.slice(message.indexOf('## Standing Instructions'));
    expect(standingBlock).not.toContain(
      '[truncated; ask the Space Agent for full context if needed]'
    );
    expect(standingBlock).toContain('Mandatory instruction');
    expect(standingBlock).toContain('Workflow instruction');
  });

  it('truncates an oversized newest previous-work summary instead of dropping it', () => {
    const newestSummary = `Latest result: ${'z'.repeat(2_000)}`;
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        previousTaskSummaries: ['Older result', newestSummary],
      })
    );

    const previousStart = message.indexOf('## Previous Work on This Goal');
    const previousEnd = message.indexOf('## Project Context');
    const previousBlock = message.slice(
      previousStart,
      previousEnd === -1 ? undefined : previousEnd
    );
    expect(previousBlock).toContain('Latest result:');
    expect(previousBlock).toContain('…');
    expect(previousBlock).toContain('Older result');
    expect(previousBlock.length).toBeLessThan(2_200);
  });

  it('renders Standing Instructions last, after Project Context', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        workflow: makeWorkflow({ instructions: 'WF instructions.' }),
        workflowRun: makeWorkflowRun(),
        space: makeSpace({
          backgroundContext: 'Project context block',
          instructions: 'Space instructions.',
        }),
        nodeId: 'node-1',
      })
    );

    const contextIdx = message.indexOf('## Project Context');
    const standingIdx = message.indexOf('## Standing Instructions');
    expect(contextIdx).toBeGreaterThan(-1);
    expect(standingIdx).toBeGreaterThan(contextIdx);

    const standingBlock = message.slice(standingIdx);
    expect(standingBlock).toContain('Space instructions.');
    expect(standingBlock).toContain('WF instructions.');
  });

  it('does not inject hidden behavioral instructions', () => {
    const message = buildCustomAgentTaskMessage(makeConfig());

    expect(message).not.toContain('Begin working on this task.');
    expect(message).not.toContain('Push your changes to update this PR');
    expect(message).not.toContain('Focus on the current step first');
  });

  it('does not include ## Instructions section', () => {
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        customAgent: makeAgent({ customPrompt: 'Some instructions' }),
      })
    );

    expect(message).not.toContain('## Instructions\n');
  });

  it('handles workflow without channels or gates (backward compat)', () => {
    const barebonesWorkflow = makeWorkflow({ channels: undefined, gates: undefined });
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        workflow: barebonesWorkflow,
        workflowRun: makeWorkflowRun(),
        nodeId: 'node-1',
      })
    );

    expect(message).toContain('- Node: Plan');
    expect(message).not.toContain('Channels from this node:');
    expect(message).not.toContain('Gates you can write:');
  });

  it('injects exact Coding workflow send_message handoff into future task messages', () => {
    const codingNode = CODING_WORKFLOW.nodes.find((node) => node.name === 'Coding')!;
    const message = buildCustomAgentTaskMessage(
      makeConfig({
        workflow: CODING_WORKFLOW,
        workflowRun: makeWorkflowRun({ workflowId: CODING_WORKFLOW.id }),
        nodeId: codingNode.id,
        agentSlotName: 'coder',
      })
    );

    expect(message).toContain(
      'Review (Coding → Review): call `send_message(target="Review", message="<short summary>", data: { "pr_url": "<pr_url>" })`'
    );
    expect(message).toContain('`save_artifact` alone does not deliver this gated handoff');
  });

  it('injects exact handoff even when persisted workflow slot prompt is stale', () => {
    const workflow = structuredClone(CODING_WORKFLOW);
    const codingNode = workflow.nodes.find((node) => node.name === 'Coding')!;
    codingNode.agents[0].customPrompt = {
      value: 'Legacy wording: write code-pr-gate with field pr_url so Review can activate.',
    };

    const message = buildCustomAgentTaskMessage(
      makeConfig({
        workflow,
        workflowRun: makeWorkflowRun({ workflowId: workflow.id }),
        nodeId: codingNode.id,
        agentSlotName: 'coder',
      })
    );

    expect(message).toContain(
      'Review (Coding → Review): call `send_message(target="Review", message="<short summary>", data: { "pr_url": "<pr_url>" })`'
    );
    expect(message).toContain('`save_artifact` alone does not deliver this gated handoff');
  });
});

describe('createCustomAgentInit', () => {
  it('uses permissive SDK tool defaults when no tool profile is configured', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ customPrompt: 'Agent-visible prompt' }),
      })
    );

    expect(init.systemPrompt?.type).toBe('preset');
    expect(init.systemPrompt?.append).toBe('Agent-visible prompt');
    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toBeUndefined();
    expect(init.disallowedTools).toBeUndefined();
    expect(init.agent).toBeUndefined();
  });

  it('bounds Space worker delegation at one subagent generation', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ customPrompt: 'Delegate independent investigations.' }),
      })
    );

    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toBeUndefined();
    expect(init.disallowedTools).toBeUndefined();

    const child = init.agents?.['general-purpose'];
    expect(child).toBeDefined();
    expect(child?.tools).toEqual([
      'Read',
      'Bash',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'Skill',
      'ToolSearch',
    ]);
    expect(child?.disallowedTools).toEqual(['Agent', 'Task', 'TaskOutput', 'TaskStop']);
    expect(child?.prompt).toContain('must not spawn or delegate to other agents');
  });

  it('denies only omitted mutation tools for configured worker profiles', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ tools: ['Read', 'Bash', 'Grep', 'Glob'] }),
      })
    );

    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toBeUndefined();
    expect(init.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    expect(init.disallowedTools).not.toContain('Bash');
    expect(init.disallowedTools).not.toContain('WebFetch');
  });

  it('does not exclude MCP tools when applying a restricted profile', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ tools: ['Read'] }),
      })
    );

    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toBeUndefined();
    expect(init.agent).toBeUndefined();
    expect(init.disallowedTools).toEqual(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    expect(init.disallowedTools).not.toContain('mcp__node-agent__send_message');
    expect(init.disallowedTools).not.toContain('space-agent-tools__send_message');
  });

  it('expands slot customPrompt on top of agent customPrompt inside workflow runs', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ customPrompt: 'Base prompt' }),
        workflowRun: makeWorkflowRun(),
        slotOverrides: { customPrompt: 'Slot expansion' },
      })
    );

    expect(init.systemPrompt?.append).toBe('Base prompt\n\nSlot expansion');
  });

  it('replaces the agent customPrompt when replaceAgentPrompt is set on the slot', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ customPrompt: 'Agent base prompt' }),
        workflowRun: makeWorkflowRun(),
        slotOverrides: { customPrompt: 'Slot-only prompt', replaceAgentPrompt: true },
      })
    );

    expect(init.systemPrompt?.append).toBe('Slot-only prompt');
    expect(init.systemPrompt?.append).not.toContain('Agent base prompt');
    expect(init.systemPrompt?.preset).toBe('claude_code');
    expect(init.promptProvenance).toMatchObject({ source: 'workflow_node_replaced_prompt' });
  });

  it('runs a Reviewer slot without REVIEWER_SYSTEM_CONTRACT when the slot replaces the prompt', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({
          id: 'reviewer-agent-id',
          name: 'Reviewer',
          customPrompt: REVIEWER_SYSTEM_CONTRACT,
        }),
        workflowRun: makeWorkflowRun({ id: 'run-review' }),
        slotOverrides: {
          customPrompt: 'A stricter, focused reviewer prompt.',
          replaceAgentPrompt: true,
        },
      })
    );

    const prompt = init.systemPrompt?.append ?? '';
    expect(prompt).toBe('A stricter, focused reviewer prompt.');
    expect(prompt).not.toContain(REVIEWER_SYSTEM_CONTRACT);
    expect(init.promptProvenance?.source).toBe('workflow_node_replaced_prompt');
  });

  it('injects Coding workflow coder-owned handoff guidance into system prompt', () => {
    const codingNode = CODING_WORKFLOW.nodes.find((node) => node.name === 'Coding')!;
    const codingSlot = codingNode.agents[0];
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ id: codingSlot.agentId, name: 'Coder', customPrompt: null }),
        workflow: CODING_WORKFLOW,
        workflowRun: makeWorkflowRun({ workflowId: CODING_WORKFLOW.id }),
        nodeId: codingNode.id,
        agentSlotName: codingSlot.name,
        slotOverrides: {
          customPrompt: codingSlot.customPrompt?.value,
          resolutionContext: {
            agentId: codingSlot.agentId,
            agentName: codingSlot.name,
            workflowRunId: 'run-1',
            workflowId: CODING_WORKFLOW.id,
            nodeId: codingNode.id,
            nodeName: codingNode.name,
          },
        },
      })
    );

    const prompt = init.systemPrompt?.append ?? '';
    expect(prompt).toContain(
      'hand it off via the gated handoff described in Your Role in This Workflow'
    );
    expect(prompt).toContain('do not restate or assume it here');
    expect(prompt).toContain('do not merge or call task-completion tools');
    expect(prompt).toContain('merge the PR');
    expect(prompt).not.toContain('code-ready-gate');
  });

  it('uses the agent custom prompt when no slot override is defined', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ customPrompt: 'Agent base prompt' }),
        workflowRun: makeWorkflowRun(),
      })
    );

    expect(init.systemPrompt?.append).toBe('Agent base prompt');
  });

  it('records workflow-node prompt provenance for sentinel prompts', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({
          id: 'reviewer-agent-id',
          name: 'Reviewer',
          customPrompt: 'Base reviewer prompt',
        }),
        workflowRun: makeWorkflowRun({ id: 'run-review' }),
        workflow: makeWorkflow({ id: 'workflow-review' }),
        slotOverrides: {
          customPrompt: 'SENTINEL REVIEW NODE PROMPT',
          resolutionContext: {
            agentId: 'reviewer-agent-id',
            agentName: 'reviewer',
            workflowRunId: 'run-review',
            workflowId: 'workflow-review',
            nodeId: 'review-node',
            nodeName: 'Review',
          },
        },
      })
    );

    expect(init.systemPrompt?.append).toContain('SENTINEL REVIEW NODE PROMPT');
    expect(init.systemPrompt?.append).not.toContain(
      'You are an expert code reviewer. You review pull requests'
    );
    expect(init.promptProvenance).toMatchObject({
      source: 'workflow_node_custom_prompt',
      agentId: 'reviewer-agent-id',
      agentName: 'reviewer',
      workflowRunId: 'run-review',
      workflowId: 'workflow-review',
      nodeId: 'review-node',
      nodeName: 'Review',
    });
    expect(init.promptProvenance?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records agent prompt provenance for non-reviewer agents without node overrides', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({
          id: 'qa-agent-id',
          name: 'QA',
          customPrompt: 'SENTINEL QA PROMPT',
        }),
        workflowRun: makeWorkflowRun({ id: 'run-qa' }),
      })
    );

    expect(init.systemPrompt?.append).toBe('SENTINEL QA PROMPT');
    expect(init.promptProvenance).toMatchObject({
      source: 'space_agent_custom_prompt',
      agentId: 'qa-agent-id',
      agentName: 'QA',
    });
  });

  it('uses visible tool profiles as mutation-only deny policy', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({
          name: 'Restricted Agent',
          customPrompt: 'Visible prompt',
          tools: ['Read', 'Bash'],
        }),
      })
    );

    expect(init.agent).toBeUndefined();
    expect(init.systemPrompt?.preset).toBe('claude_code');
    expect(init.systemPrompt?.append).toBe('Visible prompt');
    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toBeUndefined();
    expect(init.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
    expect(init.disallowedTools).not.toContain('Read');
    expect(init.disallowedTools).not.toContain('Bash');
    expect(init.disallowedTools).not.toContain('Task');
    expect(init.disallowedTools).not.toContain('Skill');
  });

  it('leaves session-level tool restrictions unset when no tools are configured', () => {
    const init = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ tools: undefined }),
      })
    );

    expect(init.agent).toBeUndefined();
    expect(init.sdkToolsPreset).toBeUndefined();
    expect(init.allowedTools).toBeUndefined();
    expect(init.disallowedTools).toBeUndefined();
  });

  it('applies model precedence slot > agent > space > default', () => {
    const slot = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ model: 'agent-model' }),
        space: makeSpace({ defaultModel: 'space-model' }),
        slotOverrides: { model: 'slot-model' },
      })
    );
    expect(slot.model).toBe('slot-model');

    const agent = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ model: 'agent-model' }),
        space: makeSpace({ defaultModel: 'space-model' }),
      })
    );
    expect(agent.model).toBe('agent-model');

    const space = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ model: undefined }),
        space: makeSpace({ defaultModel: 'space-model' }),
      })
    );
    expect(space.model).toBe('space-model');

    const fallback = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ model: undefined }),
        space: makeSpace({ defaultModel: undefined }),
      })
    );
    expect(fallback.model).toBe('claude-sonnet-4-6');
  });

  it('uses saved agent provider only when the effective model is the agent model', () => {
    const agentModel = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ model: 'custom-model', provider: 'openrouter' }),
      })
    );

    expect(agentModel.model).toBe('custom-model');
    expect(agentModel.provider).toBe('openrouter');

    const slotOverride = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ model: 'custom-model', provider: 'openrouter' }),
        slotOverrides: { model: 'claude-sonnet-4-6' },
      })
    );

    expect(slotOverride.model).toBe('claude-sonnet-4-6');
    expect(slotOverride.provider).toBe('anthropic');
  });

  it('applies thinking level precedence slot > agent > app default', () => {
    const slot = createCustomAgentInit(
      makeConfig({
        customAgent: makeAgent({ thinkingLevel: 'think8k' }),
        slotOverrides: { thinkingLevel: 'think32k' },
      })
    );
    expect(slot.thinkingLevel).toBe('think32k');

    const agent = createCustomAgentInit(
      makeConfig({ customAgent: makeAgent({ thinkingLevel: 'think16k' }) })
    );
    expect(agent.thinkingLevel).toBe('think16k');

    const fallback = createCustomAgentInit(
      makeConfig({ customAgent: makeAgent({ thinkingLevel: undefined }) })
    );
    expect(fallback.thinkingLevel).toBeUndefined();
  });
});

describe('resolveAgentInit', () => {
  it('throws when assigned agent cannot be found', () => {
    const agentManager = { getById: mock(() => null) } as unknown as SpaceAgentManager;

    expect(() =>
      resolveAgentInit({
        task: makeTask(),
        space: makeSpace(),
        agentManager,
        agentId: 'missing-agent',
        sessionId: 'session-1',
        workspacePath: '/workspace/project',
      })
    ).toThrow('Agent not found: missing-agent');
  });

  it('resolves the assigned agent and builds the session init', () => {
    const agentManager = {
      getById: mock(() => makeAgent({ id: 'agent-2', customPrompt: 'Visible prompt' })),
    } as unknown as SpaceAgentManager;

    const init = resolveAgentInit({
      task: makeTask(),
      space: makeSpace(),
      agentManager,
      agentId: 'agent-2',
      sessionId: 'session-1',
      workspacePath: '/workspace/project',
    });

    expect(init.systemPrompt?.append).toBe('Visible prompt');
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

  it('trims whitespace from both base and expansion', () => {
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

  it('returns base when expansion is empty', () => {
    expect(expandPrompt('base', '')).toBe('base');
    expect(expandPrompt('base', '   ')).toBe('base');
  });

  it('returns base when expansion is undefined', () => {
    expect(expandPrompt('base prompt', undefined)).toBe('base prompt');
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

  it('returns empty string when base is null and expansion is absent', () => {
    expect(expandPrompt(null, undefined)).toBe('');
  });

  it('handles expansion with only whitespace base', () => {
    expect(expandPrompt('   ', 'value')).toBe('value');
  });

  it('with empty expansion and empty base returns empty', () => {
    expect(expandPrompt('', '')).toBe('');
  });

  it('preserves exact base trimmed when expansion is undefined', () => {
    expect(expandPrompt('  exact  spacing  ', undefined)).toBe('exact  spacing');
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
