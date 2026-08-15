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
  CustomHook,
} from '@hyperneo/shared';
import { HANDOFF_TARGET_WILDCARD, MAX_NODE_HANDOFF_TRANSITIONS } from '@hyperneo/shared';
import {
  availableHookIds,
  validateCustomHooks,
  validateWorkflowHookBindings,
} from '../workflow-hook-validation';
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
import { slugify, validateSlug } from '../slug';
import { CORRUPT_HOOK_BINDINGS_HOOK_ID } from '../hook-reserved-ids';
import { legacyHookCoverage } from '../legacy-hook-coverage';

const logger = new Logger('SpaceWorkflowManager');
const RESERVED_WORKFLOW_AGENT_NAMES = new Set(['space-agent', 'task-agent']);

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
  /** Returns the SpaceWorkerAgent with the given UUID in the given space, or null if not found. */
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

/**
 * Raised when deleting (or replacing) a workflow that still has a run whose
 * canonical task is not archived. Such a run is still executable — `done`/
 * `cancelled` reopen, and only `SpaceTask.archivedAt` is the non-reopenable
 * tombstone — so deleting the definition would orphan its pinned version and
 * strand the run. RFC §4 #3. Callers that want to ignore this for a specific
 * path (resync, import-replacement) catch it and skip-with-warn instead of
 * surfacing a hard failure.
 */
export class WorkflowDeletionBlockedError extends WorkflowValidationError {
  constructor(
    message: string,
    readonly workflowId: string
  ) {
    super(message);
    this.name = 'WorkflowDeletionBlockedError';
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
      // Generate an id only when the caller omitted one. Do NOT trim a supplied
      // id here — trimming would re-key it away from params.layout entries
      // (which are keyed by the original id) and silently discard saved
      // positions. Empty/whitespace ids are rejected by validateNodes instead.
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

    if (params.channels && params.channels.length > 0) {
      this.validateChannels(params.channels);
    }

    this.validateHooks(params.hookBindings, params.customHooks, nodes);

    this.validateTransitions(nodes, availableHookIds(params.customHooks));

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
    const result = this.getWorkflowForRunStart(id);
    return result?.workflow ?? null;
  }

  /** Load the raw persisted definition and its sanitized runtime view from one read. */
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

  /**
   * Resolve the definition an in-flight run executes (RFC §4 Phase 1 read cutover).
   *
   * A pinned run reads the IMMUTABLE version it was created with — not the mutable
   * `space_workflows` head — so a later edit to the definition cannot change what an
   * in-flight run executes. The pinned payload is the raw persisted definition captured at
   * run creation; we rehydrate it through the SAME sanitization (`sanitizePostApprovalForLoad`)
   * the live path applies, so "this run reads version V" is well-defined regardless of read
   * site (manager or raw repo) — the sanitize-at-rehydrate model (see `definition-version.ts`).
   *
   * Stable timestamps: the pinned payload strips `createdAt`/`updatedAt` (volatile). The
   * rehydrated `updatedAt` is derived from the immutable version hash
   * (`stableVersionTimestamp`), so the gate-open cache fingerprint is version-stable — it
   * does not churn on unrelated head edits, and is identical on first activation and
   * recovery (independent of when the version row was appended; INSERT OR IGNORE can leave a
   * reused hash's `created_at` stale). The startup backfill RE-KEYS a backfilled run's
   * existing persisted gate-open entries to this basis, so the cache survives the cutover
   * without re-evaluating gates. (`createdAt` is the row's append time, not a staleness
   * signal.)
   *
   * Fallback: a null pin (legacy run pre-backfill, or an archived orphan whose version row
   * is absent) — or any rehydration failure — resolves to the live head, preserving exact
   * pre-cutover behavior. This is why the cutover is content-neutral: every pre-existing
   * run is backfilled to a pin equal to its current head, so resolving through the pin
   * changes nothing at cutover time; only a later edit diverges, which is the invariant.
   *
   * The pinned payload captures user-authored content (nodes, channels, hooks,
   * agents, post-approval) and built-in definitions as authored.
   */
  getWorkflowForRun(run: {
    workflowId: string;
    definitionVersion: string | null;
  }): SpaceWorkflow | null {
    // Delegate pin-resolution to the repository (raw rehydration + stable timestamps +
    // head fallback — see SpaceWorkflowRepository.getWorkflowForRun), then apply the same
    // load-time sanitization the live path uses (sanitize-at-rehydrate). One pin-resolution
    // implementation shared by the sanitized (manager) and raw (repo) callers.
    const raw = this.repo.getWorkflowForRun(run);
    return raw ? this.sanitizePostApprovalForLoad(raw) : null;
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
    return withSanitizedNodes;
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /** Update built-in identity metadata without rewriting workflow structure. */
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

  /**
   * Stamp only the `templateName` on a built-in workflow row — no name/handle
   * validation and no structural migration. Used by the legacy identity
   * migration to point older duplicate rows at the canonical template so they
   * group for duplicate cleanup even when their name/handle cannot be renamed
   * (collision). Unlike {@link updateWorkflow}, this writes a single column and
   * skips gate→hook migration, so it cannot mangle the row's structure.
   */
  stampBuiltInTemplateName(id: string, templateName: string): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;
    return this.repo.updateWorkflow(id, { templateName });
  }

  /**
   * Stamp only the `tags` on a built-in workflow row — no validation and no
   * structural migration. Used by the legacy identity migration to drop a stale
   * `default` tag from merger-variant rows (the stable `Coding` workflow is the
   * default now), so the deterministic workflow fallback does not pick the
   * legacy merger flow over the stable one. Like {@link stampBuiltInTemplateName},
   * this writes a single column and cannot mangle the row's structure.
   */
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

    // The corrupt-column fail-closed MARKER is repository-level state, not
    // configuration: without this filter it fails hook validation (its
    // reserved id resolves to no hook) and WEDGES every edit of the workflow
    // — even hook-unrelated ones — with a misleading "unknown hook" error.
    // Filter it from validation: hook-unrelated edits proceed with the
    // corrupt column untouched (the marker reloads); an edit that supplies
    // real bindings or clears them replaces the marker wholesale.
    const effectiveBindings = (
      params.hookBindings === undefined
        ? (existing.hookBindings ?? [])
        : (params.hookBindings ?? [])
    ).filter((b) => b.hookId !== CORRUPT_HOOK_BINDINGS_HOOK_ID);

    // LEGACY MIGRATION COMPLETENESS: supplying v2 bindings for a workflow
    // that still carries legacy hooks is the migration act — but only when
    // the new bindings COVER every legacy hook id. A partial set would run
    // only the new gates and silently skip the rest (and migration 197
    // would then drop the legacy definitions permanently). Refuse with the
    // missing ids; on complete coverage, clear the legacy column in the
    // SAME update (atomic — the run either sees both or neither).
    const existingLegacyHooks = (existing as { hooks?: unknown } | null)?.hooks;
    if (
      params.hookBindings !== undefined &&
      params.hookBindings !== null &&
      Array.isArray(existingLegacyHooks) &&
      existingLegacyHooks.length > 0
    ) {
      const coverage = legacyHookCoverage(existingLegacyHooks, [
        ...(existing.hookBindings ?? []),
        ...params.hookBindings,
      ]);
      if (!coverage.complete) {
        throw new WorkflowValidationError(
          `hookBindings: this workflow still carries legacy hooks that must ALL be recreated ` +
            `before the legacy definitions can be retired — missing v2 bindings for: ${coverage.missing.join(', ')}.`
        );
      }
      params = { ...params, clearLegacyHooks: true };
    }

    // ANTI-LAUNDERING: the marker must never REACH PERSISTENCE. The filter
    // above only protects VALIDATION — an ordinary editor save (the visual
    // editor round-trips existing bindings verbatim) or the startup restamp
    // would write the synthetic bindings as real JSON, after which the
    // column decodes cleanly into a permanently unresolvable hook set that
    // no validation can ever flag again. Strip reserved ids from the
    // caller-supplied bindings before they reach updateWorkflow (and
    // replace the marker wholesale when params carries real bindings).
    const callerBindings = params.hookBindings;
    if (
      callerBindings !== undefined &&
      callerBindings !== null &&
      callerBindings.some((b) => b.hookId === CORRUPT_HOOK_BINDINGS_HOOK_ID)
    ) {
      const cleaned = callerBindings.filter((b) => b.hookId !== CORRUPT_HOOK_BINDINGS_HOOK_ID);
      params = { ...params, hookBindings: cleaned };
      if (cleaned.length === 0) {
        logger.warn(
          `Workflow ${id}: caller-supplied hookBindings contained only the corrupt-column marker; clearing bindings (repair the corrupt column or re-author hooks).`
        );
      }
    }
    const effectiveCustomHooks =
      params.customHooks === undefined ? (existing.customHooks ?? []) : (params.customHooks ?? []);
    this.validateHooks(effectiveBindings, effectiveCustomHooks, effectiveNodes);
    this.validateTransitions(effectiveNodes, availableHookIds(effectiveCustomHooks));

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

  /**
   * Deletion-safety predicate (RFC §4 #3): does this workflow have any
   * EXECUTABLE run that must not be orphaned? True ⇒ deleting the definition
   * would orphan the run's pinned version. A run is executable when it is
   * non-terminal (`pending`/`in_progress`/`blocked`) OR terminal with a
   * non-archived task (`done`/`cancelled` reopen). Used by import-replacement
   * to pre-check before freeing a name/handle slot.
   */
  hasExecutableRuns(id: string): boolean {
    return this.repo.hasExecutableRuns(id);
  }

  deleteWorkflow(id: string): boolean {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return false;
    // RFC §4 #3: refuse to delete a definition that still has an executable
    // run — deleting it orphans the run's pinned version. A run is executable
    // when non-terminal (incl. the startWorkflowRun window before its task is
    // attached) or terminal with a non-archived task (done/cancelled reopen).
    // Callers that must tolerate a blocked delete (resync, import-replacement)
    // catch WorkflowDeletionBlockedError.
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

    // Reject node ids that collide with another node's name (or a duplicate id).
    // Channel authorization is by node NAME, while queued-handoff resolution can
    // resolve a name-authorized worker ref to a node by ID — so a node id equal
    // to another node's name makes the ref ambiguous and can route a message
    // into a node the topology never authorized. ids are generated before this
    // check (createWorkflow/updateWorkflow), so every node has one here.
    const seenIds = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const id = nodes[i].id;
      // Reject an explicit empty id (breaks workflowNodeId pinning downstream)
      // and surrounding-whitespace ids (trimming would re-key them away from
      // params.layout and silently discard saved positions). Undefined/null are
      // generated by createWorkflow before this runs.
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
        // Network JSON isn't protected by the TypeScript interface, so read the
        // interest defensively. Exactly one of `topic` / `topicFrom` must be set.
        const rawInterest = interests[k] as {
          topic?: unknown;
          topicFrom?: { source?: unknown; pattern?: unknown } | undefined;
          label?: unknown;
        };
        // Presence is independent of type: a malformed `{ topic: 123 }` is still
        // "topic set" and must trip the exactly-one-of check (or a type error),
        // not silently fall through to the `topicFrom` branch.
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

      // Non-blocking warning: a slot that replaces the agent prompt with empty text
      // runs only the SDK base contract (no role guidance). Allowed, but almost always
      // a misconfiguration — surface it without blocking the save.
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
        // Network JSON isn't protected by the TypeScript interface — reject
        // non-boolean values (e.g. "true" or null) so persisted config, the
        // editor, and the runtime (strict ===) cannot disagree. null is rejected
        // to match the import schema (z.boolean().optional() accepts only
        // undefined, not null).
        throw new WorkflowValidationError(`${loc}: resetContextPerTurn must be a boolean`);
      }
    }

    // Existence validation: only when agentLookup is available.
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

  /**
   * Validate declared outbound handoff transitions on every node.
   *
   * Enforces the workflow handoff CONTRACT (see HandoffTransition /
   * HandoffOperation):
   * - `id` is a non-empty string, unique within its node.
   * - `target` is a known node name, agent slot name, or the broadcast wildcard
   *   `'*'`. A handoff target must resolve to a declared node/agent.
   * - `target` is unique within the node (at most one transition per concrete
   *   name, at most one `'*'`) so `handoff({ target })` resolves unambiguously.
   * - `hookId`, when set, references a known hook id.
   * - `maxCycles`, when set, is a positive integer.
   *
   * Runtime transition EXECUTION is out of scope here; this only enforces the
   * declarative shape and referential integrity.
   */
  private validateTransitions(nodes: WorkflowNodeInput[], hookIds: Set<string>): void {
    // Valid target names: every node name + every agent slot name (matches
    // channel addressing). The broadcast wildcard is always valid. A name is
    // AMBIGUOUS when a name can address more than one destination — two nodes
    // share a name, a slot name appears in multiple nodes, OR a node name
    // collides with a slot name (even within the same node). Count distinct
    // addressable destinations per name (a node-name destination and a slot-name
    // destination are distinct), and reject names addressing more than one.
    const targetNameDestinations = new Map<string, Set<string>>();
    const addDestination = (name: string, destinationKey: string) => {
      const set = targetNameDestinations.get(name) ?? new Set<string>();
      set.add(destinationKey);
      targetNameDestinations.set(name, set);
    };
    for (const node of nodes) {
      // node.id is optional on WorkflowNodeInput; names are unique within a
      // workflow, so fall back to the name when id is absent.
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
      // RPC JSON is untyped — a non-array (e.g. `{}`) is truthy with no .length
      // and would otherwise slip past the guards below and be silently dropped by
      // the repository. Fail loudly instead.
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

        // RPC JSON is untyped — a non-object element (e.g. null) would throw a
        // TypeError on the field reads below; reject it cleanly first.
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
        // RPC JSON is untyped — reject a non-string label before the length
        // check (a numeric label has no .length and would otherwise slip through).
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

  private validateHooks(bindings: unknown, customHooks: unknown, nodes: WorkflowNodeInput[]): void {
    // Validate custom hooks FIRST, and do not resolve bindings when they are
    // malformed: validateWorkflowHookBindings calls resolveHook, whose `.find`
    // dereferences entries, so a non-array or null-element customHooks would
    // throw a TypeError instead of surfacing the validation errors.
    const customErrors = validateCustomHooks(customHooks);
    if (customErrors.length > 0) {
      throw new WorkflowValidationError(customErrors.join('; '));
    }
    const customHookArray = Array.isArray(customHooks) ? (customHooks as CustomHook[]) : undefined;
    const errors = validateWorkflowHookBindings(bindings, customHookArray, nodes);
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
