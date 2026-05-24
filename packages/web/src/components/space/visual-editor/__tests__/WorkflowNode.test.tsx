/**
 * Unit tests for WorkflowNode component.
 *
 * Tests:
 * - Renders step name and agent name
 * - Shows step number badge
 * - Start node shows START badge and green border, hides input port
 * - Non-start node shows input port
 * - Selected state applies ring
 * - Port mousedown events do not trigger drag (stopPropagation check)
 * - Port mousedown calls onPortMouseDown with correct args
 * - Dragging updates position accounting for viewport scale
 * - Drag with scale=2 halves the canvas-space delta
 * - Drag with scale=0.5 doubles the canvas-space delta
 * - Click calls onClick with stepId
 *
 * Note: window.dispatchEvent(new MouseEvent(...)) is used for window-level
 * mouse events because fireEvent(window, ...) does not work in happy-dom.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { WorkflowNode } from '../WorkflowNode';
import type { WorkflowNodeProps } from '../WorkflowNode';
import type { SpaceAgent } from '@neokai/shared';
import type { AgentTaskState } from '../../WorkflowNodeCard';
import type { Point } from '../types';

// Default to non-mobile for every test — individual tests (see "mobile"
// describe blocks) override this before rendering. This keeps matchMedia
// defined in happy-dom, which otherwise returns undefined.
function mockMatchMedia(isMobile: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 767px)' ? isMobile : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => mockMatchMedia(false));
afterEach(() => cleanup());

// ============================================================================
// Helpers
// ============================================================================

function windowMouseMove(clientX: number, clientY: number) {
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
}

function windowMouseUp() {
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

// ============================================================================
// Test fixtures
// ============================================================================

const AGENT_A: SpaceAgent = {
  id: 'agent-1',
  spaceId: 'space-1',
  name: 'Alpha Agent',
  customPrompt: null,
  createdAt: 0,
  updatedAt: 0,
};

const AGENT_B: SpaceAgent = {
  id: 'agent-2',
  spaceId: 'space-1',
  name: 'Beta Agent',
  customPrompt: null,
  createdAt: 0,
  updatedAt: 0,
};

const STEP_DRAFT = {
  localId: 'step-local-1',
  id: 'step-id-1',
  name: 'Build App',
  agentId: 'agent-1',
  instructions: 'build it',
};

const DEFAULT_POSITION: Point = { x: 100, y: 200 };

function makeProps(overrides: Partial<WorkflowNodeProps> = {}): WorkflowNodeProps {
  return {
    stepIndex: 0,
    step: STEP_DRAFT,
    position: DEFAULT_POSITION,
    agents: [AGENT_A, AGENT_B],
    workflowChannels: [],
    isSelected: false,
    isStartNode: false,
    scale: 1,
    onPositionChange: vi.fn(),
    onPortMouseDown: vi.fn(),
    onClick: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// Rendering tests
// ============================================================================

describe('WorkflowNode rendering', () => {
  it('renders step name', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps()} />);
    expect(getByTestId('step-name').textContent).toBe('Build App');
  });

  it('renders agent name resolved from agents list', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps()} />);
    expect(getByTestId('agent-name').textContent).toBe('Alpha Agent');
  });

  it('falls back to agentId when agent not found', () => {
    const props = makeProps({ step: { ...STEP_DRAFT, agentId: 'unknown-agent' } });
    const { getByTestId } = render(<WorkflowNode {...props} />);
    expect(getByTestId('agent-name').textContent).toBe('unknown-agent');
  });

  it('shows correct step number badge (1-indexed)', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps({ stepIndex: 2 })} />);
    expect(getByTestId('step-badge').textContent).toBe('3');
  });

  it('shows START badge and input port is hidden when isStartNode=true', () => {
    const { getByTestId, queryByTestId } = render(
      <WorkflowNode {...makeProps({ isStartNode: true })} />
    );
    expect(getByTestId('start-badge').textContent).toBe('START');
    expect(queryByTestId('port-input')).toBeNull();
  });

  it('shows input port when not start node', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps({ isStartNode: false })} />);
    expect(getByTestId('port-input')).toBeTruthy();
  });

  it('always renders output port', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps({ isStartNode: true })} />);
    expect(getByTestId('port-output')).toBeTruthy();
  });

  it('applies ring class when selected', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps({ isSelected: true })} />);
    const node = getByTestId('workflow-node-step-local-1');
    expect(node.className).toContain('ring-2');
    expect(node.className).toContain('ring-blue-500');
  });

  it('does not apply ring class when not selected', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps({ isSelected: false })} />);
    const node = getByTestId('workflow-node-step-local-1');
    expect(node.className).not.toContain('ring-2');
  });

  it('applies green border class for start node', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps({ isStartNode: true })} />);
    expect(getByTestId('workflow-node-step-local-1').className).toContain('border-green-500');
  });

  it('positions node using absolute style from position prop', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps({ position: { x: 42, y: 88 } })} />);
    const node = getByTestId('workflow-node-step-local-1');
    expect(node.style.left).toBe('42px');
    expect(node.style.top).toBe('88px');
  });

  it('shows (unnamed) when step name is empty', () => {
    const props = makeProps({ step: { ...STEP_DRAFT, name: '' } });
    const { getByTestId } = render(<WorkflowNode {...props} />);
    expect(getByTestId('step-name').textContent).toBe('(unnamed)');
  });

  it('does not render channel topology text inside the node card', () => {
    const { queryByTestId, queryByText } = render(
      <WorkflowNode
        {...makeProps({
          workflowChannels: [],
        })}
      />
    );

    expect(queryByTestId('channel-topology-badge')).toBeNull();
    expect(queryByText('handoff')).toBeNull();
  });
});

// ============================================================================
// Port events
// ============================================================================

describe('WorkflowNode port events', () => {
  it('calls onPortMouseDown with input type when input port is pressed', () => {
    const onPortMouseDown = vi.fn();
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ onPortMouseDown, isStartNode: false })} />
    );
    fireEvent.mouseDown(getByTestId('port-input'), { button: 0 });
    expect(onPortMouseDown).toHaveBeenCalledWith(
      'step-local-1',
      'input',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('calls onPortMouseDown with output type when output port is pressed', () => {
    const onPortMouseDown = vi.fn();
    const { getByTestId } = render(<WorkflowNode {...makeProps({ onPortMouseDown })} />);
    fireEvent.mouseDown(getByTestId('port-output'), { button: 0 });
    expect(onPortMouseDown).toHaveBeenCalledWith(
      'step-local-1',
      'output',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('port mousedown does not trigger drag (stopPropagation)', () => {
    const onPositionChange = vi.fn();
    const { getByTestId } = render(<WorkflowNode {...makeProps({ onPositionChange })} />);

    // Press the output port then move mouse on window
    fireEvent.mouseDown(getByTestId('port-output'), { button: 0, clientX: 0, clientY: 0 });
    windowMouseMove(50, 50);

    // Position should not change because the port stopPropagation prevented drag start
    expect(onPositionChange).not.toHaveBeenCalled();

    windowMouseUp();
  });
});

// ============================================================================
// Click events
// ============================================================================

describe('WorkflowNode click', () => {
  it('calls onClick with stepId when card is clicked', () => {
    const onClick = vi.fn();
    const { getByTestId } = render(<WorkflowNode {...makeProps({ onClick })} />);
    fireEvent.click(getByTestId('workflow-node-step-local-1'));
    expect(onClick).toHaveBeenCalledWith('step-local-1');
  });

  it('does NOT call onClick after a drag completes', () => {
    const onClick = vi.fn();
    const { getByTestId } = render(<WorkflowNode {...makeProps({ onClick })} />);
    const node = getByTestId('workflow-node-step-local-1');

    // Simulate drag: mousedown → move past threshold → mouseup → click
    fireEvent.mouseDown(node, { button: 0, clientX: 0, clientY: 0 });
    windowMouseMove(20, 20); // well past 3px threshold
    windowMouseUp();
    fireEvent.click(node);

    expect(onClick).not.toHaveBeenCalled();
  });

  it('calls onClick normally after a sub-threshold mousedown (no real drag)', () => {
    const onClick = vi.fn();
    const { getByTestId } = render(<WorkflowNode {...makeProps({ onClick })} />);
    const node = getByTestId('workflow-node-step-local-1');

    // Mousedown then release without crossing threshold
    fireEvent.mouseDown(node, { button: 0, clientX: 0, clientY: 0 });
    windowMouseMove(1, 1); // below 3px threshold — not a drag
    windowMouseUp();
    fireEvent.click(node);

    expect(onClick).toHaveBeenCalledWith('step-local-1');
  });
});

// ============================================================================
// Multi-agent rendering tests
// ============================================================================

describe('WorkflowNode multi-agent rendering', () => {
  it('renders agent badges when step has agents array', () => {
    const step = {
      ...STEP_DRAFT,
      agentId: '',
      agents: [
        { agentId: 'agent-1', name: 'coder' },
        { agentId: 'agent-2', name: 'reviewer' },
      ],
    };
    const { getByTestId, queryByTestId } = render(<WorkflowNode {...makeProps({ step })} />);
    const badges = getByTestId('agent-badges');
    expect(badges).toBeTruthy();
    // agent-name element should not be present in multi-agent mode
    expect(queryByTestId('agent-name')).toBeNull();
    // Canvas shows slot role names (not agent names) for compact display
    expect(badges.textContent).toContain('coder');
    expect(badges.textContent).toContain('reviewer');
  });

  it('renders single agent name when agents array is absent', () => {
    const { getByTestId, queryByTestId } = render(<WorkflowNode {...makeProps()} />);
    expect(getByTestId('agent-name')).toBeTruthy();
    expect(queryByTestId('agent-badges')).toBeNull();
  });

  it('renders single agent name when agents array is empty', () => {
    const step = { ...STEP_DRAFT, agents: [] as { agentId: string; name: string }[] };
    const { getByTestId, queryByTestId } = render(<WorkflowNode {...makeProps({ step })} />);
    // Empty agents array = single-agent mode
    expect(getByTestId('agent-name')).toBeTruthy();
    expect(queryByTestId('agent-badges')).toBeNull();
  });

  it('shows slot role in single-agent label when one slot is present and agent lookup fails', () => {
    const step = {
      ...STEP_DRAFT,
      agentId: '',
      agents: [{ agentId: 'unknown-agent-id', name: 'coder' }],
    };
    const { getByTestId } = render(<WorkflowNode {...makeProps({ step })} />);
    expect(getByTestId('agent-name').textContent).toContain('coder');
  });

  it('shows override-indicator dot when a multi-agent slot has customPrompt override', () => {
    const step = {
      ...STEP_DRAFT,
      agentId: '',
      agents: [
        {
          agentId: 'agent-1',
          name: 'coder',
          customPrompt: { value: 'Be precise.' },
        },
        { agentId: 'agent-2', name: 'reviewer' },
      ],
    };
    const { getByTestId } = render(<WorkflowNode {...makeProps({ step })} />);
    expect(getByTestId('override-indicator')).toBeTruthy();
  });

  it('does not show override-indicator when slot has no overrides', () => {
    const step = {
      ...STEP_DRAFT,
      agentId: '',
      agents: [{ agentId: 'agent-1', name: 'coder' }],
    };
    const { queryByTestId } = render(<WorkflowNode {...makeProps({ step })} />);
    expect(queryByTestId('override-indicator')).toBeNull();
  });

  it('uses wider minWidth for multi-agent steps', () => {
    const step = {
      ...STEP_DRAFT,
      agentId: '',
      agents: [
        { agentId: 'agent-1', name: 'coder' },
        { agentId: 'agent-2', name: 'reviewer' },
      ],
    };
    const { getByTestId } = render(<WorkflowNode {...makeProps({ step })} />);
    const node = getByTestId('workflow-node-step-local-1');
    expect(node.style.width).toBe('200px');
    expect(node.style.minHeight).toBe('112px');
  });

  it('uses default minWidth for single-agent steps', () => {
    const { getByTestId } = render(<WorkflowNode {...makeProps()} />);
    const node = getByTestId('workflow-node-step-local-1');
    expect(node.style.width).toBe('160px');
    expect(node.style.minHeight).toBe('80px');
  });
});

// ============================================================================
// Drag-and-drop tests
// ============================================================================

describe('WorkflowNode drag-and-drop', () => {
  it('updates position on drag at scale=1', () => {
    const onPositionChange = vi.fn();
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ onPositionChange, position: { x: 100, y: 200 }, scale: 1 })} />
    );

    const node = getByTestId('workflow-node-step-local-1');
    fireEvent.mouseDown(node, { button: 0, clientX: 0, clientY: 0 });
    windowMouseMove(30, 40);

    expect(onPositionChange).toHaveBeenCalledWith('step-local-1', { x: 130, y: 240 });

    windowMouseUp();
  });

  it('halves canvas-space delta when scale=2', () => {
    const onPositionChange = vi.fn();
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ onPositionChange, position: { x: 0, y: 0 }, scale: 2 })} />
    );

    fireEvent.mouseDown(getByTestId('workflow-node-step-local-1'), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    windowMouseMove(100, 60);

    // canvas delta = screen delta / scale = 100/2=50, 60/2=30
    expect(onPositionChange).toHaveBeenCalledWith('step-local-1', { x: 50, y: 30 });

    windowMouseUp();
  });

  it('doubles canvas-space delta when scale=0.5', () => {
    const onPositionChange = vi.fn();
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ onPositionChange, position: { x: 0, y: 0 }, scale: 0.5 })} />
    );

    fireEvent.mouseDown(getByTestId('workflow-node-step-local-1'), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    windowMouseMove(20, 10);

    // canvas delta = screen delta / scale = 20/0.5=40, 10/0.5=20
    expect(onPositionChange).toHaveBeenCalledWith('step-local-1', { x: 40, y: 20 });

    windowMouseUp();
  });

  it('stops dragging after mouseup', () => {
    const onPositionChange = vi.fn();
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ onPositionChange, position: { x: 0, y: 0 }, scale: 1 })} />
    );

    fireEvent.mouseDown(getByTestId('workflow-node-step-local-1'), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    windowMouseMove(10, 10);
    expect(onPositionChange).toHaveBeenCalledTimes(1);

    windowMouseUp();
    windowMouseMove(50, 50);
    // No additional calls after mouseup
    expect(onPositionChange).toHaveBeenCalledTimes(1);
  });

  it('ignores non-primary mouse button', () => {
    const onPositionChange = vi.fn();
    const { getByTestId } = render(<WorkflowNode {...makeProps({ onPositionChange, scale: 1 })} />);

    // Right-click (button=2)
    fireEvent.mouseDown(getByTestId('workflow-node-step-local-1'), {
      button: 2,
      clientX: 0,
      clientY: 0,
    });
    windowMouseMove(50, 50);

    expect(onPositionChange).not.toHaveBeenCalled();
    windowMouseUp();
  });

  it('continuously updates position on multiple mousemove events', () => {
    const positions: Point[] = [];
    const onPositionChange = vi.fn((_, pos: Point) => positions.push(pos));

    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ onPositionChange, position: { x: 0, y: 0 }, scale: 1 })} />
    );

    fireEvent.mouseDown(getByTestId('workflow-node-step-local-1'), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    windowMouseMove(10, 5);
    windowMouseMove(20, 15);
    windowMouseMove(30, 25);

    expect(positions).toEqual([
      { x: 10, y: 5 },
      { x: 20, y: 15 },
      { x: 30, y: 25 },
    ]);

    windowMouseUp();
  });

  it('does not fire onPositionChange for moves below 3px threshold', () => {
    const onPositionChange = vi.fn();
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ onPositionChange, position: { x: 0, y: 0 }, scale: 1 })} />
    );

    fireEvent.mouseDown(getByTestId('workflow-node-step-local-1'), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    windowMouseMove(2, 1); // 2px — below the 3px threshold
    expect(onPositionChange).not.toHaveBeenCalled();

    windowMouseUp();
  });

  it('guards against scale=0 (no Infinity positions)', () => {
    const onPositionChange = vi.fn();
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ onPositionChange, position: { x: 0, y: 0 }, scale: 0 })} />
    );

    fireEvent.mouseDown(getByTestId('workflow-node-step-local-1'), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    windowMouseMove(10, 10);

    expect(onPositionChange).toHaveBeenCalledOnce();
    const [, pos] = onPositionChange.mock.calls[0];
    expect(isFinite(pos.x)).toBe(true);
    expect(isFinite(pos.y)).toBe(true);

    windowMouseUp();
  });

  it('drag uses position prop at drag-start time (not stale closure)', () => {
    // Simulate dynamic position updates: wrapper re-renders with new position
    // between the mousedown and mousemove.
    const onPositionChange = vi.fn();

    function Wrapper() {
      const [pos, setPos] = useState<Point>({ x: 50, y: 50 });
      return (
        <WorkflowNode
          {...makeProps({
            position: pos,
            scale: 1,
            onPositionChange: (id, newPos) => {
              onPositionChange(id, newPos);
              setPos(newPos);
            },
          })}
        />
      );
    }

    const { getByTestId } = render(<Wrapper />);

    // Start drag at (50,50) with mouse at screen (0,0)
    fireEvent.mouseDown(getByTestId('workflow-node-step-local-1'), {
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    // Move 20px in screen space — canvas delta = 20
    windowMouseMove(20, 10);
    expect(onPositionChange).toHaveBeenLastCalledWith('step-local-1', { x: 70, y: 60 });

    // Move another 10px — still relative to drag start (0,0), so total delta = 30
    windowMouseMove(30, 20);
    expect(onPositionChange).toHaveBeenLastCalledWith('step-local-1', { x: 80, y: 70 });

    windowMouseUp();
  });
});

// ============================================================================
// Agent completion state
// ============================================================================

describe('WorkflowNode — agent completion state', () => {
  const MULTI_STEP = {
    localId: 'step-multi',
    id: 'node-multi',
    name: 'Multi Agent Step',
    agentId: '',
    instructions: '',
    agents: [
      { agentId: 'agent-1', name: 'coder' },
      { agentId: 'agent-2', name: 'reviewer' },
    ],
  };

  it('shows spinner for in_progress single-agent', () => {
    const states: AgentTaskState[] = [{ agentName: null, status: 'in_progress' }];
    const { getByTestId } = render(<WorkflowNode {...makeProps({ nodeTaskStates: states })} />);
    expect(getByTestId('agent-status-spinner')).toBeTruthy();
  });

  it('shows checkmark for idle single-agent', () => {
    const states: AgentTaskState[] = [{ agentName: null, status: 'idle' }];
    const { getByTestId } = render(<WorkflowNode {...makeProps({ nodeTaskStates: states })} />);
    expect(getByTestId('agent-status-check')).toBeTruthy();
  });

  it('shows fail icon for blocked single-agent', () => {
    const states: AgentTaskState[] = [{ agentName: null, status: 'blocked' }];
    const { getByTestId } = render(<WorkflowNode {...makeProps({ nodeTaskStates: states })} />);
    expect(getByTestId('agent-status-fail')).toBeTruthy();
  });

  it('shows per-agent status icons for multi-agent node', () => {
    const states: AgentTaskState[] = [
      { agentName: 'coder', status: 'idle' },
      { agentName: 'reviewer', status: 'in_progress' },
    ];
    const { getAllByTestId } = render(
      <WorkflowNode {...makeProps({ step: MULTI_STEP, nodeTaskStates: states })} />
    );
    expect(getAllByTestId('agent-status-check')).toHaveLength(1);
    expect(getAllByTestId('agent-status-spinner')).toHaveLength(1);
  });

  it('applies gray border when all agents done (green is start-node only)', () => {
    const states: AgentTaskState[] = [
      { agentName: 'coder', status: 'idle' },
      { agentName: 'reviewer', status: 'idle' },
    ];
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ step: MULTI_STEP, nodeTaskStates: states })} />
    );
    const node = getByTestId('workflow-node-step-multi');
    expect(node.className).not.toContain('green');
  });

  it('does not apply green border when not all done', () => {
    const states: AgentTaskState[] = [
      { agentName: 'coder', status: 'idle' },
      { agentName: 'reviewer', status: 'in_progress' },
    ];
    const { getByTestId } = render(
      <WorkflowNode {...makeProps({ step: MULTI_STEP, nodeTaskStates: states })} />
    );
    const node = getByTestId('workflow-node-step-multi');
    expect(node.className).not.toContain('green');
  });

  it('does not show status icons without nodeTaskStates', () => {
    const { container } = render(<WorkflowNode {...makeProps()} />);
    expect(container.querySelector('[data-testid="agent-status-check"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-status-spinner"]')).toBeNull();
  });
});
