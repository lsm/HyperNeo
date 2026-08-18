import { describe, test, expect } from 'bun:test';
import type { SpaceWorkflow, WorkflowNode } from '../src/types/space.ts';
import { isWorkflowAutoClosingAtLevel } from '../src/space/workflow-autonomy.ts';

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-1',
    name: 'Node 1',
    agents: [{ agentId: 'agent-1', name: 'agent-1' }],
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Workflow 1',
    nodes: [makeNode()],
    startNodeId: 'node-1',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    completionAutonomyLevel: 3,
    ...overrides,
  };
}

describe('isWorkflowAutoClosingAtLevel', () => {
  test('auto-closes when space level >= workflow.completionAutonomyLevel', () => {
    const wf = makeWorkflow({ completionAutonomyLevel: 3 });
    expect(isWorkflowAutoClosingAtLevel(wf, 1)).toBe(false);
    expect(isWorkflowAutoClosingAtLevel(wf, 2)).toBe(false);
    expect(isWorkflowAutoClosingAtLevel(wf, 3)).toBe(true);
    expect(isWorkflowAutoClosingAtLevel(wf, 4)).toBe(true);
    expect(isWorkflowAutoClosingAtLevel(wf, 5)).toBe(true);
  });

  test('workflow with explicit completionAutonomyLevel=5 only auto-closes at 5', () => {
    const wf = makeWorkflow({ completionAutonomyLevel: 5 });
    expect(isWorkflowAutoClosingAtLevel(wf, 4)).toBe(false);
    expect(isWorkflowAutoClosingAtLevel(wf, 5)).toBe(true);
  });

  test('workflow with explicit completionAutonomyLevel=1 auto-closes at every level', () => {
    const wf = makeWorkflow({ completionAutonomyLevel: 1 });
    expect(isWorkflowAutoClosingAtLevel(wf, 1)).toBe(true);
    expect(isWorkflowAutoClosingAtLevel(wf, 2)).toBe(true);
    expect(isWorkflowAutoClosingAtLevel(wf, 5)).toBe(true);
  });

  test('missing completionAutonomyLevel defaults to 5 (max gating)', () => {
    const wf = {
      ...makeWorkflow(),
      completionAutonomyLevel: undefined,
    } as unknown as SpaceWorkflow;
    expect(isWorkflowAutoClosingAtLevel(wf, 1)).toBe(false);
    expect(isWorkflowAutoClosingAtLevel(wf, 4)).toBe(false);
    expect(isWorkflowAutoClosingAtLevel(wf, 5)).toBe(true);
  });
});
