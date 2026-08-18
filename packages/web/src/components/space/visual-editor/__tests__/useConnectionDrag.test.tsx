import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/preact';
import { useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { useConnectionDrag } from '../useConnectionDrag';
import type { TransitionLike } from '../useConnectionDrag';
import type { ViewportState } from '../types';
import { WorkflowCanvas } from '../WorkflowCanvas';
import type { WorkflowNodeData, WorkflowCanvasProps } from '../WorkflowCanvas';
import type { SpaceWorkerAgent } from '@hyperneo/shared';
import type { NodeDraft } from '../../WorkflowNodeCard';

vi.mock('../../../../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

afterEach(() => cleanup());

const VP: ViewportState = { offsetX: 0, offsetY: 0, scale: 1 };

function makeAgent(id: string, name = 'Agent'): SpaceWorkerAgent {
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

function makeStep(localId: string, name = 'Step'): NodeDraft {
  return { localId, name, agentId: 'agent-1' };
}

const AGENTS = [makeAgent('agent-1')];

function makeNode(
  localId: string,
  name = 'Step',
  opts: Partial<WorkflowNodeData> = {}
): WorkflowNodeData {
  return {
    step: makeStep(localId, name),
    stepIndex: 0,
    position: { x: 0, y: 0 },
    agents: AGENTS,
    workflowChannels: [],
    isStartNode: false,
    ...opts,
  };
}

function makePortEl(x = 100, y = 200, w = 14, h = 14): Element {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
    width: w,
    height: h,
    x,
    y,
    toJSON: () => ({}),
  });
  return el;
}

function makeContainerEl(left = 0, top = 0): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left,
    top,
    right: left + 800,
    bottom: top + 600,
    width: 800,
    height: 600,
    x: left,
    y: top,
    toJSON: () => ({}),
  });
  return el;
}

interface HarnessProps {
  viewportState: ViewportState;
  transitions?: TransitionLike[];
  onCreateTransition?: (from: string, to: string) => void;
}

function HookHarness({
  viewportState,
  transitions = [],
  onCreateTransition = vi.fn(),
}: HarnessProps) {
  const containerRef = useRef<HTMLElement>(makeContainerEl() as HTMLElement);

  const { dragState, startDrag, setHoverTarget } = useConnectionDrag({
    viewportState,
    containerRef: containerRef as RefObject<HTMLElement>,
    transitions,
    onCreateTransition,
  });

  return (
    <div>
      <div data-testid="active">{String(dragState.active)}</div>
      <div data-testid="from-step-id">{dragState.fromStepId ?? ''}</div>
      <div data-testid="hover-target">{dragState.hoverTargetStepId ?? ''}</div>
      <div data-testid="from-x">{dragState.fromPos?.x ?? ''}</div>
      <div data-testid="from-y">{dragState.fromPos?.y ?? ''}</div>
      <div data-testid="current-x">{dragState.currentPos?.x ?? ''}</div>
      <div data-testid="current-y">{dragState.currentPos?.y ?? ''}</div>
      <button
        data-testid="start-drag"
        onClick={(e) => startDrag('step-a', makePortEl(100, 200), e as unknown as MouseEvent)}
      />
      <button data-testid="set-hover" onClick={() => setHoverTarget('step-b')} />
      <button data-testid="clear-hover" onClick={() => setHoverTarget(null)} />
    </div>
  );
}

describe('useConnectionDrag — idle state', () => {
  it('starts idle', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);
    expect(getByTestId('active').textContent).toBe('false');
    expect(getByTestId('from-step-id').textContent).toBe('');
  });
});

describe('useConnectionDrag — startDrag', () => {
  it('activates drag and sets fromStepId', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);
    fireEvent.click(getByTestId('start-drag'));
    expect(getByTestId('active').textContent).toBe('true');
    expect(getByTestId('from-step-id').textContent).toBe('step-a');
  });

  it('sets fromPos to port center in canvas coords (scale 1, no offset)', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);
    fireEvent.click(getByTestId('start-drag'));
    expect(Number(getByTestId('from-x').textContent)).toBeCloseTo(107, 0);
    expect(Number(getByTestId('from-y').textContent)).toBeCloseTo(207, 0);
  });
});

describe('useConnectionDrag — mousemove', () => {
  it('updates currentPos during drag', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);
    fireEvent.click(getByTestId('start-drag'));

    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 400 })
      );
    });

    expect(getByTestId('current-x').textContent).toBe('300');
    expect(getByTestId('current-y').textContent).toBe('400');
  });

  it('does not update currentPos when drag is inactive', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);

    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 400 })
      );
    });

    expect(getByTestId('current-x').textContent).toBe('');
  });
});

describe('useConnectionDrag — setHoverTarget', () => {
  it('sets hoverTargetStepId during drag', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);
    fireEvent.click(getByTestId('start-drag'));
    fireEvent.click(getByTestId('set-hover'));
    expect(getByTestId('hover-target').textContent).toBe('step-b');
  });

  it('clears hoverTargetStepId', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);
    fireEvent.click(getByTestId('start-drag'));
    fireEvent.click(getByTestId('set-hover'));
    fireEvent.click(getByTestId('clear-hover'));
    expect(getByTestId('hover-target').textContent).toBe('');
  });

  it('is ignored when drag is not active', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);
    fireEvent.click(getByTestId('set-hover'));
    expect(getByTestId('hover-target').textContent).toBe('');
  });
});

describe('useConnectionDrag — mouseup (cancel)', () => {
  it('cancels drag when no hover target', () => {
    const onCreateTransition = vi.fn();
    const { getByTestId } = render(
      <HookHarness viewportState={VP} onCreateTransition={onCreateTransition} />
    );

    fireEvent.click(getByTestId('start-drag'));
    expect(getByTestId('active').textContent).toBe('true');

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(getByTestId('active').textContent).toBe('false');
    expect(onCreateTransition).not.toHaveBeenCalled();
  });

  it('resets to idle after mouseup', () => {
    const { getByTestId } = render(<HookHarness viewportState={VP} />);
    fireEvent.click(getByTestId('start-drag'));
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(getByTestId('from-step-id').textContent).toBe('');
    expect(getByTestId('hover-target').textContent).toBe('');
  });
});

describe('useConnectionDrag — mouseup (connect)', () => {
  it('calls onCreateTransition on valid drop', () => {
    const onCreateTransition = vi.fn();
    const { getByTestId } = render(
      <HookHarness viewportState={VP} onCreateTransition={onCreateTransition} />
    );

    fireEvent.click(getByTestId('start-drag'));
    fireEvent.click(getByTestId('set-hover'));

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(onCreateTransition).toHaveBeenCalledWith('step-a', 'step-b');
    expect(getByTestId('active').textContent).toBe('false');
  });

  it('blocks self-connections', () => {
    const onCreateTransition = vi.fn();

    function SelfConnectionHarness() {
      const containerRef = useRef<HTMLElement>(makeContainerEl() as HTMLElement);
      const { dragState, startDrag, setHoverTarget } = useConnectionDrag({
        viewportState: VP,
        containerRef: containerRef as RefObject<HTMLElement>,
        transitions: [],
        onCreateTransition,
      });
      return (
        <div>
          <div data-testid="active">{String(dragState.active)}</div>
          <button
            data-testid="start"
            onClick={(e) => startDrag('node-x', makePortEl(), e as unknown as MouseEvent)}
          />
          <button data-testid="hover-self" onClick={() => setHoverTarget('node-x')} />
        </div>
      );
    }

    const { getByTestId } = render(<SelfConnectionHarness />);
    fireEvent.click(getByTestId('start'));
    fireEvent.click(getByTestId('hover-self'));
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(onCreateTransition).not.toHaveBeenCalled();
    expect(getByTestId('active').textContent).toBe('false');
  });

  it('blocks duplicate transitions', () => {
    const onCreateTransition = vi.fn();
    const existing: TransitionLike[] = [{ from: 'step-a', to: 'step-b' }];
    const { getByTestId } = render(
      <HookHarness
        viewportState={VP}
        transitions={existing}
        onCreateTransition={onCreateTransition}
      />
    );

    fireEvent.click(getByTestId('start-drag'));
    fireEvent.click(getByTestId('set-hover'));
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(onCreateTransition).not.toHaveBeenCalled();
  });
});

function renderCanvas(extra: Partial<WorkflowCanvasProps> = {}) {
  const nodes: WorkflowNodeData[] = [
    makeNode('step-1', 'Step One', { isStartNode: true }),
    makeNode('step-2', 'Step Two'),
    makeNode('step-3', 'Step Three'),
  ];
  const onCreateTransition = vi.fn();

  function Wrapper() {
    const [vp, setVp] = useState<ViewportState>(VP);
    return (
      <WorkflowCanvas
        nodes={nodes}
        viewportState={vp}
        onViewportChange={setVp}
        transitions={[]}
        onCreateTransition={onCreateTransition}
        {...extra}
      />
    );
  }

  const result = render(<Wrapper />);
  return { ...result, onCreateTransition };
}

describe('WorkflowCanvas — connection drag ghost edge', () => {
  it('ghost edge is not present when drag is inactive', () => {
    const { queryByTestId } = renderCanvas();
    expect(queryByTestId('ghost-edge')).toBeNull();
  });

  it('ghost edge appears when output port is pressed and mouse moves', () => {
    const { getByTestId } = renderCanvas();
    const outputPort = getByTestId('workflow-node-step-1').querySelector(
      '[data-testid="port-output"]'
    )!;

    fireEvent.mouseDown(outputPort, { button: 0, clientX: 50, clientY: 50 });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 200 })
      );
    });

    expect(getByTestId('ghost-edge')).toBeTruthy();
  });

  it('ghost edge appears when input port is pressed and mouse moves', () => {
    const { getByTestId } = renderCanvas();
    const inputPort = getByTestId('workflow-node-step-2').querySelector(
      '[data-testid="port-input"]'
    )!;

    fireEvent.mouseDown(inputPort, { button: 0, clientX: 50, clientY: 50 });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 200 })
      );
    });

    expect(getByTestId('ghost-edge')).toBeTruthy();
  });

  it('ghost edge disappears after mouseup (cancel)', () => {
    const { getByTestId, queryByTestId } = renderCanvas();
    const outputPort = getByTestId('workflow-node-step-1').querySelector(
      '[data-testid="port-output"]'
    )!;

    fireEvent.mouseDown(outputPort, { button: 0, clientX: 50, clientY: 50 });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 200 })
      );
    });
    expect(getByTestId('ghost-edge')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(queryByTestId('ghost-edge')).toBeNull();
  });
});

describe('WorkflowCanvas — drop target highlighting', () => {
  it('non-source nodes get drop target highlight during drag', () => {
    const { getByTestId } = renderCanvas();
    const outputPort = getByTestId('workflow-node-step-1').querySelector(
      '[data-testid="port-output"]'
    )!;

    fireEvent.mouseDown(outputPort, { button: 0, clientX: 50, clientY: 50 });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 200 })
      );
    });

    const inputPort2 = getByTestId('workflow-node-step-2').querySelector(
      '[data-testid="port-input"]'
    ) as HTMLElement;
    const inputPort3 = getByTestId('workflow-node-step-3').querySelector(
      '[data-testid="port-input"]'
    ) as HTMLElement;
    expect(inputPort2?.style.background).toBe('#22c55e');
    expect(inputPort3?.style.background).toBe('#22c55e');
  });

  it('source node does NOT get drop target highlight', () => {
    const { getByTestId } = renderCanvas();
    const outputPort = getByTestId('workflow-node-step-2').querySelector(
      '[data-testid="port-output"]'
    )!;

    fireEvent.mouseDown(outputPort, { button: 0, clientX: 50, clientY: 50 });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 200 })
      );
    });

    const inputPort2 = getByTestId('workflow-node-step-2').querySelector(
      '[data-testid="port-input"]'
    ) as HTMLElement;
    expect(inputPort2?.style.background).not.toBe('#22c55e');
  });

  it('highlights disappear after drag ends', () => {
    const { getByTestId } = renderCanvas();
    const outputPort = getByTestId('workflow-node-step-1').querySelector(
      '[data-testid="port-output"]'
    )!;

    fireEvent.mouseDown(outputPort, { button: 0, clientX: 50, clientY: 50 });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 200 })
      );
    });

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const inputPort2 = getByTestId('workflow-node-step-2').querySelector(
      '[data-testid="port-input"]'
    ) as HTMLElement;
    expect(inputPort2?.style.background).not.toBe('#22c55e');
  });
});

describe('WorkflowCanvas — start node not a drop target', () => {
  it('start node input port is hidden, so it cannot be a drop target', () => {
    const { getByTestId } = renderCanvas();
    const startNode = getByTestId('workflow-node-step-1');
    expect(startNode.querySelector('[data-testid="port-input"]')).toBeNull();
  });
});

describe('WorkflowCanvas — end-to-end connection creation', () => {
  it('calls onCreateTransition when dropping on a valid input port', () => {
    const { getByTestId, onCreateTransition } = renderCanvas();

    const outputPort = getByTestId('workflow-node-step-1').querySelector(
      '[data-testid="port-output"]'
    )!;
    fireEvent.mouseDown(outputPort, { button: 0, clientX: 50, clientY: 50 });

    const inputPort2 = getByTestId('workflow-node-step-2').querySelector(
      '[data-testid="port-input"]'
    )!;
    fireEvent.mouseEnter(inputPort2);

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(onCreateTransition).toHaveBeenCalledWith('step-1', 'step-2');
  });

  it('calls onCreateTransition when drag starts from an input port', () => {
    const { getByTestId, onCreateTransition } = renderCanvas();

    const inputPort2 = getByTestId('workflow-node-step-2').querySelector(
      '[data-testid="port-input"]'
    )!;
    fireEvent.mouseDown(inputPort2, { button: 0, clientX: 50, clientY: 50 });

    const inputPort3 = getByTestId('workflow-node-step-3').querySelector(
      '[data-testid="port-input"]'
    )!;
    fireEvent.mouseEnter(inputPort3);

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(onCreateTransition).toHaveBeenCalledWith('step-2', 'step-3');
  });

  it('does not call onCreateTransition when releasing over empty space', () => {
    const { getByTestId, onCreateTransition } = renderCanvas();

    const outputPort = getByTestId('workflow-node-step-1').querySelector(
      '[data-testid="port-output"]'
    )!;
    fireEvent.mouseDown(outputPort, { button: 0, clientX: 50, clientY: 50 });

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(onCreateTransition).not.toHaveBeenCalled();
  });

  it('cancels drag when Escape is pressed', () => {
    const { getByTestId, queryByTestId, onCreateTransition } = renderCanvas();

    const outputPort = getByTestId('workflow-node-step-1').querySelector(
      '[data-testid="port-output"]'
    )!;
    fireEvent.mouseDown(outputPort, { button: 0, clientX: 50, clientY: 50 });
    act(() => {
      window.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 150, clientY: 200 })
      );
    });
    expect(queryByTestId('ghost-edge')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(queryByTestId('ghost-edge')).toBeNull();
    expect(onCreateTransition).not.toHaveBeenCalled();
  });
});
