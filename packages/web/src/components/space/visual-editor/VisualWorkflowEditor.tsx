import { useEffect, useState, useMemo, useCallback, useRef } from 'preact/hooks';
import type {
  SpaceWorkflow,
  WorkflowNode,
  WorkflowChannel,
  SpaceAutonomyLevel,
  WorkflowHook,
} from '@hyperneo/shared';
import { generateUUID, isChannelCyclic } from '@hyperneo/shared';
import { spaceStore } from '../../../lib/space-store';
import { AUTONOMY_LEVELS } from '../../../lib/space-constants';
import { filterAgents, buildTemplateNodes, getAvailableTemplates } from '../workflow-templates';
import type { WorkflowTemplate } from '../workflow-templates';
import { ConfirmModal } from '../../ui/ConfirmModal';
import type { NodeDraft, AgentTaskState } from '../WorkflowNodeCard';
import type { ViewportState, Point, VisualTransition, WorkflowConditionType } from './types';
import type { VisualNode, VisualEdge, VisualEditorState } from './serialization';
import {
  workflowToVisualState,
  visualStateToCreateParams,
  visualStateToUpdateParams,
} from './serialization';
import type { WorkflowNodeData } from './WorkflowCanvas';
import { WorkflowCanvas } from './WorkflowCanvas';
import { computeFitToView } from './CanvasToolbar';
import { autoLayout } from './layout';
import type { NodePosition } from './types';
import { NodeConfigPanel } from './NodeConfigPanel';
import type { NodeChannelLink } from './NodeConfigPanel';
import { EdgeConfigPanel } from './EdgeConfigPanel';
import { ChannelRelationConfigPanel } from './ChannelRelationConfigPanel';
import { buildVisualNodePositions } from './nodeMetrics';
import type { ResolvedWorkflowChannel } from './EdgeRenderer';
import {
  buildNodeAnchorUsage,
  buildSemanticWorkflowEdges,
  routeSemanticWorkflowEdges,
} from './semanticWorkflowGraph';

function remapHookCallerAgentSlots(
  slots: string[] | undefined,
  previousStep: NodeDraft | undefined,
  nextStep: NodeDraft
): string[] | undefined {
  if (!slots || !previousStep?.agents || !nextStep.agents) return slots;

  const nextSlots = slots.flatMap((slot) => {
    const index = previousStep.agents?.findIndex((agent) => agent.name === slot) ?? -1;
    if (index === -1) return [slot];
    const nextName = nextStep.agents?.[index]?.name?.trim();
    return nextName ? [nextName] : [];
  });

  return nextSlots.length > 0 ? nextSlots : undefined;
}

function buildTemplateCanvasSignature(
  nodes: VisualNode[],
  edges: VisualEdge[],
  channels: WorkflowChannel[],
  startNodeId: string,
  hooks: WorkflowHook[],
  endNodeId: string | undefined
): string {
  const regularNodes = nodes
    .map((node) => ({
      localId: node.step.localId,
      id: node.step.id ?? null,
      name: node.step.name,
      agentId: node.step.agentId ?? null,
      model: node.step.model ?? null,
      thinkingLevel: node.step.thinkingLevel ?? null,
      customPrompt: node.step.customPrompt ?? null,
      replaceAgentPrompt: node.step.replaceAgentPrompt ?? null,
      resetContextPerTurn: node.step.resetContextPerTurn ?? null,
      agents:
        node.step.agents?.map((agent) => ({
          agentId: agent.agentId ?? null,
          name: agent.name ?? '',
          model: agent.model ?? null,
          thinkingLevel: agent.thinkingLevel ?? null,
          customPrompt: agent.customPrompt ?? null,
          replaceAgentPrompt: agent.replaceAgentPrompt ?? null,
          resetContextPerTurn: agent.resetContextPerTurn ?? null,
        })) ?? [],
      nodeChannels:
        node.step.channels?.map((channel) => ({
          from: channel.from,
          to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
        })) ?? [],
      postApproval: node.step.postApproval ? { ...node.step.postApproval } : null,
      position: { x: node.position.x, y: node.position.y },
    }))
    .sort((a, b) => a.localId.localeCompare(b.localId));

  const normalizedEdges = edges
    .map((edge) => ({
      fromStepKey: edge.fromStepKey,
      toStepKey: edge.toStepKey,
      condition: edge.condition ? { ...edge.condition } : undefined,
    }))
    .sort((a, b) =>
      `${a.fromStepKey}:${a.toStepKey}`.localeCompare(`${b.fromStepKey}:${b.toStepKey}`)
    );

  const normalizedChannels = channels
    .map((channel) => ({
      from: channel.from,
      to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
      maxCycles: channel.maxCycles ?? null,
    }))
    .sort((a, b) => `${a.from}:${String(a.to)}`.localeCompare(`${b.from}:${String(b.to)}`));

  const normalizedHooks = hooks
    .map((hook) => ({
      ...hook,
      targetNode: hook.targetNode ?? null,
      label: hook.label ?? null,
      templateData: hook.templateData ?? null,
      classification: hook.classification ?? null,
      authorizedCallers: hook.authorizedCallers ?? [],
      retry: hook.retry ?? null,
      poll: hook.poll ?? null,
      order: hook.order ?? null,
      humanOnly: hook.humanOnly ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    nodes: regularNodes,
    edges: normalizedEdges,
    channels: normalizedChannels,
    startNodeId,
    endNodeId,
    hooks: normalizedHooks,
  });
}

function resolveChannelTargetNodeIds(
  channel: WorkflowChannel,
  endpointNodeIdLookup: Map<string, string>
): string[] {
  const targets = Array.isArray(channel.to) ? channel.to : [channel.to];
  return targets
    .map((target) => endpointNodeIdLookup.get(target) ?? null)
    .filter((nodeId): nodeId is string => !!nodeId);
}

function inferChannelIsCyclic(
  channel: WorkflowChannel,
  channels: WorkflowChannel[],
  endpointNodeIdLookup: Map<string, string>,
  nodeOrder: Map<string, number>,
  options?: { ignoreChannelIndex?: number }
): boolean {
  const index = channels.indexOf(channel);
  if (index === -1) return false;
  return isChannelCyclic(
    index,
    channels,
    [],
    endpointNodeIdLookup,
    nodeOrder,
    options?.ignoreChannelIndex
  );
}

export interface VisualWorkflowEditorProps {
  workflow?: SpaceWorkflow;
  onSave: () => void;
  onCancel: () => void;
}

export function VisualWorkflowEditor({ workflow, onSave, onCancel }: VisualWorkflowEditorProps) {
  const isEditing = !!workflow;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initState: VisualEditorState | null = useMemo(
    () => (workflow ? workflowToVisualState(workflow) : null),
    []
  );

  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [nodes, setNodes] = useState<VisualNode[]>(() => initState?.nodes ?? []);
  const [edges, setEdges] = useState<VisualEdge[]>(() => initState?.edges ?? []);
  const [tags, setTags] = useState<string[]>(() => initState?.tags ?? []);
  const [startNodeId, setStartStepId] = useState<string>(() => initState?.startNodeId ?? '');
  const [endNodeId, setEndNodeId] = useState<string | undefined>(() => initState?.endNodeId);
  const [channels, setChannels] = useState<WorkflowChannel[]>(() => initState?.channels ?? []);
  const [hooks, setHooks] = useState<WorkflowHook[]>(() => initState?.hooks ?? []);
  const [completionAutonomyLevel, setCompletionAutonomyLevel] = useState<SpaceAutonomyLevel>(
    () =>
      (initState?.completionAutonomyLevel ??
        workflow?.completionAutonomyLevel ??
        3) as SpaceAutonomyLevel
  );
  const [disabled, setDisabled] = useState<boolean>(() => initState?.disabled ?? false);
  const [viewportState, setViewportState] = useState<ViewportState>({
    offsetX: 0,
    offsetY: 0,
    scale: 1,
  });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [pendingTemplate, setPendingTemplate] = useState<WorkflowTemplate | null>(null);
  const [editorView, setEditorView] = useState<'canvas' | 'settings'>('canvas');

  const canvasContainerRef = useRef<HTMLDivElement>(null);

  const agents = filterAgents(spaceStore.agents.value);
  const availableTemplates = useMemo(
    () => getAvailableTemplates(spaceStore.workflowTemplates.value),
    [spaceStore.workflowTemplates.value]
  );
  const nodeExecutionsByNodeId = spaceStore.nodeExecutionsByNodeId.value;
  const regularNodes = nodes;
  const currentTemplateCanvasSignature = useMemo(
    () => buildTemplateCanvasSignature(nodes, edges, channels, startNodeId, hooks, endNodeId),
    [nodes, edges, channels, startNodeId, hooks, endNodeId]
  );
  const [templateBaselineSignature, setTemplateBaselineSignature] = useState(() =>
    buildTemplateCanvasSignature(
      initState?.nodes ?? [],
      initState?.edges ?? [],
      initState?.channels ?? [],
      initState?.startNodeId ?? '',
      initState?.hooks ?? [],
      initState?.endNodeId
    )
  );

  const relevantRunId = (() => {
    if (!workflow?.id) return null;
    const runs = spaceStore.workflowRuns.value.filter((r) => r.workflowId === workflow.id);
    if (!runs.length) return null;
    const active = runs.find((r) => r.status === 'pending' || r.status === 'in_progress');
    if (active) return active.id;
    return [...runs].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  })();

  useEffect(() => {
    spaceStore.ensureNodeExecutions(relevantRunId).catch(() => {});
  }, [relevantRunId]);

  useEffect(() => {
    return () => {
      spaceStore.ensureNodeExecutions(null).catch(() => {});
    };
  }, []);

  const localIdToStepKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of nodes) {
      map.set(node.step.localId, node.step.id ?? node.step.localId);
    }
    return map;
  }, [nodes]);

  const nodeOrderByLocalId = useMemo(
    () => new Map(regularNodes.map((node, index) => [node.step.localId, index])),
    [regularNodes]
  );

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

  const channelEdges = useMemo<ResolvedWorkflowChannel[]>(() => {
    return routedSemanticEdges.map((edge) => ({
      fromStepId: edge.fromStepId,
      toStepId: edge.toStepId,
      direction: edge.direction,
      isCyclic: edge.hasCyclic,
      sourceSide: edge.sourceSide,
      targetSide: edge.targetSide,
      id: edge.id,
    }));
  }, [routedSemanticEdges]);

  const nodeIsStart = useCallback(
    (node: VisualNode): boolean => {
      return node.step.localId === startNodeId || node.step.id === startNodeId;
    },
    [startNodeId]
  );

  const nodeIsEnd = useCallback(
    (node: VisualNode): boolean => {
      return !!endNodeId && (node.step.localId === endNodeId || node.step.id === endNodeId);
    },
    [endNodeId]
  );

  const nodeData = useMemo<WorkflowNodeData[]>(() => {
    return regularNodes.map((node, i) => {
      const nodeId = node.step.id;
      const allNodeExecs = nodeId ? (nodeExecutionsByNodeId.get(nodeId) ?? []) : [];
      const nodeExecs = relevantRunId
        ? allNodeExecs.filter((e) => e.workflowRunId === relevantRunId)
        : allNodeExecs;
      const nodeTaskStates: AgentTaskState[] = nodeExecs.map((e) => ({
        agentName: e.agentName ?? null,
        status: e.status,
        completionSummary: e.result,
      }));
      return {
        stepIndex: i,
        step: node.step,
        position: node.position,
        agents,
        workflowChannels: channels,
        isStartNode: nodeIsStart(node),
        isEndNode: nodeIsEnd(node),
        activeAnchorSides: anchorUsageByNodeId.get(node.step.localId) ?? [],
        nodeTaskStates: nodeTaskStates.length > 0 ? nodeTaskStates : undefined,
      };
    });
  }, [
    regularNodes,
    agents,
    channels,
    nodeIsStart,
    nodeIsEnd,
    nodeExecutionsByNodeId,
    relevantRunId,
    anchorUsageByNodeId,
  ]);

  const canvasNodePositions = useMemo<NodePosition>(
    () => buildVisualNodePositions(regularNodes),
    [regularNodes]
  );

  const selectedNode = selectedNodeId
    ? (nodes.find((n) => n.step.localId === selectedNodeId) ?? null)
    : null;

  const selectedEdgeInfo = useMemo(() => {
    if (!selectedEdgeId) return null;
    const colonIdx = selectedEdgeId.indexOf(':');
    if (colonIdx === -1) return null;
    const fromLocalId = selectedEdgeId.slice(0, colonIdx);
    const toLocalId = selectedEdgeId.slice(colonIdx + 1);
    const fromNode = nodes.find((n) => n.step.localId === fromLocalId);
    const toNode = nodes.find((n) => n.step.localId === toLocalId);
    if (!fromNode || !toNode) return null;
    const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
    const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
    const edge = edges.find((e) => e.fromStepKey === fromKey && e.toStepKey === toKey);
    return { fromNode, toNode, edge, fromKey, toKey };
  }, [selectedEdgeId, nodes, edges, localIdToStepKey]);

  const selectedChannelInfo = useMemo(() => {
    if (selectedChannelId == null) return null;
    const relation = routedSemanticEdges.find((edge) => edge.id === selectedChannelId);
    if (!relation) return null;
    const fromNode = nodes.find((n) => n.step.localId === relation.fromStepId) ?? null;
    const toNode = nodes.find((n) => n.step.localId === relation.toStepId) ?? null;
    const links = Array.from(new Set(relation.channelIndexes))
      .map((index) => {
        const channel = channels[index];
        return channel ? { index, channel } : null;
      })
      .filter((entry): entry is { index: number; channel: WorkflowChannel } => !!entry);

    const forwardLinks = links.filter(({ channel }) => {
      const fromId = endpointNodeIdLookup.get(channel.from);
      const targetIds = resolveChannelTargetNodeIds(channel, endpointNodeIdLookup);
      return fromId === relation.fromStepId && targetIds.includes(relation.toStepId);
    });

    const reverseLinks = links.filter(({ channel }) => {
      const fromId = endpointNodeIdLookup.get(channel.from);
      const targetIds = resolveChannelTargetNodeIds(channel, endpointNodeIdLookup);
      return fromId === relation.toStepId && targetIds.includes(relation.fromStepId);
    });

    const visibleLinkCount = forwardLinks.length + reverseLinks.length;
    const relationIsBidirectional =
      reverseLinks.length > 0 || relation.direction === 'bidirectional' || false;

    return {
      relation,
      fromNode,
      toNode,
      links,
      forwardLinks: forwardLinks.map(({ index, channel }) => ({
        index,
        channel,
        shouldBeCyclic: inferChannelIsCyclic(
          channel,
          channels,
          endpointNodeIdLookup,
          nodeOrderByLocalId,
          {
            ignoreChannelIndex: index,
          }
        ),
      })),
      reverseLinks: reverseLinks.map(({ index, channel }) => ({
        index,
        channel,
        shouldBeCyclic: inferChannelIsCyclic(
          channel,
          channels,
          endpointNodeIdLookup,
          nodeOrderByLocalId,
          {
            ignoreChannelIndex: index,
          }
        ),
      })),
      relationIsBidirectional,
      visibleLinkCount,
      canConvertToBidirectional: forwardLinks.length > 0 && reverseLinks.length === 0,
      relationLabel: relationIsBidirectional
        ? `${fromNode?.step.name || 'Unnamed'} ↔ ${toNode?.step.name || 'Unnamed'}`
        : `${fromNode?.step.name || 'Unnamed'} → ${toNode?.step.name || 'Unnamed'}`,
    };
  }, [
    selectedChannelId,
    routedSemanticEdges,
    nodes,
    channels,
    endpointNodeIdLookup,
    nodeOrderByLocalId,
  ]);

  const nodeChannelLinksByNodeId = useMemo(() => {
    const linksByNodeId = new Map<string, NodeChannelLink[]>();

    for (const edge of routedSemanticEdges) {
      const fromNode = nodes.find((n) => n.step.localId === edge.fromStepId);
      const toNode = nodes.find((n) => n.step.localId === edge.toStepId);
      if (!fromNode || !toNode) continue;

      const link: NodeChannelLink = {
        id: edge.id,
        label:
          edge.direction === 'bidirectional'
            ? `${fromNode.step.name || 'Unnamed'} ↔ ${toNode.step.name || 'Unnamed'}`
            : `${fromNode.step.name || 'Unnamed'} → ${toNode.step.name || 'Unnamed'}`,
        channelCount: edge.channelCount,
      };

      linksByNodeId.set(edge.fromStepId, [...(linksByNodeId.get(edge.fromStepId) ?? []), link]);
      linksByNodeId.set(edge.toStepId, [...(linksByNodeId.get(edge.toStepId) ?? []), link]);
    }

    return linksByNodeId;
  }, [nodes, routedSemanticEdges]);

  function addStep() {
    const newLocalId = generateUUID();
    const newStep: NodeDraft = { localId: newLocalId, name: '', agentId: '' };

    setNodes((prev) => {
      const isFirstNode = prev.length === 0;
      if (isFirstNode) setStartStepId(newLocalId);

      const regularCount = prev.length;
      const position: Point = { x: 120, y: 80 + regularCount * 100 };

      return [...prev, { step: newStep, position }];
    });
  }

  const handleNodePositionChange = useCallback((localId: string, newPosition: Point) => {
    setNodes((prev) =>
      prev.map((n) => (n.step.localId === localId ? { ...n, position: newPosition } : n))
    );
  }, []);

  const handleNodeSelect = useCallback((localId: string | null) => {
    setSelectedNodeId(localId);
    if (localId) {
      setSelectedEdgeId(null);
      setSelectedChannelId(null);
    }
  }, []);

  const handleDeleteNode = useCallback(
    (localId: string) => {
      const nodeToDelete = nodes.find((n) => n.step.localId === localId);
      if (!nodeToDelete) return;

      const key = nodeToDelete.step.id ?? nodeToDelete.step.localId;
      const remaining = nodes.filter((n) => n.step.localId !== localId);
      const wasStart =
        nodeToDelete.step.localId === startNodeId || nodeToDelete.step.id === startNodeId;
      const wasEnd = nodeToDelete.step.localId === endNodeId || nodeToDelete.step.id === endNodeId;

      setNodes(remaining);
      setEdges((prev) => prev.filter((e) => e.fromStepKey !== key && e.toStepKey !== key));
      const deletedRefs = new Set(
        [nodeToDelete.step.name, nodeToDelete.step.id, nodeToDelete.step.localId].filter(Boolean)
      );
      setHooks((prev) =>
        prev
          .filter((hook) => !deletedRefs.has(hook.sourceNode) && !deletedRefs.has(hook.targetNode))
          .map((hook) => ({
            ...hook,
            authorizedCallers: hook.authorizedCallers?.filter(
              (caller) => !deletedRefs.has(caller.sourceNode)
            ),
          }))
      );

      if (wasStart && remaining.length > 0) {
        const next = remaining[0];
        setStartStepId(next.step.id ?? next.step.localId);
      } else if (wasStart) {
        setStartStepId('');
      }

      if (wasEnd) {
        setEndNodeId(undefined);
      }

      setSelectedNodeId(null);
    },
    [nodes, startNodeId, endNodeId]
  );

  const handleUpdateNode = useCallback(
    (step: NodeDraft) => {
      const previousNode = nodes.find((n) => n.step.localId === step.localId);
      const previousRefs = new Set(
        [previousNode?.step.name, previousNode?.step.id, previousNode?.step.localId].filter(Boolean)
      );
      const nextRef = step.name || step.localId;

      setNodes((prev) => prev.map((n) => (n.step.localId === step.localId ? { ...n, step } : n)));

      setHooks((prev) =>
        prev.map((hook) => ({
          ...hook,
          sourceNode: previousRefs.has(hook.sourceNode) ? nextRef : hook.sourceNode,
          targetNode: previousRefs.has(hook.targetNode) ? nextRef : hook.targetNode,
          authorizedCallers: hook.authorizedCallers?.map((caller) => ({
            ...caller,
            sourceNode: previousRefs.has(caller.sourceNode) ? nextRef : caller.sourceNode,
            agentSlots: previousRefs.has(caller.sourceNode)
              ? remapHookCallerAgentSlots(caller.agentSlots, previousNode?.step, step)
              : caller.agentSlots,
          })),
        }))
      );
    },
    [nodes]
  );

  const handleSetAsStart = useCallback((localId: string) => {
    setStartStepId(localId);
  }, []);

  const handleSetAsEnd = useCallback((localId: string) => {
    setEndNodeId((prev) => (prev === localId ? undefined : localId));
  }, []);

  const handleEdgeSelect = useCallback((edgeId: string | null) => {
    setSelectedEdgeId(edgeId);
    if (edgeId) {
      setSelectedNodeId(null);
      setSelectedChannelId(null);
    }
  }, []);

  const handleChannelSelect = useCallback((channelId: string | null) => {
    setSelectedChannelId(channelId);
    if (channelId) {
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    }
  }, []);

  const handleChannelSelectFromNodePanel = useCallback((channelId: string | null) => {
    setSelectedChannelId(channelId);
    if (channelId) {
      setSelectedEdgeId(null);
    }
  }, []);

  const resolveSourceChannelName = useCallback((node: VisualNode): string | null => {
    if (node.step.name?.trim()) return node.step.name.trim();
    if (node.step.agentId?.trim()) return node.step.agentId.trim();
    return null;
  }, []);

  const resolveTargetChannelName = useCallback((node: VisualNode): string | null => {
    if (node.step.name?.trim()) return node.step.name.trim();
    if (node.step.agentId?.trim()) return node.step.agentId.trim();
    return null;
  }, []);

  const handleCreateTransition = useCallback(
    (fromLocalId: string, toLocalId: string) => {
      const fromNode = nodes.find((n) => n.step.localId === fromLocalId);
      const toNode = nodes.find((n) => n.step.localId === toLocalId);
      if (!fromNode || !toNode) return;

      const fromName = resolveSourceChannelName(fromNode);
      const toName = resolveTargetChannelName(toNode);
      if (!toName || !fromName) return;

      setChannels((prev) => {
        const newChannel: WorkflowChannel = {
          from: fromName,
          to: toName,
        };

        if (
          prev.some(
            (ch) =>
              ch.from === newChannel.from &&
              !Array.isArray(ch.to) &&
              ch.to === newChannel.to &&
              true
          )
        ) {
          return prev;
        }

        if (inferChannelIsCyclic(newChannel, prev, endpointNodeIdLookup, nodeOrderByLocalId)) {
          newChannel.maxCycles = 5;
        }

        return [...prev, newChannel];
      });
    },
    [
      nodes,
      resolveSourceChannelName,
      resolveTargetChannelName,
      endpointNodeIdLookup,
      nodeOrderByLocalId,
    ]
  );

  const handleUpdateChannelFromEdgePanel = useCallback(
    (index: number, channel: WorkflowChannel) => {
      setChannels((prev) => prev.map((ch, i) => (i === index ? channel : ch)));
    },
    []
  );

  const handleDeleteChannelFromEdgePanel = useCallback((index: number) => {
    setChannels((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleConvertChannelRelationToBidirectional = useCallback(() => {
    if (!selectedChannelInfo?.fromNode || !selectedChannelInfo.toNode) return;

    const reverseSourceName = resolveSourceChannelName(selectedChannelInfo.toNode);
    const reverseTargetName = resolveTargetChannelName(selectedChannelInfo.fromNode);
    if (!reverseSourceName || !reverseTargetName) return;

    const relationFromStepId = selectedChannelInfo.relation.fromStepId;
    const relationToStepId = selectedChannelInfo.relation.toStepId;

    setChannels((prev) => {
      const next = [...prev];

      const reverseAlreadyExists = next.some((channel) => {
        const fromId = endpointNodeIdLookup.get(channel.from);
        const targetValues = Array.isArray(channel.to) ? channel.to : [channel.to];
        const targetNodeIds = targetValues
          .map((target) => endpointNodeIdLookup.get(target) ?? null)
          .filter((nodeId): nodeId is string => !!nodeId);

        return (
          fromId === relationToStepId &&
          targetNodeIds.includes(relationFromStepId) &&
          channel.from === reverseSourceName &&
          targetValues.includes(reverseTargetName)
        );
      });

      if (reverseAlreadyExists) return prev;

      const reverseChannel: WorkflowChannel = {
        from: reverseSourceName,
        to: reverseTargetName,
      };
      if (inferChannelIsCyclic(reverseChannel, next, endpointNodeIdLookup, nodeOrderByLocalId)) {
        reverseChannel.maxCycles = 5;
      }
      next.push(reverseChannel);

      return next;
    });
  }, [
    selectedChannelInfo,
    resolveSourceChannelName,
    resolveTargetChannelName,
    endpointNodeIdLookup,
    nodeOrderByLocalId,
  ]);

  const handleDeleteEdge = useCallback(
    (edgeId: string) => {
      const colonIdx = edgeId.indexOf(':');
      if (colonIdx === -1) return;
      const fromLocalId = edgeId.slice(0, colonIdx);
      const toLocalId = edgeId.slice(colonIdx + 1);
      const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
      const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
      setEdges((prev) => prev.filter((e) => !(e.fromStepKey === fromKey && e.toStepKey === toKey)));
      setSelectedEdgeId(null);
    },
    [localIdToStepKey]
  );

  const handleUpdateEdgeCondition = useCallback(
    (edgeId: string, conditionType: WorkflowConditionType, expression?: string) => {
      const colonIdx = edgeId.indexOf(':');
      if (colonIdx === -1) return;
      const fromLocalId = edgeId.slice(0, colonIdx);
      const toLocalId = edgeId.slice(colonIdx + 1);
      const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
      const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
      setEdges((prev) =>
        prev.map((e) => {
          if (e.fromStepKey !== fromKey || e.toStepKey !== toKey) return e;
          const newCond =
            conditionType === 'always'
              ? undefined
              : { ...e.condition, type: conditionType, expression };
          return { ...e, condition: newCond };
        })
      );
    },
    [localIdToStepKey]
  );

  function addTag(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags((prev) => [...prev, trimmed]);
    }
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  function handleTagInputKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput);
      setTagInput('');
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }

  function applyTemplate(template: WorkflowTemplate) {
    const templateSteps = buildTemplateNodes(template, agents);
    if (templateSteps.length === 0) return;
    const templateStartName = template.startStepName?.trim();
    const templateEndName = template.endStepName?.trim();
    if (!templateStartName || !templateEndName) {
      setError(`Template "${template.label}" is missing required start/end node metadata.`);
      return;
    }
    const resolvedStartLocalId =
      templateSteps.find((step) => step.name === templateStartName)?.localId ?? '';
    const resolvedEndLocalId =
      templateSteps.find((step) => step.name === templateEndName)?.localId ?? '';

    if (!resolvedStartLocalId || !resolvedEndLocalId) {
      setError(`Template "${template.label}" is missing required start/end node metadata.`);
      return;
    }

    const newNodes: VisualNode[] = templateSteps.map((step) => ({
      step: {
        ...step,
        agents: step.agents?.map((slot) => ({ ...slot })),
        channels: step.channels?.map((channel) => ({
          ...channel,
          to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
        })),
      },
      position: { x: 0, y: 0 },
    }));

    const localIds = templateSteps.map((step) => step.localId);

    const newEdges: VisualEdge[] = localIds.slice(0, -1).map((fromId, i) => ({
      fromStepKey: fromId,
      toStepKey: localIds[i + 1],
      condition: undefined,
    }));

    const layoutSteps: WorkflowNode[] = newNodes.map((n) => ({
      id: n.step.localId,
      name: n.step.name,
      agents: n.step.agents?.map((slot) => ({ ...slot })) ?? [],
    }));
    const layoutTransitions: VisualTransition[] = newEdges.map((e, i) => ({
      id: `t-${i}`,
      from: e.fromStepKey,
      to: e.toStepKey,
      order: i,
    }));

    const positions = autoLayout(
      layoutSteps,
      layoutTransitions,
      resolvedStartLocalId,
      template.channels ?? []
    );

    const positionedNodes: VisualNode[] = newNodes.map((n) => ({
      ...n,
      position: positions.get(n.step.localId) ?? n.position,
    }));

    const nextNodes = positionedNodes;
    const nextChannels = (template.channels ?? []).map((channel) => ({
      ...channel,
      to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
    }));
    const nextHooks = (template.hooks ?? []).map((hook) => ({ ...hook }));

    setNodes(nextNodes);
    setEdges(newEdges);
    setChannels(nextChannels);
    setHooks(nextHooks);
    if (template.tags) {
      setTags([...template.tags]);
    }
    setStartStepId(resolvedStartLocalId);
    setEndNodeId(resolvedEndLocalId);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setShowTemplates(false);
    setPendingTemplate(null);
    setTemplateBaselineSignature(
      buildTemplateCanvasSignature(
        nextNodes,
        newEdges,
        nextChannels,
        resolvedStartLocalId,
        nextHooks,
        resolvedEndLocalId
      )
    );
    if (!name) setName(template.label);

    const container = canvasContainerRef.current;
    if (container) {
      setViewportState(
        computeFitToView(
          buildVisualNodePositions(positionedNodes),
          container.clientWidth,
          container.clientHeight
        )
      );
    } else {
      setViewportState({ offsetX: 0, offsetY: 0, scale: 1 });
    }
  }

  function handleTemplateSelection(template: WorkflowTemplate) {
    setShowTemplates(false);
    if (currentTemplateCanvasSignature !== templateBaselineSignature) {
      setPendingTemplate(template);
      return;
    }
    applyTemplate(template);
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('Workflow name is required.');
      return;
    }
    const regularNodes = nodes;

    if (regularNodes.length === 0) {
      setError('A workflow must have at least one node.');
      return;
    }

    for (let i = 0; i < regularNodes.length; i++) {
      const step = regularNodes[i].step;
      const hasMultiAgent = Array.isArray(step.agents) && step.agents.length > 0;
      if (!hasMultiAgent && !step.agentId) {
        setError(`Node ${i + 1} requires an agent.`);
        return;
      }
    }

    for (const edge of edges) {
      if (edge.condition?.type === 'condition' && !edge.condition.expression?.trim()) {
        setError('A transition using "Expression" condition requires a non-empty expression.');
        return;
      }
    }
    for (const node of regularNodes) {
      const route = node.step.postApproval;
      if (!route) continue;
      const nodeLabel = node.step.name?.trim() || 'selected node';
      if (!route.instructions.trim()) {
        setError(`Post-approval instructions are required on ${nodeLabel}.`);
        return;
      }
    }

    const visualState: VisualEditorState = {
      nodes,
      edges,
      startNodeId,
      endNodeId: endNodeId || undefined,
      tags,
      channels,
      hooks,
      completionAutonomyLevel,
      disabled,
    };

    setSaving(true);
    setError(null);

    try {
      if (isEditing && workflow) {
        const params = visualStateToUpdateParams(visualState, {
          name: name.trim(),
          description: description.trim() || null,
        });
        await spaceStore.updateWorkflow(workflow.id, params);
      } else {
        const fullParams = visualStateToCreateParams(
          visualState,
          '',
          name.trim(),
          description.trim() || undefined
        );
        const { spaceId: _spaceId, ...createParams } = fullParams;
        await spaceStore.createWorkflow(createParams);
      }
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save workflow.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="visual-workflow-editor" class="flex h-full flex-col overflow-hidden bg-bg">
      <div class="flex-shrink-0 border-b border-line bg-surface/95">
        <div class="flex h-[52px] items-center gap-2 px-3 sm:px-4">
          <button
            onClick={onCancel}
            class="flex h-8 w-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg-soft"
            title="Back"
            data-testid="back-button"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <h1 class="truncate text-sm font-semibold text-fg">
                {isEditing ? 'Edit Workflow' : 'New Workflow'}
              </h1>
              <span class="hidden rounded-full bg-fill-soft px-2 py-0.5 text-xs text-fg-muted sm:inline-flex">
                {regularNodes.length} {regularNodes.length === 1 ? 'node' : 'nodes'}
              </span>
              {disabled && (
                <span class="hidden rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger-soft sm:inline-flex">
                  Disabled
                </span>
              )}
            </div>
          </div>
          <div class="flex items-center gap-1 rounded-lg border border-line bg-surface-raised/75 p-1 shadow-lg shadow-black/10 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => setEditorView('canvas')}
              class={[
                'px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
                editorView === 'canvas'
                  ? 'text-fg bg-fill-strong/70 shadow-sm'
                  : 'text-fg-soft/80 hover:text-fg hover:bg-fill-strong/40',
              ].join(' ')}
              data-testid="workflow-canvas-toggle"
              aria-pressed={editorView === 'canvas'}
            >
              Canvas
            </button>
            <button
              type="button"
              onClick={() => setEditorView('settings')}
              class={[
                'px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap',
                editorView === 'settings'
                  ? 'text-fg bg-fill-strong/70 shadow-sm'
                  : 'text-fg-soft/80 hover:text-fg hover:bg-fill-strong/40',
              ].join(' ')}
              data-testid="workflow-settings-toggle"
              aria-pressed={editorView === 'settings'}
            >
              Settings
            </button>
          </div>
          <button
            onClick={onCancel}
            class="hidden rounded-lg px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg-soft sm:inline-flex"
            data-testid="cancel-button"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            data-testid="save-button"
            class="whitespace-nowrap rounded-lg bg-accent-hover px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent disabled:opacity-50"
          >
            {saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Workflow'}
          </button>
        </div>
      </div>

      {error && (
        <div class="px-4 py-2 bg-danger/20 border-b border-danger/40 flex-shrink-0">
          <p class="text-xs text-danger-soft">{error}</p>
        </div>
      )}

      <div
        class={[
          'scrollbar-dark min-h-0 flex-1 overflow-y-auto bg-bg px-4 py-4 pr-3',
          editorView === 'settings' ? '' : 'hidden',
        ].join(' ')}
        data-testid="workflow-settings-view"
      >
        <div class="mx-auto min-h-[calc(100%+1px)] max-w-5xl space-y-4">
          <section class="grid gap-4 rounded-lg border border-line bg-fill-soft p-4 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-6">
            <div>
              <h2 class="text-xs font-semibold uppercase tracking-wider text-fg-muted">Basics</h2>
              <p class="mt-1 text-xs leading-5 text-fg-muted">
                Name this workflow and decide whether new tasks may use it.
              </p>
            </div>
            <div class="grid gap-4">
              <div>
                <label class="mb-1 block text-xs font-medium text-fg-muted">Name</label>
                <input
                  type="text"
                  value={name}
                  onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
                  placeholder="Workflow name…"
                  data-testid="workflow-name-input"
                  class="w-full rounded-lg border border-line bg-surface-overlay px-3 py-2 text-sm text-fg-soft placeholder-gray-600 focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-fg-muted">
                  Description <span class="text-fg-muted">(optional)</span>
                </label>
                <input
                  type="text"
                  value={description}
                  onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)}
                  placeholder="Description (optional)"
                  data-testid="workflow-description-input"
                  class="w-full rounded-lg border border-line bg-surface-overlay px-3 py-2 text-sm text-fg-muted placeholder-gray-600 focus:border-accent focus:outline-none"
                />
              </div>
              <label class="flex w-fit items-center gap-2 rounded-lg px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-soft cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={disabled}
                  data-testid="workflow-disabled-checkbox"
                  onChange={(e) => setDisabled((e.currentTarget as HTMLInputElement).checked)}
                  class="w-3 h-3 rounded accent-blue-500"
                />
                <span class={disabled ? 'text-danger-soft font-medium' : ''}>Disable workflow</span>
              </label>
            </div>
          </section>

          <section class="grid gap-4 rounded-lg border border-line bg-fill-soft p-4 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-6">
            <div>
              <h2 class="text-xs font-semibold uppercase tracking-wider text-fg-muted">Runtime</h2>
              <p class="mt-1 text-xs leading-5 text-fg-muted">
                Control completion authority and optional routing after approval.
              </p>
            </div>
            <div class="space-y-5">
              <div>
                <label class="mb-2 block text-xs font-medium text-fg-muted">
                  Completion autonomy
                </label>
                <div class="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-overlay p-1.5">
                  {AUTONOMY_LEVELS.map(({ level, label, description }) => (
                    <button
                      key={level}
                      type="button"
                      data-testid={`autonomy-level-${level}`}
                      onClick={() => setCompletionAutonomyLevel(level)}
                      title={`${label}: ${description}`}
                      class={[
                        'flex h-8 items-center gap-1 rounded-md px-2.5 text-xs transition-colors',
                        completionAutonomyLevel === level
                          ? 'bg-accent/10 text-accent-soft'
                          : 'text-fg-muted hover:bg-fill-soft hover:text-fg-soft',
                      ].join(' ')}
                    >
                      <span
                        class={[
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                          completionAutonomyLevel === level
                            ? 'bg-accent/20 text-accent-soft'
                            : 'bg-fill-soft text-fg-muted',
                        ].join(' ')}
                      >
                        {level}
                      </span>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section class="grid gap-4 rounded-lg border border-line bg-fill-soft p-4 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-6">
            <div>
              <h2 class="text-xs font-semibold uppercase tracking-wider text-fg-muted">Tags</h2>
              <p class="mt-1 text-xs leading-5 text-fg-muted">
                Use short labels to organize workflows.
              </p>
            </div>
            <div class="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-overlay px-2 py-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  class="flex items-center gap-1 rounded-full border border-line bg-fill-soft px-2 py-0.5 text-xs text-fg-soft"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    class="text-fg-muted transition-colors hover:text-danger"
                    aria-label={`Remove tag ${tag}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                placeholder={tags.length === 0 ? 'Add tags…' : ''}
                onInput={(e) => setTagInput((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={handleTagInputKeyDown}
                onBlur={() => {
                  if (tagInput.trim()) {
                    tagInput.split(',').forEach((t) => addTag(t));
                    setTagInput('');
                  }
                }}
                class="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-xs text-fg-soft outline-none placeholder-gray-700"
              />
            </div>
          </section>
        </div>
      </div>

      <div
        class={[
          'flex-1 relative overflow-hidden bg-bg',
          editorView === 'canvas' ? '' : 'hidden',
        ].join(' ')}
        data-testid="workflow-canvas-view"
      >
        <div
          class="absolute top-4 left-4 z-10 flex items-center gap-1.5 rounded-xl border border-line bg-surface/90 p-1.5 shadow-2xl shadow-black/30 backdrop-blur"
          style={{ pointerEvents: 'auto' }}
        >
          <button
            onClick={addStep}
            data-testid="add-step-button"
            class="flex items-center gap-1.5 rounded-lg border border-line bg-fill-soft px-3 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-line-strong hover:bg-fill hover:text-fg"
          >
            <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Add Node
          </button>

          {!isEditing && (
            <div class="relative">
              <button
                onClick={() => setShowTemplates((v) => !v)}
                data-testid="template-picker-button"
                class="flex items-center gap-1.5 rounded-lg border border-line bg-fill-soft px-3 py-1.5 text-xs font-medium text-fg-soft transition-colors hover:border-line-strong hover:bg-fill hover:text-fg"
              >
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M4 6h16M4 10h16M4 14h8"
                  />
                </svg>
                From Template
                <svg
                  class={`w-3 h-3 transition-transform ${showTemplates ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {showTemplates && (
                <div class="absolute top-full left-0 mt-2 w-72 overflow-hidden rounded-xl border border-line bg-surface-overlay shadow-2xl shadow-black/40">
                  {availableTemplates.length === 0 && (
                    <div class="px-3 py-2.5 text-xs text-fg-muted border-b border-line">
                      No built-in templates available for this space.
                    </div>
                  )}
                  {availableTemplates.map((t) => (
                    <button
                      key={t.label}
                      onClick={() => handleTemplateSelection(t)}
                      data-testid="template-option"
                      data-template-label={t.label}
                      class="w-full border-b border-line px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-fill-soft"
                    >
                      <div class="text-xs font-medium text-fg-soft">{t.label}</div>
                      <div class="text-xs text-fg-muted mt-0.5">{t.description}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {regularNodes.length === 0 && (
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div class="rounded-xl border border-line bg-surface/80 px-6 py-5 text-center shadow-2xl shadow-black/30 backdrop-blur">
              <p class="text-sm font-medium text-fg-soft">Start the workflow canvas</p>
              <p class="text-xs text-fg-muted mt-1">Add a node or apply a template.</p>
            </div>
          </div>
        )}

        <div
          ref={canvasContainerRef}
          class="h-full min-h-0"
          data-testid="native-workflow-canvas-panel"
        >
          <WorkflowCanvas
            nodes={nodeData}
            nodePositions={canvasNodePositions}
            viewportState={viewportState}
            onViewportChange={setViewportState}
            transitions={[]}
            channels={channelEdges}
            onNodeSelect={handleNodeSelect}
            onDeleteNode={handleDeleteNode}
            onNodePositionChange={handleNodePositionChange}
            onCreateTransition={handleCreateTransition}
            onEdgeSelect={handleEdgeSelect}
            onDeleteEdge={handleDeleteEdge}
            onChannelSelect={handleChannelSelect}
            selectedChannelId={selectedChannelId}
          />
        </div>

        {selectedNode && (
          <NodeConfigPanel
            step={selectedNode.step}
            agents={agents}
            isStartNode={nodeIsStart(selectedNode)}
            onUpdate={handleUpdateNode}
            onSetAsStart={handleSetAsStart}
            isEndNode={nodeIsEnd(selectedNode)}
            onSetAsEnd={handleSetAsEnd}
            channelLinks={nodeChannelLinksByNodeId.get(selectedNode.step.localId) ?? []}
            onOpenChannelLink={handleChannelSelectFromNodePanel}
            selectedChannelRelation={
              selectedChannelInfo
                ? {
                    title: 'Channel Links',
                    description: `${selectedChannelInfo.relationLabel} · ${selectedChannelInfo.visibleLinkCount} editable link${selectedChannelInfo.visibleLinkCount === 1 ? '' : 's'}`,
                    forwardLinks: selectedChannelInfo.forwardLinks,
                    reverseLinks: selectedChannelInfo.reverseLinks,
                    canConvertToBidirectional: selectedChannelInfo.canConvertToBidirectional,
                  }
                : undefined
            }
            onUpdateChannelLink={handleUpdateChannelFromEdgePanel}
            onDeleteChannelLink={handleDeleteChannelFromEdgePanel}
            onConvertChannelRelationToBidirectional={handleConvertChannelRelationToBidirectional}
            onCloseChannelLink={() => setSelectedChannelId(null)}
            onClose={() => {
              setSelectedChannelId(null);
              setSelectedNodeId(null);
            }}
            onDelete={handleDeleteNode}
            nodeHooks={hooks.filter(
              (h) => h.sourceNode === (selectedNode.step.name || selectedNode.step.localId)
            )}
            workflowNodeNames={nodes.map((n) => n.step.name || n.step.localId)}
            onUpdateNodeHooks={(nextHooks) => {
              const nodeName = selectedNode.step.name || selectedNode.step.localId;
              const otherHooks = hooks.filter((h) => h.sourceNode !== nodeName);
              setHooks([...otherHooks, ...nextHooks]);
            }}
          />
        )}

        {selectedEdgeInfo && (
          <div class="absolute bottom-16 left-3 w-72 z-20" style={{ pointerEvents: 'auto' }}>
            <EdgeConfigPanel
              transition={{
                id: selectedEdgeId!,
                fromStepName: selectedEdgeInfo.fromNode.step.name || 'Unnamed',
                toStepName: selectedEdgeInfo.toNode.step.name || 'Unnamed',
                condition: selectedEdgeInfo.edge?.condition ?? { type: 'always' },
              }}
              onUpdateCondition={handleUpdateEdgeCondition}
              onDelete={handleDeleteEdge}
              onClose={() => setSelectedEdgeId(null)}
            />
          </div>
        )}

        {selectedChannelInfo && !selectedNode && (
          <ChannelRelationConfigPanel
            title="Channel Links"
            description={`${selectedChannelInfo.relationLabel} · ${selectedChannelInfo.visibleLinkCount} editable link${selectedChannelInfo.visibleLinkCount === 1 ? '' : 's'}`}
            forwardLinks={selectedChannelInfo.forwardLinks}
            reverseLinks={selectedChannelInfo.reverseLinks}
            canConvertToBidirectional={selectedChannelInfo.canConvertToBidirectional}
            onConvertToBidirectional={handleConvertChannelRelationToBidirectional}
            onChange={handleUpdateChannelFromEdgePanel}
            onDelete={handleDeleteChannelFromEdgePanel}
            onBack={selectedNode ? () => setSelectedChannelId(null) : undefined}
            onClose={() => setSelectedChannelId(null)}
            width={selectedNode ? 320 : 360}
          />
        )}

        <ConfirmModal
          isOpen={!!pendingTemplate}
          onClose={() => setPendingTemplate(null)}
          onConfirm={() => {
            if (pendingTemplate) applyTemplate(pendingTemplate);
          }}
          title="Replace current canvas?"
          message="Applying a template will replace the current workflow canvas."
          confirmText="Apply Template"
          confirmButtonVariant="warning"
          confirmTestId="confirm-template-apply-button"
        >
          <p class="text-xs text-fg-muted">Current canvas changes will be discarded.</p>
        </ConfirmModal>
      </div>
    </div>
  );
}
