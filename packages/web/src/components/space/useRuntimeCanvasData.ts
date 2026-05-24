/**
 * useRuntimeCanvasData
 *
 * Derives WorkflowNodeData[] and ResolvedWorkflowChannel[] from spaceStore for
 * use in the read-only runtime canvas view.
 *
 * Data sources:
 * - spaceStore.workflows — workflow definition
 * - spaceStore.agents — agent metadata for node cards
 * - spaceStore.nodeExecutionsByNodeId — per-node execution status
 * - hub RPC spaceWorkflowRun.listGateData + space.gateData.updated events
 */

import { useMemo, useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { isChannelCyclic } from '@neokai/shared';
import type { Gate, SpaceWorkflow, WorkflowChannel } from '@neokai/shared';
import { spaceStore } from '../../lib/space-store';
import { connectionManager } from '../../lib/connection-manager';
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
import { evaluateGateStatus, parseScriptResult, type GateStatus } from './gate-status';

// ---- Gate data types ----

interface GateDataRecord {
  runId: string;
  gateId: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

// ---- Hook ----

export interface RuntimeCanvasData {
  nodeData: WorkflowNodeData[];
  channelEdges: ResolvedWorkflowChannel[];
  canvasNodePositions: NodePosition;
  viewportState: ViewportState;
  setViewportState: (state: ViewportState) => void;
  workflow: SpaceWorkflow | null;
  gateDataLoading: boolean;
  /** Gate data keyed by gateId — used by GateArtifactsView for PR link extraction. */
  gateDataMap: Map<string, Record<string, unknown>>;
  /** Last gate-data fetch error, if any. Null when loading or after success. */
  gateDataError: string | null;
  /** Re-run the gate-data fetch (e.g. for a Retry button). */
  retryGateData: () => void;
}

export function useRuntimeCanvasData(
  workflowId: string | null,
  runId: string | null
): RuntimeCanvasData {
  const agents = spaceStore.agents.value;
  const nodeExecutionsByNodeId = spaceStore.nodeExecutionsByNodeId.value;

  const [workflow, setWorkflow] = useState<SpaceWorkflow | null>(null);
  // Read the workflow version so the effect re-runs when the same workflow
  // is edited in place (spaceStore bumps the version on spaceWorkflow.updated).
  const workflowVersion = spaceStore.workflowVersions.value.get(workflowId ?? '') ?? 0;

  useEffect(() => {
    if (!workflowId) {
      setWorkflow(null);
      return;
    }
    let cancelled = false;
    // Clear stale workflow immediately so the canvas never renders with
    // nodes/channels/gates from a previous ID while the new fetch is in flight.
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

  // ---- Gate data fetching ----
  const [gateDataMap, setGateDataMap] = useState<Map<string, Record<string, unknown>>>(new Map());
  const [gateDataLoading, setGateDataLoading] = useState(false);
  const [gateDataError, setGateDataError] = useState<string | null>(null);
  const [gateDataAttempt, setGateDataAttempt] = useState(0);
  const runIdRef = useRef<string | null>(null);
  const retryGateData = useCallback(() => setGateDataAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!runId || !workflow) {
      setGateDataMap(new Map());
      setGateDataError(null);
      return;
    }
    runIdRef.current = runId;
    setGateDataLoading(true);
    setGateDataError(null);

    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      // WS not connected at mount — surface as an error so the Retry chip
      // renders. Clicking Retry bumps gateDataAttempt and re-enters this
      // effect; by then the connection may have come back up.
      setGateDataLoading(false);
      setGateDataError('Not connected');
      return;
    }

    hub
      .request<{ gateData: GateDataRecord[] }>('spaceWorkflowRun.listGateData', { runId })
      .then((result) => {
        if (runIdRef.current !== runId) return;
        setGateDataMap((prev) => {
          // Build from fetched data, then overlay any event-based updates that
          // arrived while the request was in-flight — events are more recent.
          const fetched = new Map<string, Record<string, unknown>>();
          for (const record of result.gateData) {
            fetched.set(record.gateId, record.data);
          }
          for (const [gateId, data] of prev) {
            fetched.set(gateId, data);
          }
          return fetched;
        });
      })
      .catch((err: unknown) => {
        if (runIdRef.current !== runId) return;
        setGateDataError(err instanceof Error ? err.message : 'Failed to load gate data');
      })
      .finally(() => {
        if (runIdRef.current === runId) setGateDataLoading(false);
      });

    const unsubscribe = hub.onEvent<{
      runId: string;
      gateId: string;
      data: Record<string, unknown>;
    }>('space.gateData.updated', (event) => {
      if (event.runId !== runId) return;
      setGateDataMap((prev) => {
        const next = new Map(prev);
        next.set(event.gateId, event.data);
        return next;
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [runId, workflow?.id, gateDataAttempt]);

  // ---- Build visual state from workflow ----
  const visualState = useMemo(
    () => (workflow ? workflowToVisualState(workflow) : null),
    [workflow]
  );

  // ---- Endpoint lookup for channel resolution ----
  const nodes = visualState?.nodes ?? [];
  const channels: WorkflowChannel[] = visualState?.channels ?? [];
  const gates: Gate[] = visualState?.gates ?? [];

  // Compute cyclic channel indexes (same as VisualWorkflowEditor)
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
    () => buildSemanticWorkflowEdges(nodes, channels, gates, cyclicChannelIndexes),
    [nodes, channels, gates, cyclicChannelIndexes]
  );

  const routedSemanticEdges = useMemo(
    () => routeSemanticWorkflowEdges(nodes, semanticEdges),
    [nodes, semanticEdges]
  );

  const anchorUsageByNodeId = useMemo(
    () => buildNodeAnchorUsage(routedSemanticEdges),
    [routedSemanticEdges]
  );

  // ---- Build channel edges with runtime status ----
  const channelEdges = useMemo<ResolvedWorkflowChannel[]>(() => {
    const gateLookup = new Map((gates ?? []).map((g) => [g.id, g]));

    return routedSemanticEdges.map((edge) => {
      // Find the forward gate ID from the channels that make up this edge
      let forwardGateId: string | undefined;

      for (const channelIndex of edge.channelIndexes) {
        const ch = channels[channelIndex];
        if (!ch) continue;
        const fromNodeId = endpointNodeIdLookup.get(ch.from);
        if (fromNodeId === edge.fromStepId) {
          forwardGateId = forwardGateId ?? ch.gateId;
        }
      }

      // Compute runtime status for forward gate
      let runtimeStatus: GateStatus | undefined;
      let voteCount: { current: number; min: number } | undefined;
      if (forwardGateId && runId) {
        const gate = gateLookup.get(forwardGateId);
        const data = gateDataMap.get(forwardGateId) ?? {};
        const scriptResult = gate ? parseScriptResult(data) : { failed: false };
        runtimeStatus = gate ? evaluateGateStatus(gate, data, scriptResult.failed) : undefined;
        // Compute vote count for count-type gates (e.g. review-votes-gate)
        const countField = gate?.fields?.find((f) => f.check.op === 'count');
        if (countField && countField.check.op === 'count') {
          const map = data[countField.name];
          const match = countField.check.match;
          const current =
            map && typeof map === 'object' && !Array.isArray(map)
              ? Object.values(map as Record<string, unknown>).filter((v) => v === match).length
              : 0;
          voteCount = { current, min: countField.check.min };
        }
      }

      return {
        fromStepId: edge.fromStepId,
        toStepId: edge.toStepId,
        direction: edge.direction,
        gateType: edge.gateType,
        reverseGateType: edge.reverseGateType,
        gateLabel: edge.gateLabel,
        gateColor: edge.gateColor,
        hasScript: edge.hasScript,
        reverseGateLabel: edge.reverseGateLabel,
        reverseGateColor: edge.reverseGateColor,
        reverseHasScript: edge.reverseHasScript,
        isCyclic: edge.hasCyclic,
        sourceSide: edge.sourceSide,
        targetSide: edge.targetSide,
        id: edge.id,
        runtimeStatus,
        gateId: forwardGateId,
        voteCount,
      };
    });
  }, [routedSemanticEdges, channels, endpointNodeIdLookup, gates, gateDataMap, runId]);

  // ---- Build WorkflowNodeData[] ----
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

  // ---- Build canvas node positions ----
  const canvasNodePositions = useMemo<NodePosition>(() => buildVisualNodePositions(nodes), [nodes]);

  return {
    nodeData,
    channelEdges,
    canvasNodePositions,
    viewportState,
    setViewportState,
    workflow,
    gateDataLoading,
    gateDataMap,
    gateDataError,
    retryGateData,
  };
}
