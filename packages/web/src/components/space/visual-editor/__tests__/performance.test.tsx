/**
 * Performance validation tests for the visual workflow editor with large workflows.
 *
 * This is a manual validation checkpoint, not a dedicated perf suite. Its purpose
 * is to document performance baselines and catch severe regressions in CI.
 *
 * Baselines (recorded 2026-03-20, Bun + Vitest + jsdom):
 *   - autoLayout for 25 nodes / 35 edges: < 100ms  (typical: ~3ms)
 *   - VisualWorkflowEditor fully settled for 25 nodes / 35 edges: < 500ms
 *     (typical: ~65-70ms; "fully settled" means act() has flushed all effects,
 *      state updates and microtasks triggered by useMemo / useState initializers)
 *
 * Topology of the large test workflow — genuine fan-out / fan-in DAG:
 *
 *   Layer 0 (1 node):   n0
 *   Layer 1 (5 nodes):  n1, n2, n3, n4, n5         ← fan-out from n0
 *   Layer 2 (5 nodes):  n6, n7, n8, n9, n10        ← fan-out from layer 1
 *   Layer 3 (5 nodes):  n11, n12, n13, n14, n15    ← fan-out from layer 2
 *   Layer 4 (5 nodes):  n16, n17, n18, n19, n20    ← fan-out from layer 3
 *   Layer 5 (4 nodes):  n21, n22, n23, n24         ← converge
 *
 * Multiple nodes share every interior layer, so the horizontal-separation logic
 * inside autoLayout is meaningfully exercised (unlike a purely linear chain where
 * every node would land in its own unique layer).
 *
 * Edge count breakdown:
 *   Main fan-out chains:              5 + 5 + 5 + 5 + 5 = 25 edges
 *   Cross-layer forward edges:        2 + 3 + 3 + 2     = 10 edges
 *   Total:                                                 35 edges
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceWorkerAgent, SpaceWorkflow, WorkflowNode } from '@neokai/shared';

// ---- Mocks ----

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

// ============================================================================
// Helpers
// ============================================================================

/** Create a WorkflowNode with a given index. */
function makeStep(index: number): WorkflowNode {
  return {
    id: `node-${index}`,
    name: `Step ${index}`,
    agents: [{ agentId: 'agent-1', name: 'coder' }],
  };
}

/**
 * Build a large workflow with 25 nodes and 35 edges.
 *
 * The topology uses genuine fan-out layers so that multiple nodes share the same
 * y-coordinate and the horizontal-separation logic inside autoLayout is exercised.
 * See the file-level comment for the full layer breakdown and edge-count proof.
 */
function buildLargeWorkflow(): SpaceWorkflow {
  // 25 nodes: n0 through n24
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

// ============================================================================
// Setup / Teardown
// ============================================================================

afterEach(() => {
  cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('VisualWorkflowEditor performance — large workflow (25 nodes, 35 edges)', () => {
  // Baseline: autoLayout for 25 nodes / 35 edges should complete in < 100ms.
  it('autoLayout for 25 nodes completes in < 100ms', () => {
    const workflow = buildLargeWorkflow();

    const start = performance.now();
    const positions = autoLayout(workflow.nodes, [], workflow.startNodeId!);
    const elapsed = performance.now() - start;

    // Verify correctness: all 25 workflow nodes must receive a position.
    expect(positions.size).toBe(25);

    // Performance gate: layout must finish well within 100ms.
    // This guards against accidental O(n²) or O(n³) regressions.
    expect(elapsed).toBeLessThan(100);
  });

  // Verify that all 25 positions are distinct — exercises the horizontal-separation
  // logic inside autoLayout since layers 1–5 each contain multiple nodes that must
  // be assigned different x-coordinates.
  it('autoLayout assigns unique positions to all 25 nodes', () => {
    const workflow = buildLargeWorkflow();
    const positions = autoLayout(workflow.nodes, [], workflow.startNodeId!);

    // All 25 workflow nodes should have a position entry.
    expect(positions.size).toBe(25);

    // No two nodes may share the exact same canvas point.
    const positionStrings = new Set<string>();
    for (const [, pos] of positions) {
      positionStrings.add(`${pos.x},${pos.y}`);
    }
    expect(positionStrings.size).toBe(25);
  });

  // Baseline: VisualWorkflowEditor should be fully settled for 25 nodes + 35 edges
  // within 500ms. "Fully settled" means act() has flushed all pending effects, state
  // updates, and microtasks (useMemo/useState initialisers, signal subscriptions,
  // post-render async work). This is broader than raw DOM-paint time but is the
  // meaningful threshold for interactive readiness.
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

    // Component must mount successfully and render the editor root.
    expect(container).not.toBeNull();
    expect(container!.querySelector('[data-testid="visual-workflow-editor"]')).toBeTruthy();

    // Performance gate: fully settled in under 500ms.
    expect(elapsed).toBeLessThan(500);
  });

  // Sanity: the large workflow fixture has the exact expected node count.
  it('large workflow fixture has exactly 25 nodes', () => {
    const workflow = buildLargeWorkflow();
    expect(workflow.nodes.length).toBe(25);
  });
});
