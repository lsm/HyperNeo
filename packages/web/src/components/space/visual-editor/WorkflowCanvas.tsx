import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import type { ComponentChildren, JSX, RefObject } from 'preact';

import { VisualCanvas } from './VisualCanvas';
import { WorkflowNode } from './WorkflowNode';
import type { WorkflowNodeProps, PortType } from './WorkflowNode';
import { EdgeRenderer, type ResolvedWorkflowChannel } from './EdgeRenderer';
import type { ViewportState, Point, NodePosition, VisualTransition } from './types';
import { useConnectionDrag } from './useConnectionDrag';

export const DEFAULT_NODE_WIDTH = 160;
export const DEFAULT_NODE_HEIGHT = 80;

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
  transitions?: VisualTransition[];
  channels?: ResolvedWorkflowChannel[];
  nodePositions?: NodePosition;
  onNodeSelect?: (stepId: string | null) => void;
  onDeleteNode?: (stepId: string) => void;
  onNodePositionChange?: (stepId: string, position: Point) => void;
  onCreateTransition?: (fromStepId: string, toStepId: string) => void;
  onEdgeSelect?: (transitionId: string | null) => void;
  onDeleteEdge?: (transitionId: string) => void;
  onChannelSelect?: (channelId: string | null) => void;
  selectedChannelId?: string | null;
  readOnly?: boolean;
}

function GhostEdge({ from, to }: { from: Point; to: Point }): JSX.Element | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let d: string;
  if (dy >= -40) {
    const cpOffset = Math.max(50, dy * 0.5);
    d = `M ${from.x} ${from.y} C ${from.x} ${from.y + cpOffset}, ${to.x} ${to.y - cpOffset}, ${to.x} ${to.y}`;
  } else {
    const sideOffset = Math.max(60, Math.abs(dx) * 0.4 + 40);
    const midY = (from.y + to.y) / 2;
    d = `M ${from.x} ${from.y} C ${from.x} ${from.y + 40}, ${from.x + sideOffset} ${from.y + 40}, ${from.x + sideOffset} ${midY} S ${from.x + sideOffset} ${to.y - 40}, ${to.x} ${to.y}`;
  }

  return (
    <>
      <path
        d={d}
        fill="none"
        stroke="rgba(0,0,0,0.3)"
        strokeWidth={5}
        strokeDasharray="8 4"
        strokeLinecap="round"
      />
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

export function computeChannelEdges(nodes: WorkflowNodeData[]): ResolvedWorkflowChannel[] {
  const result: ResolvedWorkflowChannel[] = [];

  const seenEdges = new Set<string>();

  const agentSlotNameToNodeId = new Map<string, string>();
  for (const node of nodes) {
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
      let fromNodeId: string | null = null;

      if (channel.from === '*') {
        fromNodeId = node.step.localId;
      } else {
        fromNodeId = agentSlotNameToNodeId.get(channel.from) ?? null;
      }

      const toTargets: (string | null)[] =
        typeof channel.to === 'string'
          ? [resolveToTarget(channel.to, node, agentSlotNameToNodeId)]
          : channel.to.map((t) => resolveToTarget(t, node, agentSlotNameToNodeId));

      if (!fromNodeId) continue;

      for (const toNodeId of toTargets) {
        if (!toNodeId) continue;

        if (fromNodeId === toNodeId) continue;

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

function resolveToTarget(
  toValue: string,
  node: WorkflowNodeData,
  agentSlotNameToNodeId: Map<string, string>
): string | null {
  if (toValue === '*') {
    return node.step.localId;
  }
  return agentSlotNameToNodeId.get(toValue) ?? null;
}

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
  selectedChannelId,
  readOnly = false,
}: WorkflowCanvasProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

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

  const containerRef = useRef<HTMLDivElement>(null);

  const { dragState, startDrag, setHoverTarget } = useConnectionDrag({
    viewportState,
    containerRef: containerRef as RefObject<HTMLElement>,
    transitions,
    onCreateTransition: onCreateTransition ?? (() => {}),
  });

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

  const computedChannelEdges = useMemo(() => computeChannelEdges(nodes), [nodes]);
  const effectiveChannels = channels.length > 0 ? channels : computedChannelEdges;

  useEffect(() => {
    if (selectedNodeId !== null && !nodes.some((n) => n.step.localId === selectedNodeId)) {
      setSelectedNodeId(null);
      onNodeSelectRef.current?.(null);
    }
  }, [nodes, selectedNodeId]);

  const handleNodeSelect = useCallback(
    (stepId: string) => {
      setSelectedNodeId(stepId);
      onNodeSelect?.(stepId);
      if (selectedEdgeIdRef.current !== null) {
        setSelectedEdgeId(null);
        onEdgeSelectRef.current?.(null);
      }
    },
    [onNodeSelect]
  );

  const handleEdgeSelect = useCallback(
    (transitionId: string) => {
      setSelectedEdgeId(transitionId);
      onEdgeSelect?.(transitionId);
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

  const handlePortMouseDown = useCallback(
    (stepId: string, _portType: PortType, e: MouseEvent, portEl: Element) => {
      startDrag(stepId, portEl, e);
    },
    [startDrag]
  );

  const handlePortMouseEnter = useCallback(
    (stepId: string, portType: PortType) => {
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
