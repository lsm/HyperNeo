/**
 * Serialization helpers for converting between the visual editor's internal
 * state and the SpaceWorkflow / CreateSpaceWorkflowParams / UpdateSpaceWorkflowParams
 * data model used by the backend.
 *
 * Key design decisions:
 * - `startNodeId` is passed through from the editor state (explicitly set by the
 *   user via "Set as Start"), never auto-detected from graph topology.
 * - Edge `order` is computed from the left-to-right x-position of the
 *   target node among all outgoing edges of a given source node.
 * - When `workflow.layout` is present, stored positions are restored exactly.
 *   When absent (or only partially populated), `autoLayout` fills in missing positions.
 * - `WorkflowCondition` is stored verbatim on `VisualEdge` (including `description`,
 *   `maxRetries`, `timeoutMs`). Fields that the visual editor UI does not expose are
 *   preserved through load/save so they are not silently stripped.
 * - `VisualEdge` represents a canvas-only directed edge for the visual editor.
 *   Transitions have been removed from the backend; edges are visual-only.
 * - New steps (no `step.id`) receive a generated UUID inside `buildWorkflowFields`.
 *   This UUID is stable within a single call but differs across calls — callers must
 *   not invoke `visualStateToCreateParams` / `visualStateToUpdateParams` twice on the
 *   same state and expect the generated IDs to match.
 */

import { generateUUID, normalizeThinkingLevel } from '@neokai/shared';
import type {
  SpaceWorkflow,
  CreateSpaceWorkflowParams,
  UpdateSpaceWorkflowParams,
  WorkflowNodeAgent,
  WorkflowChannel,
  Gate,
  SpaceAutonomyLevel,
} from '@neokai/shared';
import type { NodeDraft } from '../WorkflowNodeCard';
import type { Point, WorkflowCondition } from './types';
import { autoLayout } from './layout';

// ============================================================================
// Visual Editor State types
// ============================================================================

/**
 * A single workflow node in the visual editor.
 * `step.id` is the stable persisted step ID (present for existing steps).
 * `step.localId` is used for React keying.
 */
export interface VisualNode {
  step: NodeDraft;
  position: Point;
}

/**
 * A directed edge between two nodes in the visual editor.
 *
 * `fromStepKey` and `toStepKey` are the stable step identifiers used
 * for serialization: `step.id` when the step already exists in the backend,
 * or `step.localId` for brand-new steps.
 *
 * `condition` stores the full `WorkflowCondition` from the backend (including
 * `description`, `maxRetries`, `timeoutMs`), or undefined for unconditional
 * (always-fire) transitions. This avoids silent data loss when the UI edits a
 * transition that already has backend-only fields set.
 */
export interface VisualEdge {
  fromStepKey: string;
  toStepKey: string;
  /** Full backend condition — undefined means unconditional ("always"). */
  condition: WorkflowCondition | undefined;
}

/**
 * Complete state of the visual workflow editor.
 */
export interface VisualEditorState {
  nodes: VisualNode[];
  edges: VisualEdge[];
  /**
   * The step key (step.id for existing, step.localId for new) of the
   * start node. Managed explicitly by the user.
   */
  startNodeId: string;
  /**
   * The step key (step.id for existing, step.localId for new) of the
   * end node. Managed explicitly by the user. When set, the workflow
   * run auto-completes when the end node's execution sets `task.reportedStatus`.
   */
  endNodeId?: string;
  tags: string[];
  /** Directed messaging channels at the workflow level. */
  channels: WorkflowChannel[];
  /** First-class workflow gates referenced by channel.gateId. */
  gates: Gate[];
  /**
   * Minimum space autonomy level required to run this workflow without
   * human approval at each completion gate. Defaults to 3 when not set.
   */
  completionAutonomyLevel?: SpaceAutonomyLevel;
  /** When true, the workflow is disabled and cannot be selected for new tasks. */
  disabled?: boolean;
}

// ============================================================================
// workflowToVisualState
// ============================================================================

/**
 * Convert a SpaceWorkflow to a VisualEditorState.
 *
 * - If `workflow.layout` is present and covers all steps, positions are restored
 *   exactly from the stored layout. Steps missing from a partial layout fall back
 *   to `autoLayout` positions (autoLayout is only invoked when needed).
 * - All `WorkflowCondition` fields are preserved verbatim on the edges.
 */
export function workflowToVisualState(workflow: SpaceWorkflow): VisualEditorState {
  // Determine whether auto-layout is needed (any step missing from layout)
  const layoutMap = workflow.layout;
  const needsAutoLayout = !layoutMap || workflow.nodes.some((s) => !layoutMap[s.id]);

  // Lazily compute auto-layout only when at least one step lacks a stored position
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
    };
    return { step, position };
  });

  // Transitions have been removed from SpaceWorkflow; edges start empty.
  const edges: VisualEdge[] = [];

  // startNodeId: use the step.id directly (matches the edge keys).
  // Fall back to the first step's id if the workflow's startNodeId is missing.
  const startKey =
    workflow.nodes.find((s) => s.id === workflow.startNodeId)?.id ?? workflow.nodes[0]?.id ?? '';

  // endNodeId: use the step.id directly (matches the edge keys).
  // Undefined when the workflow has no endNodeId set.
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
    gates: workflow.gates ?? [],
    completionAutonomyLevel: workflow.completionAutonomyLevel ?? (3 as SpaceAutonomyLevel),
    disabled: workflow.disabled,
  };
}

// ============================================================================
// visualStateToWorkflowParams
// ============================================================================

/**
 * Shared structure returned by both create and update serialisation.
 */
interface BuiltWorkflowFields {
  nodes: Array<{
    id: string;
    name: string;
    agents: WorkflowNodeAgent[];
    postApproval?: import('@neokai/shared').PostApprovalRoute;
  }>;
  startNodeId: string;
  endNodeId?: string;
  layout: Record<string, { x: number; y: number }>;
  tags: string[];
  channels?: WorkflowChannel[];
  gates?: Gate[];
}

/**
 * Resolve the stable persisted step ID for a given node.
 * If the node has a persisted `step.id`, that is used directly.
 * Otherwise a new UUID is generated once and cached in `generatedIds`.
 */
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

/**
 * Build the serialized workflow fields from a VisualEditorState.
 * Shared between create and update serialisation.
 *
 */
function buildWorkflowFields(state: VisualEditorState): {
  fields: BuiltWorkflowFields;
  keyToPersistedId: Map<string, string>;
} {
  const generatedIds = new Map<string, string>();

  const persistableNodes = state.nodes;

  // Assign persisted IDs to all nodes
  const nodeMap = new Map<string, { node: VisualNode; persistedId: string }>();
  for (const node of persistableNodes) {
    const key = node.step.id ?? node.step.localId;
    const persistedId = resolveStepId(node, generatedIds);
    nodeMap.set(key, { node, persistedId });
  }

  // Also build a lookup by localId so startNodeId can reference either key style
  // (e.g. when startNodeId was set to step.localId rather than step.id).
  const localIdMap = new Map<string, { node: VisualNode; persistedId: string }>();
  for (const [, entry] of nodeMap) {
    localIdMap.set(entry.node.step.localId, entry);
  }

  // Build key -> persisted ID map for channel endpoint remapping
  const keyToPersistedId = new Map<string, string>();
  for (const [key, { persistedId }] of nodeMap) {
    keyToPersistedId.set(key, persistedId);
  }
  // Also map localId -> persistedId (covers startNodeId and appliesTo references)
  for (const [, entry] of nodeMap) {
    keyToPersistedId.set(entry.node.step.localId, entry.persistedId);
  }

  const nodes = persistableNodes.map((node, i) => {
    const key = node.step.id ?? node.step.localId;
    const persistedId = nodeMap.get(key)!.persistedId;
    const hasMultiAgent = Array.isArray(node.step.agents) && node.step.agents.length > 0;
    // Build agents array — if no multi-agent configured, fall back to single agentId as a slot
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
              disabledSkillIds: node.step.disabledSkillIds,
            },
          ]
        : [];
    const postApproval = node.step.postApproval
      ? {
          targetAgent: derivePostApprovalTargetAgent(agents, i),
          instructions: node.step.postApproval.instructions,
        }
      : undefined;
    return {
      id: persistedId,
      name: node.step.name || `Step ${i + 1}`,
      agents,
      ...(postApproval ? { postApproval } : {}),
      ...(node.step.requireCodexApproval ? { requireCodexApproval: true } : {}),
    };
  });

  // Build layout
  const layout: Record<string, { x: number; y: number }> = {};
  for (const node of persistableNodes) {
    const key = node.step.id ?? node.step.localId;
    const persistedId = nodeMap.get(key)!.persistedId;
    layout[persistedId] = { x: node.position.x, y: node.position.y };
  }

  // Resolve startNodeId — prefer exact key match, then localId match, then first persistable node
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

  // Resolve endNodeId — prefer exact key match, then localId match. Undefined when not set.
  let endNodeId: string | undefined;
  if (state.endNodeId) {
    const endEntry = nodeMap.get(state.endNodeId) ?? localIdMap.get(state.endNodeId);
    endNodeId = endEntry?.persistedId;
  }

  const referencedGateIds = new Set(
    state.channels.map((channel) => channel.gateId).filter((gateId): gateId is string => !!gateId)
  );
  const gates = state.gates.filter((gate) => referencedGateIds.has(gate.id));

  return {
    fields: {
      nodes,
      startNodeId,
      endNodeId,
      layout,
      tags: state.tags,
      channels: state.channels,
      gates,
    },
    keyToPersistedId,
  };
}

/**
 * Convert a VisualEditorState to CreateSpaceWorkflowParams.
 *
 * @param state - Current visual editor state
 * @param spaceId - The space to create the workflow in
 * @param name - Workflow name
 * @param description - Optional workflow description
 */
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
    gates: fields.gates && fields.gates.length > 0 ? fields.gates : undefined,
    completionAutonomyLevel: state.completionAutonomyLevel,
    disabled: state.disabled,
  };
}

/**
 * Convert a VisualEditorState to UpdateSpaceWorkflowParams.
 *
 * @param state - Current visual editor state
 * @param overrides - Optional field overrides (name, description)
 */
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
    gates: fields.gates && fields.gates.length > 0 ? fields.gates : null,
    completionAutonomyLevel: state.completionAutonomyLevel,
    postApproval: null,
    disabled: state.disabled ?? null,
  };
}
