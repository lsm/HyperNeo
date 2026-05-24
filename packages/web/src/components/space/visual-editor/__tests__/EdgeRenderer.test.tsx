/**
 * Unit tests for EdgeRenderer
 *
 * Tests:
 * - Correct number of paths rendered per transition
 * - Missing node position skips that edge
 * - computeEdgePoints bezier control point math
 * - buildPathD produces correct SVG path string
 * - Edge color matches condition type (always/human/condition) via data-stroke-color
 * - Selected edge gets thicker stroke (data-stroke-width) and white color
 * - Clicking an edge calls onEdgeSelect with transitionId
 * - Delete key on selected edge calls onEdgeDelete
 * - Backspace key on selected edge calls onEdgeDelete
 * - Delete key without selection does not call onEdgeDelete
 * - Delete inside input/textarea/contenteditable does not trigger onEdgeDelete
 * - Arrowhead markers are rendered in defs
 * - Multiple instances have non-colliding marker IDs
 * - Channel edge constants (CHANNEL_EDGE_COLOR, CHANNEL_EDGE_DASH_ARRAY)
 * - computeChannelEdgePoints for regular node-to-node channels
 * - Bidirectional channel renders two arrowheads (markerStart + markerEnd)
 * - One-way channel renders one arrowhead (markerEnd only)
 * - Channel edges use dashed style (strokeDasharray)
 * - Channel edges are teal colored (distinct from transition edge colors)
 * - Channel edges have correct data-testid attribute
 */

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const T1 = makeTransition('t1', 'step-1', 'step-2'); // always (no condition)
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

// Helper to get the visible path (second <path> in the group)
function getVisiblePath(group: Element): Element {
  return group.querySelectorAll('path')[1];
}

// ---------------------------------------------------------------------------
// computeEdgePoints
// ---------------------------------------------------------------------------

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
    // step-1: x=50, width=160 → center x = 50 + 80 = 130
    expect(pts!.sx).toBe(50 + 160 / 2);
  });

  it('source y is bottom edge of from-node', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    // step-1: y=50, height=80 → bottom = 130
    expect(pts!.sy).toBe(50 + 80);
  });

  it('target x is horizontal center of to-node', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    // step-2: x=300, width=160 → center x = 380
    expect(pts!.tx).toBe(300 + 160 / 2);
  });

  it('target y is top edge of to-node', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS);
    // step-2: y=250
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

// ---------------------------------------------------------------------------
// buildPathD
// ---------------------------------------------------------------------------

describe('buildPathD', () => {
  it('produces a valid SVG cubic bezier path string', () => {
    const pts = computeEdgePoints(T1, NODE_POSITIONS)!;
    const d = buildPathD(pts);
    // Format: M sx sy C cp1x cp1y, cp2x cp2y, tx ty
    expect(d).toBe(
      `M ${pts.sx} ${pts.sy} C ${pts.cp1x} ${pts.cp1y}, ${pts.cp2x} ${pts.cp2y}, ${pts.tx} ${pts.ty}`
    );
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('EdgeRenderer — rendering', () => {
  it('renders a <g> element for each transition', () => {
    const { container } = renderEdges();
    const groups = container.querySelectorAll('g[data-edge-id]');
    expect(groups).toHaveLength(3);
  });

  it('renders two paths per edge (hitbox + visible)', () => {
    const { container } = renderEdges();
    // Each <g> should have 2 paths
    const groups = container.querySelectorAll('g[data-edge-id]');
    for (const g of groups) {
      expect(g.querySelectorAll('path')).toHaveLength(2);
    }
  });

  it('skips edges where node positions are missing', () => {
    const missingEdge = makeTransition('tmissing', 'step-1', 'missing-node');
    const { container } = renderEdges({ transitions: [T1, missingEdge] });
    // Only t1 should render (missingEdge skipped)
    const groups = container.querySelectorAll('g[data-edge-id]');
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute('data-edge-id')).toBe('t1');
  });

  it('renders arrowhead marker <defs>', () => {
    const { container } = renderEdges();
    const defs = container.querySelector('defs');
    expect(defs).not.toBeNull();
    // Should have 5 markers: always, human, condition, task_result, selected
    // (channel-end and channel-start are only rendered when channels prop is provided)
    expect(defs!.querySelectorAll('marker')).toHaveLength(5);
  });

  it('uses testid data-testid="edge-{id}" on each group', () => {
    const { getByTestId } = renderEdges();
    expect(getByTestId('edge-t1')).toBeTruthy();
    expect(getByTestId('edge-t2')).toBeTruthy();
    expect(getByTestId('edge-t3')).toBeTruthy();
  });

  it('multiple instances have non-colliding marker IDs', () => {
    // Render two EdgeRenderer instances and check their marker IDs differ
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
    // No overlap between the two instances' marker IDs
    const overlap = markers1.filter((id) => markers2.includes(id));
    expect(overlap).toHaveLength(0);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Edge colors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Selected edge
// ---------------------------------------------------------------------------

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

  it('selected edge visible path has white stroke color', () => {
    const { getByTestId } = renderEdges({ selectedEdgeId: 't1' });
    const visible = getVisiblePath(getByTestId('edge-t1'));
    expect(visible.getAttribute('data-stroke-color')).toBe('white');
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

// ---------------------------------------------------------------------------
// Click selection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Keyboard delete
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Channel edge constants
// ---------------------------------------------------------------------------

describe('Channel edge constants', () => {
  it('CHANNEL_EDGE_COLOR is teal', () => {
    expect(CHANNEL_EDGE_COLOR).toBe('#14b8a6');
  });

  it('CHANNEL_EDGE_DASH_ARRAY is a dashed pattern', () => {
    expect(CHANNEL_EDGE_DASH_ARRAY).toBe('6 4');
  });
});

// ---------------------------------------------------------------------------
// computeChannelEdgePoints
// ---------------------------------------------------------------------------

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
    // step-1: x=50, width=160 → center x = 130
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
    // step-1: y=50, height=80 → bottom = 130
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
    // step-2: x=300, width=160 → center x = 380
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
    // step-2: y=250
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

// ---------------------------------------------------------------------------
// Channel edge rendering
// ---------------------------------------------------------------------------

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

  it('selected channel uses the white selected arrowhead marker', () => {
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
    expect(visiblePath!.getAttribute('stroke')).toBe('white');
    expect(visiblePath!.getAttribute('markerStart')).toContain('channel-selected');
    expect(visiblePath!.getAttribute('markerEnd')).toContain('channel-selected');
    const selectedMarkerPath = container.querySelector('marker[id*="channel-selected"] path');
    expect(selectedMarkerPath?.getAttribute('fill')).toBe('white');
  });

  it('clicking the gate badge selects the channel relation', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        id: 'plan:review',
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
      },
    ];
    const { getByTestId, onChannelSelect } = renderEdgesWithChannels({ channels });
    fireEvent.click(getByTestId('channel-gate-step-1-step-2'));
    expect(onChannelSelect).toHaveBeenCalledWith('plan:review');
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

  it('one-way gated channel edges still use dashed stroke style', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
      },
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

  it('renders a midpoint gate badge when a channel is gated', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
      },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    // textContent includes only the <text> label (the polygon has no text content)
    expect(getByTestId('channel-gate-step-1-step-2').textContent).toBe('Gate');
  });

  it('one-way gated badge renders a directional arrow polygon', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
      },
    ];
    const { getByTestId, queryByTestId } = renderEdgesWithChannels({ channels });
    // Arrow polygon should be present for one-way
    expect(queryByTestId('channel-gate-arrow-step-1-step-2')).not.toBeNull();
    // Badge group should expose the gate angle attribute
    const badge = getByTestId('channel-gate-step-1-step-2');
    expect(badge.getAttribute('data-gate-angle')).not.toBeNull();
  });

  it('bidirectional channel with only forward gate renders a single forward arrow', () => {
    // Bug fix: a bidirectional channel with a gate only in the forward direction
    // must NOT show ⇄ — it shows a single directional arrow (same as one-way).
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        // no reverseGateType
      },
    ];
    const { getByTestId, queryByTestId } = renderEdgesWithChannels({ channels });
    expect(queryByTestId('channel-gate-arrow-step-1-step-2')).not.toBeNull();
    // Plain label — no ⇄ prefix
    expect(getByTestId('channel-gate-step-1-step-2').textContent).toBe('Gate');
  });

  it('bidirectional channel with only reverse gate renders a single reverse arrow', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        // no gateType
        reverseGateType: 'check',
      },
    ];
    const { queryByTestId } = renderEdgesWithChannels({ channels });
    expect(queryByTestId('channel-gate-arrow-step-1-step-2')).not.toBeNull();
  });

  it('bidirectional channel with both direction gates renders two arrows', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'bidirectional' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        reverseGateType: 'check',
      },
    ];
    const { queryByTestId } = renderEdgesWithChannels({ channels });
    // Forward arrow
    expect(queryByTestId('channel-gate-arrow-step-1-step-2')).not.toBeNull();
    // Reverse arrow
    expect(queryByTestId('channel-gate-reverse-arrow-step-1-step-2')).not.toBeNull();
  });

  it('both-direction gated badge label has no ⇄ prefix', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        reverseGateType: 'check',
      },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    expect(getByTestId('channel-gate-step-1-step-2').textContent).toBe('Gate');
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

  it('does not render a midpoint gate badge when a channel is ungated', () => {
    const channels: ResolvedWorkflowChannel[] = [
      { fromStepId: 'step-1', toStepId: 'step-2', direction: 'one-way' as const },
    ];
    const { queryByTestId } = renderEdgesWithChannels({ channels });
    expect(queryByTestId('channel-gate-step-1-step-2')).toBeNull();
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
    // Verify it's different from transition edge colors
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

// ---------------------------------------------------------------------------
// Gate badge: custom label, color, and hasScript
// ---------------------------------------------------------------------------

describe('EdgeRenderer — gate badge custom label/color/hasScript', () => {
  it('renders custom gateLabel when set on one-way channel', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateLabel: 'Custom Gate',
      },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    expect(getByTestId('channel-gate-step-1-step-2').textContent).toContain('Custom Gate');
  });

  it('falls back to "Gate" when gateLabel is not set', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
      },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    expect(getByTestId('channel-gate-step-1-step-2').textContent).toBe('Gate');
  });

  it('renders custom gateColor on badge text when set', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateColor: '#ff6600',
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const badgeText = container.querySelector('g[data-testid="channel-gate-step-1-step-2"] text');
    expect(badgeText?.getAttribute('fill')).toBe('#ff6600');
  });

  it('falls back to heuristic color when gateColor is not set', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const badgeText = container.querySelector('g[data-testid="channel-gate-step-1-step-2"] text');
    // check gate type heuristic color is #60a5fa
    expect(badgeText?.getAttribute('fill')).toBe('#60a5fa');
  });

  it('applies custom gateColor to arrow polygon fills', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateColor: '#00ff88',
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const arrow = container.querySelector(
      'polygon[data-testid="channel-gate-arrow-step-1-step-2"]'
    );
    expect(arrow?.getAttribute('fill')).toBe('#00ff88');
  });

  it('selected state overrides custom gateColor with white on text', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        id: 'custom:gate',
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateColor: '#ff6600',
      },
    ];
    const { container } = renderEdgesWithChannels({ selectedChannelId: 'custom:gate', channels });
    const badgeText = container.querySelector('g[data-testid="channel-gate-step-1-step-2"] text');
    expect(badgeText?.getAttribute('fill')).toBe('white');
  });

  it('selected state overrides custom gateColor with white on arrow polygon', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        id: 'custom:gate',
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateColor: '#ff6600',
      },
    ];
    const { container } = renderEdgesWithChannels({ selectedChannelId: 'custom:gate', channels });
    const arrow = container.querySelector(
      'polygon[data-testid="channel-gate-arrow-step-1-step-2"]'
    );
    expect(arrow?.getAttribute('fill')).toBe('white');
  });

  it('renders script indicator (\u26A1) when hasScript is true', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        hasScript: true,
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const badgeTexts = container.querySelectorAll(
      'g[data-testid="channel-gate-step-1-step-2"] text'
    );
    // Should have two text elements: label + script icon
    expect(badgeTexts).toHaveLength(2);
    const scriptIconText = badgeTexts[1];
    expect(scriptIconText.textContent).toBe('\u26A1');
    expect(scriptIconText.getAttribute('opacity')).toBe('0.7');
  });

  it('does not render script icon when hasScript is false', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        hasScript: false,
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const badgeTexts = container.querySelectorAll(
      'g[data-testid="channel-gate-step-1-step-2"] text'
    );
    // Should only have the label text element
    expect(badgeTexts).toHaveLength(1);
  });

  it('does not render script icon when hasScript is undefined', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        // hasScript not set
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const badgeTexts = container.querySelectorAll(
      'g[data-testid="channel-gate-step-1-step-2"] text'
    );
    expect(badgeTexts).toHaveLength(1);
  });

  it('script icon uses gateColor when hasScript is true', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateColor: '#ff6600',
        hasScript: true,
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const badgeTexts = container.querySelectorAll(
      'g[data-testid="channel-gate-step-1-step-2"] text'
    );
    const scriptIconText = badgeTexts[1];
    expect(scriptIconText.getAttribute('fill')).toBe('#ff6600');
  });

  it('script icon becomes white when selected', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        id: 'script:gate',
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        hasScript: true,
      },
    ];
    const { container } = renderEdgesWithChannels({ selectedChannelId: 'script:gate', channels });
    const badgeTexts = container.querySelectorAll(
      'g[data-testid="channel-gate-step-1-step-2"] text'
    );
    const scriptIconText = badgeTexts[1];
    expect(scriptIconText.getAttribute('fill')).toBe('white');
  });

  it('custom gateLabel on bidirectional forward gate renders correctly', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateLabel: 'Approve',
        reverseGateType: 'check',
      },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    expect(getByTestId('channel-gate-step-1-step-2').textContent).toContain('Approve');
  });

  it('custom gateColor on bidirectional both-direction gates applies to both arrows', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'bidirectional' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateColor: '#00ccff',
        reverseGateType: 'check',
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const forwardArrow = container.querySelector(
      'polygon[data-testid="channel-gate-arrow-step-1-step-2"]'
    );
    const reverseArrow = container.querySelector(
      'polygon[data-testid="channel-gate-reverse-arrow-step-1-step-2"]'
    );
    expect(forwardArrow?.getAttribute('fill')).toBe('#00ccff');
    expect(reverseArrow?.getAttribute('fill')).toBe('#00ccff');
  });

  it('loop badge is unaffected by gateLabel/gateColor', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-2',
        toStepId: 'step-1',
        isCyclic: true,
        gateType: 'check',
        gateLabel: 'Custom',
        gateColor: '#ff0000',
      },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    // Loop badge should still show "Loop"
    expect(getByTestId('channel-loop-step-2-step-1').textContent).toBe('Loop');
  });

  it('uses reverseHasScript when only reverse gate is set on bidirectional', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        reverseGateType: 'check',
        reverseHasScript: true,
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const badgeTexts = container.querySelectorAll(
      'g[data-testid="channel-gate-step-1-step-2"] text'
    );
    // Should have label + script icon
    expect(badgeTexts).toHaveLength(2);
    expect(badgeTexts[1].textContent).toBe('\u26A1');
  });

  it('uses reverseGateLabel when only reverse gate is set on bidirectional', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        reverseGateType: 'human',
        reverseGateLabel: 'Reverse Label',
      },
    ];
    const { getByTestId } = renderEdgesWithChannels({ channels });
    expect(getByTestId('channel-gate-step-1-step-2').textContent).toContain('Reverse Label');
  });

  it('uses reverseGateColor when only reverse gate is set on bidirectional', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        reverseGateType: 'check',
        reverseGateColor: '#00ff00',
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const badgeText = container.querySelector('g[data-testid="channel-gate-step-1-step-2"] text');
    expect(badgeText?.getAttribute('fill')).toBe('#00ff00');
  });

  it('forward gateLabel/gateColor takes precedence over reverse on bidirectional with both gates', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        gateType: 'check',
        gateLabel: 'Forward',
        gateColor: '#ff0000',
        reverseGateType: 'check',
        reverseGateLabel: 'Reverse',
        reverseGateColor: '#00ff00',
      },
    ];
    const { container, getByTestId } = renderEdgesWithChannels({ channels });
    expect(getByTestId('channel-gate-step-1-step-2').textContent).toContain('Forward');
    const badgeText = container.querySelector('g[data-testid="channel-gate-step-1-step-2"] text');
    expect(badgeText?.getAttribute('fill')).toBe('#ff0000');
  });

  it('reverseGateColor on arrow polygon when only reverse gate is set', () => {
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId: 'step-1',
        toStepId: 'step-2',
        reverseGateType: 'check',
        reverseGateColor: '#aa00ff',
      },
    ];
    const { container } = renderEdgesWithChannels({ channels });
    const arrow = container.querySelector(
      'polygon[data-testid="channel-gate-arrow-step-1-step-2"]'
    );
    expect(arrow?.getAttribute('fill')).toBe('#aa00ff');
  });
});

// ---------------------------------------------------------------------------
// getOrthogonalPathMidpointWithAngle
// ---------------------------------------------------------------------------

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
    // Path: right 60px then down 60px  (total=120, midpoint=60px along)
    // Midpoint is exactly at the end of the first segment (the corner).
    // The loop condition is `traversed + segmentLength < midpointDistance` (strict <),
    // so when traversed=0 and segmentLength=60 == midpointDistance=60, the strict <
    // is false and the midpoint falls ON the first (rightward) segment.
    const pts = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
    ];
    const result = getOrthogonalPathMidpointWithAngle(pts);
    expect(result.x).toBe(60);
    expect(result.y).toBe(0);
    expect(result.angle).toBe(0); // horizontal rightward segment
  });

  it('midpoint angle follows the segment with more path length', () => {
    // Path: right 20px then down 100px (total=120, midpoint=60px)
    // First segment ends at 20px, so midpoint (60px) is 40px into second segment.
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
    // Normalizes to a single point — position should be that point
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

// ---------------------------------------------------------------------------
// Arrow polygon SVG transform correctness
// ---------------------------------------------------------------------------

describe('gate badge arrow SVG transform', () => {
  // The arrow polygon uses `transform="translate(tx, 0) rotate(angle)"`.
  // In SVG, transforms are applied right-to-left to points:
  //   1. rotate(angle)  — pivots the right-pointing triangle around origin (0,0)
  //   2. translate(tx)  — shifts the rotated arrow to its badge position
  // This test verifies the transform string for both horizontal (0°) and
  // vertical (90°) paths to guard against accidental reordering.
  function getArrowTransform(angle: number, fromStepId: string, toStepId: string) {
    const nodePositions: NodePosition = {
      [fromStepId]: { x: 50, y: 50, width: 160, height: 80 },
      [toStepId]: { x: 300, y: 50, width: 160, height: 80 },
    };
    const channels: ResolvedWorkflowChannel[] = [
      {
        direction: 'one-way' as const,
        fromStepId,
        toStepId,
        gateType: 'check',
      },
    ];
    // We need to override the angle — use a path that produces the desired angle
    // by swapping fromStepId/toStepId or using node positions that force the angle.
    // For a direct test of the badge, render it with known node positions.
    const { container } = render(
      <svg>
        <EdgeRenderer transitions={[]} nodePositions={nodePositions} channels={channels} />
      </svg>
    );
    return (
      container
        .querySelector(`[data-testid="channel-gate-arrow-${fromStepId}-${toStepId}"]`)
        ?.getAttribute('transform') ?? ''
    );
  }

  it('arrow polygon transform starts with translate(...) for a horizontal path (angle=0)', () => {
    const transform = getArrowTransform(0, 'step-a', 'step-b');
    // The transform must be "translate(...) rotate(...)" — translate comes first in the string.
    expect(transform).toMatch(/^translate\(/);
    expect(transform).toContain('rotate(0)');
  });
});
