import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { VisualTransition } from '../types';
import {
  EdgeRenderer,
  computeEdgePoints,
  buildPathD,
  CONTROL_OFFSET,
  EDGE_COLORS,
  NORMAL_STROKE_WIDTH,
  SELECTED_STROKE_WIDTH,
  CHANNEL_EDGE_COLOR,
  CHANNEL_EDGE_DASH_ARRAY,
  computeChannelEdgePoints,
  buildChannelPathD,
  buildVisibleChannelPathD,
  getOrthogonalPathMidpointWithAngle,
} from '../EdgeRenderer';
import type { EdgeRendererProps } from '../EdgeRenderer';
import type { NodePosition } from '../types';
import type { ResolvedWorkflowChannel } from '../EdgeRenderer';

afterEach(() => cleanup());

const NODE_POSITIONS: NodePosition = {
  'step-1': { x: 50, y: 50, width: 160, height: 80 },
  'step-2': { x: 300, y: 250, width: 160, height: 80 },
  'step-3': { x: 50, y: 450, width: 160, height: 80 },
};

function makeTransition(
  id: string,
  from: string,
  to: string,
  conditionType?: 'always' | 'human' | 'condition'
): VisualTransition {
  return {
    id,
    from,
    to,
    condition: conditionType ? { type: conditionType } : undefined,
  };
}

const T1 = makeTransition('t1', 'step-1', 'step-2');
const T2 = makeTransition('t2', 'step-2', 'step-3', 'human');
const T3 = makeTransition('t3', 'step-1', 'step-3', 'condition');

function renderEdges(props: Partial<EdgeRendererProps> = {}) {
  const onEdgeSelect = vi.fn();
  const onEdgeDelete = vi.fn();
  const result = render(
    <svg>
      <EdgeRenderer
        transitions={[T1, T2, T3]}
        nodePositions={NODE_POSITIONS}
        onEdgeSelect={onEdgeSelect}
        onEdgeDelete={onEdgeDelete}
        {...props}
      />
    </svg>
  );
  return { ...result, onEdgeSelect, onEdgeDelete };
}

function getVisiblePath(group: Element): Element {
  return group.querySelectorAll('path')[1];
}

describe('computeEdgePoints', () => {
  it('returns null when from-node is missing', () => {
    const t = makeTransition('t', 'missing', 'step-2');
    expect(computeEdgePoints(t, NODE_POSITIONS)).toBeNull();
  });

  it('returns null when to-node is missing', () => {
    const t = makeTransition('t', 'step-1', 'missing');
    expect(computeEdgePoints(t, NODE_POSITIONS)).toBeNull();
  });

  it('source x is horizontal center of from-node', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    expect(pts).not.toBeNull();
    expect(pts!.sx).toBe(50 + 160 / 2);
  });

  it('source y is bottom edge of from-node', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    expect(pts!.sy).toBe(50 + 80);
  });

  it('target x is horizontal center of to-node', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    expect(pts!.tx).toBe(300 + 160 / 2);
  });

  it('target y is top edge of to-node', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    expect(pts!.ty).toBe(250);
  });

  it('control point 1 is directly below source by CONTROL_OFFSET', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    expect(pts!.cp1x).toBe(pts!.sx);
    expect(pts!.cp1y).toBe(pts!.sy + CONTROL_OFFSET);
  });

  it('control point 2 is directly above target by CONTROL_OFFSET', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    expect(pts!.cp2x).toBe(pts!.tx);
    expect(pts!.cp2y).toBe(pts!.ty - CONTROL_OFFSET);
  });
});

describe('buildPathD', () => {
  it('produces a valid SVG cubic bezier path string', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS)!;
    const d = buildPathD(pts);
    expect(d).toBe(
      `M ${pts.sx} ${pts.sy} C ${pts.cp1x} ${pts.cp1y}, ${pts.cp2x} ${pts.cp2y}, ${pts.tx} ${pts.ty}`
    );
  });
});

describe('EdgeRenderer — rendering', () => {
  it('renders a <g> element for each transition', () => {
    const { container } = renderEdges();
    const groups = container.querySelectorAll('g[data-edge-id]');
    expect(groups).toHaveLength(3);
  });

  it('renders two paths per edge (hitbox + visible)', () => {
    const { container } = renderEdges();
    const groups = container.querySelectorAll('g[data-edge-id]');
    for (const g of groups) {
      expect(g.querySelectorAll('path')).toHaveLength(2);
    }
  });

  it('skips edges where node positions are missing', () => {
    const missingEdge = makeTransition('tmissing', 'step-1', 'missing-node');
    const { container } = renderEdges({ transitions: [T1, missingEdge] });
    const groups = container.querySelectorAll('g[data-edge-id]');
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute('data-edge-id')).toBe('t1');
  });

  it('renders arrowhead marker <defs>', () => {
    const { container } = renderEdges();
    const defs = container.querySelector('defs');
    expect(defs).not.toBeNull();
    expect(defs!.querySelectorAll('marker')).toHaveLength(5);
  });

  it('uses testid data-testid="edge-{id}" on each group', () => {
    const { getByTestId } = renderEdges();
    expect(getByTestId('edge-t1')).toBeTruthy();
    expect(getByTestId('edge-t2')).toBeTruthy();
    expect(getByTestId('edge-t3')).toBeTruthy();
  });

  it('multiple instances have non-colliding marker IDs', () => {
    const { container: c1 } = render(
      <svg>
        <EdgeRenderer transitions={[T1]} nodePositions={NODE_POSITIONS} />
      </svg>
    );
    const { container: c2 } = render(
      <svg>
        <EdgeRenderer transitions={[T1]} nodePositions={NODE_POSITIONS} />
      </svg>
    );
    const markers1 = Array.from(c1.querySelectorAll('marker')).map((m) => m.id);
    const markers2 = Array.from(c2.querySelectorAll('marker')).map((m) => m.id);
    const overlap = markers1.filter((id) => markers2.includes(id));
    expect(overlap).toHaveLength(0);
    cleanup();
  });
});

describe('EdgeRenderer — edge colors', () => {
  it('EDGE_COLORS has correct hex values for all condition types', () => {
    expect(EDGE_COLORS.always).toBe('#3b82f6');
    expect(EDGE_COLORS.human).toBe('#facc15');
    expect(EDGE_COLORS.condition).toBe('#c084fc');
  });

  it('always transition (no condition) has data-condition-type="always"', () => {
    const { getByTestId } = renderEdges();
    expect(getByTestId('edge-t1').getAttribute('data-condition-type')).toBe('always');
  });

  it('human transition has data-condition-type="human"', () => {
    const { getByTestId } = renderEdges();
    expect(getByTestId('edge-t2').getAttribute('data-condition-type')).toBe('human');
  });

  it('condition transition has data-condition-type="condition"', () => {
    const { getByTestId } = renderEdges();
    expect(getByTestId('edge-t3').getAttribute('data-condition-type')).toBe('condition');
  });

  it('always transition visible path has correct stroke color', () => {
    const { getByTestId } = renderEdges();
    const visible = getVisiblePath(getByTestId('edge-t1'));
    expect(visible.getAttribute('data-stroke-color')).toBe(EDGE_COLORS.always);
  });

  it('human transition visible path has correct stroke color', () => {
    const { getByTestId } = renderEdges();
    const visible = getVisiblePath(getByTestId('edge-t2'));
    expect(visible.getAttribute('data-stroke-color')).toBe(EDGE_COLORS.human);
  });

  it('condition transition visible path has correct stroke color', () => {
    const { getByTestId } = renderEdges();
    const visible = getVisiblePath(getByTestId('edge-t3'));
    expect(visible.getAttribute('data-stroke-color')).toBe(EDGE_COLORS.condition);
  });
});

describe('EdgeRenderer — selected state', () => {
  it('selected edge has data-selected="true"', () => {
    const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
    expect(getByTestId('edge-t1').getAttribute('data-selected')).toBe('true');
  });

  it('non-selected edges have data-selected="false"', () => {
    const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
    expect(getByTestId('edge-t2').getAttribute('data-selected')).toBe('false');
    expect(getByTestId('edge-t3').getAttribute('data-selected')).toBe('false');
  });

  it('selected edge visible path uses the theme foreground stroke color', () => {
    const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
    const visible = getVisiblePath(getByTestId('edge-t1'));
    expect(visible.getAttribute('data-stroke-color')).toBe('var(--fg)');
  });

  it('selected edge visible path has thicker stroke-width than normal', () => {
    const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
    const selectedVisible = getVisiblePath(getByTestId('edge-t1'));
    const normalVisible = getVisiblePath(getByTestId('edge-t2'));
    const selectedWidth = parseFloat(selectedVisible.getAttribute('data-stroke-width') ?? '0');
    const normalWidth = parseFloat(normalVisible.getAttribute('data-stroke-width') ?? '0');
    expect(selectedWidth).toBe(SELECTED_STROKE_WIDTH);
    expect(normalWidth).toBe(NORMAL_STROKE_WIDTH);
    expect(selectedWidth).toBeGreaterThan(normalWidth);
  });

  it('non-selected edges retain their condition color when one is selected', () => {
    const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
    expect(getVisiblePath(getByTestId('edge-t2')).getAttribute('data-stroke-color')).toBe(
      EDGE_COLORS.human
    );
  });
});

describe('EdgeRenderer — click selection', () => {
  it('clicking an edge calls onEdgeSelect with the transitionId', () => {
    const { getByTestId, onEdgeSelect } = renderEdges();
    const group = getByTestId('edge-t1');
    const hitboxPath = group.querySelectorAll('path')[0];
    fireEvent.click(hitboxPath);
    expect(onEdgeSelect).toHaveBeenCalledWith('t1');
  });

  it('clicking a different edge calls onEdgeSelect with its id', () => {
    const { getByTestId, onEdgeSelect } = renderEdges();
    const group = getByTestId('edge-t2');
    const hitboxPath = group.querySelectorAll('path')[0];
    fireEvent.click(hitboxPath);
    expect(onEdgeSelect).toHaveBeenCalledWith('t2');
  });

  it('hitbox path uses transparent stroke', () => {
    const { getByTestId } = renderEdges();
    const group = getByTestId('edge-t1');
    const hitboxPath = group.querySelectorAll('path')[0];
    expect(hitboxPath.getAttribute('stroke')).toBe('transparent');
  });
});

describe('EdgeRenderer — keyboard delete', () => {
  it('Delete key calls onEdgeDelete with selected edgeId', () => {
    const { onEdgeDelete } = renderEdges({ selectedEdgeId: 't1' });
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(onEdgeDelete).toHaveBeenCalledWith('t1');
  });

  it('Backspace key calls onEdgeDelete with selected edgeId', () => {
    const { onEdgeDelete } = renderEdges({ selectedEdgeId: 't2' });
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(onEdgeDelete).toHaveBeenCalledWith('t2');
  });

  it('Delete without selection does not call onEdgeDelete', () => {
    const { onEdgeDelete } = renderEdges({ selectedEdgeId: null });
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(onEdgeDelete).not.toHaveBeenCalled();
  });

  it('Delete inside an input does not trigger onEdgeDelete', () => {
    const { onEdgeDelete, container } = renderEdges({ selectedEdgeId: 't1' });
    const input = document.createElement('input');
    container.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'Delete', target: input });
    expect(onEdgeDelete).not.toHaveBeenCalled();
  });

  it('Delete inside a textarea does not trigger onEdgeDelete', () => {
    const { onEdgeDelete, container } = renderEdges({ selectedEdgeId: 't1' });
    const textarea = document.createElement('textarea');
    container.appendChild(textarea);
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Delete', target: textarea });
    expect(onEdgeDelete).not.toHaveBeenCalled();
  });

  it('Delete inside a contenteditable element does not trigger onEdgeDelete', () => {
    const { onEdgeDelete, container } = renderEdges({ selectedEdgeId: 't1' });
    const div = document.createElement('div');
    div.contentEditable = 'true';
    container.appendChild(div);
    div.focus();
    fireEvent.keyDown(div, { key: 'Delete', target: div });
    expect(onEdgeDelete).not.toHaveBeenCalled();
  });
});

describe('Channel edge constants', () => {
  it('CHANNEL_EDGE_COLOR is teal', () => {
    expect(CHANNEL_EDGE_COLOR).toBe('#14b8a6');
  });

  it('CHANNEL_EDGE_DASH_ARRAY is a dashed pattern', () => {
    expect(CHANNEL_EDGE_DASH_ARRAY).toBe('6 4');
  });
});

describe('computeChannelEdgePoints', () => {
  it('returns null when from-node is missing', () => {
    const channel: ResolvedWorkflowChannel = {
      direction: 'one-way' as const,
      fromStepId: 'missing',
      toStepId: 'step-2',
    };
    expect(computeChannelEdgePoints(channel, NODE_POSITIONS)).toBeNull();
  });

  it('returns null when to-node is missing', () => {
    const channel: ResolvedWorkflowChannel = {
      direction: 'one-way' as const,
      fromStepId: 'step-1',
      toStepId: 'missing',
    };
    expect(computeChannelEdgePoints(channel, NODE_POSITIONS)).toBeNull();
  });

  it('source x is bottom-center of from-node for regular channel', () => {
    const channel: ResolvedWorkflowChannel = {
      direction: 'one-way' as const,
      fromStepId: 'step-1',
      toStepId: 'step-2',
    };
    const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
    expect(pts).not.toBeNull();
    expect(pts!.sx).toBe(50 + 160 / 2);
  });

  it('source y is bottom edge of from-node', () => {
    const channel: ResolvedWorkflowChannel = {
      direction: 'one-way' as const,
      fromStepId: 'step-1',
      toStepId: 'step-2',
    };
    const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
    expect(pts).not.toBeNull();
    expect(pts!.sy).toBe(50 + 80);
  });

  it('target x is top-center of to-node', () => {
    const channel: ResolvedWorkflowChannel = {
      direction: 'one-way' as const,
      fromStepId: 'step-1',
      toStepId: 'step-2',
    };
    const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
    expect(pts).not.toBeNull();
    expect(pts!.tx).toBe(300 + 160 / 2);
  });

  it('target y is top edge of to-node', () => {
    const channel: ResolvedWorkflowChannel = {
      direction: 'one-way' as const,
      fromStepId: 'step-1',
      toStepId: 'step-2',
    };
    const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
    expect(pts).not.toBeNull();
    expect(pts!.ty).toBe(250);
  });

  it('builds an orthogonal path for routed semantic channels', () => {
    const channel: ResolvedWorkflowChannel = {
      direction: 'one-way' as const,
      fromStepId: 'step-1',
      toStepId: 'step-2',
      sourceSide: 'right',
      targetSide: 'left',
    };
    const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
    expect(pts).not.toBeNull();
    const d = buildChannelPathD(channel, pts!);
    expect(d).toContain('L');
    expect(d).toContain('Q');
    expect(d.startsWith(`M ${pts!.sx} ${pts!.sy}`)).toBe(true);
    expect(d.endsWith(`${pts!.tx} ${pts!.ty}`)).toBe(true);
  });

  it('trims the visible bidirectional channel path so arrowheads are not buried in nodes', () => {
    const channel: ResolvedWorkflowChannel = {
      direction: 'bidirectional' as const,
      fromStepId: 'step-1',
      toStepId: 'step-2',
      sourceSide: 'right',
      targetSide: 'left',
    };
    const pts = computeChannelEdgePoints(channel, NODE_POSITIONS);
    expect(pts).not.toBeNull();
    const d = buildVisibleChannelPathD(channel, pts!);
    expect(d.startsWith(`M ${pts!.sx} ${pts!.sy}`)).toBe(false);
    expect(d.endsWith(`${pts!.tx} ${pts!.ty}`)).toBe(false);
  });
});

function renderEdgesWithChannels(props: Partial<EdgeRendererProps> = {}) {
  const onEdgeSelect = vi.fn();
  const onEdgeDelete = vi.fn();
  const onChannelSelect = vi.fn();
  const result = render(
    <svg>
      <EdgeRenderer
        transitions={[T1, T2, T3]}
        nodePositions={NODE_POSITIONS}
        onEdgeSelect={onEdgeSelect}
        onEdgeDelete={onEdgeDelete}
        onChannelSelect={onChannelSelect}
        {...props}
      />
    </svg>
  );
  return { ...result, onEdgeSelect, onEdgeDelete, onChannelSelect };
}

describe('EdgeRenderer — channel edge rendering', () => {
  it('renders channel edges when channels prop is provided', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-3', toStepId: 'step-1', direction: 'one-way' as const },
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'bidirectional' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const channelEdgeGroups = container.querySelectorAll('g[data-channel-edge="true"]');
    expect(channelEdgeGroups).toHaveLength(2);
  });

  it('channel edges have correct data-testid attribute', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-3', toStepId: 'step-1', direction: 'one-way' as const },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    expect(getByTestId('channel-edge-step-3-step-1')).toBeTruthy();
  });

  it('channel edges have correct data-channel-direction attribute', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-3', toStepId: 'step-1', direction: 'one-way' as const },
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'bidirectional' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const bidirectional = container.querySelector('g[data-channel-direction="bidirectional"]');
    const oneWay = container.querySelector('g[data-channel-direction="one-way"]');
    expect(bidirectional).toBeTruthy();
    expect(oneWay).toBeTruthy();
  });

  it('bidirectional channel has both markerStart and markerEnd on visible path', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'bidirectional' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const visiblePath = container.querySelector(
      'g[data-channel-edge="true"] path:not([stroke="transparent"])'
    );
    expect(visiblePath).not.toBeNull();
    const markerStart = visiblePath!.getAttribute('markerStart');
    const markerEnd = visiblePath!.getAttribute('markerEnd');
    expect(markerStart).toContain('channel-end');
    expect(markerEnd).toContain('channel-end');
  });

  it('one-way channel has only markerEnd on visible path', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const visiblePath = container.querySelector(
      'g[data-channel-edge="true"] path:not([stroke="transparent"])'
    );
    expect(visiblePath).not.toBeNull();
    const markerStart = visiblePath!.getAttribute('markerStart');
    const markerEnd = visiblePath!.getAttribute('markerEnd');
    expect(markerStart).toBeNull();
    expect(markerEnd).toContain('channel-end');
  });

  it('selected channel uses the theme foreground selected arrowhead marker', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        id: 'plan:review',
        fromStepId: 'step-1',
        toStepId: 'step-2',
        direction: 'bidirectional' as const,
      },
    ];
    const { container } = renderEdgesWithChannels({
      channels,
      selectedChannelId: 'plan:review',
    });
    const visiblePath = container.querySelector(
      'g[data-channel-edge="true"] path:not([stroke="transparent"])'
    );
    expect(visiblePath).not.toBeNull();
    expect(visiblePath!.getAttribute('stroke')).toBe('var(--fg)');
    expect(visiblePath!.getAttribute('markerStart')).toContain('channel-selected');
    expect(visiblePath!.getAttribute('markerEnd')).toContain('channel-selected');
    const selectedMarkerPath = container.querySelector('marker[id*="channel-selected"] path');
    expect(selectedMarkerPath?.getAttribute('fill')).toBe('var(--fg)');
  });

  it('one-way ungated channel edges use dashed stroke style', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const visiblePath = container.querySelector(
      'g[data-channel-edge="true"] path:not([stroke="transparent"])'
    );
    expect(visiblePath).not.toBeNull();
    expect(visiblePath!.getAttribute('strokeDasharray')).toBe(CHANNEL_EDGE_DASH_ARRAY);
  });

  it('bidirectional channel edges use solid stroke style', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'bidirectional' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const visiblePath = container.querySelector(
      'g[data-channel-edge="true"] path:not([stroke="transparent"])'
    );
    expect(visiblePath).not.toBeNull();
    expect(visiblePath!.getAttribute('strokeDasharray')).toBeNull();
  });

  it('renders a loop badge when a channel is cyclic', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-2',
        toStepId: 'step-1',
        isCyclic: true,
      },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    expect(getByTestId('channel-loop-step-2-step-1').textContent).toBe('Loop');
  });

  it('channel edges use teal color (distinct from transition edge colors)', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const visiblePath = container.querySelector(
      'g[data-channel-edge="true"] path:not([stroke="transparent"])'
    );
    expect(visiblePath).not.toBeNull();
    expect(visiblePath!.getAttribute('stroke')).toBe(CHANNEL_EDGE_COLOR);
    expect(CHANNEL_EDGE_COLOR).not.toBe(EDGE_COLORS.always);
    expect(CHANNEL_EDGE_COLOR).not.toBe(EDGE_COLORS.human);
    expect(CHANNEL_EDGE_COLOR).not.toBe(EDGE_COLORS.condition);
  });

  it('skips channel edges where target node position is missing', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' as const },
      { fromStepId: 'step-1', toStepId: 'missing-node', direction: 'one-way' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const channelEdgeGroups = container.querySelectorAll('g[data-channel-edge="true"]');
    expect(channelEdgeGroups).toHaveLength(1);
  });

  it('channel edge defs include channel arrowhead markers', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' as const },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const defs = container.querySelector('defs');
    expect(defs).not.toBeNull();
    const channelEndMarker = defs!.querySelector('marker[id*="channel-end"]');
    expect(channelEndMarker).not.toBeNull();
    expect(channelEndMarker?.getAttribute('orient')).toBe('auto-start-reverse');
  });
});

describe('getOrthogonalPathMidpointWithAngle', () => {
  it('returns angle=0 for a single horizontal rightward segment', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const result = getOrthogonalPathMidpointWithAngle(pts);
    expect(result.x).toBe(50);
    expect(result.y).toBe(0);
    expect(result.angle).toBe(0);
  });

  it('returns angle=180 for a leftward horizontal segment', () => {
    const pts = [
      { x: 100, y: 0 },
      { x: 0, y: 0 },
    ];
    const result = getOrthogonalPathMidpointWithAngle(pts);
    expect(result.x).toBe(50);
    expect(result.y).toBe(0);
    expect(result.angle).toBe(180);
  });

  it('returns angle=90 for a downward vertical segment', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ];
    const result = getOrthogonalPathMidpointWithAngle(pts);
    expect(result.x).toBe(0);
    expect(result.y).toBe(50);
    expect(result.angle).toBe(90);
  });

  it('returns angle=270 for an upward vertical segment', () => {
    const pts = [
      { x: 0, y: 100 },
      { x: 0, y: 0 },
    ];
    const result = getOrthogonalPathMidpointWithAngle(pts);
    expect(result.x).toBe(0);
    expect(result.y).toBe(50);
    expect(result.angle).toBe(270);
  });

  it('returns the angle of the segment the midpoint falls on in a multi-segment L-path', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
    ];
    const result = getOrthogonalPathMidpointWithAngle(pts);
    expect(result.x).toBe(60);
    expect(result.y).toBe(0);
    expect(result.angle).toBe(0);
  });

  it('midpoint angle follows the segment with more path length', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 100 },
    ];
    const result = getOrthogonalPathMidpointWithAngle(pts);
    expect(result.x).toBe(20);
    expect(result.y).toBe(40);
    expect(result.angle).toBe(90);
  });

  it('returns angle=0 and last point when all points are equal', () => {
    const pts = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    const result = getOrthogonalPathMidpointWithAngle(pts);
    expect(result.x).toBe(5);
    expect(result.y).toBe(5);
    expect(result.angle).toBe(0);
  });

  it('returns angle=0 for an empty points array', () => {
    const result = getOrthogonalPathMidpointWithAngle([]);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.angle).toBe(0);
  });
});
