/**
 * SpaceWorkflowRepository
 *
 * Data access layer for SpaceWorkflow and SpaceWorkflowNode records.
 *
 * Storage layout:
 *   space_workflows             — id, space_id, name, description, start_node_id, end_node_id,
 *                                  tags (JSON), channels (JSON), gates (JSON), layout (JSON),
 *                                  created_at, updated_at
 *   space_workflow_nodes        — id, workflow_id, name, description, config (JSON),
 *                                  created_at, updated_at
 *
 * The `config` column on space_workflow_nodes stores: { agents? }
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type {
  SpaceWorkflow,
  SpaceWorkflowSummary,
  SpaceAutonomyLevel,
  WorkflowNode,
  WorkflowNodeInput,
  WorkflowNodeAgent,
  WorkflowChannel,
  Gate,
  WorkflowHook,
  CreateSpaceWorkflowParams,
  PostApprovalRoute,
  UpdateSpaceWorkflowParams,
} from '@hyperneo/shared';
import { Logger } from '../../lib/logger';
import {
  computeDefinitionVersion,
  stableVersionTimestamp,
} from '../../lib/space/workflows/definition-version';
import {
  SpaceWorkflowDefinitionVersionRepository,
  type DefinitionVersionSource,
} from './space-workflow-definition-version-repository';

const log = new Logger('space-workflow-repository');

// ---------------------------------------------------------------------------
// Internal DB row shapes
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: string;
  space_id: string;
  name: string;
  description: string;
  start_node_id: string | null;
  end_node_id?: string | null;
  tags: string;
  channels: string | null;
  gates: string | null;
  hooks: string | null;
  layout: string | null;
  template_name: string | null;
  template_hash: string | null;
  instructions: string | null;
  completion_autonomy_level: number;
  /**
   * JSON-encoded legacy workflow-level `PostApprovalRoute` — null when the
   * workflow has no legacy route configured. New routes live in node config.
   */
  post_approval?: string | null;
  disabled: number;
  handle: string | null;
  created_at: number;
  updated_at: number;
}

interface NodeRow {
  id: string;
  workflow_id: string;
  name: string;
  description: string;
  config: string | null;
  created_at: number;
  updated_at: number;
}

// JSON stored inside space_workflow_nodes.config
interface NodeConfigJson {
  /** Multi-agent array */
  agents?: WorkflowNodeAgent[];
  /** Optional post-approval route scoped to this workflow node. */
  postApproval?: PostApprovalRoute;
  /** Require codex[bot] +1 on approval gates for channels from this node. */
  requireCodexApproval?: boolean;
  /** Custom poll interval (ms) for the codex review bot. */
  codexPollIntervalMs?: number;
  /** Custom timeout (seconds) for the codex review bot reaction check. */
  codexTimeoutSeconds?: number;
  /**
   * Forward-compat: rows persisted before PR 5/5 of the
   * task-agent-as-post-approval-executor refactor may carry a legacy
   * post-approval action list under this key. The runtime no longer reads it;
   * `rowToNode` strips it on load and logs a warning so the row can be
   * re-saved cleanly the next time the workflow is updated. The field is
   * intentionally untyped (`unknown`) because the action union has been
   * deleted from `@hyperneo/shared`.
   */
  completionActions?: unknown;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Per-load migration accumulator. `rowToNode` pushes the names of any
 * deprecated fields it strips into `strippedFields` so the caller can emit a
 * single workflow-level `workflow.migrated` structured log line covering every
 * stripped field across all nodes — instead of a noisy per-node warning.
 */
interface NodeMigrationContext {
  strippedFields: Set<string>;
}

function rowToNode(row: NodeRow, ctx?: NodeMigrationContext): WorkflowNode {
  const cfg = parseJson<NodeConfigJson>(row.config, {});
  // Ensure agents is always a non-empty array
  const agents: WorkflowNodeAgent[] =
    cfg.agents && cfg.agents.length > 0
      ? cfg.agents.map((a: WorkflowNodeAgent) => ({
          ...a,
          // Backfill name if missing (legacy rows)
          name: a.name?.trim() ? a.name : a.agentId,
        }))
      : [];

  // Forward-compat: drop the deprecated `completionActions` key without
  // failing the load. Older rows persisted before PR 5/5 of the
  // task-agent-as-post-approval-executor refactor still carry it. The
  // runtime no longer routes through it — node-level `postApproval` routes
  // are the supported replacement. We do NOT log here per-node; the
  // caller aggregates stripped fields and emits a single structured
  // `workflow.migrated` log line per workflow load. See plan §6.1.
  if (cfg.completionActions !== undefined && ctx) {
    ctx.strippedFields.add('completionActions');
  }

  return {
    id: row.id,
    name: row.name,
    agents,
    ...(cfg.postApproval ? { postApproval: cfg.postApproval } : {}),
    ...(cfg.requireCodexApproval ? { requireCodexApproval: true } : {}),
    ...(cfg.codexPollIntervalMs ? { codexPollIntervalMs: cfg.codexPollIntervalMs } : {}),
    ...(cfg.codexTimeoutSeconds ? { codexTimeoutSeconds: cfg.codexTimeoutSeconds } : {}),
  };
}

function rowToWorkflow(row: WorkflowRow, nodes: WorkflowNode[]): SpaceWorkflow {
  const startNodeId = row.start_node_id ?? nodes[0]?.id ?? '';
  const tags = parseJson<string[]>(row.tags, []);
  const layout = parseJson<Record<string, { x: number; y: number }> | null>(row.layout, null);
  const channels = parseJson<WorkflowChannel[] | null>(row.channels, null);
  const gates = parseJson<Gate[] | null>(row.gates, null);
  const hooks = parseJson<WorkflowHook[] | null>(row.hooks, null);

  const wf: SpaceWorkflow = {
    id: row.id,
    spaceId: row.space_id,
    name: row.name,
    description: row.description || undefined,
    nodes,
    startNodeId,
    tags,
    completionAutonomyLevel: row.completion_autonomy_level as SpaceAutonomyLevel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.end_node_id) wf.endNodeId = row.end_node_id;
  if (channels && channels.length > 0) wf.channels = channels;
  if (gates && gates.length > 0) wf.gates = gates;
  if (hooks && hooks.length > 0) wf.hooks = hooks;
  if (layout) wf.layout = layout;
  if (row.template_name) wf.templateName = row.template_name;
  if (row.template_hash) wf.templateHash = row.template_hash;
  if (row.instructions) wf.instructions = row.instructions;
  const postApproval = parseJson<PostApprovalRoute | null>(row.post_approval ?? null, null);
  if (postApproval && typeof postApproval === 'object') {
    wf.postApproval = postApproval;
  }
  if (row.disabled) {
    wf.disabled = true;
  }
  if (row.handle) {
    wf.handle = row.handle;
  }
  return wf;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SpaceWorkflowRepository {
  private readonly definitionVersions: SpaceWorkflowDefinitionVersionRepository;

  constructor(private db: BunDatabase) {
    this.definitionVersions = new SpaceWorkflowDefinitionVersionRepository(db);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  createWorkflow(params: CreateSpaceWorkflowParams): SpaceWorkflow {
    const workflowId = generateUUID();
    const now = Date.now();

    // Default completionAutonomyLevel to 3 (supervised) when not provided.
    // The DB column has NOT NULL DEFAULT 3; we mirror that here so callers
    // (e.g. the visual editor) do not need to pass an explicit value.
    const completionAutonomyLevel: SpaceAutonomyLevel =
      params.completionAutonomyLevel ?? (3 as SpaceAutonomyLevel);

    // Pre-resolve node IDs so channels can reference them
    const nodeInputs = params.nodes ?? [];
    const resolvedNodes: Array<{ id: string; input: WorkflowNodeInput }> = nodeInputs.map(
      (input) => ({
        id: input.id ?? generateUUID(),
        input,
      })
    );

    const startNodeId = params.startNodeId ?? resolvedNodes[0]?.id ?? null;
    const endNodeId = params.endNodeId ?? null;

    const channelsJson =
      params.channels && params.channels.length > 0 ? JSON.stringify(params.channels) : null;
    const gatesJson = params.gates && params.gates.length > 0 ? JSON.stringify(params.gates) : null;
    const hooksJson = params.hooks && params.hooks.length > 0 ? JSON.stringify(params.hooks) : null;
    const layoutJson = params.layout ? JSON.stringify(params.layout) : null;
    const postApprovalJson = params.postApproval ? JSON.stringify(params.postApproval) : null;

    this.db
      .prepare(
        `INSERT INTO space_workflows (id, space_id, name, description, start_node_id, end_node_id, tags, channels, gates, hooks, layout, template_name, template_hash, instructions, completion_autonomy_level, post_approval, disabled, handle, created_at, updated_at)
	         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        workflowId,
        params.spaceId,
        params.name.trim(),
        params.description ?? '',
        startNodeId,
        endNodeId,
        JSON.stringify(params.tags ?? []),
        channelsJson,
        gatesJson,
        hooksJson,
        layoutJson,
        params.templateName ?? null,
        params.templateHash ?? null,
        params.instructions ?? null,
        completionAutonomyLevel,
        postApprovalJson,
        params.disabled ? 1 : 0,
        params.handle ?? null,
        now,
        now
      );

    // Insert node rows
    for (let i = 0; i < resolvedNodes.length; i++) {
      const { id, input } = resolvedNodes[i];
      this.insertNode(workflowId, input, id, i, now);
    }

    const created = this.getWorkflow(workflowId)!;
    this.recordDefinitionVersion(created, 'create');
    return created;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  getWorkflow(id: string): SpaceWorkflow | null {
    const row = this.db.prepare(`SELECT * FROM space_workflows WHERE id = ?`).get(id) as
      | WorkflowRow
      | undefined;
    if (!row) return null;
    const ctx: NodeMigrationContext = { strippedFields: new Set<string>() };
    const nodes = this.fetchNodes(id, ctx);
    this.emitMigrationLog(row, ctx);
    return rowToWorkflow(row, nodes);
  }

  /**
   * Resolve the RAW persisted definition an in-flight run executes (RFC §4 Phase 1 read
   * cutover), without manager-level sanitization. Mirrors `getWorkflow` (raw) but resolves
   * a pinned run through its immutable version instead of the mutable head. Callers that
   * need the sanitized runtime view use `SpaceWorkflowManager.getWorkflowForRun`; this raw
   * variant serves paths (e.g. delivery-permission checks) that today read the raw repo
   * row. See the manager method for the stable-timestamp, fallback, and built-in-gate
   * boundary rationale.
   */
  getWorkflowForRun(run: {
    workflowId: string;
    definitionVersion: string | null;
  }): SpaceWorkflow | null {
    const versionHash = run.definitionVersion;
    if (versionHash) {
      try {
        const version = this.definitionVersions.getVersion(run.workflowId, versionHash);
        if (version) {
          const parsed = JSON.parse(version.payload) as SpaceWorkflow;
          // Preserve the pre-cutover gate-fingerprint basis: rehydrate `updatedAt` from the
          // LIVE head's `updatedAt` (a cheap PK lookup), so a backfilled in-flight run's
          // existing gate-open cache (fingerprinted with that same head timestamp) survives
          // the cutover instead of being invalidated and re-evaluated. This also keeps
          // first-activation and recovery consistent while the head is unchanged. Only when
          // the head is gone (deleted-definition orphan) do we fall back to a version-derived
          // value — there is no head timestamp to match.
          const headRow = this.db
            .prepare('SELECT updated_at FROM space_workflows WHERE id = ?')
            .get(run.workflowId) as { updated_at: number } | undefined;
          return {
            ...parsed,
            createdAt: version.createdAt,
            updatedAt: headRow?.updated_at ?? stableVersionTimestamp(versionHash),
          };
        }
      } catch (err) {
        log.warn(
          `getWorkflowForRun: failed to rehydrate pinned version ${versionHash} for workflow ` +
            `${run.workflowId}; falling back to live head:`,
          err
        );
      }
    }
    return this.getWorkflow(run.workflowId);
  }

  listWorkflows(spaceId: string): SpaceWorkflow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_workflows WHERE space_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(spaceId) as WorkflowRow[];
    return rows.map((r) => {
      const ctx: NodeMigrationContext = { strippedFields: new Set<string>() };
      const nodes = this.fetchNodes(r.id, ctx);
      this.emitMigrationLog(r, ctx);
      return rowToWorkflow(r, nodes);
    });
  }

  listWorkflowSummaries(spaceId: string): SpaceWorkflowSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, space_id, name, description, tags, template_name, template_hash, disabled, handle, completion_autonomy_level, created_at, updated_at
				 FROM space_workflows
				 WHERE space_id = ?
				 ORDER BY created_at ASC, rowid ASC`
      )
      .all(spaceId) as Array<
      Pick<
        WorkflowRow,
        | 'id'
        | 'space_id'
        | 'name'
        | 'description'
        | 'tags'
        | 'template_name'
        | 'template_hash'
        | 'disabled'
        | 'handle'
        | 'completion_autonomy_level'
        | 'created_at'
        | 'updated_at'
      >
    >;

    const nodeCounts = this.db
      .prepare(
        `SELECT workflow_id, COUNT(*) as count
				 FROM space_workflow_nodes
				 WHERE workflow_id IN (SELECT id FROM space_workflows WHERE space_id = ?)
				 GROUP BY workflow_id`
      )
      .all(spaceId) as Array<{ workflow_id: string; count: number }>;
    const countByWorkflowId = new Map<string, number>();
    for (const nc of nodeCounts) {
      countByWorkflowId.set(nc.workflow_id, nc.count);
    }

    return rows.map((r) => ({
      id: r.id,
      spaceId: r.space_id,
      name: r.name,
      description: r.description || undefined,
      tags: parseJson<string[]>(r.tags, []),
      templateName: r.template_name ?? undefined,
      templateHash: r.template_hash ?? null,
      disabled: !!r.disabled,
      handle: r.handle ?? undefined,
      nodeCount: countByWorkflowId.get(r.id) ?? 0,
      completionAutonomyLevel:
        (r.completion_autonomy_level as SpaceAutonomyLevel) ?? (3 as SpaceAutonomyLevel),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Emit the structured `workflow.migrated` log line when a load stripped
   * deprecated fields. Format is fixed by plan §6.1 so operators / log
   * aggregators can grep / parse it reliably:
   *
   *   `workflow.migrated: workflowId=<id> workflowName=<name> strippedFields=[<csv>]`
   *
   * The DB row is intentionally NOT rewritten — re-saving the workflow via
   * the editor is the documented way to clear persisted legacy fields.
   */
  private emitMigrationLog(row: WorkflowRow, ctx: NodeMigrationContext): void {
    if (ctx.strippedFields.size === 0) return;
    const stripped = [...ctx.strippedFields].sort().join(',');
    log.warn(
      `workflow.migrated: workflowId=${row.id} workflowName=${row.name} ` +
        `strippedFields=[${stripped}]`
    );
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null {
    const row = this.db.prepare(`SELECT * FROM space_workflows WHERE id = ?`).get(id) as
      | WorkflowRow
      | undefined;
    if (!row) return null;

    const now = Date.now();
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (params.name !== undefined) {
      fields.push('name = ?');
      values.push(params.name.trim());
    }
    if (params.description !== undefined) {
      fields.push('description = ?');
      values.push(params.description ?? '');
    }
    if (params.startNodeId !== undefined) {
      fields.push('start_node_id = ?');
      values.push(params.startNodeId ?? null);
    }
    if (params.endNodeId !== undefined) {
      fields.push('end_node_id = ?');
      values.push(params.endNodeId ?? null);
    }
    if (params.tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(params.tags ?? []));
    }

    if (params.channels !== undefined) {
      fields.push('channels = ?');
      values.push(
        params.channels && params.channels.length > 0 ? JSON.stringify(params.channels) : null
      );
    }

    if (params.gates !== undefined) {
      fields.push('gates = ?');
      values.push(params.gates && params.gates.length > 0 ? JSON.stringify(params.gates) : null);
    }

    if (params.hooks !== undefined) {
      fields.push('hooks = ?');
      values.push(params.hooks && params.hooks.length > 0 ? JSON.stringify(params.hooks) : null);
    }

    if (params.layout !== undefined) {
      fields.push('layout = ?');
      values.push(params.layout ? JSON.stringify(params.layout) : null);
    }

    if (params.templateName !== undefined) {
      fields.push('template_name = ?');
      values.push(params.templateName ?? null);
    }
    if (params.templateHash !== undefined) {
      fields.push('template_hash = ?');
      values.push(params.templateHash ?? null);
    }
    if (params.instructions !== undefined) {
      fields.push('instructions = ?');
      values.push(params.instructions ?? null);
    }
    if (params.completionAutonomyLevel !== undefined) {
      fields.push('completion_autonomy_level = ?');
      values.push(params.completionAutonomyLevel);
    }

    if (params.postApproval !== undefined) {
      fields.push('post_approval = ?');
      values.push(params.postApproval ? JSON.stringify(params.postApproval) : null);
    }
    if (params.disabled !== undefined && params.disabled !== null) {
      fields.push('disabled = ?');
      values.push(params.disabled ? 1 : 0);
    }
    if (params.handle !== undefined) {
      fields.push('handle = ?');
      values.push(params.handle ?? null);
    }

    const hasNodeReplacement = params.nodes !== undefined;

    if (fields.length > 0 || hasNodeReplacement) {
      fields.push('updated_at = ?');
      values.push(now, id);
      if (fields.length > 0) {
        this.db
          .prepare(`UPDATE space_workflows SET ${fields.join(', ')} WHERE id = ?`)
          .run(...values);
      }
    }

    if (hasNodeReplacement) {
      const nodes = params.nodes ?? [];
      this.updateWorkflowNodesInPlace(id, nodes as WorkflowNodeInput[], now);
    }

    const updated = this.getWorkflow(id)!;
    this.recordDefinitionVersion(updated, 'update');
    return updated;
  }

  /**
   * Update only persisted node-agent toolGuards for existing workflow nodes.
   *
   * This intentionally avoids replacing rows in `space_workflow_nodes`: workflow
   * IDs, node IDs, and node-agent slots are stable identifiers referenced by
   * in-flight workflow runs. Nodes are matched by stable node ID and only the
   * JSON config for that node is rewritten.
   */
  updateWorkflowNodeToolGuards(workflowId: string, nodes: WorkflowNode[]): void {
    const now = Date.now();
    const updateNode = this.db.prepare(
      `UPDATE space_workflow_nodes SET config = ?, updated_at = ? WHERE workflow_id = ? AND id = ?`
    );

    for (const node of nodes) {
      const cfg: NodeConfigJson = {
        agents: node.agents,
        ...(node.postApproval ? { postApproval: node.postApproval } : {}),
        ...(node.requireCodexApproval ? { requireCodexApproval: true } : {}),
        ...(node.codexPollIntervalMs ? { codexPollIntervalMs: node.codexPollIntervalMs } : {}),
        ...(node.codexTimeoutSeconds ? { codexTimeoutSeconds: node.codexTimeoutSeconds } : {}),
      };
      const result = updateNode.run(JSON.stringify(cfg), now, workflowId, node.id);
      if (result.changes === 0) {
        log.error(
          `workflow.nodeToolGuards.update.missingNode: workflowId=${workflowId} nodeId=${node.id}`
        );
      }
    }

    this.db.prepare(`UPDATE space_workflows SET updated_at = ? WHERE id = ?`).run(now, workflowId);

    const afterGuards = this.getWorkflow(workflowId);
    if (afterGuards) this.recordDefinitionVersion(afterGuards, 'update');
  }

  /**
   * Record an immutable version snapshot of the definition (RFC §4, Phase 1). Best-effort
   * at write time: a failure here must never break a definition write — the read cutover
   * resolves a pinned run through `getWorkflowForRun`, which falls back to the live head if
   * a version row is missing, so a missed append degrades to the pre-cutover read rather
   * than failing. Idempotent on `(workflow_id, version_hash)` — re-stamping a
   * behaviorally-identical definition is a silent no-op.
   */
  private recordDefinitionVersion(workflow: SpaceWorkflow, source: DefinitionVersionSource): void {
    try {
      const { versionHash, payload } = computeDefinitionVersion(workflow);
      this.definitionVersions.appendVersion({
        workflowId: workflow.id,
        spaceId: workflow.spaceId,
        versionHash,
        payload,
        source,
        createdAt: Date.now(),
      });
    } catch (err) {
      log.warn('Failed to record workflow definition version (non-fatal):', err);
    }
  }

  /**
   * Ensure the CURRENT head of every workflow has a recorded version snapshot.
   *
   * Captures pre-existing definition heads at rollout so that, if a workflow is later
   * edited, the version that existed at rollout is preserved (`updateWorkflow` records
   * only the post-edit version). This is the rollout-time capture the history needs for
   * the future Phase-1 read cutover (RFC §11.1).
   *
   * The predicate keys on the current head's computed hash, not on "has any version": a
   * workflow can hold an older version yet lack its current head's — if a prior
   * `updateWorkflow` committed the head but the version append was swallowed (best-effort
   * try/catch) or the daemon crashed between the head write and the append. Only the
   * current head matters for pinning a run created from it, so we repair that gap.
   *
   * Uses the live `computeDefinitionVersion` hash on the canonical domain object
   * (`getWorkflow`), so backfilled versions are byte-consistent with later writes. A
   * migration-time backfill cannot do this: migrations must stay self-contained (m94
   * principle), and a raw-row hash would diverge from the domain-object hash.
   *
   * Idempotent — a head whose version is already recorded is skipped. Cost is
   * O(workflows) per boot (acceptable for a startup hook); full atomicity — head + version
   * in one transaction, which would eliminate the partial-write window and restore a
   * cheaper predicate — is deferred to the Phase-1 read cutover alongside the broader
   * transactional model (RFC §6.1).
   */
  backfillExistingDefinitionVersions(): number {
    const rows = this.db
      .prepare(`SELECT id FROM space_workflows ORDER BY created_at ASC, rowid ASC`)
      .all() as Array<{ id: string }>;
    let count = 0;
    for (const { id } of rows) {
      // Guard each iteration: a single malformed row (e.g. node `config` JSON whose
      // `agents` isn't an array → TypeError in getWorkflow/rowToNode) must not propagate
      // through setupRPCHandlers and prevent daemon startup. This is a non-fatal shadow
      // feature; `recordDefinitionVersion` is already best-effort, but the getWorkflow /
      // computeDefinitionVersion calls above it are not, so the whole body is guarded.
      try {
        const workflow = this.getWorkflow(id);
        if (!workflow) continue;
        const { versionHash } = computeDefinitionVersion(workflow);
        if (this.definitionVersions.getVersion(id, versionHash)) continue;
        this.recordDefinitionVersion(workflow, 'backfill');
        count += 1;
      } catch (err) {
        log.warn(`backfillDefinitionVersion: skipped workflow ${id} (non-fatal):`, err);
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  deleteWorkflow(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM space_workflows WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Handle lookup
  // -------------------------------------------------------------------------

  /**
   * Get a workflow by its handle within a specific space.
   */
  getWorkflowByHandle(spaceId: string, handle: string): SpaceWorkflow | null {
    const row = this.db
      .prepare(`SELECT * FROM space_workflows WHERE space_id = ? AND handle = ?`)
      .get(spaceId, handle) as WorkflowRow | undefined;
    if (!row) return null;
    const ctx: NodeMigrationContext = { strippedFields: new Set<string>() };
    const nodes = this.fetchNodes(row.id, ctx);
    this.emitMigrationLog(row, ctx);
    return rowToWorkflow(row, nodes);
  }

  /**
   * Get all handles currently in use for a space (for collision detection).
   */
  getHandlesForSpace(spaceId: string): string[] {
    const rows = this.db
      .prepare(`SELECT handle FROM space_workflows WHERE space_id = ? AND handle IS NOT NULL`)
      .all(spaceId) as Array<{ handle: string }>;
    return rows.map((r) => r.handle);
  }

  // -------------------------------------------------------------------------
  // Agent reference queries
  // -------------------------------------------------------------------------

  /**
   * Find all workflows in a space whose nodes reference the given worker agent ID.
   * Used by SpaceAgentManager to prevent deletion of agents that are still in use.
   *
   * Checks the `config` JSON column for multi-agent nodes (agents[] format).
   */
  getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[] {
    const nodeRows = this.db
      .prepare(
        `SELECT DISTINCT workflow_id FROM space_workflow_nodes
	         WHERE config LIKE '%' || ? || '%'`
      )
      .all(agentId) as Array<{ workflow_id: string }>;

    const workflows: SpaceWorkflow[] = [];
    for (const { workflow_id } of nodeRows) {
      const wf = this.getWorkflow(workflow_id);
      if (wf) workflows.push(wf);
    }
    return workflows;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private fetchNodes(workflowId: string, ctx?: NodeMigrationContext): WorkflowNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`)
      .all(workflowId) as NodeRow[];
    return rows.map((r) => rowToNode(r, ctx));
  }

  private updateWorkflowNodesInPlace(
    workflowId: string,
    nodes: WorkflowNodeInput[],
    now: number
  ): void {
    const existingRows = this.db
      .prepare(`SELECT id FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`)
      .all(workflowId) as Array<{ id: string }>;
    const existingNodeIds = new Set(existingRows.map((row) => row.id));
    const incomingNodeIds = new Set(
      nodes.map((node) => node.id).filter((id): id is string => !!id)
    );
    const updateNode = this.db.prepare(
      `UPDATE space_workflow_nodes SET name = ?, config = ?, updated_at = ? WHERE workflow_id = ? AND id = ?`
    );
    const insertNodeRow = this.db.prepare(
      `INSERT INTO space_workflow_nodes
				(id, workflow_id, name, description, config, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const rowOrderByNodeId = new Map<string, number>();

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node.id) {
        log.error(`workflow.node.update.missingStableId: workflowId=${workflowId}`);
        continue;
      }
      rowOrderByNodeId.set(node.id, i + 1);
      const configJson = JSON.stringify(this.buildNodeConfig(node));
      if (existingNodeIds.has(node.id)) {
        const result = updateNode.run(node.name, configJson, now, workflowId, node.id);
        if (result.changes === 0) {
          log.error(`workflow.node.update.missingNode: workflowId=${workflowId} nodeId=${node.id}`);
        }
      } else {
        insertNodeRow.run(node.id, workflowId, node.name, '', configJson, now, now);
      }
    }

    for (const nodeId of existingNodeIds) {
      if (!incomingNodeIds.has(nodeId)) {
        this.db
          .prepare(`DELETE FROM space_workflow_nodes WHERE workflow_id = ? AND id = ?`)
          .run(workflowId, nodeId);
      }
    }

    this.reorderWorkflowNodeRows(workflowId, rowOrderByNodeId);
  }

  private reorderWorkflowNodeRows(workflowId: string, rowOrderByNodeId: Map<string, number>): void {
    if (rowOrderByNodeId.size === 0) return;

    const existingRows = this.db
      .prepare(`SELECT id FROM space_workflow_nodes WHERE workflow_id = ? ORDER BY rowid ASC`)
      .all(workflowId) as Array<{ id: string }>;
    const sortedIds = [...existingRows]
      .sort((a, b) => {
        const aOrder = rowOrderByNodeId.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = rowOrderByNodeId.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder;
      })
      .map((row) => row.id);
    if (sortedIds.every((id, index) => id === existingRows[index]?.id)) return;

    const rowsById = new Map<string, NodeRow>();
    for (const row of this.db
      .prepare(`SELECT * FROM space_workflow_nodes WHERE workflow_id = ?`)
      .all(workflowId) as NodeRow[]) {
      rowsById.set(row.id, row);
    }

    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM space_workflow_nodes WHERE workflow_id = ?`).run(workflowId);
      const insertNodeRow = this.db.prepare(
        `INSERT INTO space_workflow_nodes
					(id, workflow_id, name, description, config, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const nodeId of sortedIds) {
        const row = rowsById.get(nodeId);
        if (!row) continue;
        insertNodeRow.run(
          row.id,
          row.workflow_id,
          row.name,
          row.description,
          row.config,
          row.created_at,
          row.updated_at
        );
      }
    })();
  }

  private buildNodeConfig(input: WorkflowNodeInput): NodeConfigJson {
    const nodeCfg: NodeConfigJson = {};

    // Normalize agents: use `agents` array if present, otherwise fall back to legacy
    // `agentId` shorthand (still used in tests and older call-sites).
    const legacyAgentId = (input as unknown as Record<string, unknown>)['agentId'] as
      | string
      | undefined;
    let resolvedAgents = input.agents && input.agents.length > 0 ? input.agents : undefined;
    if (!resolvedAgents && legacyAgentId) {
      resolvedAgents = [{ agentId: legacyAgentId, name: input.name }];
    }
    if (resolvedAgents && resolvedAgents.length > 0) {
      nodeCfg.agents = resolvedAgents;
    }
    if (input.postApproval) {
      nodeCfg.postApproval = input.postApproval;
    }
    if (input.requireCodexApproval) {
      nodeCfg.requireCodexApproval = true;
    }
    if (input.codexPollIntervalMs) {
      nodeCfg.codexPollIntervalMs = input.codexPollIntervalMs;
    }
    if (input.codexTimeoutSeconds) {
      nodeCfg.codexTimeoutSeconds = input.codexTimeoutSeconds;
    }

    return nodeCfg;
  }

  private insertNode(
    workflowId: string,
    input: WorkflowNodeInput,
    nodeId: string,
    _index: number,
    now: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO space_workflow_nodes
		           (id, workflow_id, name, description, config, created_at, updated_at)
		         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nodeId,
        workflowId,
        input.name,
        '',
        JSON.stringify(this.buildNodeConfig(input)),
        now,
        now
      );
  }
}
