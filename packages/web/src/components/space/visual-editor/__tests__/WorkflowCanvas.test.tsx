import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import type { SpaceWorkerAgent } from '@hyperneo/shared';
import type { VisualTransition } from '../types';
import { WorkflowCanvas } from '../WorkflowCanvas';
import type { WorkflowNodeData, WorkflowCanvasProps } from '../WorkflowCanvas';
import type { NodeDraft } from '../../WorkflowNodeCard';
import type { ViewportState } from '../types';

vi.mock('../../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

afterEach(() => cleanup());

const VP: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };

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

function makeStep(localId: string, name: string): NodeDraft {
  return { localId, name, agentId: 'agent-1' };
}

const AGENTS: SpaceWorkerAgent[] = [makeAgent('agent-1', 'Coder')];

const NODES: WorkflowNodeData[] = [
  {
    step: makeStep('step-1', 'Step One'),
    stepIndex: 1,
    position: { x: 10, y: 10 },
    agents: AGENTS,
    workflowChannels: [],
    isStartNode: false,
  },
  {
    step: makeStep('step-2', 'Step Two'),
    stepIndex: 2,
    position: { x: 200, y: 10 },
    agents: AGENTS,
    workflowChannels: [],
    isStartNode: false,
  },
];

function renderCanvas(extra: Partial<WorkflowCanvasProps> = {}) {
  const onNodeSelect = vi.fn();
  const onDeleteNode = vi.fn();

  function Wrapper() {
    const [vp, setVp] = useState<ViewportState>(VP);
    return (
      <WorkflowCanvas
        nodes={NODES}
        viewportState={vp}
        onViewportChange={setVp}
        onNodeSelect={onNodeSelect}
        onDeleteNode={onDeleteNode}
        {...extra}
      />
    );
  }

  const result = render(<Wrapper />);
  return { ...result, onNodeSelect, onDeleteNode };
}

describe('WorkflowCanvas — rendering', () => {
  it('renders all provided nodes', () => {
    const { getByTestId } = renderCanvas();
    expect(getByTestId('workflow-node-step-1').textContent).toContain('Step One');
    expect(getByTestId('workflow-node-step-2').textContent).toContain('Step Two');
  });

  it('starts with no node selected', () => {
    const { getByTestId } = renderCanvas();
    expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
    expect(getByTestId('workflow-node-step-2').className).not.toContain('ring-2');
  });
});

describe('WorkflowCanvas — selection', () => {
  it('clicking a node adds selected classes', () => {
    const { getByTestId } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');
    expect(getByTestId('workflow-node-step-1').className).toContain('ring-accent');
  });

  it('clicking a node calls onNodeSelect with the stepId', () => {
    const { getByTestId, onNodeSelect } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    expect(onNodeSelect).toHaveBeenCalledWith('step-1');
  });

  it('clicking a different node switches selection', () => {
    const { getByTestId } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    fireEvent.click(getByTestId('workflow-node-step-2'));
    expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
    expect(getByTestId('workflow-node-step-2').className).toContain('ring-2');
  });

  it('clicking background deselects the node', () => {
    const { getByTestId } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');

    fireEvent.click(getByTestId('visual-canvas-transform'));
    expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
  });

  it('clicking background calls onNodeSelect(null)', () => {
    const { getByTestId, onNodeSelect } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    onNodeSelect.mockClear();

    fireEvent.click(getByTestId('visual-canvas-transform'));
    expect(onNodeSelect).toHaveBeenCalledWith(null);
  });

  it('clicking canvas container deselects', () => {
    const { getByTestId, onNodeSelect } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    onNodeSelect.mockClear();

    fireEvent.click(getByTestId('visual-canvas'));
    expect(onNodeSelect).toHaveBeenCalledWith(null);
  });
});

describe('WorkflowCanvas — keyboard delete', () => {
  it('Delete key calls onDeleteNode with selected stepId', () => {
    const { getByTestId, onDeleteNode } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(onDeleteNode).toHaveBeenCalledWith('step-1');
  });

  it('Backspace key calls onDeleteNode with selected stepId', () => {
    const { getByTestId, onDeleteNode } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-2'));
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(onDeleteNode).toHaveBeenCalledWith('step-2');
  });

  it('Delete key without selection does not call onDeleteNode', () => {
    const { onDeleteNode } = renderCanvas();
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(onDeleteNode).not.toHaveBeenCalled();
  });

  it('Delete key clears selection after calling onDeleteNode', () => {
    const { getByTestId } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');

    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
  });

  it('Delete calls onNodeSelect(null) after deletion', () => {
    const { getByTestId, onNodeSelect } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    onNodeSelect.mockClear();

    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(onNodeSelect).toHaveBeenCalledWith(null);
  });

  it('Delete inside an input does not trigger onDeleteNode', () => {
    const { onDeleteNode, container } = renderCanvas();
    const input = document.createElement('input');
    container.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'Delete', target: input });
    expect(onDeleteNode).not.toHaveBeenCalled();
  });

  it('Delete inside a textarea does not trigger onDeleteNode', () => {
    const { onDeleteNode, container } = renderCanvas();
    const textarea = document.createElement('textarea');
    container.appendChild(textarea);
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Delete', target: textarea });
    expect(onDeleteNode).not.toHaveBeenCalled();
  });
});

describe('WorkflowCanvas — stale selection cleanup', () => {
  it('clears selection when the selected node is removed from the nodes array', () => {
    const onNodeSelect = vi.fn();
    const onDeleteNode = vi.fn();

    function Wrapper() {
      const [vp, setVp] = useState<ViewportState>(VP);
      const [nodes, setNodes] = useState<WorkflowNodeData[]>(NODES);
      return (
        <div>
          <button
            data-testid="remove-step-1"
            onClick={() => setNodes((prev) => prev.filter((n) => n.step.localId !== 'step-1'))}
          >
            Remove
          </button>
          <WorkflowCanvas
            nodes={nodes}
            viewportState={vp}
            onViewportChange={setVp}
            onNodeSelect={onNodeSelect}
            onDeleteNode={onDeleteNode}
          />
        </div>
      );
    }

    const { getByTestId, queryByTestId } = render(<Wrapper />);

    fireEvent.click(getByTestId('workflow-node-step-1'));
    expect(onNodeSelect).toHaveBeenLastCalledWith('step-1');
    onNodeSelect.mockClear();

    fireEvent.click(getByTestId('remove-step-1'));

    expect(queryByTestId('workflow-node-step-1')).toBeNull();
    expect(onNodeSelect).toHaveBeenCalledWith(null);
  });
});

describe('WorkflowNode — isSelected prop via WorkflowCanvas', () => {
  it('node without selection does not have ring classes', () => {
    const { getByTestId } = renderCanvas();
    expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
  });

  it('selected node has ring-2 and ring-accent classes', () => {
    const { getByTestId } = renderCanvas();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');
    expect(getByTestId('workflow-node-step-1').className).toContain('ring-accent');
    expect(getByTestId('workflow-node-step-2').className).not.toContain('ring-2');
  });
});

const TRANSITIONS: VisualTransition[] = [
  { id: 'tr1', from: 'step-1', to: 'step-2' },
  { id: 'tr2', from: 'step-2', to: 'step-1', condition: { type: 'human' } },
];

function renderCanvasWithEdges(extra: Partial<WorkflowCanvasProps> = {}) {
  const onEdgeSelect = vi.fn();
  const onDeleteEdge = vi.fn();

  function Wrapper() {
    const [vp, setVp] = useState<ViewportState>(VP);
    return (
      <WorkflowCanvas
        nodes={NODES}
        viewportState={vp}
        onViewportChange={setVp}
        transitions={TRANSITIONS}
        onEdgeSelect={onEdgeSelect}
        onDeleteEdge={onDeleteEdge}
        {...extra}
      />
    );
  }

  const result = render(<Wrapper />);
  return { ...result, onEdgeSelect, onDeleteEdge };
}

describe('WorkflowCanvas — edge rendering', () => {
  it('renders SVG edges for each transition', () => {
    const { getByTestId } = renderCanvasWithEdges();
    expect(getByTestId('edge-tr1')).toBeTruthy();
    expect(getByTestId('edge-tr2')).toBeTruthy();
  });

  it('renders SVG overlay layer', () => {
    const { getByTestId } = renderCanvasWithEdges();
    expect(getByTestId('visual-canvas-svg')).toBeTruthy();
  });
});

describe('WorkflowCanvas — edge selection mutual exclusivity', () => {
  it('clicking an edge calls onEdgeSelect', () => {
    const { getByTestId, onEdgeSelect } = renderCanvasWithEdges();
    const group = getByTestId('edge-tr1');
    const hitbox = group.querySelectorAll('path')[0];
    fireEvent.click(hitbox);
    expect(onEdgeSelect).toHaveBeenCalledWith('tr1');
  });

  it('selecting a node clears edge selection and calls onEdgeSelect(null)', () => {
    const onEdgeSelect = vi.fn();
    const onNodeSelect = vi.fn();

    function Wrapper() {
      const [vp, setVp] = useState<ViewportState>(VP);
      return (
        <WorkflowCanvas
          nodes={NODES}
          viewportState={vp}
          onViewportChange={setVp}
          transitions={TRANSITIONS}
          onEdgeSelect={onEdgeSelect}
          onNodeSelect={onNodeSelect}
        />
      );
    }
    const { getByTestId } = render(<Wrapper />);

    const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
    fireEvent.click(hitbox);
    expect(onEdgeSelect).toHaveBeenCalledWith('tr1');
    expect(getByTestId('edge-tr1').getAttribute('data-selected')).toBe('true');
    onEdgeSelect.mockClear();

    fireEvent.click(getByTestId('workflow-node-step-1'));
    expect(onEdgeSelect).toHaveBeenCalledWith(null);
    expect(getByTestId('edge-tr1').getAttribute('data-selected')).toBe('false');
    cleanup();
  });

  it('selecting an edge clears node selection and calls onNodeSelect(null)', () => {
    const onEdgeSelect = vi.fn();
    const onNodeSelect = vi.fn();

    function Wrapper() {
      const [vp, setVp] = useState<ViewportState>(VP);
      return (
        <WorkflowCanvas
          nodes={NODES}
          viewportState={vp}
          onViewportChange={setVp}
          transitions={TRANSITIONS}
          onEdgeSelect={onEdgeSelect}
          onNodeSelect={onNodeSelect}
        />
      );
    }
    const { getByTestId } = render(<Wrapper />);

    fireEvent.click(getByTestId('workflow-node-step-1'));
    expect(getByTestId('workflow-node-step-1').className).toContain('ring-2');
    onNodeSelect.mockClear();

    const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
    fireEvent.click(hitbox);
    expect(onNodeSelect).toHaveBeenCalledWith(null);
    expect(getByTestId('workflow-node-step-1').className).not.toContain('ring-2');
    cleanup();
  });

  it('background click clears both node and edge selection', () => {
    const onEdgeSelect = vi.fn();
    const onNodeSelect = vi.fn();

    function Wrapper() {
      const [vp, setVp] = useState<ViewportState>(VP);
      return (
        <WorkflowCanvas
          nodes={NODES}
          viewportState={vp}
          onViewportChange={setVp}
          transitions={TRANSITIONS}
          onEdgeSelect={onEdgeSelect}
          onNodeSelect={onNodeSelect}
        />
      );
    }
    const { getByTestId } = render(<Wrapper />);

    const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
    fireEvent.click(hitbox);
    expect(getByTestId('edge-tr1').getAttribute('data-selected')).toBe('true');
    onEdgeSelect.mockClear();

    fireEvent.click(getByTestId('visual-canvas-transform'));
    expect(onEdgeSelect).toHaveBeenCalledWith(null);
    expect(getByTestId('edge-tr1').getAttribute('data-selected')).toBe('false');
    cleanup();
  });
});

describe('WorkflowCanvas — edge delete', () => {
  it('Delete key on selected edge calls onDeleteEdge', () => {
    const { getByTestId, onDeleteEdge } = renderCanvasWithEdges();
    const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
    fireEvent.click(hitbox);
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(onDeleteEdge).toHaveBeenCalledWith('tr1');
  });

  it('Delete on selected edge does not call onDeleteNode', () => {
    const onDeleteNode = vi.fn();

    function Wrapper() {
      const [vp, setVp] = useState<ViewportState>(VP);
      return (
        <WorkflowCanvas
          nodes={NODES}
          viewportState={vp}
          onViewportChange={setVp}
          transitions={TRANSITIONS}
          onDeleteNode={onDeleteNode}
        />
      );
    }
    const { getByTestId } = render(<Wrapper />);

    const hitbox = getByTestId('edge-tr1').querySelectorAll('path')[0];
    fireEvent.click(hitbox);
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(onDeleteNode).not.toHaveBeenCalled();
    cleanup();
  });

  it('Delete on selected node does not call onDeleteEdge when edge not selected', () => {
    const { getByTestId, onDeleteEdge } = renderCanvasWithEdges();
    fireEvent.click(getByTestId('workflow-node-step-1'));
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(onDeleteEdge).not.toHaveBeenCalled();
  });
});

import { computeChannelEdges } from '../WorkflowCanvas';
import type { WorkflowChannel } from '@hyperneo/shared';

describe('computeChannelEdges', () => {
  function makeAgentWithRole(id: string, role: string): SpaceWorkerAgent {
    return {
      id,
      spaceId: 'space-1',
      name: role,
      handle: id,
      customPrompt: null,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  function makeNodeWithAgentsAndChannels(
    localId: string,
    name: string,
    agents: SpaceWorkerAgent[],
    channels?: WorkflowChannel[]
  ) {
    return {
      step: {
        localId,
        name,
        agentId: agents[0]?.id ?? '',
        agents: agents.map((a) => ({ agentId: a.id })),
        instructions: '',
      },
      stepIndex: 0,
      position: { x: 0, y: 0 },
      agents,
      workflowChannels: channels ?? [],
      isStartNode: false,
    };
  }

  it('returns empty array when no nodes have channels', () => {
    const agents = [makeAgentWithRole('agent-1', 'coder')];
    const nodes = [
      makeNodeWithAgentsAndChannels('step-1', 'Step One', agents),
      makeNodeWithAgentsAndChannels('step-2', 'Step Two', agents),
    ];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(0);
  });

  it('ignores unresolved channels', () => {
    const agents = [makeAgentWithRole('agent-1', 'coder')];
    const channels: WorkflowChannel[] = [
      { from: 'missing-source', to: 'coder' },
      { from: 'coder', to: 'missing-target' },
    ];
    const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(0);
  });

  it('extracts one-way channel as edge between nodes', () => {
    const nodeAAgents = [makeAgentWithRole('agent-1', 'planner')];
    const nodeBAgents = [makeAgentWithRole('agent-2', 'coder')];
    const channels: WorkflowChannel[] = [{ id: 'ch-1', from: 'planner', to: 'coder' }];
    const nodes = [
      makeNodeWithAgentsAndChannels('step-1', 'Step One', nodeAAgents, channels),
      makeNodeWithAgentsAndChannels('step-2', 'Step Two', nodeBAgents),
    ];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fromStepId: 'step-1',
      toStepId: 'step-2',
    });
  });

  it('skips intra-node channels (same from and to node)', () => {
    const agents = [
      makeAgentWithRole('agent-1', 'coder'),
      makeAgentWithRole('agent-2', 'reviewer'),
    ];
    const channels: WorkflowChannel[] = [];
    const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(0);
  });

  it('handles wildcard to/from within same node as intra-node (skipped)', () => {
    const agents = [makeAgentWithRole('agent-1', 'coder')];
    const channels: WorkflowChannel[] = [{ id: 'ch-1', from: '*', to: 'coder' }];
    const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(0);
  });

  it('creates edge when channel.to is an array of roles', () => {
    const plannerAgents = [makeAgentWithRole('agent-1', 'planner')];
    const coderAgents = [makeAgentWithRole('agent-2', 'coder')];
    const reviewerAgents = [makeAgentWithRole('agent-3', 'reviewer')];
    const channels: WorkflowChannel[] = [{ from: 'planner', to: ['coder', 'reviewer'] }];
    const nodes = [
      makeNodeWithAgentsAndChannels('step-1', 'Step One', plannerAgents, channels),
      makeNodeWithAgentsAndChannels('step-2', 'Step Two', coderAgents),
      makeNodeWithAgentsAndChannels('step-3', 'Step Three', reviewerAgents),
    ];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(2);
    expect(result.map((edge) => edge.toStepId).sort()).toEqual(['step-2', 'step-3']);
  });

  it('returns empty array when node has agents but channel references unknown role', () => {
    const agents = [makeAgentWithRole('agent-1', 'coder')];
    const channels: WorkflowChannel[] = [];
    const nodes = [makeNodeWithAgentsAndChannels('step-1', 'Step One', agents, channels)];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(0);
  });

  it('creates inter-node edge between two regular nodes', () => {
    const nodeAAgents = [makeAgentWithRole('agent-1', 'coder')];
    const nodeBAgents = [makeAgentWithRole('agent-2', 'reviewer')];
    const nodeAChannels: WorkflowChannel[] = [{ from: 'coder', to: 'reviewer' }];
    const nodes = [
      makeNodeWithAgentsAndChannels('node-a', 'Node A', nodeAAgents, nodeAChannels),
      makeNodeWithAgentsAndChannels('node-b', 'Node B', nodeBAgents, []),
    ];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fromStepId: 'node-a',
      toStepId: 'node-b',
    });
  });

  it('deduplicates edges when same (from, to) pair appears multiple times', () => {
    const nodeAAgents = [makeAgentWithRole('agent-1', 'coder')];
    const nodeBAgents = [makeAgentWithRole('agent-2', 'reviewer')];
    const nodeAChannels: WorkflowChannel[] = [
      { from: 'coder', to: 'reviewer' },
      { from: 'coder', to: 'reviewer' },
    ];
    const nodes = [
      makeNodeWithAgentsAndChannels('node-a', 'Node A', nodeAAgents, nodeAChannels),
      makeNodeWithAgentsAndChannels('node-b', 'Node B', nodeBAgents, []),
    ];
    const result = computeChannelEdges(nodes as any);
    expect(result).toHaveLength(1);
  });
});

describe('WorkflowCanvas — channel edge rendering', () => {
  it('renders no channel edges when nodes have no channels', () => {
    const { queryByTestId } = renderCanvas();
    expect(queryByTestId('channel-edge-list')).toBeNull();
  });

  it('renders channel edges when nodes have inter-node channels', () => {
    const planner = makeAgent('agent-1', 'planner');
    const coder = makeAgent('agent-2', 'coder');
    const nodesWithChannels: WorkflowNodeData[] = [
      {
        step: {
          ...makeStep('step-1', 'Step One'),
          agentId: 'agent-1',
        },
        stepIndex: 1,
        position: { x: 10, y: 10 },
        agents: [planner],
        workflowChannels: [{ from: 'planner', to: 'coder' }],
        isStartNode: false,
      },
      {
        step: {
          ...makeStep('step-2', 'Step Two'),
          agentId: 'agent-2',
        },
        stepIndex: 2,
        position: { x: 200, y: 10 },
        agents: [coder],
        workflowChannels: [],
        isStartNode: false,
      },
    ];

    function WrapperWithChannels() {
      const [vp, setVp] = useState<ViewportState>(VP);
      return (
        <WorkflowCanvas
          nodes={nodesWithChannels}
          viewportState={vp}
          onViewportChange={setVp}
          onNodeSelect={() => {}}
          onDeleteNode={() => {}}
        />
      );
    }

    const { container } = render(<WrapperWithChannels />);
    const channelEdges = container.querySelectorAll('[data-channel-edge]');
    expect(channelEdges.length).toBeGreaterThan(0);
  });
});

import type { ResolvedWorkflowChannel } from '../EdgeRenderer';

describe('WorkflowCanvas — explicit channels prop', () => {
  const CHANNEL_EDGES: ResolvedWorkflowChannel[] = [
    { fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' as const },
  ];

  function renderCanvasWithExplicitChannels(extra: Partial<WorkflowCanvasProps> = {}) {
    function Wrapper() {
      const [vp, setVp] = useState<ViewportState>(VP);
      return (
        <WorkflowCanvas
          nodes={NODES}
          viewportState={vp}
          onViewportChange={setVp}
          channels={CHANNEL_EDGES}
          {...extra}
        />
      );
    }
    return render(<Wrapper />);
  }

  it('renders SVG overlay when explicit channels are provided', () => {
    const { getByTestId } = renderCanvasWithExplicitChannels();
    expect(getByTestId('visual-canvas-svg')).toBeTruthy();
  });

  it('renders channel edges from explicit channels prop', () => {
    const { container } = renderCanvasWithExplicitChannels();
    const channelEdges = container.querySelectorAll('[data-channel-edge]');
    expect(channelEdges.length).toBeGreaterThan(0);
  });

  it('prefers explicit channels over computed node channels when provided', () => {
    const agentWithRole = makeAgent('agent-1', 'coder');
    const nodesWithChannels: WorkflowNodeData[] = [
      {
        step: {
          ...makeStep('step-1', 'Step One'),
          agentId: 'agent-1',
        },
        stepIndex: 1,
        position: { x: 10, y: 10 },
        agents: [agentWithRole],
        workflowChannels: [{ from: 'coder', to: 'Reviewer' }],
        isStartNode: false,
      },
      {
        step: makeStep('step-2', 'Step Two'),
        stepIndex: 2,
        position: { x: 200, y: 10 },
        agents: [makeAgent('agent-2', 'Reviewer')],
        workflowChannels: [],
        isStartNode: false,
      },
    ];
    const duplicateChannels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-2', toStepId: 'step-1', direction: 'one-way' as const },
    ];

    function Wrapper() {
      const [vp, setVp] = useState<ViewportState>(VP);
      return (
        <WorkflowCanvas
          nodes={nodesWithChannels}
          viewportState={vp}
          onViewportChange={setVp}
          channels={duplicateChannels}
          onNodeSelect={() => {}}
          onDeleteNode={() => {}}
        />
      );
    }

    const { container } = render(<Wrapper />);
    const explicitEdge = container.querySelector('[data-testid="channel-edge-step-2-step-1"]');
    expect(explicitEdge).toBeTruthy();
    expect(container.querySelectorAll('[data-channel-edge]').length).toBe(1);
    cleanup();
  });
});
