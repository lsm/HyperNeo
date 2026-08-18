import type {
  SpaceWorkflow,
  SpaceWorkflowSummary,
  WorkflowNodeInput,
  CreateSpaceWorkflowParams,
  UpdateSpaceWorkflowParams,
  WorkflowChannel,
  WorkflowHook,
} from '@hyperneo/shared';
import { HANDOFF_TARGET_WILDCARD, MAX_NODE_HANDOFF_TRANSITIONS } from '@hyperneo/shared';
import { validateWorkflowHooks } from '../workflow-hook-validation';
import { generateUUID } from '@hyperneo/shared';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository';
import { validateGlobPattern } from '../../external-events/topic-validator';
import { MAX_AGENT_SLOT_EVENT_INTERESTS } from '../export-format';
import { Logger } from '../../logger';
import {
  validatePostApproval,
  validatePostApprovalRoutes,
} from '../workflows/post-approval-validator';
import { KNOWN_TOPIC_FROM_SOURCES } from '../runtime/parse-pr-url';
import '../runtime/connectors/production';
import { slugify, validateSlug } from '../slug';

const logger = new Logger('SpaceWorkflowManager');
const RESERVED_WORKFLOW_AGENT_NAMES = new Set(['space-agent', 'task-agent']);

function normalizeWorkflowAgentName(name: string): string {
  return name.trim().toLowerCase();
}

export function isReservedWorkflowAgentName(name: string): boolean {
  return RESERVED_WORKFLOW_AGENT_NAMES.has(normalizeWorkflowAgentName(name));
}

export interface SpaceAgentLookup {
  getAgentById(spaceId: string, id: string): { id: string; name: string } | null;
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

export class WorkflowDeletionBlockedError extends WorkflowValidationError {
  constructor(
    message: string,
    readonly workflowId: string
  ) {
    super(message);
    this.name = 'WorkflowDeletionBlockedError';
  }
}

export class SpaceWorkflowManager {
  constructor(
    private repo: SpaceWorkflowRepository,
    private agentLookup: SpaceAgentLookup | null = null
  ) {}

  createWorkflow(params: CreateSpaceWorkflowParams): SpaceWorkflow {
    const trimmedName = params.name.trim();
    this.validateName(params.spaceId, trimmedName, null);
    const nodes = (params.nodes ?? []).map((node) => ({
      ...node,
      id: node.id ?? generateUUID(),
    }));
    this.validateNodes(params.spaceId, nodes);

    const fallbackStartNodeId = nodes[0]?.id ?? '';
    const fallbackEndNodeId = nodes[nodes.length - 1]?.id ?? '';
    const startNodeId =
      params.startNodeId == null ? fallbackStartNodeId : params.startNodeId.trim();
    const endNodeId = params.endNodeId == null ? fallbackEndNodeId : params.endNodeId.trim();

    this.validateStartNodeId(startNodeId, nodes);
    this.validateEndNodeId(endNodeId, nodes);

    this.validateNoDuplicateHookIds(params.hooks ?? []);

    if (params.channels && params.channels.length > 0) {
      this.validateChannels(params.channels);
    }

    this.validateHooks(params.hooks ?? [], nodes);

    this.validateTransitions(nodes, params.hooks ?? []);

    const postApprovalResult = validatePostApprovalRoutes({
      workflowPostApproval: params.postApproval,
      nodes,
    });
    if (!postApprovalResult.ok) {
      throw new WorkflowValidationError(postApprovalResult.error);
    }

    let handle: string;
    if (params.handle !== undefined && params.handle !== null) {
      if (typeof params.handle !== 'string') {
        throw new WorkflowValidationError('Workflow handle must be a string');
      }
      const trimmedHandle = params.handle.trim();
      this.validateHandle(params.spaceId, trimmedHandle, null);
      handle = trimmedHandle;
    } else {
      handle = this.generateUniqueHandle(params.spaceId, trimmedName);
    }

    return this.repo.createWorkflow({
      ...params,
      name: trimmedName,
      nodes,
      startNodeId,
      endNodeId,
      handle,
    });
  }

  getWorkflow(id: string): SpaceWorkflow | null {
    const result = this.getWorkflowForRunStart(id);
    return result?.workflow ?? null;
  }

  getWorkflowForRunStart(
    id: string
  ): { rawWorkflow: SpaceWorkflow; workflow: SpaceWorkflow } | null {
    const rawWorkflow = this.repo.getWorkflow(id);
    if (!rawWorkflow) return null;
    return {
      rawWorkflow,
      workflow: this.sanitizePostApprovalForLoad(rawWorkflow),
    };
  }

  getWorkflowForRun(run: {
    workflowId: string;
    definitionVersion: string | null;
  }): SpaceWorkflow | null {
    const raw = this.repo.getWorkflowForRun(run);
    return raw ? this.sanitizePostApprovalForLoad(raw) : null;
  }

  getWorkflowByHandle(spaceId: string, handle: string): SpaceWorkflow | null {
    const wf = this.repo.getWorkflowByHandle(spaceId, handle);
    if (!wf) return null;
    return this.sanitizePostApprovalForLoad(wf);
  }

  listWorkflows(spaceId: string): SpaceWorkflow[] {
    return this.repo.listWorkflows(spaceId).map((wf) => this.sanitizePostApprovalForLoad(wf));
  }

  listWorkflowSummaries(spaceId: string): SpaceWorkflowSummary[] {
    return this.repo.listWorkflowSummaries(spaceId);
  }

  private sanitizePostApprovalForLoad(wf: SpaceWorkflow): SpaceWorkflow {
    let sanitized: SpaceWorkflow | null = null;

    if (wf.postApproval) {
      const result = validatePostApproval({ postApproval: wf.postApproval, nodes: wf.nodes });
      if (!result.ok) {
        logger.warn(
          `disabling stale postApproval route on workflow ${wf.id} ` +
            `(space ${wf.spaceId}): ${result.error}`
        );
        sanitized = { ...(sanitized ?? wf) };
        delete sanitized.postApproval;
      }
    }

    const nextNodes = (sanitized ?? wf).nodes.map((node) => {
      if (!node.postApproval) return node;
      const result = validatePostApproval({ postApproval: node.postApproval, nodes: wf.nodes });
      if (result.ok) return node;
      logger.warn(
        `disabling stale postApproval route on workflow ${wf.id} node ${node.id} ` +
          `(space ${wf.spaceId}): ${result.error}`
      );
      const nextNode = { ...node };
      delete nextNode.postApproval;
      sanitized = { ...(sanitized ?? wf) };
      return nextNode;
    });

    const withSanitizedNodes = sanitized ? { ...sanitized, nodes: nextNodes } : wf;
    return withSanitizedNodes;
  }

  updateBuiltInIdentity(
    id: string,
    identity: Pick<UpdateSpaceWorkflowParams, 'name' | 'handle' | 'templateName'>
  ): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;
    const name = identity.name?.trim();
    if (!name) throw new WorkflowValidationError('Workflow name is required');
    this.validateName(existing.spaceId, name, id);
    if (typeof identity.handle !== 'string') {
      throw new WorkflowValidationError('Workflow handle must be a string');
    }
    const handle = identity.handle.trim();
    this.validateHandle(existing.spaceId, handle, id);
    return this.repo.updateWorkflow(id, {
      name,
      handle,
      templateName: identity.templateName,
    });
  }

  stampBuiltInTemplateName(id: string, templateName: string): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;
    return this.repo.updateWorkflow(id, { templateName });
  }

  stampBuiltInTags(id: string, tags: string[]): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;
    return this.repo.updateWorkflow(id, { tags });
  }

  updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;

    if (params.name !== undefined) {
      const trimmedName = params.name.trim();
      this.validateName(existing.spaceId, trimmedName, id);
      params = { ...params, name: trimmedName };
      if (
        trimmedName !== existing.name &&
        params.handle === undefined &&
        typeof existing.handle === 'string'
      ) {
        params = {
          ...params,
          handle: this.generateUniqueHandle(existing.spaceId, trimmedName, id),
        };
      }
    }
    if (params.handle !== undefined && params.handle !== null) {
      if (typeof params.handle !== 'string') {
        throw new WorkflowValidationError('Workflow handle must be a string');
      }
      const trimmedHandle = params.handle.trim();
      this.validateHandle(existing.spaceId, trimmedHandle, id);
      params = { ...params, handle: trimmedHandle };
    }
    if (params.nodes !== undefined) {
      this.validateStableNodeIds(id, existing.nodes, params.nodes ?? [], {
        allowStructuralChanges: true,
      });
    }

    const effectiveNodes: WorkflowNodeInput[] =
      params.nodes !== undefined
        ? (params.nodes ?? []).map(
            (n): WorkflowNodeInput => ({
              id: n.id,
              name: n.name,
              agents: n.agents,
              postApproval: n.postApproval,
              transitions: n.transitions,
            })
          )
        : existing.nodes.map(
            (n): WorkflowNodeInput => ({
              id: n.id,
              name: n.name,
              agents: n.agents,
              postApproval: n.postApproval,
              transitions: n.transitions,
            })
          );

    this.validateNodes(existing.spaceId, effectiveNodes);

    const fallbackStartNodeId = effectiveNodes[0]?.id ?? '';
    const fallbackEndNodeId = effectiveNodes[effectiveNodes.length - 1]?.id ?? '';
    const nodeIds = new Set(effectiveNodes.map((n) => n.id));
    const startNodeIdInput =
      params.startNodeId === undefined ? existing.startNodeId : params.startNodeId;
    const endNodeIdInput = params.endNodeId === undefined ? existing.endNodeId : params.endNodeId;
    const explicitStartNodeId = params.startNodeId !== undefined;
    const explicitEndNodeId = params.endNodeId !== undefined;
    const normalizedStartNodeId =
      startNodeIdInput == null ? fallbackStartNodeId : startNodeIdInput.trim();
    const normalizedEndNodeId = endNodeIdInput == null ? fallbackEndNodeId : endNodeIdInput.trim();
    const resolvedStartNodeId =
      !explicitStartNodeId && !nodeIds.has(normalizedStartNodeId)
        ? fallbackStartNodeId
        : normalizedStartNodeId;
    const resolvedEndNodeId =
      !explicitEndNodeId && !nodeIds.has(normalizedEndNodeId)
        ? fallbackEndNodeId
        : normalizedEndNodeId;

    this.validateStartNodeId(resolvedStartNodeId, effectiveNodes);
    this.validateEndNodeId(resolvedEndNodeId, effectiveNodes);
    params = { ...params, startNodeId: resolvedStartNodeId, endNodeId: resolvedEndNodeId };

    if (params.channels && params.channels.length > 0) {
      this.validateChannels(params.channels);
    }

    this.validateNoDuplicateHookIds(params.hooks ?? []);

    const effectiveHooks =
      params.hooks === undefined ? (existing.hooks ?? []) : (params.hooks ?? []);
    this.validateHooks(effectiveHooks, effectiveNodes);
    this.validateTransitions(effectiveNodes, effectiveHooks);

    const workflowPostApproval =
      params.postApproval === undefined
        ? existing.postApproval
        : (params.postApproval ?? undefined);
    const routeResult = validatePostApprovalRoutes({
      workflowPostApproval,
      nodes: effectiveNodes,
    });
    if (!routeResult.ok) {
      throw new WorkflowValidationError(routeResult.error);
    }

    return this.repo.updateWorkflow(id, params);
  }

  updateWorkflowNodeToolGuards(id: string, nodes: SpaceWorkflow['nodes']): void {
    const existing = this.repo.getWorkflow(id);
    if (!existing) {
      throw new WorkflowValidationError(`Workflow not found: ${id}`);
    }
    this.validateStableNodeIds(id, existing.nodes, nodes);
    this.repo.updateWorkflowNodeToolGuards(id, nodes);
  }

  hasExecutableRuns(id: string): boolean {
    return this.repo.hasExecutableRuns(id);
  }

  deleteWorkflow(id: string): boolean {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return false;
    if (this.repo.hasExecutableRuns(id)) {
      throw new WorkflowDeletionBlockedError(
        `Cannot delete workflow "${existing.name}" (${id}): it has run(s) that ` +
          `are still executable (in progress, or not archived). Archive the ` +
          `task(s) and let the run(s) finish first, or keep the workflow.`,
        id
      );
    }
    return this.repo.deleteWorkflow(id);
  }

  getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[] {
    return this.repo.getWorkflowsReferencingAgent(agentId);
  }

  private validateName(spaceId: string, name: string, excludeId: string | null): void {
    if (!name) {
      throw new WorkflowValidationError('Workflow name must not be empty');
    }
    const existing = this.repo.listWorkflows(spaceId);
    for (const wf of existing) {
      if (wf.name === name && wf.id !== excludeId) {
        throw new WorkflowValidationError(
          `A workflow named "${name}" already exists in this space`
        );
      }
    }
  }

  private validateHandle(spaceId: string, handle: string, excludeId: string | null): void {
    if (!handle) {
      throw new WorkflowValidationError('Workflow handle must not be empty');
    }
    const slugError = validateSlug(handle);
    if (slugError) {
      throw new WorkflowValidationError(`Invalid workflow handle: ${slugError}`);
    }
    const existingHandles = this.repo.getHandlesForSpace(spaceId);
    for (const existing of existingHandles) {
      if (existing === handle) {
        const wf = this.repo.getWorkflowByHandle(spaceId, handle);
        if (wf && wf.id !== excludeId) {
          throw new WorkflowValidationError(
            `A workflow with handle "${handle}" already exists in this space`
          );
        }
      }
    }
  }

  private generateUniqueHandle(spaceId: string, name: string, excludeId?: string): string {
    const existingHandles = this.repo.getHandlesForSpace(spaceId);
    const filteredHandles = excludeId
      ? existingHandles.filter((h) => {
          const wf = this.repo.getWorkflowByHandle(spaceId, h);
          return wf?.id !== excludeId;
        })
      : existingHandles;
    const handle = slugify(name, filteredHandles);
    return this.ensureValidHandle(handle, filteredHandles);
  }

  private ensureValidHandle(handle: string, existingHandles: string[]): string {
    const maxLen = 60;
    if (validateSlug(handle) === null) return handle;

    for (let len = maxLen; len > 0; len--) {
      const truncated = handle.slice(0, len);
      const cleaned = truncated.replace(/-+$/, '');
      const fallback = cleaned || 'workflow';
      const candidate = slugify(fallback, existingHandles);
      if (validateSlug(candidate) === null) {
        return candidate;
      }
    }
    return 'workflow';
  }

  private validateNodes(spaceId: string, nodes: WorkflowNodeInput[]): void {
    if (nodes.length === 0) {
      throw new WorkflowValidationError('A workflow must have at least one node');
    }

    const seenIds = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const id = nodes[i].id;
      if (id !== undefined && id !== null) {
        if (id.length === 0) {
          throw new WorkflowValidationError(`node[${i}]: id must be a non-empty string`);
        }
        if (id !== id.trim()) {
          throw new WorkflowValidationError(`node[${i}]: id must not have surrounding whitespace`);
        }
      }
      if (!id) continue;
      if (seenIds.has(id)) {
        throw new WorkflowValidationError(`node[${i}]: duplicate node id "${id}"`);
      }
      seenIds.add(id);
      for (let j = 0; j < nodes.length; j++) {
        if (i !== j && nodes[j].name === id) {
          throw new WorkflowValidationError(
            `node[${i}] id "${id}" must not equal node "${nodes[j].name}"'s name — ` +
              'a node id colliding with another node name makes worker-handle resolution ambiguous and can bypass node-name channel authorization'
          );
        }
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      this.validateNodeAgentRef(spaceId, node, i);
      this.validateEventInterests(node, i);
    }
  }

  private validateStableNodeIds(
    workflowId: string,
    existingNodes: Array<{ id: string }>,
    incomingNodes: Array<{ id?: string }>,
    options: { allowStructuralChanges?: boolean } = {}
  ): void {
    const existingIds = existingNodes.map((node) => node.id);
    const incomingIds = incomingNodes.map((node) => node.id).filter((id): id is string => !!id);
    const allIncomingIdsPresent = incomingIds.length === incomingNodes.length;
    const incomingIdsUnique = new Set(incomingIds).size === incomingIds.length;
    const existingSet = new Set(existingIds);
    const sameSet =
      existingIds.length === incomingNodes.length &&
      allIncomingIdsPresent &&
      new Set(incomingIds).size === existingSet.size &&
      incomingIds.every((id) => existingSet.has(id));

    if (sameSet) return;
    if (options.allowStructuralChanges && allIncomingIdsPresent && incomingIdsUnique) return;

    logger.error(
      `workflow.idChangeRejected: workflowId=${workflowId} ` +
        `existingNodeIds=[${existingIds.join(',')}] incomingNodeIds=[${incomingIds.join(',')}]`
    );
    throw new WorkflowValidationError(
      'Workflow node IDs are stable and cannot be duplicated, regenerated, or omitted during update'
    );
  }

  private validateEventInterests(node: WorkflowNodeInput, index: number): void {
    for (let j = 0; j < (node.agents ?? []).length; j++) {
      const entry = node.agents![j];
      const loc = `node[${index}].agents[${j}].eventInterests`;
      const interests = entry.eventInterests ?? [];
      if (interests.length > MAX_AGENT_SLOT_EVENT_INTERESTS) {
        throw new WorkflowValidationError(
          `${loc}: cannot contain more than ${MAX_AGENT_SLOT_EVENT_INTERESTS} entries`
        );
      }
      for (let k = 0; k < interests.length; k++) {
        const interestLoc = `${loc}[${k}]`;
        const rawInterest = interests[k] as {
          topic?: unknown;
          topicFrom?: { source?: unknown; pattern?: unknown } | undefined;
          label?: unknown;
        };
        const hasTopic = rawInterest.topic !== undefined && rawInterest.topic !== null;
        const hasTopicFrom = rawInterest.topicFrom !== undefined && rawInterest.topicFrom !== null;
        if (hasTopic === hasTopicFrom) {
          throw new WorkflowValidationError(
            `${interestLoc}: exactly one of "topic" or "topicFrom" must be set`
          );
        }
        if (hasTopic) {
          if (typeof rawInterest.topic !== 'string') {
            throw new WorkflowValidationError(`${interestLoc}.topic: must be a string`);
          }
          const validation = validateGlobPattern(rawInterest.topic);
          if (!validation.valid) {
            throw new WorkflowValidationError(
              `${interestLoc}.topic: ${validation.reason ?? 'invalid external-event topic pattern'}`
            );
          }
          continue;
        }
        const topicFrom = rawInterest.topicFrom!;
        if (
          typeof topicFrom.source !== 'string' ||
          !KNOWN_TOPIC_FROM_SOURCES.has(topicFrom.source)
        ) {
          throw new WorkflowValidationError(
            `${interestLoc}.topicFrom.source: unknown source "${String(
              topicFrom.source
            )}"; expected one of ${[...KNOWN_TOPIC_FROM_SOURCES].map((s) => `"${s}"`).join(', ')}`
          );
        }
        if (
          typeof topicFrom.pattern !== 'string' ||
          topicFrom.pattern.length === 0 ||
          topicFrom.pattern !== topicFrom.pattern.trim()
        ) {
          throw new WorkflowValidationError(
            `${interestLoc}.topicFrom.pattern: must be a non-empty string with no surrounding whitespace`
          );
        }
      }
    }
  }

  private validateNodeAgentRef(spaceId: string, node: WorkflowNodeInput, index: number): void {
    const legacyAgentId = (node as unknown as Record<string, unknown>)['agentId'] as
      | string
      | undefined;
    if ((!node.agents || node.agents.length === 0) && legacyAgentId) {
      node.agents = [{ agentId: legacyAgentId, name: node.name }];
    }

    const hasAgents = node.agents && node.agents.length > 0;

    if (!hasAgents) {
      throw new WorkflowValidationError(`node[${index}]: agents must be a non-empty array`);
    }

    const seenNames = new Set<string>();
    for (let j = 0; j < node.agents.length; j++) {
      const entry = node.agents[j];
      const loc = `node[${index}].agents[${j}]`;
      if (!entry.agentId || !entry.agentId.trim()) {
        throw new WorkflowValidationError(
          `${loc}: agentId must be a non-empty SpaceWorkerAgent UUID`
        );
      }
      if (!entry.name || !entry.name.trim()) {
        throw new WorkflowValidationError(`${loc}: name must be a non-empty string`);
      }
      if (isReservedWorkflowAgentName(entry.name)) {
        throw new WorkflowValidationError(
          `${loc}: name "${entry.name}" is reserved for a built-in agent`
        );
      }
      if (seenNames.has(entry.name)) {
        throw new WorkflowValidationError(
          `${loc}: duplicate name "${entry.name}" — each agent slot must have a unique name within the node`
        );
      }
      seenNames.add(entry.name);

      if (entry.replaceAgentPrompt === true && !entry.customPrompt?.value?.trim()) {
        logger.warn(
          `${loc}: replaceAgentPrompt is true but customPrompt is empty — ` +
            `this slot will run with only the SDK base contract (the agent's prompt is replaced with nothing).`
        );
      }

      if (
        entry.resetContextPerTurn !== undefined &&
        typeof entry.resetContextPerTurn !== 'boolean'
      ) {
        throw new WorkflowValidationError(`${loc}: resetContextPerTurn must be a boolean`);
      }
    }

    if (this.agentLookup) {
      for (let j = 0; j < node.agents.length; j++) {
        const entry = node.agents[j];
        const agent = this.agentLookup.getAgentById(spaceId, entry.agentId);
        if (!agent) {
          throw new WorkflowValidationError(
            `node[${index}].agents[${j}]: agentId "${entry.agentId}" does not match any SpaceWorkerAgent in this space`
          );
        }
      }
    }
  }

  private validateChannels(channels: WorkflowChannel[]): void {
    for (let ci = 0; ci < channels.length; ci++) {
      const ch = channels[ci];
      const loc = `channels[${ci}]`;

      if (!ch.from || !ch.from.trim()) {
        throw new WorkflowValidationError(`${loc}: 'from' must be a non-empty node name string`);
      }

      if (Array.isArray(ch.to)) {
        if (ch.to.length === 0) {
          throw new WorkflowValidationError(
            `${loc}: 'to' array must contain at least one agent name string`
          );
        }
        for (let ti = 0; ti < ch.to.length; ti++) {
          if (!ch.to[ti] || !ch.to[ti].trim()) {
            throw new WorkflowValidationError(
              `${loc}.to[${ti}]: must be a non-empty agent name string`
            );
          }
        }
      } else {
        if (!ch.to || !(ch.to as string).trim()) {
          throw new WorkflowValidationError(`${loc}: 'to' must be a non-empty agent name string`);
        }
      }
    }
  }

  private validateTransitions(nodes: WorkflowNodeInput[], hooks: WorkflowHook[]): void {
    const hookIds = new Set(hooks.map((h) => h.id));
    const targetNameDestinations = new Map<string, Set<string>>();
    const addDestination = (name: string, destinationKey: string) => {
      const set = targetNameDestinations.get(name) ?? new Set<string>();
      set.add(destinationKey);
      targetNameDestinations.set(name, set);
    };
    for (const node of nodes) {
      const nodeId = node.id ?? node.name;
      addDestination(node.name, `node:${nodeId}`);
      for (const agent of node.agents ?? []) {
        if (agent.name) addDestination(agent.name, `slot:${nodeId}`);
      }
    }

    for (let ni = 0; ni < nodes.length; ni++) {
      const node = nodes[ni];
      const transitions = node.transitions;
      if (transitions === undefined) continue;
      if (!Array.isArray(transitions)) {
        throw new WorkflowValidationError(
          `node[${ni}] "${node.name}": transitions must be an array`
        );
      }
      if (transitions.length === 0) continue;

      const seenIds = new Set<string>();
      const seenTargets = new Set<string>();
      if (transitions.length > MAX_NODE_HANDOFF_TRANSITIONS) {
        throw new WorkflowValidationError(
          `node[${ni}] "${node.name}": transitions cannot contain more than ${MAX_NODE_HANDOFF_TRANSITIONS} entries`
        );
      }
      for (let ti = 0; ti < transitions.length; ti++) {
        const t = transitions[ti];
        const loc = `node[${ni}] "${node.name}".transitions[${ti}]`;

        if (!t || typeof t !== 'object') {
          throw new WorkflowValidationError(`${loc}: transition must be an object`);
        }
        if (typeof t.id !== 'string') {
          throw new WorkflowValidationError(`${loc}: 'id' must be a string`);
        }
        if (!t.id.trim()) {
          throw new WorkflowValidationError(`${loc}: 'id' must be a non-empty string`);
        }
        if (t.id.length > 100) {
          throw new WorkflowValidationError(`${loc}: 'id' must be at most 100 characters`);
        }
        if (t.label !== undefined && typeof t.label !== 'string') {
          throw new WorkflowValidationError(`${loc}: 'label' must be a string`);
        }
        if (typeof t.label === 'string' && t.label.length > 200) {
          throw new WorkflowValidationError(`${loc}: 'label' must be at most 200 characters`);
        }
        if (seenIds.has(t.id)) {
          throw new WorkflowValidationError(
            `${loc}: duplicate transition id "${t.id}" within node "${node.name}"`
          );
        }
        seenIds.add(t.id);

        if (typeof t.target !== 'string') {
          throw new WorkflowValidationError(`${loc}: 'target' must be a string`);
        }
        if (!t.target.trim()) {
          throw new WorkflowValidationError(`${loc}: 'target' must be a non-empty string`);
        }
        if (t.target.length > 100) {
          throw new WorkflowValidationError(`${loc}: 'target' must be at most 100 characters`);
        }
        if (t.target !== HANDOFF_TARGET_WILDCARD) {
          const destinations = targetNameDestinations.get(t.target);
          if (!destinations || destinations.size === 0) {
            throw new WorkflowValidationError(
              `${loc}: target "${t.target}" does not reference a known node name or agent slot name`
            );
          }
          if (destinations.size > 1) {
            throw new WorkflowValidationError(
              `${loc}: target "${t.target}" is ambiguous — matches ${destinations.size} destinations; ` +
                'use a name unique to one node or slot'
            );
          }
        }
        if (seenTargets.has(t.target)) {
          throw new WorkflowValidationError(
            `${loc}: duplicate transition target "${t.target}" within node "${node.name}" — ` +
              'a handoff target must resolve to a single declared transition'
          );
        }
        seenTargets.add(t.target);

        if (t.hookId !== undefined) {
          if (typeof t.hookId !== 'string') {
            throw new WorkflowValidationError(`${loc}: 'hookId' must be a string`);
          }
          if (!t.hookId.trim()) {
            throw new WorkflowValidationError(`${loc}: 'hookId' must be a non-empty string`);
          }
          if (t.hookId.length > 100) {
            throw new WorkflowValidationError(`${loc}: 'hookId' must be at most 100 characters`);
          }
          if (!hookIds.has(t.hookId)) {
            throw new WorkflowValidationError(
              `${loc}: hookId "${t.hookId}" does not reference a known hook`
            );
          }
        }

        if (t.maxCycles !== undefined) {
          if (typeof t.maxCycles !== 'number' || !Number.isFinite(t.maxCycles)) {
            throw new WorkflowValidationError(`${loc}: 'maxCycles' must be a finite number`);
          }
          if (t.maxCycles <= 0 || !Number.isInteger(t.maxCycles)) {
            throw new WorkflowValidationError(`${loc}: 'maxCycles' must be a positive integer`);
          }
        }
      }
    }
  }

  private validateHooks(hooks: unknown[], nodes: WorkflowNodeInput[]): void {
    const errors = validateWorkflowHooks(hooks, nodes);
    if (errors.length > 0) {
      throw new WorkflowValidationError(errors.join('; '));
    }
  }

  private validateNoDuplicateHookIds(hooks: unknown[]): void {
    const seen = new Set<string>();
    for (let hi = 0; hi < hooks.length; hi++) {
      const hook = hooks[hi];
      if (!hook || typeof hook !== 'object') continue;
      const id = (hook as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      if (seen.has(id)) {
        throw new WorkflowValidationError(`hooks[${hi}].id: duplicate hook id "${id}"`);
      }
      seen.add(id);
    }
  }

  private validateStartNodeId(startNodeId: string, nodes: WorkflowNodeInput[]): void {
    if (!startNodeId.trim()) {
      throw new WorkflowValidationError('startNodeId must be a non-empty string');
    }
    const nodeIds = new Set(nodes.map((n) => n.id));
    if (!nodeIds.has(startNodeId)) {
      throw new WorkflowValidationError(
        `startNodeId "${startNodeId}" does not match any node in this workflow`
      );
    }
  }

  private validateEndNodeId(endNodeId: string, nodes: WorkflowNodeInput[]): void {
    if (!endNodeId.trim()) {
      throw new WorkflowValidationError('endNodeId must be a non-empty string');
    }
    const endNode = nodes.find((n) => n.id === endNodeId);
    if (!endNode) {
      throw new WorkflowValidationError(
        `endNodeId "${endNodeId}" does not match any node in this workflow`
      );
    }
    const agentCount = endNode.agents?.length ?? 0;
    if (agentCount !== 1) {
      throw new WorkflowValidationError(
        `endNode "${endNode.name}" must have exactly 1 agent (has ${agentCount}); ` +
          `end nodes own the workflow completion signal via task.reportedStatus`
      );
    }
  }
}
