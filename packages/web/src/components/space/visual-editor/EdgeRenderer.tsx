/**
 * EdgeRenderer
 *
 * Renders VisualTransition (canvas edge) entries as SVG cubic bezier paths.
 *
 * Each edge connects the output port (bottom-center) of the source node to the
 * input port (top-center) of the target node. Control points are offset vertically
 * by CONTROL_OFFSET px for a smooth curve.
 *
 * Edge color reflects the condition type:
 *   always    -> blue  (#3b82f6)
 *   human     -> yellow (#facc15)
 *   condition -> purple (#c084fc)
 *
 * A wider invisible hitbox path (stroke-width 12px) is rendered behind each
 * visible edge to make clicking easier. An arrowhead marker indicates direction.
 *
 * Delete/Backspace while an edge is selected calls onEdgeDelete.
 *
 * Marker IDs are prefixed with a stable per-instance ID (via useId) to prevent
 * collisions when multiple EdgeRenderer instances are mounted simultaneously.
 *
 * Channel edges are also rendered (via the channels prop). Channel edges connect
 * between routed semantic node anchors with a distinct teal style.
 * Direction is encoded by the line style:
 *   one-way       -> dashed
 *   bidirectional -> solid + double arrowheads
 * Cyclic (loop-back) channels render a Loop badge at the midpoint.
 * Channels are selectable by clicking; the selected channel highlights in white.
 */

import { useEffect, useRef } from 'preact/hooks';
import type { NodePosition, VisualTransition, WorkflowConditionType } from './types';
import type { AnchorSide } from './semanticWorkflowGraph';

// Module-level counter -- increments on each EdgeRenderer mount, giving every
// instance a unique marker ID prefix even when multiple instances are on the
// same page (e.g. split-view or comparison mode).
let _instanceCounter = 0;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Control point vertical offset for bezier curves (px, canvas space). */
export const CONTROL_OFFSET = 60;

/** Stroke colors matching GATE_COLORS from WorkflowList.tsx */
export const EDGE_COLORS: Record<WorkflowConditionType, string> = {
  always: '#3b82f6', // blue-500
  human: '#facc15', // yellow-400
  condition: '#c084fc', // purple-400
  task_result: '#f97316', // orange-500
};

export const NORMAL_STROKE_WIDTH = 1.5;
export const SELECTED_STROKE_WIDTH = 3;
export const CHANNEL_STROKE_WIDTH = 2.4;
export const CHANNEL_SELECTED_STROKE_WIDTH = 3.6;
const HITBOX_STROKE_WIDTH = 12;

// ---------------------------------------------------------------------------
// Channel edge types and constants
// ---------------------------------------------------------------------------

/**
 * A messaging channel between two nodes with resolved node IDs.
 * This is the rendered form of a WorkflowChannel where slot name strings
 * have been resolved to actual node/step IDs.
 */
export interface ResolvedWorkflowChannel {
  fromStepId: string;
  toStepId: string;
  /** Visual direction derived from channel topology: 'bidirectional' means arrows in both directions. */
  direction: 'one-way' | 'bidirectional';
  isCyclic?: boolean;
  /** Stable ID for selection -- typically the workflow-level channel array index as a string. */
  id?: string;
  /** Optional display label from WorkflowChannel.label */
  label?: string;
  sourceSide?: AnchorSide;
  targetSide?: AnchorSide;
}

/** Channel edge color -- teal, distinct from transition edge colors */
export const CHANNEL_EDGE_COLOR = '#14b8a6'; // teal-500

/** Channel edge stroke dash pattern for one-way channels */
export const CHANNEL_EDGE_DASH_ARRAY = '6 4';
const CHANNEL_DOCK_RADIUS = 7;
const CHANNEL_MARKER_SIZE = 7;
const CHANNEL_GATE_BADGE_HEIGHT = 20;
const CHANNEL_GATE_BADGE_HORIZONTAL_PADDING = 8;
const CHANNEL_GATE_BADGE_CHAR_WIDTH = 7;
const CHANNEL_GATE_BADGE_BG = '#0f1115';
const CHANNEL_GATE_BADGE_BORDER = '#232733';
const CHANNEL_LOOP_BADGE_COLOR = '#f59e0b';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EdgeRendererProps {
  transitions: VisualTransition[];
  nodePositions: NodePosition;
  selectedEdgeId?: string | null;
  onEdgeSelect?: (transitionId: string) => void;
  onEdgeDelete?: (transitionId: string) => void;
  /** Channel edges to render between nodes (with resolved source/target node IDs). */
  channels?: ResolvedWorkflowChannel[];
  /** Selected channel ID -- highlights the matching channel edge. */
  selectedChannelId?: string | null;
  /** Called when the user clicks a channel edge. Receives the channel's `id` field. */
  onChannelSelect?: (channelId: string) => void;
  /** When true, the Delete/Backspace keydown listener is not registered. */
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Helper: compute bezier path string
// ---------------------------------------------------------------------------

export interface EdgePoints {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
}

interface Point2D {
  x: number;
  y: number;
}

/**
 * Compute the bezier path data and control points for a transition.
 * Returns null when either node position is missing.
 */
export function computeEdgePoints(
  transition: VisualTransition,
  nodePositions: NodePosition
): EdgePoints | null {
  const fromPos = nodePositions[transition.from];
  const toPos = nodePositions[transition.to];
  if (!fromPos || !toPos) return null;

  // Source: bottom-center of from-node (output port center)
  const sx = fromPos.x + fromPos.width / 2;
  const sy = fromPos.y + fromPos.height;

  // Target: top-center of to-node (input port center)
  const tx = toPos.x + toPos.width / 2;
  const ty = toPos.y;

  // Bezier control points offset vertically
  const cp1x = sx;
  const cp1y = sy + CONTROL_OFFSET;
  const cp2x = tx;
  const cp2y = ty - CONTROL_OFFSET;

  return { sx, sy, tx, ty, cp1x, cp1y, cp2x, cp2y };
}

/** Build the SVG path `d` attribute string from computed edge points. */
export function buildPathD(pts: EdgePoints): string {
  return `M ${pts.sx} ${pts.sy} C ${pts.cp1x} ${pts.cp1y}, ${pts.cp2x} ${pts.cp2y}, ${pts.tx} ${pts.ty}`;
}

// ---------------------------------------------------------------------------
// Channel edge helpers
// ---------------------------------------------------------------------------

function getNodeAnchorPoint(
  nodePos: NodePosition[string],
  side: AnchorSide
): Pick<EdgePoints, 'sx' | 'sy'> {
  switch (side) {
    case 'top':
      return { sx: nodePos.x + nodePos.width / 2, sy: nodePos.y };
    case 'bottom':
      return { sx: nodePos.x + nodePos.width / 2, sy: nodePos.y + nodePos.height };
    case 'left':
      return { sx: nodePos.x, sy: nodePos.y + nodePos.height / 2 };
    case 'right':
      return { sx: nodePos.x + nodePos.width, sy: nodePos.y + nodePos.height / 2 };
  }
}

function buildChannelControlPoints(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  sourceSide: AnchorSide,
  targetSide: AnchorSide
) {
  const offset = Math.max(56, Math.min(120, Math.max(Math.abs(tx - sx), Math.abs(ty - sy)) * 0.35));

  const cp1x = sourceSide === 'left' ? sx - offset : sourceSide === 'right' ? sx + offset : sx;
  const cp1y = sourceSide === 'top' ? sy - offset : sourceSide === 'bottom' ? sy + offset : sy;

  const cp2x = targetSide === 'left' ? tx - offset : targetSide === 'right' ? tx + offset : tx;
  const cp2y = targetSide === 'top' ? ty - offset : targetSide === 'bottom' ? ty + offset : ty;

  return { cp1x, cp1y, cp2x, cp2y };
}

function movePoint(point: Point2D, side: AnchorSide, distance: number): Point2D {
  switch (side) {
    case 'top':
      return { x: point.x, y: point.y - distance };
    case 'bottom':
      return { x: point.x, y: point.y + distance };
    case 'left':
      return { x: point.x - distance, y: point.y };
    case 'right':
      return { x: point.x + distance, y: point.y };
  }
}

function pointsEqual(a: Point2D | undefined, b: Point2D | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

function isCollinear(a: Point2D, b: Point2D, c: Point2D): boolean {
  return (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
}

function normalizeOrthogonalPoints(points: Point2D[]): Point2D[] {
  const normalized: Point2D[] = [];

  for (const point of points) {
    const last = normalized[normalized.length - 1];
    if (pointsEqual(last, point)) continue;

    if (normalized.length >= 2) {
      const prev = normalized[normalized.length - 2];
      if (isCollinear(prev, last!, point)) {
        normalized[normalized.length - 1] = point;
        continue;
      }
    }

    normalized.push(point);
  }

  return normalized;
}

function trimOrthogonalEndpoint(a: Point2D, b: Point2D, distance: number): Point2D {
  if (a.x === b.x) {
    return {
      x: a.x,
      y: a.y + Math.sign(b.y - a.y) * Math.min(distance, Math.abs(b.y - a.y)),
    };
  }

  return {
    x: a.x + Math.sign(b.x - a.x) * Math.min(distance, Math.abs(b.x - a.x)),
    y: a.y,
  };
}

function trimOrthogonalPathPoints(
  points: Point2D[],
  trimStart: number,
  trimEnd: number
): Point2D[] {
  const normalized = normalizeOrthogonalPoints(points);
  if (normalized.length < 2) return normalized;

  const trimmed = [...normalized];
  if (trimStart > 0) {
    trimmed[0] = trimOrthogonalEndpoint(trimmed[0], trimmed[1], trimStart);
  }
  if (trimEnd > 0) {
    const lastIndex = trimmed.length - 1;
    trimmed[lastIndex] = trimOrthogonalEndpoint(
      trimmed[lastIndex],
      trimmed[lastIndex - 1],
      trimEnd
    );
  }

  return normalizeOrthogonalPoints(trimmed);
}

export interface OrthogonalMidpointWithAngle extends Point2D {
  /** Direction angle in degrees: 0 = right, 90 = down, 180 = left, 270 = up */
  angle: number;
}

/**
 * Returns the midpoint of an orthogonal path together with the direction angle
 * (in degrees, clockwise) of the segment the midpoint falls on.
 * Because orthogonal paths are always axis-aligned the angle is always one of
 * 0, 90, 180, or 270.
 */
export function getOrthogonalPathMidpointWithAngle(points: Point2D[]): OrthogonalMidpointWithAngle {
  const normalized = normalizeOrthogonalPoints(points);
  if (normalized.length === 0) return { x: 0, y: 0, angle: 0 };
  if (normalized.length === 1) return { ...normalized[0], angle: 0 };

  let totalLength = 0;
  for (let index = 1; index < normalized.length; index += 1) {
    totalLength +=
      Math.abs(normalized[index].x - normalized[index - 1].x) +
      Math.abs(normalized[index].y - normalized[index - 1].y);
  }

  const midpointDistance = totalLength / 2;
  let traversed = 0;

  for (let index = 1; index < normalized.length; index += 1) {
    const start = normalized[index - 1];
    const end = normalized[index];
    const segmentLength = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    if (traversed + segmentLength < midpointDistance) {
      traversed += segmentLength;
      continue;
    }

    const distanceIntoSegment = midpointDistance - traversed;
    if (start.x === end.x) {
      // Vertical segment
      const angle = end.y > start.y ? 90 : 270;
      return {
        x: start.x,
        y: start.y + Math.sign(end.y - start.y) * distanceIntoSegment,
        angle,
      };
    }

    // Horizontal segment
    const angle = end.x > start.x ? 0 : 180;
    return {
      x: start.x + Math.sign(end.x - start.x) * distanceIntoSegment,
      y: start.y,
      angle,
    };
  }

  return { ...normalized[normalized.length - 1], angle: 0 };
}

/** Returns the midpoint of an orthogonal path. Delegates to `getOrthogonalPathMidpointWithAngle`. */
function getOrthogonalPathMidpoint(points: Point2D[]): Point2D {
  return getOrthogonalPathMidpointWithAngle(points);
}

function roundedOrthogonalPath(points: Point2D[], cornerRadius = 14): string {
  const normalized = normalizeOrthogonalPoints(points);
  if (normalized.length === 0) return '';
  if (normalized.length === 1) return `M ${normalized[0].x} ${normalized[0].y}`;

  let d = `M ${normalized[0].x} ${normalized[0].y}`;

  for (let index = 1; index < normalized.length - 1; index += 1) {
    const prev = normalized[index - 1];
    const current = normalized[index];
    const next = normalized[index + 1];

    if (isCollinear(prev, current, next)) {
      d += ` L ${current.x} ${current.y}`;
      continue;
    }

    const radius = Math.min(
      cornerRadius,
      Math.abs(current.x - prev.x || current.y - prev.y) / 2,
      Math.abs(next.x - current.x || next.y - current.y) / 2
    );

    const entry: Point2D =
      prev.x === current.x
        ? { x: current.x, y: current.y - Math.sign(current.y - prev.y) * radius }
        : { x: current.x - Math.sign(current.x - prev.x) * radius, y: current.y };

    const exit: Point2D =
      next.x === current.x
        ? { x: current.x, y: current.y + Math.sign(next.y - current.y) * radius }
        : { x: current.x + Math.sign(next.x - current.x) * radius, y: current.y };

    d += ` L ${entry.x} ${entry.y} Q ${current.x} ${current.y} ${exit.x} ${exit.y}`;
  }

  const last = normalized[normalized.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function buildChannelOrthogonalPoints(
  channel: ResolvedWorkflowChannel,
  pts: EdgePoints
): Point2D[] {
  const sourceSide = channel.sourceSide ?? 'bottom';
  const targetSide = channel.targetSide ?? 'top';
  const start = { x: pts.sx, y: pts.sy };
  const end = { x: pts.tx, y: pts.ty };
  const startLead = movePoint(start, sourceSide, 28);
  const endLead = movePoint(end, targetSide, 28);

  let midPoints: Point2D[] = [];
  const sourceVertical = sourceSide === 'top' || sourceSide === 'bottom';
  const targetVertical = targetSide === 'top' || targetSide === 'bottom';

  if (sourceVertical && targetVertical) {
    const midY = (startLead.y + endLead.y) / 2;
    midPoints = [
      { x: startLead.x, y: midY },
      { x: endLead.x, y: midY },
    ];
  } else if (!sourceVertical && !targetVertical) {
    const midX = (startLead.x + endLead.x) / 2;
    midPoints = [
      { x: midX, y: startLead.y },
      { x: midX, y: endLead.y },
    ];
  } else {
    midPoints = [{ x: endLead.x, y: startLead.y }];
  }

  return [start, startLead, ...midPoints, endLead, end];
}

export function buildChannelPathD(channel: ResolvedWorkflowChannel, pts: EdgePoints): string {
  return roundedOrthogonalPath(buildChannelOrthogonalPoints(channel, pts));
}

export function buildVisibleChannelPathD(
  channel: ResolvedWorkflowChannel,
  pts: EdgePoints
): string {
  const trimmedPoints = trimOrthogonalPathPoints(
    buildChannelOrthogonalPoints(channel, pts),
    channel.direction === 'bidirectional' ? CHANNEL_DOCK_RADIUS : 0,
    CHANNEL_DOCK_RADIUS
  );

  return roundedOrthogonalPath(trimmedPoints);
}

function getVisibleChannelPathPoints(channel: ResolvedWorkflowChannel, pts: EdgePoints): Point2D[] {
  return trimOrthogonalPathPoints(
    buildChannelOrthogonalPoints(channel, pts),
    channel.direction === 'bidirectional' ? CHANNEL_DOCK_RADIUS : 0,
    CHANNEL_DOCK_RADIUS
  );
}

/** Compute the bezier path for a channel edge connecting node ports. */
export function computeChannelEdgePoints(
  channel: ResolvedWorkflowChannel,
  nodePositions: NodePosition
): EdgePoints | null {
  const fromPos = nodePositions[channel.fromStepId];
  const toPos = nodePositions[channel.toStepId];
  if (!fromPos || !toPos) return null;

  const sourceSide = channel.sourceSide ?? 'bottom';
  const targetSide = channel.targetSide ?? 'top';
  const sourcePoint = getNodeAnchorPoint(fromPos, sourceSide);
  const targetPoint = getNodeAnchorPoint(toPos, targetSide);
  const sx = sourcePoint.sx;
  const sy = sourcePoint.sy;
  const tx = targetPoint.sx;
  const ty = targetPoint.sy;
  const { cp1x, cp1y, cp2x, cp2y } = buildChannelControlPoints(
    sx,
    sy,
    tx,
    ty,
    sourceSide,
    targetSide
  );

  return { sx, sy, tx, ty, cp1x, cp1y, cp2x, cp2y };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EdgeRenderer({
  transitions,
  nodePositions,
  selectedEdgeId,
  onEdgeSelect,
  onEdgeDelete,
  channels = [],
  selectedChannelId,
  onChannelSelect,
  readOnly = false,
}: EdgeRendererProps) {
  // Stable per-instance prefix to prevent marker ID collisions across instances
  const markerPrefixRef = useRef<string | null>(null);
  if (markerPrefixRef.current === null) {
    markerPrefixRef.current = `edge-arrow-${_instanceCounter++}`;
  }
  const markerPrefix = markerPrefixRef.current;

  // Keep refs so the keyboard handler always sees the latest values
  const selectedEdgeIdRef = useRef(selectedEdgeId);
  selectedEdgeIdRef.current = selectedEdgeId;

  const onEdgeDeleteRef = useRef(onEdgeDelete);
  onEdgeDeleteRef.current = onEdgeDelete;

  // ---- Keyboard: Delete / Backspace deletes the selected edge ----
  // Skipped in readOnly mode — no destructive editing affordances.
  useEffect(() => {
    if (readOnly) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      const current = selectedEdgeIdRef.current;
      if (!current || !onEdgeDeleteRef.current) return;

      e.preventDefault();
      onEdgeDeleteRef.current(current);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readOnly]);

  return (
    <>
      {/* Arrowhead marker definitions -- one per condition type + one for selected state.
			    IDs are prefixed with instanceId to prevent collisions between multiple instances. */}
      <defs>
        {(Object.entries(EDGE_COLORS) as [WorkflowConditionType, string][]).map(([type, color]) => (
          <marker
            key={`${markerPrefix}-${type}`}
            id={`${markerPrefix}-${type}`}
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        ))}
        <marker
          id={`${markerPrefix}-selected`}
          viewBox="0 0 10 10"
          refX="10"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="white" />
        </marker>
        {/* Channel edge arrowhead markers -- rendered when channels are present */}
        {channels.length > 0 && (
          <>
            <marker
              id={`${markerPrefix}-channel-end`}
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth={CHANNEL_MARKER_SIZE}
              markerHeight={CHANNEL_MARKER_SIZE}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={CHANNEL_EDGE_COLOR} />
            </marker>
            {/* White markers for selected channel state */}
            <marker
              id={`${markerPrefix}-channel-selected`}
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth={CHANNEL_MARKER_SIZE}
              markerHeight={CHANNEL_MARKER_SIZE}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="white" />
            </marker>
          </>
        )}
      </defs>

      {transitions.map((transition) => {
        const pts = computeEdgePoints(transition, nodePositions);
        if (!pts) return null;

        const d = buildPathD(pts);
        const conditionType: WorkflowConditionType = transition.condition?.type ?? 'always';
        const color = EDGE_COLORS[conditionType];
        const isSelected = transition.id === selectedEdgeId;
        const strokeColor = isSelected ? 'white' : color;
        const strokeWidth = isSelected ? SELECTED_STROKE_WIDTH : NORMAL_STROKE_WIDTH;
        const markerId = isSelected
          ? `${markerPrefix}-selected`
          : `${markerPrefix}-${conditionType}`;

        return (
          <g
            key={transition.id}
            data-testid={`edge-${transition.id}`}
            data-edge-id={transition.id}
            data-selected={isSelected ? 'true' : 'false'}
            data-condition-type={conditionType}
            style={{ pointerEvents: 'auto' }}
          >
            {/* Invisible wider hitbox for easier click selection */}
            <path
              d={d}
              stroke="transparent"
              strokeWidth={HITBOX_STROKE_WIDTH}
              fill="none"
              style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onEdgeSelect?.(transition.id);
              }}
            />
            {/* Visible edge path */}
            <path
              d={d}
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              strokeOpacity={isSelected ? 1 : 0.85}
              fill="none"
              markerEnd={`url(#${markerId})`}
              data-stroke-color={strokeColor}
              data-stroke-width={String(strokeWidth)}
              style={{ pointerEvents: 'none' }}
            />
          </g>
        );
      })}

      {/* Channel edges -- teal edges connecting semantic node relationships.
		    One-way channels render dashed. Bidirectional channels render solid.
		    Cyclic (loop-back) channels render a Loop badge at the midpoint. */}
      {channels.map((channel, idx) => {
        const pts = computeChannelEdgePoints(channel, nodePositions);
        if (!pts) return null;

        const d = buildChannelPathD(channel, pts);
        const visiblePoints = getVisibleChannelPathPoints(channel, pts);
        const visibleD = roundedOrthogonalPath(visiblePoints);
        const isBidirectional = channel.direction === 'bidirectional';
        const isCyclic = !!channel.isCyclic;
        const isSelected = channel.id != null && channel.id === selectedChannelId;

        const strokeColor = isSelected ? 'white' : CHANNEL_EDGE_COLOR;
        const strokeWidth = isSelected ? CHANNEL_SELECTED_STROKE_WIDTH : CHANNEL_STROKE_WIDTH;
        const strokeDasharray = isBidirectional ? undefined : CHANNEL_EDGE_DASH_ARRAY;
        const strokeOpacity = isSelected ? 1 : 0.85;
        const loopBadgePosition = isCyclic ? getOrthogonalPathMidpoint(visiblePoints) : null;
        const loopBadgeWidth =
          'Loop'.length * CHANNEL_GATE_BADGE_CHAR_WIDTH + CHANNEL_GATE_BADGE_HORIZONTAL_PADDING * 2;

        // Use the same marker geometry on both ends. `auto-start-reverse`
        // handles the start-end orientation flip for markerStart.
        const markerEndId = isSelected
          ? `${markerPrefix}-channel-selected`
          : `${markerPrefix}-channel-end`;

        const channelKey = channel.id ?? `${channel.fromStepId}-${channel.toStepId}-${idx}`;
        const channelRenderKey = `${channelKey}-${isSelected ? 'selected' : 'idle'}`;

        return (
          <g
            key={channelRenderKey}
            data-testid={`channel-edge-${channel.fromStepId}-${channel.toStepId}`}
            data-channel-edge="true"
            data-channel-direction={channel.direction}
            data-channel-id={channel.id}
            data-channel-cyclic={isCyclic ? 'true' : undefined}
            data-selected={isSelected ? 'true' : 'false'}
            style={{ pointerEvents: 'auto' }}
          >
            {/* Invisible wider hitbox for easier click selection */}
            <path
              d={d}
              stroke="transparent"
              strokeWidth={HITBOX_STROKE_WIDTH}
              fill="none"
              style={{
                cursor: onChannelSelect && channel.id != null ? 'pointer' : 'default',
                pointerEvents: 'stroke',
              }}
              onClick={
                onChannelSelect && channel.id != null
                  ? (e: MouseEvent) => {
                      e.stopPropagation();
                      onChannelSelect(channel.id!);
                    }
                  : undefined
              }
            />
            {/* Visible channel edge path */}
            <path
              d={visibleD}
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              strokeDasharray={strokeDasharray}
              strokeOpacity={strokeOpacity}
              fill="none"
              markerEnd={`url(#${markerEndId})`}
              markerStart={isBidirectional ? `url(#${markerEndId})` : undefined}
              data-stroke-color={strokeColor}
              data-stroke-width={String(strokeWidth)}
              style={{ pointerEvents: 'none' }}
            />
            {loopBadgePosition && (
              <g
                transform={`translate(${loopBadgePosition.x}, ${loopBadgePosition.y})`}
                data-testid={`channel-loop-${channel.fromStepId}-${channel.toStepId}`}
                style={{
                  pointerEvents: onChannelSelect && channel.id != null ? 'auto' : 'none',
                  cursor: onChannelSelect && channel.id != null ? 'pointer' : 'default',
                }}
                onClick={
                  onChannelSelect && channel.id != null
                    ? (e: MouseEvent) => {
                        e.stopPropagation();
                        onChannelSelect(channel.id!);
                      }
                    : undefined
                }
              >
                <rect
                  x={-loopBadgeWidth / 2}
                  y={-CHANNEL_GATE_BADGE_HEIGHT / 2}
                  width={loopBadgeWidth}
                  height={CHANNEL_GATE_BADGE_HEIGHT}
                  rx="10"
                  fill={CHANNEL_GATE_BADGE_BG}
                  stroke={isSelected ? 'white' : CHANNEL_GATE_BADGE_BORDER}
                  strokeWidth="1"
                />
                <text
                  x="0"
                  y="4"
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  letterSpacing="0.06em"
                  fill={isSelected ? 'white' : CHANNEL_LOOP_BADGE_COLOR}
                >
                  Loop
                </text>
              </g>
            )}
          </g>
        );
      })}
    </>
  );
}
