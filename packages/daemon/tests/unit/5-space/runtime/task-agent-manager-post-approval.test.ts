import { describe, expect, it } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { resolvePostApprovalTargetAgentName } from '../../../../src/lib/space/runtime/task-agent-manager';
import { POST_APPROVAL_TASK_AGENT_TARGET } from '../../../../src/lib/space/workflows/post-approval-validator';

function stubWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Test WF',
    description: '',
    version: 1,
    completionAutonomyLevel: 3,
    startNodeId: 'n1',
    endNodeId: 'n1',
    nodes: [],
    channels: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as SpaceWorkflow;
}

describe('resolvePostApprovalTargetAgentName', () => {
  it('returns the node-level postApproval targetAgent', () => {
    const wf = stubWorkflow({
      nodes: [
        { id: 'n1', name: 'Coding', agents: [], postApproval: { targetAgent: 'merger' } } as never,
      ],
    });
    expect(resolvePostApprovalTargetAgentName(wf)).toBe('merger');
  });

  it('returns the first valid (non-task-agent) target across nodes', () => {
    const wf = stubWorkflow({
      nodes: [
        { id: 'n1', name: 'Coding', agents: [], postApproval: { targetAgent: 'merger' } } as never,
        {
          id: 'n2',
          name: 'Deploy',
          agents: [],
          postApproval: { targetAgent: 'deployer' },
        } as never,
      ],
    });
    expect(resolvePostApprovalTargetAgentName(wf)).toBe('merger');
  });

  it('falls back to the legacy workflow-level postApproval route', () => {
    const wf = stubWorkflow({ postApproval: { targetAgent: 'merger' } } as never);
    expect(resolvePostApprovalTargetAgentName(wf)).toBe('merger');
  });

  it('skips the legacy task-agent executor target and falls through', () => {
    const wf = stubWorkflow({
      nodes: [
        {
          id: 'n1',
          name: 'Coding',
          agents: [],
          postApproval: { targetAgent: POST_APPROVAL_TASK_AGENT_TARGET },
        } as never,
      ],
      postApproval: { targetAgent: 'merger' },
    } as never);
    expect(resolvePostApprovalTargetAgentName(wf)).toBe('merger');
  });

  it('returns undefined when the only route targets the task-agent executor', () => {
    const wf = stubWorkflow({
      postApproval: { targetAgent: POST_APPROVAL_TASK_AGENT_TARGET },
    } as never);
    expect(resolvePostApprovalTargetAgentName(wf)).toBeUndefined();
  });

  it('returns undefined when no postApproval route is configured', () => {
    expect(resolvePostApprovalTargetAgentName(stubWorkflow())).toBeUndefined();
  });

  it('returns undefined for a null/missing workflow', () => {
    expect(resolvePostApprovalTargetAgentName(null)).toBeUndefined();
    expect(resolvePostApprovalTargetAgentName(undefined)).toBeUndefined();
  });
});
