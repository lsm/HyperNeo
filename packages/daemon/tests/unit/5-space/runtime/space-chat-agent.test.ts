/**
 * Unit tests for buildSpaceChatSystemPrompt()
 *
 * Verifies:
 * - Prompt includes available workflow names and tags; descriptions are lazy-loaded
 * - Prompt includes available agent names and roles
 * - Task-first guidance text is present
 * - Operator-supplied background and instructions are included
 * - Empty workflows/agents handled gracefully
 * - Event handling section always included with all four event kinds
 * - Autonomy level section reflects configured level
 * - Escalation section always included
 * - Coordination tools section always included
 */

import { describe, test, expect } from 'bun:test';
import {
  buildSpaceChatSystemPrompt,
  type SpaceChatAgentContext,
  type WorkflowSummary,
  type AgentSummary,
} from '../../../../src/lib/space/agents/space-chat-agent';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkflow(overrides?: Partial<WorkflowSummary>): WorkflowSummary {
  return {
    id: 'wf-1',
    name: 'Coding Workflow',
    description: 'Plan, code, and review',
    tags: ['coding', 'review'],
    nodeCount: 3,
    ...overrides,
  };
}

function makeAgent(overrides?: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'agent-1',
    name: 'Coder',
    description: 'Implementation specialist',
    ...overrides,
  };
}

function makeContext(overrides?: Partial<SpaceChatAgentContext>): SpaceChatAgentContext {
  return {
    workflows: [makeWorkflow()],
    agents: [makeAgent()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic structure
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — basic structure', () => {
  test('returns non-empty string', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('identifies agent as Space Agent coordinator', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('Space Agent');
  });

  test('no context produces minimal prompt without errors', () => {
    expect(() => buildSpaceChatSystemPrompt()).not.toThrow();
    expect(() => buildSpaceChatSystemPrompt({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Workflow information
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — workflow information', () => {
  test('includes workflow name', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('Coding Workflow');
  });

  test('omits workflow description so selection details stay lazy-loaded', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).not.toContain('Plan, code, and review');
    expect(prompt).toContain('get_workflow_detail');
  });

  test('includes workflow tags', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('coding');
    expect(prompt).toContain('review');
  });

  test('includes workflow id', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('wf-1');
  });

  test('includes step count', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('3 node');
  });

  test('includes multiple workflows', () => {
    const ctx = makeContext({
      workflows: [
        makeWorkflow({ id: 'wf-1', name: 'Alpha Workflow' }),
        makeWorkflow({ id: 'wf-2', name: 'Beta Workflow' }),
      ],
    });
    const prompt = buildSpaceChatSystemPrompt(ctx);
    expect(prompt).toContain('Alpha Workflow');
    expect(prompt).toContain('Beta Workflow');
  });

  test('handles workflow with no description', () => {
    const ctx = makeContext({
      workflows: [makeWorkflow({ description: undefined })],
    });
    const prompt = buildSpaceChatSystemPrompt(ctx);
    expect(prompt).toContain('Coding Workflow');
  });

  test('handles workflow with no tags', () => {
    const ctx = makeContext({
      workflows: [makeWorkflow({ tags: [] })],
    });
    const prompt = buildSpaceChatSystemPrompt(ctx);
    expect(prompt).toContain('Coding Workflow');
  });

  test('shows message when no workflows configured', () => {
    const prompt = buildSpaceChatSystemPrompt({ workflows: [] });
    expect(prompt).toContain('No workflows are currently configured');
  });

  test('shows message when workflows is undefined', () => {
    const prompt = buildSpaceChatSystemPrompt({});
    expect(prompt).toContain('No workflows are currently configured');
  });
});

// ---------------------------------------------------------------------------
// Agent information
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — agent information', () => {
  test('includes agent name', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('Coder');
  });

  test('includes agent description', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('Implementation specialist');
  });

  test('includes multiple agents', () => {
    const ctx = makeContext({
      agents: [makeAgent({ name: 'Coder' }), makeAgent({ id: 'agent-2', name: 'Reviewer' })],
    });
    const prompt = buildSpaceChatSystemPrompt(ctx);
    expect(prompt).toContain('Coder');
    expect(prompt).toContain('Reviewer');
  });

  test('handles agent with no description', () => {
    const ctx = makeContext({
      agents: [makeAgent({ description: undefined })],
    });
    const prompt = buildSpaceChatSystemPrompt(ctx);
    expect(prompt).toContain('Coder');
  });
});

// ---------------------------------------------------------------------------
// Workflow vs task guidance
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — workflow vs task guidance', () => {
  test('does not mention start_workflow_run (tool is not exposed to Space Agent)', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).not.toContain('start_workflow_run');
  });

  test('includes create_standalone_task guidance', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('create_standalone_task');
  });

  test('mentions suggest_workflow discovery tool', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('suggest_workflow');
  });

  test('mentions get_workflow_detail tool', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('get_workflow_detail');
  });

  test('warns not to silently continue when Space MCP tools are missing', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('must be available every turn');
    expect(prompt).toContain('compaction');
    expect(prompt).toContain('space-coordination');
  });

  test('includes guidance not to create tasks immediately', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('Do not create tasks from vague goals');
  });

  test('workflow selection details are lazy-loaded through detail tools', () => {
    const prompt = buildSpaceChatSystemPrompt(makeContext());
    expect(prompt).toContain('get_workflow_detail');
    expect(prompt).not.toMatch(/stacked PR/i);
    expect(prompt).not.toContain('NOT a coding workflow');
  });
});

// ---------------------------------------------------------------------------
// Operator-supplied context
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — operator context', () => {
  test('includes background context when provided', () => {
    const prompt = buildSpaceChatSystemPrompt({
      background: 'This is a payments platform.',
    });
    expect(prompt).toContain('This is a payments platform.');
  });

  test('includes instructions when provided', () => {
    const prompt = buildSpaceChatSystemPrompt({
      instructions: 'Always open PRs against the dev branch.',
    });
    expect(prompt).toContain('Always open PRs against the dev branch.');
  });

  test('omits background section when not provided', () => {
    const prompt = buildSpaceChatSystemPrompt({});
    expect(prompt).not.toContain('Space Background');
  });

  test('omits instructions section when not provided', () => {
    const prompt = buildSpaceChatSystemPrompt({});
    expect(prompt).not.toContain('Space Instructions');
  });
});

// ---------------------------------------------------------------------------
// Event handling section
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — event handling', () => {
  test('includes Event Handling section header', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('Event Handling');
  });

  test('includes [TASK_EVENT] prefix description', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('[TASK_EVENT]');
  });

  test('includes task_blocked event kind', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('task_blocked');
  });

  test('includes workflow_run_needs_attention event kind', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('workflow_run_needs_attention');
  });

  test('includes task_timeout event kind', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('task_timeout');
  });

  test('does not include routine workflow_run_completed event kind', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).not.toContain('workflow_run_completed');
  });

  test('event handling section present regardless of autonomy level', () => {
    const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    const empty = buildSpaceChatSystemPrompt({});
    for (const prompt of [supervised, semi, empty]) {
      expect(prompt).toContain('task_blocked');
      expect(prompt).not.toContain('workflow_run_completed');
    }
  });
});

// ---------------------------------------------------------------------------
// Autonomy level section
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — autonomy level', () => {
  test('includes Autonomy Level section header', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('Autonomy Level');
  });

  test('defaults to level 1 (supervised) when autonomyLevel is not set', () => {
    const prompt = buildSpaceChatSystemPrompt({});
    expect(prompt).toContain('autonomy level **1**');
    expect(prompt).toContain('wait');
  });

  test('level 1 includes notify-human instruction', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).toContain('wait');
  });

  test('level 1 includes wait for approval instruction', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).toContain('wait');
  });

  test('level 1 forbids autonomous retry/reassign/cancel', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    expect(prompt).toContain('Do not retry');
  });

  test('level 2 gets supervised prompt (runtime auto-completes but agent defers decisions)', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 2 });
    expect(prompt).toContain('autonomy level **2**');
    // Level 2 is below the >= 3 threshold for autonomous corrective actions
    expect(prompt).toContain('wait');
    expect(prompt).toContain('Do not retry');
    expect(prompt).not.toContain('Retry a failed task once');
  });

  test('level 3 shows the configured level', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('autonomy level **3**');
  });

  test('level 3 allows autonomous retry', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('retry a failed task once');
  });

  test('level 3 allows reassign', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('reassign');
  });

  test('level 3 says escalate after one failed retry', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('one failed retry');
  });

  test('level 3 still enforces human-gated workflow steps', () => {
    const prompt = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(prompt).toContain('Never bypass gates');
  });

  test('level 1 and level 3 produce different autonomy instructions', () => {
    const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    expect(supervised).not.toEqual(semi);
    expect(supervised).toContain('wait');
    expect(semi).toContain('retry a failed task once');
  });
});

// ---------------------------------------------------------------------------
// Escalation section
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — escalation', () => {
  test('includes Escalation section header', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('Escalation');
  });

  test('includes "What happened" escalation step', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('what happened');
  });

  test('includes "What was considered" escalation step', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('options considered');
  });

  test('includes "What is recommended" escalation step', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('recommendation');
  });

  test('includes "Clear question" escalation step', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('direct question');
  });

  test('escalation section present regardless of autonomy level', () => {
    const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    for (const prompt of [supervised, semi]) {
      expect(prompt).toContain('Escalation');
      expect(prompt).toContain('what happened');
    }
  });
});

// ---------------------------------------------------------------------------
// Clarification guidance (M5.3)
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — clarification guidance', () => {
  test('includes instruction to ask for clarification on ambiguous requests', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('Ask clarifying');
  });

  test('includes examples of vague requests that require clarification', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('vague goals');
  });

  test('instructs not to start work until the request is specific enough', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('unclear');
  });

  test('mentions unclear scope or success criteria as a reason to ask', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('success criteria');
  });

  test('mentions multiple interpretations as a reason to ask', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('ambiguous');
  });

  test('includes examples of clear requests ready to act on', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('Create real work');
  });

  test('guides clear coding requests to task-first workflow orchestration', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('runtime attaches and starts workflows');
  });

  test('clarification guidance present regardless of autonomy level', () => {
    const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    for (const prompt of [supervised, semi]) {
      expect(prompt).toContain('Ask clarifying');
      expect(prompt).toContain('unclear');
    }
  });
});

// ---------------------------------------------------------------------------
// Coordination tools section
// ---------------------------------------------------------------------------

describe('buildSpaceChatSystemPrompt — coordination tools', () => {
  test('includes Coordination Invariants section header', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('Coordination Invariants');
  });

  test('documents create_standalone_task tool', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('create_standalone_task');
  });

  test('documents get_task_detail tool', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('get_task_detail');
  });

  test('does not expand retry_task tool schema text', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('retry');
    expect(prompt).not.toContain('retry_task');
  });

  test('does not expand cancel_task tool schema text', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('cancel');
    expect(prompt).not.toContain('cancel_task');
  });

  test('does not expand reassign_task tool schema text', () => {
    const prompt = buildSpaceChatSystemPrompt();
    expect(prompt).toContain('reassign');
    expect(prompt).not.toContain('reassign_task');
  });

  test('coordination tools section present for all autonomy levels', () => {
    const supervised = buildSpaceChatSystemPrompt({ autonomyLevel: 1 });
    const semi = buildSpaceChatSystemPrompt({ autonomyLevel: 3 });
    for (const prompt of [supervised, semi]) {
      expect(prompt).toContain('get_task_detail');
      expect(prompt).toContain('retry');
    }
  });
});
