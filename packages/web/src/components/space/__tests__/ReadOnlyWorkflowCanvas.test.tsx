// @ts-nocheck
/**
 * Unit tests for ReadOnlyWorkflowCanvas
 *
 * Tests:
 * 1. Renders without crashing when workflow is found
 * 2. Renders empty/loading state when workflowId is not found in store
 * 3. Calls onNodeClick when a node is selected
 * 4. Passes readOnly=true to WorkflowCanvas so WorkflowNode gets draggable={false}
 * 5. Channel selection shows ChannelInfoPanel
 * 6. Channel info panel shows correct from/to node names
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceAgent, SpaceTask, SpaceWorkflow } from '@neokai/shared';

// ---- Signals for mocking ----

let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceAgent[]>([]);
let mockTasks = signal<SpaceTask[]>([]);
let mockNodeExecutionsByNodeId = signal(new Map());

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      workflows: mockWorkflows,
      agents: mockAgents,
      tasks: mockTasks,
      nodeExecutionsByNodeId: mockNodeExecutionsByNodeId,
      workflowVersions: signal(new Map()),
      fetchWorkflowDetail: vi.fn((id: string) =>
        Promise.resolve(mockWorkflows.value.find((w) => w.id === id) ?? null)
      ),
    };
  },
}));

const mockHub = {
  request: vi.fn().mockResolvedValue({ gateData: [] }),
  onEvent: vi.fn().mockReturnValue(() => {}),
};

vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: vi.fn(() => mockHub),
    getHub: vi.fn(() => Promise.resolve(mockHub)),
  },
}));

vi.mock('../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Capture readOnly prop passed to WorkflowCanvas by ReadOnlyWorkflowCanvas.
// The actual draggable={false} behavior is a consequence of readOnly=true being
// forwarded to WorkflowCanvas, which is tested in WorkflowCanvas's own tests.
const capturedReadOnly: { value?: boolean } = {};
let capturedOnChannelSelect: ((id: string | null) => void) | undefined;
let capturedOnGateClick: ((gateId: string, event: MouseEvent) => void) | undefined;

vi.mock('../visual-editor/WorkflowCanvas', () => ({
  WorkflowCanvas: ({
    nodes,
    onNodeSelect,
    onChannelSelect,
    onGateClick,
    readOnly,
  }: {
    nodes: Array<{ step: { localId: string; id?: string; name?: string } }>;
    readOnly?: boolean;
    onNodeSelect?: (id: string | null) => void;
    onChannelSelect?: (id: string | null) => void;
    onGateClick?: (gateId: string, event: MouseEvent) => void;
  }) => {
    capturedReadOnly.value = readOnly;
    capturedOnChannelSelect = onChannelSelect;
    capturedOnGateClick = onGateClick;
    return (
      <div data-testid="visual-workflow-canvas" data-node-count={nodes.length}>
        {nodes.map((n) => (
          <button
            key={n.step.localId}
            data-testid={`node-btn-${n.step.localId}`}
            data-step-id={n.step.id ?? n.step.localId}
            onClick={() => onNodeSelect?.(n.step.localId)}
          >
            {n.step.name ?? n.step.localId}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock('../GateArtifactsView', () => ({
  GateArtifactsView: ({ gateId }: { gateId: string }) => (
    <div data-testid="gate-artifacts-view" data-gate-id={gateId}>
      GateArtifactsView
    </div>
  ),
}));

vi.mock('../visual-editor/CanvasToolbar', () => ({
  CanvasToolbar: () => <div data-testid="canvas-toolbar" />,
}));

// Re-initialize signals after hoisting
mockWorkflows = signal<SpaceWorkflow[]>([]);
mockAgents = signal<SpaceAgent[]>([]);
mockTasks = signal<SpaceTask[]>([]);
mockNodeExecutionsByNodeId = signal(new Map());

import { ReadOnlyWorkflowCanvas } from '../ReadOnlyWorkflowCanvas';

// ---- Helpers ----

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'sp-1',
    name: 'Test Workflow',
    description: '',
    nodes: [
      { id: 'n1', name: 'Planner', agents: [] },
      { id: 'n2', name: 'Coder', agents: [] },
    ],
    startNodeId: 'n1',
    channels: [],
    gates: [],
    tags: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ---- Tests ----

describe('ReadOnlyWorkflowCanvas', () => {
  beforeEach(() => {
    mockWorkflows.value = [];
    mockAgents.value = [];
    mockTasks.value = [];
    mockNodeExecutionsByNodeId.value = new Map();
    capturedReadOnly.value = undefined;
    capturedOnChannelSelect = undefined;
    capturedOnGateClick = undefined;
    mockHub.request.mockClear();
    mockHub.request.mockResolvedValue({ gateData: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders without crashing when workflow is found', () => {
    mockWorkflows.value = [makeWorkflow()];
    const { getByTestId } = render(<ReadOnlyWorkflowCanvas workflowId="wf-1" />);
    expect(getByTestId('visual-workflow-canvas')).toBeTruthy();
  });

  it('renders with empty nodes when workflowId is not found in store', () => {
    mockWorkflows.value = [];
    const { getByTestId } = render(<ReadOnlyWorkflowCanvas workflowId="non-existent" />);
    const canvas = getByTestId('visual-workflow-canvas');
    expect(canvas).toBeTruthy();
    expect(canvas.getAttribute('data-node-count')).toBe('0');
  });

  it('calls onNodeClick when a node is selected, passing persisted ID and node name', async () => {
    mockWorkflows.value = [makeWorkflow()];
    const onNodeClick = vi.fn();
    const { getByTestId } = render(
      <ReadOnlyWorkflowCanvas workflowId="wf-1" onNodeClick={onNodeClick} />
    );
    // Find the button whose data-step-id is the persisted ID 'n1'
    const canvas = getByTestId('visual-workflow-canvas');
    await waitFor(() => {
      expect(canvas.querySelector('[data-step-id="n1"]')).not.toBeNull();
    });
    const nodeBtn = canvas.querySelector('[data-step-id="n1"]') as HTMLElement;
    nodeBtn.click();
    expect(onNodeClick).toHaveBeenCalledTimes(1);
    // Called with persisted node ID and node name
    expect(onNodeClick).toHaveBeenCalledWith('n1', 'Planner', []);
  });

  it('does not show ChannelInfoPanel before a channel is selected', () => {
    mockWorkflows.value = [makeWorkflow()];
    const { queryByTestId } = render(<ReadOnlyWorkflowCanvas workflowId="wf-1" />);
    expect(queryByTestId('channel-info-panel')).toBeNull();
  });

  it('does not crash when onChannelSelect fires with unknown or null channel id', () => {
    mockWorkflows.value = [makeWorkflow()];
    const { queryByTestId } = render(<ReadOnlyWorkflowCanvas workflowId="wf-1" />);
    // Fire with an ID that doesn't match any channel — panel should stay hidden
    capturedOnChannelSelect?.('no-such-channel');
    expect(queryByTestId('channel-info-panel')).toBeNull();
    // Fire with null — deselect, panel stays hidden
    capturedOnChannelSelect?.(null);
    expect(queryByTestId('channel-info-panel')).toBeNull();
  });

  it('passes readOnly=true to WorkflowCanvas so WorkflowNode gets draggable={false}', () => {
    mockWorkflows.value = [makeWorkflow()];
    render(<ReadOnlyWorkflowCanvas workflowId="wf-1" />);
    expect(capturedReadOnly.value).toBe(true);
  });

  it('clears gate popup when runId changes so stale gateId is not approvable', async () => {
    // Regression: swapping runId while the popup was open left a gateId
    // belonging to the previous run. Clicking Approve then POSTed an id
    // the server didn't know for the new run.
    mockWorkflows.value = [makeWorkflow()];
    const { findByTestId, queryByTestId, rerender } = render(
      <ReadOnlyWorkflowCanvas workflowId="wf-1" runId="r1" />
    );
    // Open the gate popup via the captured onGateClick.
    const fakeEvent = new MouseEvent('click', { clientX: 50, clientY: 60 });
    capturedOnGateClick?.('g-old', fakeEvent);
    await findByTestId('view-artifacts-btn');
    // Swap runId — popup should disappear.
    rerender(<ReadOnlyWorkflowCanvas workflowId="wf-1" runId="r2" />);
    await waitFor(() => expect(queryByTestId('view-artifacts-btn')).toBeNull());
  });

  it('artifacts overlay has dialog role + closes on Escape', async () => {
    mockWorkflows.value = [makeWorkflow()];
    const { findByTestId, getByTestId, queryByTestId } = render(
      <ReadOnlyWorkflowCanvas workflowId="wf-1" runId="r1" />
    );
    capturedOnGateClick?.('g1', new MouseEvent('click', { clientX: 0, clientY: 0 }));
    const viewBtn = await findByTestId('view-artifacts-btn');
    fireEvent.click(viewBtn);
    const overlay = await findByTestId('artifacts-panel-overlay');
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-label')).toBeTruthy();
    // Escape closes it.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(queryByTestId('artifacts-panel-overlay')).toBeNull());
    // Suppress unused warning for getByTestId.
    void getByTestId;
  });
});
