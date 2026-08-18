import { useMemo, useState, useEffect } from 'preact/hooks';
import { isChannelCyclic } from '@hyperneo/shared';
import type { SpaceWorkflow, WorkflowChannel } from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';
import type { WorkflowNodeData } from './visual-editor/WorkflowCanvas';
import type { ResolvedWorkflowChannel } from './visual-editor/EdgeRenderer';
import type { ViewportState, NodePosition } from './visual-editor/types';
import { workflowToVisualState } from './visual-editor/serialization';
import { buildVisualNodePositions } from './visual-editor/nodeMetrics';
import type { AgentTaskState } from './WorkflowNodeCard';
import {
  buildSemanticWorkflowEdges,
  routeSemanticWorkflowEdges,
  buildNodeAnchorUsage,
} from './visual-editor/semanticWorkflowGraph';

export interface RuntimeCanvasData {
  nodeData: WorkflowNodeData[];
  channelEdges: ResolvedWorkflowChannel[];
  canvasNodePositions: NodePosition;
  viewportState: ViewportState;
  setViewportState: (state: ViewportState) => void;
  workflow: SpaceWorkflow | null;
}

export function useRuntimeCanvasData(
  workflowId: string | null,
  runId: string | null
): RuntimeCanvasData {
  const agents = spaceStore.agents.value;
  const nodeExecutionsByNodeId = spaceStore.nodeExecutionsByNodeId.value;

  const [workflow, setWorkflow] = useState<SpaceWorkflow | null>(null);
  const workflowVersion = spaceStore.workflowVersions.value.get(workflowId ?? '') ?? 0;

  useEffect(() => {
    if (!workflowId) {
      setWorkflow(null);
      return;
    }
    let cancelled = false;
    setWorkflow(null);
    spaceStore.fetchWorkflowDetail(workflowId).then((wf) => {
      if (!cancelled) setWorkflow(wf);
    });
    return () => {
      cancelled = true;
    };
  }, [workflowId, workflowVersion]);

  const [viewportState, setViewportState] = useState<ViewportState>({
    offsetX: 0,
    offsetY: 0,
    scale: 1,
  });

  const visualState = useMemo(
    () => (workflow ? workflowToVisualState(workflow) : null),
    [workflow]
  );

  const nodes = visualState?.nodes ?? [];
  const channels: WorkflowChannel[] = visualState?.channels ?? [];

  const endpointNodeIdLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of nodes) {
      if (node.step.agentId) map.set(node.step.agentId, node.step.localId);
      if (node.step.name) map.set(node.step.name, node.step.localId);
      for (const agent of node.step.agents ?? []) {
        if (agent.name) map.set(agent.name, node.step.localId);
        if (agent.agentId) map.set(agent.agentId, node.step.localId);
      }
    }
    return map;
  }, [nodes]);

  const nodeOrderByLocalId = useMemo(
    () => new Map(nodes.map((node, index) => [node.step.localId, index])),
    [nodes]
  );

  const cyclicChannelIndexes = useMemo(() => {
    const set = new Set<number>();
    for (let i = 0; i < channels.length; i++) {
      if (isChannelCyclic(i, channels, [], endpointNodeIdLookup, nodeOrderByLocalId)) {
        set.add(i);
      }
    }
    return set;
  }, [channels, endpointNodeIdLookup, nodeOrderByLocalId]);

  const semanticEdges = useMemo(
    () => buildSemanticWorkflowEdges(nodes, channels, cyclicChannelIndexes),
    [nodes, channels, cyclicChannelIndexes]
  );

  const routedSemanticEdges = useMemo(
    () => routeSemanticWorkflowEdges(nodes, semanticEdges),
    [nodes, semanticEdges]
  );

  const anchorUsageByNodeId = useMemo(
    () => buildNodeAnchorUsage(routedSemanticEdges),
    [routedSemanticEdges]
  );

  const channelEdges = useMemo<ResolvedWorkflowChannel[]>(
    () =>
      routedSemanticEdges.map((edge) => ({
        fromStepId: edge.fromStepId,
        toStepId: edge.toStepId,
        direction: edge.direction,
        isCyclic: edge.hasCyclic,
        sourceSide: edge.sourceSide,
        targetSide: edge.targetSide,
        id: edge.id,
      })),
    [routedSemanticEdges]
  );

  const nodeData = useMemo<WorkflowNodeData[]>(() => {
    const startKey =
      workflow?.nodes.find((s) => s.id === workflow.startNodeId)?.id ??
      workflow?.nodes[0]?.id ??
      '';
    const endKey = workflow?.endNodeId
      ? (workflow.nodes.find((s) => s.id === workflow.endNodeId)?.id ?? undefined)
      : undefined;

    return nodes.map((node, i) => {
      const nodeId = node.step.id;
      const allNodeExecs = nodeId ? (nodeExecutionsByNodeId.get(nodeId) ?? []) : [];
      const nodeExecs = runId
        ? allNodeExecs.filter((e) => e.workflowRunId === runId)
        : allNodeExecs;
      const nodeTaskStates: AgentTaskState[] = nodeExecs.map((e) => ({
        agentName: e.agentName ?? null,
        status: e.status,
        completionSummary: e.result,
      }));

      const isStartNode = node.step.localId === startKey || node.step.id === startKey;
      const isEndNode = !!endKey && (node.step.localId === endKey || node.step.id === endKey);

      return {
        stepIndex: i,
        step: node.step,
        position: node.position,
        agents,
        workflowChannels: channels,
        isStartNode,
        isEndNode,
        activeAnchorSides: anchorUsageByNodeId.get(node.step.localId) ?? [],
        nodeTaskStates: nodeTaskStates.length > 0 ? nodeTaskStates : undefined,
      };
    });
  }, [nodes, agents, channels, workflow, nodeExecutionsByNodeId, runId, anchorUsageByNodeId]);

  const canvasNodePositions = useMemo<NodePosition>(() => buildVisualNodePositions(nodes), [nodes]);

  return {
    nodeData,
    channelEdges,
    canvasNodePositions,
    viewportState,
    setViewportState,
    workflow,
  };
}
