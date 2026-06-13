/**
 * SpaceWorkflowManager
 *
 * Business logic layer for SpaceWorkflow operations within a Space.
 *
 * Responsibilities:
 * - Validate workflow integrity (unique name, node agent refs, channel graph validity)
 * - Protect worker agents that are referenced by nodes
 *
 * Workflow selection: either explicit workflowId provided by the caller, or
 * AI auto-select at runtime via list_workflows + start_workflow_run. There is
 * no default workflow concept.
 */

import type {
  SpaceWorkflow,
  SpaceWorkflowSummary,
  WorkflowNodeInput,
  CreateSpaceWorkflowParams,
  UpdateSpaceWorkflowParams,
  WorkflowChannel,
  Gate,
} from '@neokai/shared';
import { validateWorkflowHooks } from '../workflow-hook-validation';
import { generateUUID } from '@neokai/shared';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository';
import { validateGlobPattern } from '../../external-events/topic-validator';
import { MAX_AGENT_SLOT_EVENT_INTERESTS } from '../export-format';
import { Logger } from '../../logger';
import {
  validatePostApproval,
  validatePostApprovalRoutes,
} from '../workflows/post-approval-validator';
import { validateGate } from '../runtime/gate-evaluator';
import { isApprovalGate } from '../runtime/gate-features';
import { slugify, validateSlug } from '../slug';
import {
  CODING_WORKFLOW,
  FULLSTACK_QA_LOOP_WORKFLOW,
  PLAN_AND_DECOMPOSE_WORKFLOW,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
} from '../workflows/built-in-workflows';
import { migrateWorkflowGateProgressionToHooks } from '../workflows/workflow-migration';

const logger = new Logger('SpaceWorkflowManager');
const RESERVED_WORKFLOW_AGENT_NAMES = new Set(['space-agent', 'task-agent']);

const BUILT_IN_TEMPLATE_GATES = new Map(
  [
    CODING_WORKFLOW,
    PLAN_AND_DECOMPOSE_WORKFLOW,
    FULLSTACK_QA_LOOP_WORKFLOW,
    RESEARCH_WORKFLOW,
    REVIEW_ONLY_WORKFLOW,
  ].map((workflow) => [workflow.name, workflow.gates ?? []])
);

function normalizeWorkflowAgentName(name: string): string {
  return name.trim().toLowerCase();
}

export function isReservedWorkflowAgentName(name: string): boolean {
  return RESERVED_WORKFLOW_AGENT_NAMES.has(normalizeWorkflowAgentName(name));
}

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal interface the manager needs from SpaceAgentManager to validate
 * worker agent references in workflow nodes.
 */
export interface SpaceAgentLookup {
  /** Returns the SpaceAgent with the given UUID in the given space, or null if not found. */
  getAgentById(spaceId: string, id: string): { id: string; name: string } | null;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class SpaceWorkflowManager {
  constructor(
    private repo: SpaceWorkflowRepository,
    private agentLookup: SpaceAgentLookup | null = null
  ) {}

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

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

    params = migrateWorkflowGateProgressionToHooks({
      ...params,
      nodes: nodes as SpaceWorkflow['nodes'],
    }).workflow;

    if (params.channels && params.channels.length > 0) {
      this.validateChannels(params.channels);
    }

    if (params.gates && params.gates.length > 0) {
      this.validateGates(params.gates);
    }

    this.validateHooks(params.hooks ?? [], nodes);

    this.validateCodexApprovalAgainstScriptedGates(
      nodes,
      params.channels ?? [],
      params.gates ?? []
    );

    // Hard-reject invalid post-approval routes at create time. Stale routes
    // (target no longer exists) must be caught before the row lands in the DB,
    // where they would otherwise trip the load-time warning path below.
    const postApprovalResult = validatePostApprovalRoutes({
      workflowPostApproval: params.postApproval,
      nodes,
    });
    if (!postApprovalResult.ok) {
      throw new WorkflowValidationError(postApprovalResult.error);
    }

    // Auto-generate handle from name if not provided, with collision resolution.
    // Validate explicit handles for format and uniqueness.
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

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  getWorkflow(id: string): SpaceWorkflow | null {
    const wf = this.repo.getWorkflow(id);
    if (!wf) return null;
    return this.sanitizePostApprovalForLoad(wf);
  }

  /**
   * Get a workflow by its handle within a specific space.
   */
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

  /**
   * Load-time sanitiser for optional post-approval routes.
   *
   * If a persisted route no longer resolves to a valid target (e.g. the
   * targeted node/agent was removed since the workflow was saved), we do NOT
   * fail the load — instead we strip the route from the returned object and
   * log a warning. Workflow loading is in the hot path (every run start, every
   * RPC list), so a stale route cannot be allowed to break the space.
   *
   * The DB row is untouched — re-saving the workflow via `updateWorkflow`
   * with `postApproval: null` clears a stale legacy workflow-level route.
   * Re-saving `nodes` clears stale node-level routes.
   */
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
    return migrateWorkflowGateProgressionToHooks(withSanitizedNodes).workflow;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;

    if (params.name !== undefined) {
      const trimmedName = params.name.trim();
      this.validateName(existing.spaceId, trimmedName, id);
      params = { ...params, name: trimmedName };
      // Auto-regenerate handle only when the name actually changes, the
      // caller did not supply an explicit handle, AND the existing handle
      // is a non-empty string. A missing/null handle means the user
      // deliberately cleared it (via updateWorkflow({ handle: null }));
      // regenerating on a rename would silently undo that intentional clearing.
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
              requireCodexApproval: n.requireCodexApproval,
              codexPollIntervalMs: n.codexPollIntervalMs,
            })
          )
        : existing.nodes.map(
            (n): WorkflowNodeInput => ({
              id: n.id,
              name: n.name,
              agents: n.agents,
              postApproval: n.postApproval,
              requireCodexApproval: n.requireCodexApproval,
              codexPollIntervalMs: n.codexPollIntervalMs,
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

    if (params.gates && params.gates.length > 0) {
      const existingGates = existing.gates ?? [];
      const changedGates = params.gates.filter((g) => {
        const existingGate = existingGates.find((eg) => eg.id === g.id);
        if (!existingGate) return true;
        return JSON.stringify(existingGate) !== JSON.stringify(g);
      });
      if (changedGates.length > 0) {
        this.validateGates(changedGates);
      }
    }

    const migrated = migrateWorkflowGateProgressionToHooks({
      channels: params.channels === undefined ? existing.channels : (params.channels ?? undefined),
      gates: params.gates === undefined ? existing.gates : (params.gates ?? undefined),
      hooks: params.hooks === undefined ? existing.hooks : (params.hooks ?? undefined),
      nodes: effectiveNodes as SpaceWorkflow['nodes'],
      templateName:
        params.templateName === undefined
          ? existing.templateName
          : (params.templateName ?? undefined),
      templateGates: existing.templateName
        ? (BUILT_IN_TEMPLATE_GATES.get(existing.templateName) ?? [])
        : [],
    }).workflow;
    params = {
      ...params,
      channels: migrated.channels ?? [],
      gates: migrated.gates ?? [],
      hooks: migrated.hooks ?? [],
    };

    const effectiveChannels =
      params.channels === undefined ? (existing.channels ?? []) : (params.channels ?? []);
    const effectiveGates =
      params.gates === undefined ? (existing.gates ?? []) : (params.gates ?? []);
    const effectiveHooks =
      params.hooks === undefined ? (existing.hooks ?? []) : (params.hooks ?? []);
    this.validateHooks(effectiveHooks, effectiveNodes);
    this.validateCodexApprovalAgainstScriptedGates(
      effectiveNodes,
      effectiveChannels,
      effectiveGates
    );

    // Validate node-level postApproval plus the legacy workflow-level route
    // against the effective node set so a rename submitted in the same update
    // does not spuriously invalidate the route. `null` clears the legacy
    // workflow-level route.
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

  /**
   * Built-in workflow re-stamping may update structural enforcement metadata on
   * existing node-agent slots, but it must never replace node rows. Workflow
   * runs and node executions reference node IDs directly, so a template drift
   * pass that changes the node ID set would strand in-flight executions.
   */
  updateWorkflowNodeToolGuards(id: string, nodes: SpaceWorkflow['nodes']): void {
    const existing = this.repo.getWorkflow(id);
    if (!existing) {
      throw new WorkflowValidationError(`Workflow not found: ${id}`);
    }
    this.validateStableNodeIds(id, existing.nodes, nodes);
    this.repo.updateWorkflowNodeToolGuards(id, nodes);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  deleteWorkflow(id: string): boolean {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return false;
    return this.repo.deleteWorkflow(id);
  }

  // -------------------------------------------------------------------------
  // Agent reference protection
  // -------------------------------------------------------------------------

  /**
   * Returns all workflows whose nodes reference the given worker agent.
   * Used by SpaceAgentManager to block deletion of in-use agents.
   */
  getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[] {
    return this.repo.getWorkflowsReferencingAgent(agentId);
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

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
        // Exclude the workflow being updated (if any)
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
    // Collision suffixing can push the handle over the max length; validate
    // and truncate with a fallback if necessary, then loop until valid.
    return this.ensureValidHandle(handle, filteredHandles);
  }

  /**
   * Ensure a handle (or its fallback) passes validateSlug. If the initial
   * handle is invalid (e.g. over-length after collision suffixing),
   * progressively shorten the base and re-run collision resolution until
   * the result is valid.
   */
  private ensureValidHandle(handle: string, existingHandles: string[]): string {
    const maxLen = 60;
    // If the initial slugify result is already valid, we're done.
    if (validateSlug(handle) === null) return handle;

    // Collision suffixing pushed the handle over the max length.
    // Progressively shorten the base and re-run collision resolution
    // until a valid handle is produced.
    for (let len = maxLen; len > 0; len--) {
      const truncated = handle.slice(0, len);
      const cleaned = truncated.replace(/-+$/, '');
      const fallback = cleaned || 'workflow';
      const candidate = slugify(fallback, existingHandles);
      if (validateSlug(candidate) === null) {
        return candidate;
      }
    }
    // Absolute fallback — should never reach here in practice
    return 'workflow';
  }

  private validateNodes(spaceId: string, nodes: WorkflowNodeInput[]): void {
    if (nodes.length === 0) {
      throw new WorkflowValidationError('A workflow must have at least one node');
    }

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      this.validateNodeAgentRef(spaceId, node, i);
      this.validateEventInterests(node, i);
      this.validateCodexPollInterval(node, i);
      this.validateCodexApprovalFlag(node, i);
    }
  }

  private validateCodexPollInterval(node: WorkflowNodeInput, index: number): void {
    if (node.codexPollIntervalMs === undefined || node.codexPollIntervalMs === null) {
      return;
    }
    if (
      typeof node.codexPollIntervalMs !== 'number' ||
      !Number.isFinite(node.codexPollIntervalMs)
    ) {
      throw new WorkflowValidationError(
        `node[${index}]: codexPollIntervalMs must be a finite number`
      );
    }
    if (node.codexPollIntervalMs <= 0) {
      throw new WorkflowValidationError(
        `node[${index}]: codexPollIntervalMs must be a positive number`
      );
    }
    if (!Number.isInteger(node.codexPollIntervalMs)) {
      throw new WorkflowValidationError(`node[${index}]: codexPollIntervalMs must be an integer`);
    }
  }

  private validateCodexApprovalFlag(node: WorkflowNodeInput, index: number): void {
    if (node.requireCodexApproval === undefined || node.requireCodexApproval === null) {
      return;
    }
    if (typeof node.requireCodexApproval !== 'boolean') {
      throw new WorkflowValidationError(`node[${index}]: requireCodexApproval must be a boolean`);
    }
  }

  private validateCodexApprovalAgainstScriptedGates(
    nodes: WorkflowNodeInput[],
    channels: WorkflowChannel[],
    gates: Gate[]
  ): void {
    const gateMap = new Map(gates.map((g) => [g.id, g]));

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.requireCodexApproval) continue;

      const nodeRefs = new Set([node.name, ...(node.agents?.map((a) => a.name) ?? [])]);

      for (let ci = 0; ci < channels.length; ci++) {
        const ch = channels[ci];
        if (!ch.gateId) continue;
        const gate = gateMap.get(ch.gateId);
        if (!gate?.script || !isApprovalGate(gate)) continue;

        if (ch.from === '*') {
          throw new WorkflowValidationError(
            `node[${i}] "${node.name}": requireCodexApproval is incompatible with scripted approval gate "${ch.gateId}" on wildcard channel[${ci}]; ` +
              'dynamic Codex injection is blocked when an approval gate has a custom script'
          );
        }

        if (nodeRefs.has(ch.from)) {
          throw new WorkflowValidationError(
            `node[${i}] "${node.name}": requireCodexApproval is incompatible with scripted approval gate "${ch.gateId}" on channel[${ci}]; ` +
              'dynamic Codex injection is blocked when an approval gate has a custom script'
          );
        }
      }
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
        const validation = validateGlobPattern(interests[k].topic);
        if (!validation.valid) {
          throw new WorkflowValidationError(
            `${loc}[${k}].topic: ${validation.reason ?? 'invalid external-event topic pattern'}`
          );
        }
      }
    }
  }

  private validateNodeAgentRef(spaceId: string, node: WorkflowNodeInput, index: number): void {
    // Backward compat: if `agents` is absent/empty but legacy `agentId` is set on the object,
    // synthesize a single-agent array from it before validating.
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

    // Format-level validation: always run regardless of agentLookup
    const seenNames = new Set<string>();
    for (let j = 0; j < node.agents.length; j++) {
      const entry = node.agents[j];
      const loc = `node[${index}].agents[${j}]`;
      if (!entry.agentId || !entry.agentId.trim()) {
        throw new WorkflowValidationError(`${loc}: agentId must be a non-empty SpaceAgent UUID`);
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
    }

    // Existence validation: only when agentLookup is available.
    if (this.agentLookup) {
      for (let j = 0; j < node.agents.length; j++) {
        const entry = node.agents[j];
        const agent = this.agentLookup.getAgentById(spaceId, entry.agentId);
        if (!agent) {
          throw new WorkflowValidationError(
            `node[${index}].agents[${j}]: agentId "${entry.agentId}" does not match any SpaceAgent in this space`
          );
        }
      }
    }
  }

  private validateChannels(channels: WorkflowChannel[]): void {
    for (let ci = 0; ci < channels.length; ci++) {
      const ch = channels[ci];
      const loc = `channels[${ci}]`;

      // Validate from
      if (!ch.from || !ch.from.trim()) {
        throw new WorkflowValidationError(`${loc}: 'from' must be a non-empty node name string`);
      }

      // Validate to
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

  private validateGates(gates: unknown[]): void {
    for (let gi = 0; gi < gates.length; gi++) {
      const errors = validateGate(gates[gi]);
      if (errors.length > 0) {
        throw new WorkflowValidationError(`gates[${gi}]: ${errors.join('; ')}`);
      }
    }
  }

  private validateHooks(hooks: unknown[], nodes: WorkflowNodeInput[]): void {
    const errors = validateWorkflowHooks(hooks, nodes);
    if (errors.length > 0) {
      throw new WorkflowValidationError(errors.join('; '));
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
    // End nodes own the workflow's completion signal via `task.reportedStatus`.
    // Multi-agent end nodes create ambiguity: who declares the workflow done?
    // Restrict to exactly one agent so there's a single unambiguous owner of
    // the workflow's commitment.
    const agentCount = endNode.agents?.length ?? 0;
    if (agentCount !== 1) {
      throw new WorkflowValidationError(
        `endNode "${endNode.name}" must have exactly 1 agent (has ${agentCount}); ` +
          `end nodes own the workflow completion signal via task.reportedStatus`
      );
    }
  }
}
