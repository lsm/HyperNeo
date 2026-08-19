import { describe, test, expect } from 'bun:test';
import type {
  SpaceTaskStatus,
  SpaceWorkerAgent,
  SpaceWorkflow,
  WorkflowChannel,
  WorkflowNode,
} from '../src/types/space.ts';
import {
  resolveNodeAgents,
  validateChannels,
  findChannel,
  getChannelsFromNode,
  getChannelsToNode,
  getWorkflowRunExecutionStatusLabel,
  isWorkflowRunSucceeded,
  isWorkflowRunTerminal,
  isWorkflowRunWaiting,
  isRateOrUsageLimited,
  isWorkflowRecoveryTransition,
} from '../src/types/space-utils.ts';

function makeAgent(id: string, name: string): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name,
    handle: id,
    customPrompt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Test Node',
    agents: [],
    ...overrides,
  };
}

function makeChannel(overrides: Partial<WorkflowChannel> = {}): WorkflowChannel {
  return {
    id: 'ch-1',
    from: 'Code',
    to: 'Review',
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Test Workflow',
    nodes: [],
    startNodeId: '',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    completionAutonomyLevel: 3,
    ...overrides,
  };
}

const agentCoder = makeAgent('agent-coder-id', 'coder agent');
const agentReviewer = makeAgent('agent-reviewer-id', 'reviewer agent');
const agentSecurity = makeAgent('agent-security-id', 'security agent');
const allAgents: SpaceWorkerAgent[] = [agentCoder, agentReviewer, agentSecurity];

describe('workflow-run execution status helpers', () => {
  test('labels persisted workflow-run statuses as execution attempts', () => {
    expect(getWorkflowRunExecutionStatusLabel('pending')).toBe('Queued');
    expect(getWorkflowRunExecutionStatusLabel('in_progress')).toBe('Running');
    expect(getWorkflowRunExecutionStatusLabel('blocked')).toBe('Waiting');
    expect(getWorkflowRunExecutionStatusLabel('done')).toBe('Succeeded');
    expect(getWorkflowRunExecutionStatusLabel('cancelled')).toBe('Cancelled');
    expect(getWorkflowRunExecutionStatusLabel('failed')).toBe('Failed');
  });

  test('classifies succeeded, waiting, and terminal run execution states', () => {
    expect(isWorkflowRunSucceeded('done')).toBe(true);
    expect(isWorkflowRunSucceeded('in_progress')).toBe(false);

    expect(isWorkflowRunWaiting('blocked')).toBe(true);
    expect(isWorkflowRunWaiting('pending')).toBe(false);

    expect(isWorkflowRunTerminal('done')).toBe(true);
    expect(isWorkflowRunTerminal('blocked')).toBe(false);
    expect(isWorkflowRunTerminal('cancelled')).toBe(true);
    expect(isWorkflowRunTerminal('failed')).toBe(true);
    expect(isWorkflowRunTerminal('pending')).toBe(false);
    expect(isWorkflowRunTerminal('in_progress')).toBe(false);
  });
});

describe('resolveNodeAgents', () => {
  test('returns agents array when agents is set (non-empty)', () => {
    const node = makeNode({
      agents: [
        { agentId: 'agent-coder-id', name: 'coder' },
        { agentId: 'agent-reviewer-id', name: 'reviewer' },
      ],
    });
    const result = resolveNodeAgents(node);
    expect(result).toHaveLength(2);
    expect(result[0].agentId).toBe('agent-coder-id');
    expect(result[0].name).toBe('coder');
    expect(result[1].agentId).toBe('agent-reviewer-id');
    expect(result[1].name).toBe('reviewer');
  });

  test('throws when agents is an empty array', () => {
    const node = makeNode({ agents: [] });
    expect(() => resolveNodeAgents(node)).toThrow();
  });

  test('single-element agents array works correctly', () => {
    const node = makeNode({
      agents: [{ agentId: 'agent-coder-id', name: 'coder' }],
    });
    expect(resolveNodeAgents(node)).toEqual([{ agentId: 'agent-coder-id', name: 'coder' }]);
  });

  test('same agentId can appear multiple times with different names', () => {
    const node = makeNode({
      agents: [
        { agentId: 'agent-coder-id', name: 'strict-reviewer' },
        { agentId: 'agent-coder-id', name: 'quick-reviewer' },
      ],
    });
    const result = resolveNodeAgents(node);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('strict-reviewer');
    expect(result[1].name).toBe('quick-reviewer');
  });

  test('preserves customPrompt override on agent slots', () => {
    const node = makeNode({
      agents: [
        {
          agentId: 'agent-coder-id',
          name: 'fast-coder',
          customPrompt: { value: 'Be concise.' },
        },
      ],
    });
    const result = resolveNodeAgents(node);
    expect(result[0].customPrompt).toEqual({ value: 'Be concise.' });
  });
});

describe('validateChannels', () => {
  test('returns no errors for a valid workflow with unique node names', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'agent-reviewer-id', name: 'reviewer' }] },
      ],
      channels: [{ id: 'ch-1', from: 'Code', to: 'Review' }],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors).toEqual([]);
  });

  test('returns error when node names are not unique', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'Review', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] },
        {
          id: 'n2',
          name: 'Review',
          agents: [{ agentId: 'agent-reviewer-id', name: 'reviewer' }],
        },
      ],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('Review') && e.includes('unique'))).toBe(true);
  });

  test('returns error when channel.from references unknown node', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] }],
      channels: [{ id: 'ch-1', from: 'NonExistent', to: 'Code' }],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('NonExistent'))).toBe(true);
  });

  test('returns error when channel.to references unknown node', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] }],
      channels: [{ id: 'ch-1', from: 'Code', to: 'NonExistent' }],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('NonExistent'))).toBe(true);
  });

  test('returns error when channel id is missing', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'agent-reviewer-id', name: 'reviewer' }] },
      ],
      channels: [{ id: '', from: 'Code', to: 'Review' }],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('id'))).toBe(true);
  });

  test('wildcard from is allowed', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'agent-reviewer-id', name: 'reviewer' }] },
      ],
      channels: [{ id: 'ch-1', from: '*', to: 'Review' }],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors).toEqual([]);
  });

  test('fan-out to multiple nodes is valid', () => {
    const workflow = makeWorkflow({
      nodes: [
        { id: 'n1', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] },
        { id: 'n2', name: 'Review', agents: [{ agentId: 'agent-reviewer-id', name: 'reviewer' }] },
        { id: 'n3', name: 'QA', agents: [{ agentId: 'agent-security-id', name: 'qa' }] },
      ],
      channels: [{ id: 'ch-1', from: 'Code', to: ['Review', 'QA'] }],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors).toEqual([]);
  });

  test('returns error for agent not found in space agents', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Code', agents: [{ agentId: 'unknown-agent-id', name: 'coder' }] }],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors.some((e) => e.includes('unknown-agent-id'))).toBe(true);
  });

  test('empty channels returns no errors', () => {
    const workflow = makeWorkflow({
      nodes: [{ id: 'n1', name: 'Code', agents: [{ agentId: 'agent-coder-id', name: 'coder' }] }],
      channels: [],
    });
    const errors = validateChannels(workflow, allAgents);
    expect(errors).toEqual([]);
  });
});

describe('findChannel', () => {
  const channels: WorkflowChannel[] = [
    { id: 'ch-1', from: 'Code', to: 'Review' },
    { id: 'ch-2', from: 'Review', to: 'Code' },
    { id: 'ch-3', from: 'Review', to: 'QA' },
    { id: 'ch-4', from: 'Code', to: ['Review', 'QA'] },
  ];

  test('finds a simple from → to channel', () => {
    const found = findChannel(channels, 'Review', 'Code');
    expect(found?.id).toBe('ch-2');
  });

  test('returns undefined when no channel matches', () => {
    expect(findChannel(channels, 'QA', 'Code')).toBeUndefined();
  });

  test('matches fan-out channel when target is in array', () => {
    const found = findChannel(channels, 'Code', 'QA');
    expect(found?.id).toBe('ch-4');
  });
});

describe('getChannelsFromNode', () => {
  const channels: WorkflowChannel[] = [
    { id: 'ch-1', from: 'Code', to: 'Review' },
    { id: 'ch-2', from: 'Review', to: 'Code' },
    { id: 'ch-3', from: '*', to: 'QA' },
  ];

  test('returns channels where from matches node name', () => {
    const result = getChannelsFromNode(channels, 'Code');
    expect(result.map((c) => c.id)).toEqual(['ch-1', 'ch-3']);
  });

  test('returns empty when no channels from node', () => {
    expect(getChannelsFromNode(channels, 'QA')).toHaveLength(1);
  });
});

describe('getChannelsToNode', () => {
  const channels: WorkflowChannel[] = [
    { id: 'ch-1', from: 'Code', to: 'Review' },
    { id: 'ch-2', from: 'Review', to: 'Code' },
    { id: 'ch-3', from: 'Code', to: ['Review', 'QA'] },
  ];

  test('returns channels where to matches node name (string)', () => {
    const result = getChannelsToNode(channels, 'Code');
    expect(result.map((c) => c.id)).toEqual(['ch-2']);
  });

  test('returns channels where to matches node name (array)', () => {
    const result = getChannelsToNode(channels, 'Review');
    expect(result.map((c) => c.id)).toEqual(['ch-1', 'ch-3']);
  });
});

describe('isRateOrUsageLimited — single source of truth for paused-on-cap statuses', () => {
  const ALL_SPACE_TASK_STATUSES = [
    'draft',
    'open',
    'in_progress',
    'review',
    'approved',
    'done',
    'blocked',
    'cancelled',
    'archived',
    'rate_limited',
    'usage_limited',
    'stopped',
  ] as const satisfies readonly SpaceTaskStatus[];

  type _ExhaustiveSpaceTaskStatuses =
    SpaceTaskStatus extends (typeof ALL_SPACE_TASK_STATUSES)[number] ? true : never;
  const _assertExhaustive: _ExhaustiveSpaceTaskStatuses = true;

  test('returns true exactly for rate_limited and usage_limited', () => {
    const paused = ALL_SPACE_TASK_STATUSES.filter(isRateOrUsageLimited);
    expect([...paused].sort()).toEqual(['rate_limited', 'usage_limited']);
  });

  test('isWorkflowRecoveryTransition derives its paused arm from the predicate', () => {
    for (const status of ALL_SPACE_TASK_STATUSES) {
      expect(isWorkflowRecoveryTransition(status, 'in_progress')).toBe(
        isRateOrUsageLimited(status) ||
          status === 'done' ||
          status === 'blocked' ||
          status === 'cancelled' ||
          status === 'stopped'
      );
    }
  });
});

describe('isWorkflowRecoveryTransition', () => {
  test('blocked/cancelled/done → active is a recovery transition', () => {
    expect(isWorkflowRecoveryTransition('blocked', 'in_progress')).toBe(true);
    expect(isWorkflowRecoveryTransition('blocked', 'open')).toBe(true);
    expect(isWorkflowRecoveryTransition('cancelled', 'in_progress')).toBe(true);
    expect(isWorkflowRecoveryTransition('done', 'in_progress')).toBe(true);
  });

  test('stopped → in_progress is a recovery transition (parked run resume)', () => {
    expect(isWorkflowRecoveryTransition('stopped', 'in_progress')).toBe(true);
    expect(isWorkflowRecoveryTransition('stopped', 'open')).toBe(false);
    expect(isWorkflowRecoveryTransition('stopped', 'cancelled')).toBe(false);
  });

  test('rate/usage-limited → in_progress is a recovery transition (manual resume)', () => {
    expect(isWorkflowRecoveryTransition('rate_limited', 'in_progress')).toBe(true);
    expect(isWorkflowRecoveryTransition('usage_limited', 'in_progress')).toBe(true);
  });

  test('rate/usage-limited → open/cancelled is NOT a recovery transition (it is a stop)', () => {
    expect(isWorkflowRecoveryTransition('rate_limited', 'open')).toBe(false);
    expect(isWorkflowRecoveryTransition('usage_limited', 'cancelled')).toBe(false);
  });

  test('active → active is not a recovery transition', () => {
    expect(isWorkflowRecoveryTransition('in_progress', 'open')).toBe(false);
    expect(isWorkflowRecoveryTransition('open', 'in_progress')).toBe(false);
  });
});
