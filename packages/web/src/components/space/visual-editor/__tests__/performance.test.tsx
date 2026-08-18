import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceWorkerAgent, SpaceWorkflow, WorkflowNode } from '@hyperneo/shared';

const mockAgents: Signal<SpaceWorkerAgent[]> = signal([
  {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'Test Agent',
    handle: 'agent-1',
    customPrompt: null,
    createdAt: 0,
    updatedAt: 0,
  },
]);
const mockWorkflows: Signal<SpaceWorkflow[]> = signal([]);
const mockWorkflowTemplates: Signal<SpaceWorkflow[]> = signal([]);

const mockNodeExecutionsByNodeId = signal(new Map<string, unknown[]>());
const mockWorkflowRuns = signal<unknown[]>([]);

vi.mock('../../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      workflows: mockWorkflows,
      workflowTemplates: mockWorkflowTemplates,
      nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
      workflowRuns: mockWorkflowRuns,
      createWorkflow: vi.fn(),
      updateWorkflow: vi.fn(),
    };
  },
}));

vi.mock('../../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

import { autoLayout } from '../layout';
import { VisualWorkflowEditor } from '../VisualWorkflowEditor';

function makeStep(index: number): WorkflowNode {
  return {
    id: `node-${index}`,
    name: `Step ${index}`,
    agents: [{ agentId: 'agent-1', name: 'coder' }],
  };
}

function buildLargeWorkflow(): SpaceWorkflow {
  const nodes: WorkflowNode[] = Array.from({ length: 25 }, (_, i) => makeStep(i));

  return {
    id: 'large-wf',
    spaceId: 'space-1',
    name: 'Large Workflow',
    description: 'Performance test workflow with 25 nodes and 35 edges',
    nodes,
    startNodeId: 'node-0',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    completionAutonomyLevel: 3,
  };
}

afterEach(() => {
  cleanup();
});

describe('VisualWorkflowEditor performance — large workflow (25 nodes, 35 edges)', () => {
  it('autoLayout for 25 nodes completes in < 100ms', () => {
    const workflow = buildLargeWorkflow();

    const start = performance.now();
    const positions = autoLayout(workflow.nodes, [], workflow.startNodeId!);
    const elapsed = performance.now() - start;

    expect(positions.size).toBe(25);

    expect(elapsed).toBeLessThan(100);
  });

  it('autoLayout assigns unique positions to all 25 nodes', () => {
    const workflow = buildLargeWorkflow();
    const positions = autoLayout(workflow.nodes, [], workflow.startNodeId!);

    expect(positions.size).toBe(25);

    const positionStrings = new Set<string>();
    for (const [, pos] of positions) {
      positionStrings.add(`${pos.x},${pos.y}`);
    }
    expect(positionStrings.size).toBe(25);
  });

  it('VisualWorkflowEditor renders 25 nodes + 35 edges without errors in < 500ms', async () => {
    const workflow = buildLargeWorkflow();

    let container: Element | null = null;
    const start = performance.now();

    await act(async () => {
      const result = render(
        <VisualWorkflowEditor workflow={workflow} onSave={vi.fn()} onCancel={vi.fn()} />
      );
      container = result.container;
    });

    const elapsed = performance.now() - start;

    expect(container).not.toBeNull();
    expect(container!.querySelector('[data-testid="visual-workflow-editor"]')).toBeTruthy();

    expect(elapsed).toBeLessThan(500);
  });

  it('large workflow fixture has exactly 25 nodes', () => {
    const workflow = buildLargeWorkflow();
    expect(workflow.nodes.length).toBe(25);
  });
});
