/**
 * WorkflowCanvas
 *
 * Wraps VisualCanvas with workflow-specific behaviour:
 *  - Manages selectedNodeId state (single-select)
 *  - Manages selectedEdgeId state (mutually exclusive with selectedNodeId)
 *  - Renders WorkflowNode components with correct isSelected prop
 *  - Renders EdgeRenderer via the edgeLayer render prop of VisualCanvas
 *  - Handles Delete/Backspace keyboard shortcut to delete selected node or edge
 *  - Emits onNodeSelect(stepId | null) and onEdgeSelect(transitionId | null)
 *  - Manages connection drag via useConnectionDrag hook
 *    - Shows ghost edge (dashed SVG path) during drag
 *    - Highlights valid input ports as drop targets
 *    - Creates transitions on valid drop
 *
 * Node and edge selection are mutually exclusive: selecting a node clears the
 * selected edge and vice versa. This prevents the two independent Delete/Backspace
 * listeners (WorkflowCanvas for nodes, EdgeRenderer for edges) from both firing on
 * the same keystroke.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import type { ComponentChildren, JSX, RefObject } from 'preact';

import { VisualCanvas } from './VisualCanvas';
import { WorkflowNode } from './WorkflowNode';
import type { WorkflowNodeProps, PortType } from './WorkflowNode';
import { EdgeRenderer, type ResolvedWorkflowChannel } from './EdgeRenderer';
import type { ViewportState, Point, NodePosition, VisualTransition } from './types';
import { useConnectionDrag } from './useConnectionDrag';

/** Default node dimensions used when deriving NodePosition from WorkflowNodeData. */
export const DEFAULT_NODE_WIDTH = 160;
export const DEFAULT_NODE_HEIGHT = 80;

/**
 * Per-node data passed to WorkflowCanvas.
 * WorkflowCanvas injects: isSelected, isDropTarget, onClick, scale, onPositionChange,
 * onPortMouseDown, onPortMouseEnter, onPortMouseLeave.
 */
export type WorkflowNodeData = Omit<
  WorkflowNodeProps,
  | 'isSelected'
  | 'isDropTarget'
  | 'onClick'
  | 'scale'
  | 'onPositionChange'
  | 'onPortMouseDown'
  | 'onPortMouseEnter'
  | 'onPortMouseLeave'
>;

export interface WorkflowCanvasProps {
  nodes: WorkflowNodeData[];
  viewportState: ViewportState;
  onViewportChange: (state: ViewportState) => void;
  /** Edges to render between nodes. Also used for duplicate detection during connection drag. */
  transitions?: VisualTransition[];
  /** Channel edges to render between nodes. */
  channels?: ResolvedWorkflowChannel[];
  /**
   * Explicit node positions including width/height for edge port computation.
   * When omitted, positions are derived from nodes with DEFAULT_NODE_WIDTH/HEIGHT.
   */
  nodePositions?: NodePosition;
  /** Called when the selected node changes. Null means nothing is selected. */
  onNodeSelect?: (stepId: string | null) => void;
  /** Called when Delete/Backspace is pressed with a node selected. */
  onDeleteNode?: (stepId: string) => void;
  /** Called when a node is dragged to a new position. */
  onNodePositionChange?: (stepId: string, position: Point) => void;
  /** Called when a new connection is created by dragging between node ports. */
  onCreateTransition?: (fromStepId: string, toStepId: string) => void;
  /** Called when the selected edge changes. Null means nothing is selected. */
  onEdgeSelect?: (transitionId: string | null) => void;
  /** Called when Delete/Backspace is pressed with an edge selected. */
  onDeleteEdge?: (transitionId: string) => void;
  /** Called when a channel edge is clicked. Receives the channel's id. */
  onChannelSelect?: (channelId: string | null) => void;
  /** Called when a gate runtime-status icon is clicked. Receives gateId and mouse event. */
  onGateClick?: (gateId: string, event: MouseEvent) => void;
  /** Currently selected channel ID for highlighting. */
  selectedChannelId?: string | null;
  /**
   * When true, disables all editing affordances:
   * - No keyboard Delete/Backspace handler for node deletion
   * - No port drag-to-connect handlers
   * Node selection (onNodeSelect) still works in read-only mode.
   */
  readOnly?: boolean;
}

// ---- Ghost edge rendering ----

/** Render a dashed bezier ghost edge from `from` to `to` in canvas-space SVG coordinates. */
function GhostEdge({ from, to }: { from: Point; to: Point }): JSX.Element | null {
  // Directional bezier: for forward (downward) drags use a vertical S-curve.
  // For backward (upward) drags, route horizontally to avoid the path looping.
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let d: string;
  if (dy >= -40) {
    // Forward or slightly backward: standard vertical bezier
    const cpOffset = Math.max(50, dy * 0.5);
    d = `M ${from.x} ${from.y} C ${from.x} ${from.y + cpOffset}, ${to.x} ${to.y - cpOffset}, ${to.x} ${to.y}`;
  } else {
    // Backward drag: route around horizontally to avoid S-curve loops
    const sideOffset = Math.max(60, Math.abs(dx) * 0.4 + 40);
    const midY = (from.y + to.y) / 2;
    d = `M ${from.x} ${from.y} C ${from.x} ${from.y + 40}, ${from.x + sideOffset} ${from.y + 40}, ${from.x + sideOffset} ${midY} S ${from.x + sideOffset} ${to.y - 40}, ${to.x} ${to.y}`;
  }

  return (
    <>
      {/* Shadow for contrast */}
      <path
        d={d}
        fill="none"
        stroke="rgba(0,0,0,0.3)"
        strokeWidth={5}
        strokeDasharray="8 4"
        strokeLinecap="round"
      />
      {/* Visible ghost stroke */}
      <path
        data-testid="ghost-edge"
        d={d}
        fill="none"
        stroke="#60a5fa"
        strokeWidth={2.5}
        strokeDasharray="8 4"
        strokeLinecap="round"
        opacity={0.9}
      />
    </>
  );
}

// ---- Channel edge computation ----

/**
 * Compute channel edges from workflow nodes.
 *
 * Collects all WorkflowChannel declarations from all nodes and resolves
 * channel endpoints to node IDs:
 * - Intra-node channels (agents within the same node) are skipped - they don't
 *   need cross-node edges since all agents in a node share the same canvas space.
 * - Inter-node channels are resolved to actual node IDs and returned as
 *   ResolvedWorkflowChannel objects.
 * - Channels resolve agent roles to their containing node IDs using the
 *   SpaceAgent.agents array, which has slot name information.
 */
export function computeChannelEdges(nodes: WorkflowNodeData[]): ResolvedWorkflowChannel[] {
  const result: ResolvedWorkflowChannel[] = [];

  // Track seen (fromStepId, toStepId) pairs to avoid duplicates
  const seenEdges = new Set<string>();

  // Build a map of agent slot name -> node localId for quick lookup
  // This is used to resolve channel endpoints that reference agent slot names
  const agentSlotNameToNodeId = new Map<string, string>();
  for (const node of nodes) {
    // node.agents is SpaceAgent[] which has .name
    if (node.agents) {
      for (const agent of node.agents) {
        agentSlotNameToNodeId.set(agent.name, node.step.localId);
      }
    }
  }

  for (const node of nodes) {
    const channels = node.workflowChannels;
    if (!channels) continue;

    for (const channel of channels) {
      // Determine if this is an inter-node channel
      let fromNodeId: string | null = null;

      // Resolve 'from' endpoint
      if (channel.from === '*') {
        // Wildcard: from the node itself
        fromNodeId = node.step.localId;
      } else {
        // Resolve agent slot name to node ID
        fromNodeId = agentSlotNameToNodeId.get(channel.from) ?? null;
      }

      // Resolve 'to' endpoints (can be a string or array of strings)
      const toTargets: (string | null)[] =
        typeof channel.to === 'string'
          ? [resolveToTarget(channel.to, node, agentSlotNameToNodeId)]
          : channel.to.map((t) => resolveToTarget(t, node, agentSlotNameToNodeId));

      // Skip if we couldn't resolve the 'from' endpoint
      if (!fromNodeId) continue;

      for (const toNodeId of toTargets) {
        if (!toNodeId) continue;

        // Skip intra-node channels (both endpoints resolve to the same node)
        if (fromNodeId === toNodeId) continue;

        // Check for duplicate edges
        const edgeKey = `${fromNodeId}:${toNodeId}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        result.push({
          fromStepId: fromNodeId,
          toStepId: toNodeId,
          direction: 'one-way' as const,
        });
      }
    }
  }

  return result;
}

/**
 * Resolve a 'to' target string to a node ID.
 */
function resolveToTarget(
  toValue: string,
  node: WorkflowNodeData,
  agentSlotNameToNodeId: Map<string, string>
): string | null {
  if (toValue === '*') {
    // Wildcard: to the node itself
    return node.step.localId;
  }
  // Resolve agent slot name to node ID
  return agentSlotNameToNodeId.get(toValue) ?? null;
}

// ============================================================================
// WorkflowCanvas
// ============================================================================

export function WorkflowCanvas({
  nodes,
  viewportState,
  onViewportChange,
  transitions = [],
  channels = [],
  nodePositions,
  onNodeSelect,
  onDeleteNode,
  onNodePositionChange,
  onCreateTransition,
  onEdgeSelect,
  onDeleteEdge,
  onChannelSelect,
  onGateClick,
  selectedChannelId,
  readOnly = false,
}: WorkflowCanvasProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Keep refs so keyboard handler always sees the latest value without re-registering
  const selectedNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = selectedNodeId;

  const selectedEdgeIdRef = useRef<string | null>(null);
  selectedEdgeIdRef.current = selectedEdgeId;

  const onNodeSelectRef = useRef(onNodeSelect);
  onNodeSelectRef.current = onNodeSelect;

  const onEdgeSelectRef = useRef(onEdgeSelect);
  onEdgeSelectRef.current = onEdgeSelect;

  const onDeleteNodeRef = useRef(onDeleteNode);
  onDeleteNodeRef.current = onDeleteNode;

  const onDeleteEdgeRef = useRef(onDeleteEdge);
  onDeleteEdgeRef.current = onDeleteEdge;

  // Ref to the VisualCanvas container (for coordinate conversion in connection drag)
  const containerRef = useRef<HTMLDivElement>(null);

  // ---- Connection drag ----
  const { dragState, startDrag, setHoverTarget } = useConnectionDrag({
    viewportState,
    containerRef: containerRef as RefObject<HTMLElement>,
    transitions,
    onCreateTransition: onCreateTransition ?? (() => {}),
  });

  // Derive NodePosition map from nodes when not explicitly provided.
  // Edges update positions automatically because nodes update when dragged.
  const effectiveNodePositions = useMemo((): NodePosition => {
    if (nodePositions) return nodePositions;
    const result: NodePosition = {};
    for (const node of nodes) {
      result[node.step.localId] = {
        x: node.position.x,
        y: node.position.y,
        width: DEFAULT_NODE_WIDTH,
        height: DEFAULT_NODE_HEIGHT,
      };
    }
    return result;
  }, [nodes, nodePositions]);

  // ---- Channel edges ----
  // Compute channel edges from nodes' channel declarations.
  // When explicit channels are passed, prefer them because they carry the
  // semantic routing metadata (id, anchor sides, gate state) used by the
  // current editor. Fall back to computed node channels only when no explicit
  // channel graph is provided.
  const computedChannelEdges = useMemo(() => computeChannelEdges(nodes), [nodes]);
  const effectiveChannels = channels.length > 0 ? channels : computedChannelEdges;

  // Clear selection if the selected node is removed externally (e.g. parent deletes it
  // from the nodes array). Without this, a node re-added with the same stepId would
  // appear pre-selected, which is unexpected.
  useEffect(() => {
    if (selectedNodeId !== null && !nodes.some((n) => n.step.localId === selectedNodeId)) {
      setSelectedNodeId(null);
      onNodeSelectRef.current?.(null);
    }
  }, [nodes, selectedNodeId]);

  // Selecting a node clears the edge selection (mutually exclusive).
  const handleNodeSelect = useCallback(
    (stepId: string) => {
      setSelectedNodeId(stepId);
      onNodeSelect?.(stepId);
      // Clear edge selection to prevent dual Delete handlers from both firing
      if (selectedEdgeIdRef.current !== null) {
        setSelectedEdgeId(null);
        onEdgeSelectRef.current?.(null);
      }
    },
    [onNodeSelect]
  );

  // Selecting an edge clears the node selection (mutually exclusive).
  const handleEdgeSelect = useCallback(
    (transitionId: string) => {
      setSelectedEdgeId(transitionId);
      onEdgeSelect?.(transitionId);
      // Clear node selection to prevent dual Delete handlers from both firing
      if (selectedNodeIdRef.current !== null) {
        setSelectedNodeId(null);
        onNodeSelectRef.current?.(null);
      }
    },
    [onEdgeSelect]
  );

  const handleEdgeDelete = useCallback((transitionId: string) => {
    setSelectedEdgeId(null);
    onEdgeSelectRef.current?.(null);
    onDeleteEdgeRef.current?.(transitionId);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNodeId(null);
    onNodeSelect?.(null);
    setSelectedEdgeId(null);
    onEdgeSelect?.(null);
    onChannelSelect?.(null);
  }, [onNodeSelect, onEdgeSelect, onChannelSelect]);

  // ---- Port event handlers ----
  const handlePortMouseDown = useCallback(
    (stepId: string, _portType: PortType, e: MouseEvent, portEl: Element) => {
      startDrag(stepId, portEl, e);
    },
    [startDrag]
  );

  const handlePortMouseEnter = useCallback(
    (stepId: string, portType: PortType) => {
      // setHoverTarget guards on dragRef.current.active internally —
      // no need to read dragState here, which would cause re-renders on every toggle
      if (portType === 'input') {
        setHoverTarget(stepId);
      }
    },
    [setHoverTarget]
  );

  const handlePortMouseLeave = useCallback(
    (_stepId: string, portType: PortType) => {
      if (portType === 'input') {
        setHoverTarget(null);
      }
    },
    [setHoverTarget]
  );

  // ---- Keyboard: Delete / Backspace removes the selected node ----
  // (Edge deletion is handled by EdgeRenderer's own listener. Selections are mutually
  // exclusive so at most one handler fires per keystroke.)
  // Skipped in readOnly mode — no destructive editing affordances.
  useEffect(() => {
    if (readOnly) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      const current = selectedNodeIdRef.current;
      if (!current || !onDeleteNodeRef.current) return;

      e.preventDefault();
      onDeleteNodeRef.current(current);
      setSelectedNodeId(null);
      onNodeSelectRef.current?.(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readOnly]);

  // ---- Edge layer: committed edges (EdgeRenderer) + ghost edge during drag + channel edges ----
  const edgeLayer = useCallback(
    (_vp: ViewportState): ComponentChildren => (
      <>
        <EdgeRenderer
          transitions={transitions}
          nodePositions={effectiveNodePositions}
          selectedEdgeId={selectedEdgeId}
          onEdgeSelect={handleEdgeSelect}
          onEdgeDelete={handleEdgeDelete}
          channels={effectiveChannels}
          selectedChannelId={selectedChannelId}
          onChannelSelect={onChannelSelect ?? undefined}
          onGateClick={onGateClick}
          readOnly={readOnly}
        />
        {dragState.active && dragState.fromPos && dragState.currentPos && (
          <GhostEdge from={dragState.fromPos} to={dragState.currentPos} />
        )}
      </>
    ),
    [
      transitions,
      effectiveChannels,
      effectiveNodePositions,
      selectedEdgeId,
      handleEdgeSelect,
      handleEdgeDelete,
      dragState,
      selectedChannelId,
      onChannelSelect,
      onGateClick,
      readOnly,
    ]
  );

  return (
    <VisualCanvas
      containerRef={containerRef}
      viewportState={viewportState}
      onViewportChange={onViewportChange}
      onBackgroundClick={handleBackgroundClick}
      nodes={effectiveNodePositions}
      edgeLayer={edgeLayer}
    >
      {nodes.map((node) => {
        const stepId = node.step.localId;
        // A node is a valid drop target if: drag is active, not the source, not start node
        const isDropTarget =
          dragState.active && dragState.fromStepId !== stepId && !node.isStartNode;

        return (
          <WorkflowNode
            key={stepId}
            {...node}
            scale={viewportState.scale}
            onPositionChange={onNodePositionChange ?? (() => {})}
            isSelected={selectedNodeId === stepId}
            isDropTarget={isDropTarget}
            onClick={handleNodeSelect}
            onPortMouseDown={readOnly ? undefined : handlePortMouseDown}
            onPortMouseEnter={readOnly ? undefined : handlePortMouseEnter}
            onPortMouseLeave={readOnly ? undefined : handlePortMouseLeave}
            draggable={!readOnly}
          />
        );
      })}
    </VisualCanvas>
  );
}
