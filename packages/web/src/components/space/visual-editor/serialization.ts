import { generateUUID, normalizeThinkingLevel } from '@hyperneo/shared';
import type {
  SpaceWorkflow,
  CreateSpaceWorkflowParams,
  UpdateSpaceWorkflowParams,
  WorkflowNodeAgent,
  WorkflowChannel,
  SpaceAutonomyLevel,
  WorkflowHook,
} from '@hyperneo/shared';
import type { NodeDraft } from '../WorkflowNodeCard';
import type { Point, WorkflowCondition } from './types';
import { autoLayout } from './layout';

export interface VisualNode {
  step: NodeDraft;
  position: Point;
}

export interface VisualEdge {
  fromStepKey: string;
  toStepKey: string;
  condition: WorkflowCondition | undefined;
}

export interface VisualEditorState {
  nodes: VisualNode[];
  edges: VisualEdge[];
  startNodeId: string;
  endNodeId?: string;
  tags: string[];
  channels: WorkflowChannel[];
  hooks: WorkflowHook[];
  completionAutonomyLevel?: SpaceAutonomyLevel;
  disabled?: boolean;
}

export function workflowToVisualState(workflow: SpaceWorkflow): VisualEditorState {
  const layoutMap = workflow.layout;
  const needsAutoLayout = !layoutMap || workflow.nodes.some((s) => !layoutMap[s.id]);

  const layoutFallback = needsAutoLayout
    ? autoLayout(workflow.nodes, [], workflow.startNodeId, workflow.channels ?? [])
    : new Map<string, Point>();

  const nodes: VisualNode[] = workflow.nodes.map((s) => {
    let position: Point;
    if (layoutMap && layoutMap[s.id]) {
      position = { x: layoutMap[s.id].x, y: layoutMap[s.id].y };
    } else {
      position = layoutFallback.get(s.id) ?? { x: 0, y: 0 };
    }
    const step: NodeDraft = {
      localId: generateUUID(),
      id: s.id,
      name: s.name,
      agentId: '',
      agents: s.agents?.map((agent) => ({
        ...agent,
        thinkingLevel: agent.thinkingLevel
          ? normalizeThinkingLevel(agent.thinkingLevel)
          : undefined,
      })),
      postApproval:
        s.postApproval ?? (s.id === workflow.endNodeId ? workflow.postApproval : undefined),
      requirePrMerge:
        (s.postApproval ?? (s.id === workflow.endNodeId ? workflow.postApproval : undefined))
          ?.requirePrMerge === true
          ? true
          : undefined,
      handoffTransitions: s.transitions,
    };
    return { step, position };
  });

  const edges: VisualEdge[] = [];

  const startKey =
    workflow.nodes.find((s) => s.id === workflow.startNodeId)?.id ?? workflow.nodes[0]?.id ?? '';

  const endKey = workflow.endNodeId
    ? (workflow.nodes.find((s) => s.id === workflow.endNodeId)?.id ?? undefined)
    : undefined;

  return {
    nodes,
    edges,
    startNodeId: startKey,
    endNodeId: endKey,
    tags: workflow.tags ?? [],
    channels: (workflow.channels ?? []).map((channel) => ({
      ...channel,
      id: channel.id ?? generateUUID(),
      to: Array.isArray(channel.to) ? [...channel.to] : channel.to,
    })),
    hooks: workflow.hooks ?? [],
    completionAutonomyLevel: workflow.completionAutonomyLevel ?? (3 as SpaceAutonomyLevel),
    disabled: workflow.disabled,
  };
}

interface BuiltWorkflowFields {
  nodes: Array<{
    id: string;
    name: string;
    agents: WorkflowNodeAgent[];
    postApproval?: import('@hyperneo/shared').PostApprovalRoute;
  }>;
  startNodeId: string;
  endNodeId?: string;
  layout: Record<string, { x: number; y: number }>;
  tags: string[];
  channels?: WorkflowChannel[];
  hooks?: WorkflowHook[];
}

function resolveStepId(node: VisualNode, generatedIds: Map<string, string>): string {
  if (node.step.id) return node.step.id;
  const key = node.step.localId;
  if (!generatedIds.has(key)) {
    generatedIds.set(key, generateUUID());
  }
  return generatedIds.get(key)!;
}

function toRoleSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

function deriveSingleAgentRoleName(node: VisualNode, fallbackIndex: number): string {
  const fromSingleSlot =
    Array.isArray(node.step.agents) && node.step.agents.length === 1
      ? node.step.agents[0]?.name
      : '';
  const fromNodeName = toRoleSlug(node.step.name);
  return fromSingleSlot?.trim() || fromNodeName || `agent-${fallbackIndex + 1}`;
}

function derivePostApprovalTargetAgent(agents: WorkflowNodeAgent[], fallbackIndex: number): string {
  const namedAgent = agents.find((agent) => agent.name?.trim());
  return namedAgent?.name.trim() || `agent-${fallbackIndex + 1}`;
}

function buildHookNodeNameMap(nodes: VisualNode[]): Map<string, string> {
  const nodeNames = new Map<string, string>();
  nodes.forEach((node, i) => {
    const name = node.step.name || `Step ${i + 1}`;
    nodeNames.set(node.step.localId, name);
    if (node.step.id) nodeNames.set(node.step.id, name);
    if (node.step.name) nodeNames.set(node.step.name, name);
  });
  return nodeNames;
}

function remapHookNodeReference(value: string | undefined, nodeNames: Map<string, string>) {
  if (!value) return value;
  return nodeNames.get(value) ?? value;
}

function serializeHook(hook: WorkflowHook, nodeNames: Map<string, string>): WorkflowHook | null {
  const {
    poll: _poll,
    humanOnly: _humanOnly,
    retry: _retry,
    ...hookWithoutUnsupportedFields
  } = hook;
  if (hook.humanOnly && (!hook.authorizedCallers || hook.authorizedCallers.length === 0)) {
    return null;
  }
  const isPrReady = hook.validator.kind === 'built_in' && hook.validator.id === 'pr_ready';
  const isCodexApproval =
    hook.validator.kind === 'built_in' && hook.validator.id === 'codex_review_approved';
  const retry = isPrReady
    ? undefined
    : isCodexApproval
      ? (hook.retry ?? { maxAttempts: 0, delayMs: 60_000, backoffMultiplier: 1 })
      : (hook.retry ?? { maxAttempts: 3, delayMs: 5000, backoffMultiplier: 1 });
  return {
    ...hookWithoutUnsupportedFields,
    ...(retry ? { retry } : {}),
    sourceNode: remapHookNodeReference(hook.sourceNode, nodeNames) ?? hook.sourceNode,
    targetNode: remapHookNodeReference(hook.targetNode, nodeNames),
    authorizedCallers: hook.authorizedCallers?.map((caller) => ({
      ...caller,
      sourceNode: remapHookNodeReference(caller.sourceNode, nodeNames) ?? caller.sourceNode,
    })),
  };
}

function buildWorkflowFields(state: VisualEditorState): {
  fields: BuiltWorkflowFields;
  keyToPersistedId: Map<string, string>;
} {
  const generatedIds = new Map<string, string>();

  const persistableNodes = state.nodes;

  const nodeMap = new Map<string, { node: VisualNode; persistedId: string }>();
  for (const node of persistableNodes) {
    const key = node.step.id ?? node.step.localId;
    const persistedId = resolveStepId(node, generatedIds);
    nodeMap.set(key, { node, persistedId });
  }

  const localIdMap = new Map<string, { node: VisualNode; persistedId: string }>();
  for (const [, entry] of nodeMap) {
    localIdMap.set(entry.node.step.localId, entry);
  }

  const keyToPersistedId = new Map<string, string>();
  for (const [key, { persistedId }] of nodeMap) {
    keyToPersistedId.set(key, persistedId);
  }
  for (const [, entry] of nodeMap) {
    keyToPersistedId.set(entry.node.step.localId, entry.persistedId);
  }

  const handoffTargetDestinations = new Map<string, Set<string>>();
  const countDestination = (name: string, key: string) => {
    if (!name) return;
    const set = handoffTargetDestinations.get(name) ?? new Set<string>();
    set.add(key);
    handoffTargetDestinations.set(name, set);
  };
  for (const n of state.nodes) {
    countDestination(n.step.name, `node:${n.step.localId}`);
    for (const a of n.step.agents ?? []) countDestination(a.name, `slot:${n.step.localId}`);
  }
  const currentHookIds = new Set(state.hooks.map((h) => h.id));

  const nodes = persistableNodes.map((node, i) => {
    const key = node.step.id ?? node.step.localId;
    const persistedId = nodeMap.get(key)!.persistedId;
    const hasMultiAgent = Array.isArray(node.step.agents) && node.step.agents.length > 0;
    const agents: WorkflowNodeAgent[] = hasMultiAgent
      ? node.step.agents!.map((agent) => ({
          ...agent,
          thinkingLevel: agent.thinkingLevel
            ? normalizeThinkingLevel(agent.thinkingLevel)
            : undefined,
        }))
      : node.step.agentId
        ? [
            {
              agentId: node.step.agentId,
              name: deriveSingleAgentRoleName(node, i),
              model: node.step.model,
              thinkingLevel: node.step.thinkingLevel
                ? normalizeThinkingLevel(node.step.thinkingLevel)
                : undefined,
              customPrompt: node.step.customPrompt,
              replaceAgentPrompt: node.step.replaceAgentPrompt,
              disabledSkillIds: node.step.disabledSkillIds,
              ...(node.step.resetContextPerTurn ? { resetContextPerTurn: true } : {}),
            },
          ]
        : [];
    const postApproval = node.step.postApproval
      ? {
          targetAgent: derivePostApprovalTargetAgent(agents, i),
          instructions: node.step.postApproval.instructions,
          ...(node.step.requirePrMerge || node.step.postApproval?.requirePrMerge
            ? { requirePrMerge: true }
            : {}),
        }
      : undefined;
    return {
      id: persistedId,
      name: node.step.name || `Step ${i + 1}`,
      agents,
      ...(postApproval ? { postApproval } : {}),
      ...(() => {
        const valid = (node.step.handoffTransitions ?? []).filter((t) => {
          if (t.target !== '*') {
            const dests = handoffTargetDestinations.get(t.target);
            if (!dests || dests.size !== 1) return false;
          }
          if (t.hookId !== undefined && !currentHookIds.has(t.hookId)) return false;
          return true;
        });
        return valid.length > 0 ? { transitions: valid } : {};
      })(),
    };
  });

  const layout: Record<string, { x: number; y: number }> = {};
  for (const node of persistableNodes) {
    const key = node.step.id ?? node.step.localId;
    const persistedId = nodeMap.get(key)!.persistedId;
    layout[persistedId] = { x: node.position.x, y: node.position.y };
  }

  const startEntry =
    nodeMap.get(state.startNodeId) ??
    localIdMap.get(state.startNodeId) ??
    (persistableNodes.length > 0
      ? {
          persistedId: nodeMap.get(persistableNodes[0].step.id ?? persistableNodes[0].step.localId)!
            .persistedId,
        }
      : null);
  const startNodeId = startEntry?.persistedId ?? '';

  let endNodeId: string | undefined;
  if (state.endNodeId) {
    const endEntry = nodeMap.get(state.endNodeId) ?? localIdMap.get(state.endNodeId);
    endNodeId = endEntry?.persistedId;
  }

  const hookNodeNames = buildHookNodeNameMap(persistableNodes);
  const hooks = state.hooks
    .map((hook) => serializeHook(hook, hookNodeNames))
    .filter((hook): hook is WorkflowHook => hook !== null);

  return {
    fields: {
      nodes,
      startNodeId,
      endNodeId,
      layout,
      tags: state.tags,
      channels: state.channels,
      hooks,
    },
    keyToPersistedId,
  };
}

export function visualStateToCreateParams(
  state: VisualEditorState,
  spaceId: string,
  name: string,
  description?: string
): CreateSpaceWorkflowParams {
  const { fields } = buildWorkflowFields(state);

  return {
    spaceId,
    name,
    description,
    nodes: fields.nodes,
    startNodeId: fields.startNodeId || undefined,
    endNodeId: fields.endNodeId || undefined,
    layout: fields.layout,
    tags: fields.tags,
    channels: fields.channels && fields.channels.length > 0 ? fields.channels : undefined,
    hooks: fields.hooks && fields.hooks.length > 0 ? fields.hooks : undefined,
    completionAutonomyLevel: state.completionAutonomyLevel,
    disabled: state.disabled,
  };
}

export function visualStateToUpdateParams(
  state: VisualEditorState,
  overrides?: { name?: string; description?: string | null }
): UpdateSpaceWorkflowParams {
  const { fields } = buildWorkflowFields(state);

  return {
    ...overrides,
    nodes: fields.nodes,
    startNodeId: fields.startNodeId || null,
    endNodeId: fields.endNodeId ?? null,
    layout: fields.layout,
    tags: fields.tags,
    channels: fields.channels && fields.channels.length > 0 ? fields.channels : null,
    hooks: fields.hooks && fields.hooks.length > 0 ? fields.hooks : null,
    completionAutonomyLevel: state.completionAutonomyLevel,
    postApproval: null,
    disabled: state.disabled ?? null,
  };
}
