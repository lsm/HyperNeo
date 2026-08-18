// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { SpaceWorkerAgent, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';

let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceWorkerAgent[]>([]);
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
  request: vi.fn().mockResolvedValue({}),
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

const capturedReadOnly: { value?: boolean } = {};
let capturedOnChannelSelect: ((id: string | null) => void) | undefined;

vi.mock('../visual-editor/WorkflowCanvas', () => ({
  WorkflowCanvas: ({
    nodes,
    onNodeSelect,
    onChannelSelect,
    readOnly,
  }: {
    nodes: Array<{ step: { localId: string; id?: string; name?: string } }>;
    readOnly?: boolean;
    onNodeSelect?: (id: string | null) => void;
    onChannelSelect?: (id: string | null) => void;
  }) => {
    capturedReadOnly.value = readOnly;
    capturedOnChannelSelect = onChannelSelect;
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

vi.mock('../visual-editor/CanvasToolbar', () => ({
  CanvasToolbar: () => <div data-testid="canvas-toolbar" />,
}));

mockWorkflows = signal<SpaceWorkflow[]>([]);
mockAgents = signal<SpaceWorkerAgent[]>([]);
mockTasks = signal<SpaceTask[]>([]);
mockNodeExecutionsByNodeId = signal(new Map());

import { ReadOnlyWorkflowCanvas } from '../ReadOnlyWorkflowCanvas';

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

describe('ReadOnlyWorkflowCanvas', () => {
  beforeEach(() => {
    mockWorkflows.value = [];
    mockAgents.value = [];
    mockTasks.value = [];
    mockNodeExecutionsByNodeId.value = new Map();
    capturedReadOnly.value = undefined;
    capturedOnChannelSelect = undefined;
    mockHub.request.mockClear();
    mockHub.request.mockResolvedValue({});
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
    const canvas = getByTestId('visual-workflow-canvas');
    await waitFor(() => {
      expect(canvas.querySelector('[data-step-id="n1"]')).not.toBeNull();
    });
    const nodeBtn = canvas.querySelector('[data-step-id="n1"]') as HTMLElement;
    nodeBtn.click();
    expect(onNodeClick).toHaveBeenCalledTimes(1);
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
    capturedOnChannelSelect?.('no-such-channel');
    expect(queryByTestId('channel-info-panel')).toBeNull();
    capturedOnChannelSelect?.(null);
    expect(queryByTestId('channel-info-panel')).toBeNull();
  });

  it('passes readOnly=true to WorkflowCanvas so WorkflowNode gets draggable={false}', () => {
    mockWorkflows.value = [makeWorkflow()];
    render(<ReadOnlyWorkflowCanvas workflowId="wf-1" />);
    expect(capturedReadOnly.value).toBe(true);
  });
});
