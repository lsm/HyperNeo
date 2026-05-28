/**
 * Space Workflow RPC Handlers
 *
 * RPC handlers for SpaceWorkflow CRUD operations:
 * - spaceWorkflow.create    - Create a workflow in a Space
 * - spaceWorkflow.list      - List workflows in a Space
 * - spaceWorkflow.get       - Get a workflow by ID (optional spaceId: existence + ownership check)
 * - spaceWorkflow.update    - Update workflow fields (optional spaceId: existence + ownership check)
 * - spaceWorkflow.delete    - Delete a workflow (optional spaceId: existence + ownership check)
 *
 * No spaceWorkflow.setDefault — default selection is removed from the design.
 * Workflow selection uses only explicit workflowId or AI auto-select.
 *
 * Events emitted (spaceWorkflow.* namespace — matches SpaceStore subscriptions in M5):
 * - spaceWorkflow.created
 * - spaceWorkflow.updated
 * - spaceWorkflow.deleted
 */

import type { MessageHub } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type {
  CreateSpaceWorkflowParams,
  UpdateSpaceWorkflowParams,
  DuplicateDriftReport,
  SpaceWorkflow,
} from '@neokai/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import { getBuiltInWorkflows, seedBuiltInWorkflows } from '../space/workflows/built-in-workflows';
import { computeWorkflowHash } from '../space/workflows/template-hash';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import { Logger } from '../logger';

const log = new Logger('space-workflow-handlers');

/**
 * Resolve a template (built-in workflow) against a space's agents and produce
 * the `UpdateSpaceWorkflowParams` that overwrites an existing row with the
 * template's canonical content.
 *
 * Shared by `spaceWorkflow.syncFromTemplate` and `spaceWorkflow.resyncDuplicates`.
 *
 * Throws synchronously if any node references an agent name that doesn't exist
 * in the target space — callers rely on this to validate BEFORE performing any
 * destructive work (e.g. deleting duplicate rows).
 *
 * @param errorVerb   Appears in thrown error messages (e.g. "sync", "resync")
 *                    so users see "Cannot sync: …" vs. "Cannot resync: …".
 */
function buildTemplateUpdateParams(
  spaceAgentManager: SpaceAgentManager,
  spaceId: string,
  template: SpaceWorkflow,
  errorVerb: 'sync' | 'resync',
  existingWorkflow?: SpaceWorkflow
): UpdateSpaceWorkflowParams {
  const spaceAgents = spaceAgentManager.listBySpaceId(spaceId);
  function resolveAgentId(roleName: string): string | undefined {
    return spaceAgents.find((a) => a.name.toLowerCase() === roleName.toLowerCase())?.id;
  }

  const existingNodeIdQueuesByName = new Map<string, string[]>();
  for (const existingNode of existingWorkflow?.nodes ?? []) {
    const queue = existingNodeIdQueuesByName.get(existingNode.name) ?? [];
    queue.push(existingNode.id);
    existingNodeIdQueuesByName.set(existingNode.name, queue);
  }
  const exactExistingIdsByTemplateIndex = new Map<number, string>();
  for (let i = 0; i < template.nodes.length; i++) {
    const nameQueue = existingNodeIdQueuesByName.get(template.nodes[i].name);
    const existingIdByName = nameQueue?.shift();
    if (existingIdByName) exactExistingIdsByTemplateIndex.set(i, existingIdByName);
  }

  const existingNodeIdsInOrder = existingWorkflow?.nodes.map((node) => node.id) ?? [];
  const reservedExactExistingIds = new Set(exactExistingIdsByTemplateIndex.values());
  const usedExistingNodeIds = new Set<string>();
  const nodeIdMap = new Map<string, string>();
  for (let i = 0; i < template.nodes.length; i++) {
    const node = template.nodes[i];
    const existingIdByName = exactExistingIdsByTemplateIndex.get(i);
    const existingIdByPosition = existingNodeIdsInOrder[i];
    const existingId =
      existingIdByName && !usedExistingNodeIds.has(existingIdByName)
        ? existingIdByName
        : existingIdByPosition &&
            !usedExistingNodeIds.has(existingIdByPosition) &&
            !reservedExactExistingIds.has(existingIdByPosition)
          ? existingIdByPosition
          : undefined;
    if (existingId) usedExistingNodeIds.add(existingId);
    nodeIdMap.set(node.id, existingId ?? generateUUID());
  }

  const newNodes = template.nodes.map((node) => {
    const resolvedAgents = node.agents.map((a) => {
      const resolvedId = resolveAgentId(a.agentId);
      if (!resolvedId) {
        throw new Error(
          `Cannot ${errorVerb}: no SpaceAgent found with name "${a.agentId}" in space "${spaceId}".`
        );
      }
      return { ...a, agentId: resolvedId };
    });
    return {
      id: nodeIdMap.get(node.id)!,
      name: node.name,
      agents: resolvedAgents,
      ...(node.postApproval ? { postApproval: { ...node.postApproval } } : {}),
    };
  });

  const newStartNodeId = nodeIdMap.get(template.startNodeId);
  if (!newStartNodeId) {
    throw new Error(`Template "${template.name}" has invalid startNodeId.`);
  }
  const newEndNodeId = template.endNodeId ? nodeIdMap.get(template.endNodeId) : undefined;
  const newChannels = template.channels
    ? template.channels.map((ch) => ({ ...ch, id: ch.id ?? generateUUID() }))
    : null;
  const newGates = template.gates ? [...template.gates] : null;
  const templateHash = computeWorkflowHash(template);

  return {
    name: template.name,
    description: template.description ?? null,
    instructions: template.instructions ?? null,
    nodes: newNodes,
    startNodeId: newStartNodeId,
    endNodeId: newEndNodeId ?? null,
    channels: newChannels,
    gates: newGates,
    tags: [...template.tags],
    completionAutonomyLevel: template.completionAutonomyLevel,
    templateName: template.name,
    templateHash,
    postApproval: null,
  };
}

/**
 * Proactive drift check run once at daemon startup.
 *
 * Scans every space for workflows that were seeded from a built-in template but
 * have since drifted (i.e. the stored `templateHash` no longer matches the
 * current template's hash). Detected drifts are logged as warnings so operators
 * and developers see them in the daemon log even when no user has opened the
 * Workflow List UI.
 *
 * This function is intentionally non-blocking: failures (e.g. DB errors) are
 * caught and logged rather than propagated, so startup is never blocked by drift
 * detection.
 */
export async function checkBuiltInWorkflowDriftOnStartup(
  workflowManager: SpaceWorkflowManager,
  spaceManager: SpaceManager
): Promise<void> {
  try {
    const spaces = await spaceManager.listSpaces();
    if (spaces.length === 0) return;

    const templates = getBuiltInWorkflows();
    const templateMap = new Map(templates.map((t) => [t.name, t]));

    const driftedWorkflows: Array<{
      spaceName: string;
      workflowName: string;
      templateName: string;
    }> = [];

    for (const space of spaces) {
      const workflows = workflowManager.listWorkflows(space.id);
      for (const workflow of workflows) {
        if (!workflow.templateName) continue;
        const template = templateMap.get(workflow.templateName);
        if (!template) continue;

        const currentTemplateHash = computeWorkflowHash(template);
        const storedHash = workflow.templateHash ?? null;

        if (currentTemplateHash !== storedHash) {
          driftedWorkflows.push({
            spaceName: space.name,
            workflowName: workflow.name,
            templateName: workflow.templateName,
          });
        }
      }
    }

    if (driftedWorkflows.length === 0) return;

    log.warn(
      `[startup] ${driftedWorkflows.length} workflow(s) have drifted from their built-in templates. ` +
        `Open the Workflow List in the UI and click "Sync" to update them.`
    );
    for (const { spaceName, workflowName, templateName } of driftedWorkflows) {
      log.warn(
        `  • Space "${spaceName}" / Workflow "${workflowName}" (template: "${templateName}") is outdated`
      );
    }
  } catch (err) {
    // Non-fatal: drift detection errors must never break daemon startup.
    log.warn('[startup] Workflow drift check failed (non-fatal):', err);
  }
}

/**
 * Startup re-stamp pass for the narrow set of template fields that are safe
 * to auto-apply without regenerating node UUIDs.
 *
 * Existing spaces auto-acquire current built-in node-level `postApproval`
 * routes through this path. Delegates to
 * `seedBuiltInWorkflows`, which takes the re-stamp branch when rows already
 * exist in a space. That path only updates node-level routing metadata,
 * `completionAutonomyLevel`, and `templateHash` — see the seeder's
 * `RESTAMP_FIELDS` constant for the full list and rationale.
 *
 * Full structural re-sync (nodes/channels/gates/prompts) still requires the
 * user to click "Sync" in the Workflow List UI, because that path regenerates
 * node UUIDs and would invalidate any live workflow-run references.
 *
 * Non-blocking: any per-space failure is logged and the loop continues so
 * one broken space cannot block the daemon from starting.
 */
export async function restampBuiltInWorkflowsOnStartup(
  workflowManager: SpaceWorkflowManager,
  spaceManager: SpaceManager,
  spaceAgentManager: SpaceAgentManager
): Promise<void> {
  try {
    const spaces = await spaceManager.listSpaces();
    if (spaces.length === 0) return;

    let totalRestamped = 0;
    for (const space of spaces) {
      try {
        const agents = spaceAgentManager.listBySpaceId(space.id);
        const result = seedBuiltInWorkflows(
          space.id,
          workflowManager,
          (name) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase())?.id
        );
        if (result.restamped.length > 0) {
          totalRestamped += result.restamped.length;
          log.info(
            `[startup] Re-stamped ${result.restamped.length} built-in workflow(s) ` +
              `in space "${space.name}" (${space.id}): ${result.restamped.join(', ')}`
          );
        }
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            log.warn(
              `[startup] Failed to re-stamp built-in workflow "${err.name}" ` +
                `in space "${space.name}" (${space.id}): ${err.error}`
            );
          }
        }
      } catch (err) {
        log.warn(
          `[startup] Re-stamp pass failed for space "${space.name}" (${space.id}) (non-fatal):`,
          err
        );
      }
    }

    if (totalRestamped > 0) {
      log.info(
        `[startup] Re-stamped ${totalRestamped} built-in workflow row(s) across ${spaces.length} space(s)`
      );
    }
  } catch (err) {
    // Non-fatal: re-stamp errors must never block daemon startup.
    log.warn('[startup] Built-in workflow re-stamp pass failed (non-fatal):', err);
  }
}

export function setupSpaceWorkflowHandlers(
  messageHub: MessageHub,
  spaceManager: SpaceManager,
  workflowManager: SpaceWorkflowManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  spaceAgentManager: SpaceAgentManager,
  workflowRunRepo: SpaceWorkflowRunRepository
): void {
  // ─── spaceWorkflow.create ────────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflow.create', async (data) => {
    const params = data as CreateSpaceWorkflowParams;

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.name || params.name.trim() === '') {
      throw new Error('name is required');
    }

    // Verify space exists
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const workflow = workflowManager.createWorkflow(params);

    // namespaceId: 'global', sessionId: 'global' — spaceWorkflow.* events are global broadcast events,
    // not channel-scoped. The SpaceStore (M5) will subscribe globally and filter by spaceId.
    internalEventBus
      .publish('spaceWorkflow.created', {
        sessionId: 'global',
        spaceId: params.spaceId,
        workflow,
      })
      .catch((err) => {
        log.warn('Failed to emit spaceWorkflow.created:', err);
      });

    return { workflow };
  });

  // ─── spaceWorkflow.list ──────────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflow.list', async (data) => {
    const params = data as { spaceId: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    // Verify space exists
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const workflows = workflowManager.listWorkflowSummaries(params.spaceId);
    return { workflows };
  });

  // ─── spaceWorkflow.listBuiltInTemplates ──────────────────────────────────
  messageHub.onRequest('spaceWorkflow.listBuiltInTemplates', async (data) => {
    const params = data as { spaceId: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    // Keep validation aligned with other spaceWorkflow.* handlers.
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    // Built-in templates are a small fixed set (5 workflows). Return full
    // workflows so the visual editor template picker can use nodes/channels/gates
    // without an extra round-trip per template.
    const workflows: SpaceWorkflow[] = getBuiltInWorkflows();
    return { workflows };
  });

  // ─── spaceWorkflow.get ───────────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflow.get', async (data) => {
    const params = data as { id?: string; handle?: string; spaceId?: string };

    if (!params.id && !params.handle) {
      throw new Error('id or handle is required');
    }

    // When spaceId is provided: verify the space exists before fetching the workflow.
    // This matches the space-task-handlers.ts pattern and surfaces "Space not found"
    // correctly instead of silently returning an orphaned workflow.
    if (params.spaceId) {
      const space = await spaceManager.getSpace(params.spaceId);
      if (!space) {
        throw new Error(`Space not found: ${params.spaceId}`);
      }
    }

    let workflow: SpaceWorkflow | null = null;
    if (params.id) {
      workflow = workflowManager.getWorkflow(params.id);
      // Fall back to handle when the ID is unusable: either it returned null, or
      // it resolved to a workflow in a different space (stale/cross-space ref).
      // Clients that cache both fields still resolve correctly when UUIDs change.
      const idUnusable = !workflow || (!!params.spaceId && workflow.spaceId !== params.spaceId);
      if (idUnusable && typeof params.handle === 'string' && params.spaceId) {
        const trimmedHandle = params.handle.trim();
        if (trimmedHandle) {
          workflow = workflowManager.getWorkflowByHandle(params.spaceId, trimmedHandle);
        }
      }
    } else if (typeof params.handle === 'string') {
      if (!params.spaceId) {
        throw new Error('spaceId is required when looking up by handle');
      }
      workflow = workflowManager.getWorkflowByHandle(params.spaceId, params.handle);
    } else if (params.handle !== undefined) {
      throw new Error('handle must be a string');
    }

    if (!workflow) {
      throw new Error(`Workflow not found: ${params.id ?? params.handle}`);
    }

    // Ownership check — reject if caller's spaceId doesn't match the workflow's owner
    if (params.spaceId && workflow.spaceId !== params.spaceId) {
      throw new Error(`Workflow not found: ${params.id ?? params.handle}`);
    }

    return { workflow };
  });

  // ─── spaceWorkflow.update ────────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflow.update', async (data) => {
    const params = data as { id: string; spaceId?: string } & UpdateSpaceWorkflowParams;

    if (!params.id) {
      throw new Error('id is required');
    }

    // When spaceId is provided: verify space exists and ownership before mutating.
    // The ownership check requires fetching the workflow here; updateWorkflow will
    // re-fetch internally (synchronous SQLite — acceptable for this pattern).
    if (params.spaceId) {
      const space = await spaceManager.getSpace(params.spaceId);
      if (!space) {
        throw new Error(`Space not found: ${params.spaceId}`);
      }
      const existing = workflowManager.getWorkflow(params.id);
      if (!existing) {
        throw new Error(`Workflow not found: ${params.id}`);
      }
      if (existing.spaceId !== params.spaceId) {
        throw new Error(`Workflow not found: ${params.id}`);
      }
    }

    const { id, spaceId: _spaceId, ...updateParams } = params;

    const workflow = workflowManager.updateWorkflow(id, updateParams);
    if (!workflow) {
      throw new Error(`Workflow not found: ${id}`);
    }

    internalEventBus
      .publish('spaceWorkflow.updated', {
        sessionId: 'global',
        spaceId: workflow.spaceId,
        workflow,
      })
      .catch((err) => {
        log.warn('Failed to emit spaceWorkflow.updated:', err);
      });

    return { workflow };
  });

  // ─── spaceWorkflow.delete ────────────────────────────────────────────────
  messageHub.onRequest('spaceWorkflow.delete', async (data) => {
    const params = data as { id: string; spaceId?: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    // When spaceId is provided: verify space exists before fetching the workflow.
    if (params.spaceId) {
      const space = await spaceManager.getSpace(params.spaceId);
      if (!space) {
        throw new Error(`Space not found: ${params.spaceId}`);
      }
    }

    // Fetch before deleting — needed for the event payload and optional ownership check
    const workflow = workflowManager.getWorkflow(params.id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

    // Ownership check
    if (params.spaceId && workflow.spaceId !== params.spaceId) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

    const deleted = workflowManager.deleteWorkflow(params.id);
    if (!deleted) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

    // Await so subscribers (e.g. SpaceStore in M5) see the deletion before the handler returns,
    // consistent with how spaceAgent.delete emits spaceAgent.deleted.
    await internalEventBus
      .publish('spaceWorkflow.deleted', {
        sessionId: 'global',
        spaceId: workflow.spaceId,
        workflowId: params.id,
      })
      .catch((err) => {
        log.warn('Failed to emit spaceWorkflow.deleted:', err);
      });

    return { success: true };
  });

  // ─── spaceWorkflow.detectDrift ───────────────────────────────────────────
  messageHub.onRequest('spaceWorkflow.detectDrift', async (data) => {
    const params = data as { id: string; spaceId?: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    const workflow = workflowManager.getWorkflow(params.id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

    if (params.spaceId && workflow.spaceId !== params.spaceId) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

    // If no template tracking, no drift possible
    if (!workflow.templateName) {
      return {
        drifted: false,
        templateName: null,
        currentTemplateHash: null,
        workflowContentHash: null,
        storedHash: workflow.templateHash ?? null,
      };
    }

    // Find the current template by name
    const templates = getBuiltInWorkflows();
    const template = templates.find((t) => t.name === workflow.templateName);
    if (!template) {
      // Template no longer exists — can't detect drift
      return {
        drifted: false,
        templateName: workflow.templateName,
        currentTemplateHash: null,
        workflowContentHash: null,
        storedHash: workflow.templateHash ?? null,
      };
    }

    // Compute current template's hash
    const currentTemplateHash = computeWorkflowHash(template);
    const workflowContentHash = computeWorkflowHash(workflow);

    // Drift if either:
    // 1. The stored template_hash differs from the current template hash (template was updated)
    // 2. The workflow content hash differs from the stored template_hash (user edited workflow)
    const storedHash = workflow.templateHash ?? null;
    const drifted = currentTemplateHash !== storedHash || workflowContentHash !== storedHash;

    return {
      drifted,
      templateName: workflow.templateName,
      currentTemplateHash,
      workflowContentHash,
      storedHash,
    };
  });

  // ─── spaceWorkflow.syncFromTemplate ─────────────────────────────────────
  messageHub.onRequest('spaceWorkflow.syncFromTemplate', async (data) => {
    const params = data as { id: string; spaceId: string };

    if (!params.id) {
      throw new Error('id is required');
    }
    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    // Verify space exists
    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const workflow = workflowManager.getWorkflow(params.id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${params.id}`);
    }
    if (workflow.spaceId !== params.spaceId) {
      throw new Error(`Workflow not found: ${params.id}`);
    }
    if (!workflow.templateName) {
      throw new Error(
        `Workflow "${workflow.name}" is not linked to a built-in template and cannot be synced.`
      );
    }

    // Find the template
    const templates = getBuiltInWorkflows();
    const template = templates.find((t) => t.name === workflow.templateName);
    if (!template) {
      throw new Error(
        `Built-in template "${workflow.templateName}" not found. It may have been removed.`
      );
    }

    // Build the overwrite params. Throws synchronously if any node references
    // an agent name that doesn't exist in this space — nothing is mutated
    // in that case.
    const updateParams = buildTemplateUpdateParams(
      spaceAgentManager,
      params.spaceId,
      template,
      'sync',
      workflow
    );

    // Preserve the existing workflow's templateName rather than adopting the
    // template's name — they should match already, but this guards against
    // manual edits to the stored templateName.
    updateParams.templateName = workflow.templateName;

    // Overwrite the workflow
    const updated = workflowManager.updateWorkflow(params.id, updateParams);

    if (!updated) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

    internalEventBus
      .publish('spaceWorkflow.updated', {
        sessionId: 'global',
        spaceId: params.spaceId,
        workflow: updated,
      })
      .catch((err) => {
        log.warn('Failed to emit spaceWorkflow.updated:', err);
      });

    return { workflow: updated };
  });

  // ─── spaceWorkflow.detectDuplicateDrift ──────────────────────────────────
  // Returns groups of workflows within a space that share a `templateName`
  // but have diverging `templateHash` values — i.e. template drift between
  // multiple rows for the same built-in template.
  //
  // This is distinct from `spaceWorkflow.detectDrift` which reports per-row
  // drift against the canonical built-in template. `detectDuplicateDrift`
  // surfaces the case where two or more rows exist and their stored hashes
  // disagree, which is the signal for "this space has a stale duplicate
  // that should be cleaned up".
  messageHub.onRequest('spaceWorkflow.detectDuplicateDrift', async (data) => {
    const params = data as { spaceId: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    // Only built-in templates are eligible for drift reporting — drift on
    // a user-named template has no canonical source to resync against.
    const builtInNames = new Set(getBuiltInWorkflows().map((w) => w.name));

    const workflows = workflowManager.listWorkflowSummaries(params.spaceId);

    // Group workflows by templateName.
    const byTemplate = new Map<string, typeof workflows>();
    for (const wf of workflows) {
      if (!wf.templateName) continue;
      if (!builtInNames.has(wf.templateName)) continue;
      const bucket = byTemplate.get(wf.templateName);
      if (bucket) bucket.push(wf);
      else byTemplate.set(wf.templateName, [wf]);
    }

    const reports: DuplicateDriftReport[] = [];
    for (const [templateName, rows] of byTemplate) {
      if (rows.length < 2) continue;
      // Drift = hash values diverge across rows. Rows with identical hashes
      // aren't considered drift (even though they're still technically
      // duplicates — left for separate cleanup).
      const distinctHashes = new Set(rows.map((r) => r.templateHash ?? null));
      if (distinctHashes.size < 2) continue;
      const sortedRows = [...rows].sort((a, b) => b.createdAt - a.createdAt);
      reports.push({
        templateName,
        rows: sortedRows.map((r) => ({
          id: r.id,
          templateHash: r.templateHash ?? null,
          createdAt: r.createdAt,
        })),
      });
    }

    return { reports };
  });

  // ─── spaceWorkflow.resyncDuplicates ──────────────────────────────────────
  // Resolves a duplicate-drift group by:
  //   1. Building the template overwrite params (validates that every agent
  //      role in the template resolves to a SpaceAgent in this space — throws
  //      BEFORE any row is mutated if validation fails).
  //   2. Overwriting the kept row (newest by createdAt) with the canonical
  //      built-in template, matching `spaceWorkflow.syncFromTemplate`.
  //   3. Only after (2) succeeds: deleting every older row in the group and
  //      their workflow runs. Runs are deleted explicitly because migration
  //      60 rebuilt `space_workflow_runs` without an ON DELETE CASCADE on
  //      `workflow_id`, so dropping a workflow alone would leave orphans.
  //
  // This ordering is deliberate — if agent resolution fails on step 1 the
  // duplicates must remain on disk so the user can retry after fixing agents.
  messageHub.onRequest('spaceWorkflow.resyncDuplicates', async (data) => {
    const params = data as { spaceId: string; templateName: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.templateName) {
      throw new Error('templateName is required');
    }

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    // Only built-in templates can be resynced — other templateNames have
    // no canonical source to pull from.
    const builtInTemplates = getBuiltInWorkflows();
    const template = builtInTemplates.find((t) => t.name === params.templateName);
    if (!template) {
      throw new Error(
        `Built-in template "${params.templateName}" not found. Resync is only available for built-in workflows.`
      );
    }

    // Find all workflows in the space with this templateName.
    const all = workflowManager.listWorkflows(params.spaceId);
    const group = all.filter((w) => w.templateName === params.templateName);
    if (group.length === 0) {
      throw new Error(
        `No workflows found for templateName "${params.templateName}" in space "${params.spaceId}".`
      );
    }

    // Sort newest-first. Keep the first, the rest are candidates for deletion.
    group.sort((a, b) => b.createdAt - a.createdAt);
    const kept = group[0];
    const toDelete = group.slice(1);

    // Build the overwrite params BEFORE any destructive work. If this throws
    // (e.g. an agent role is missing), no rows have been touched and the
    // user can retry after fixing their space agents.
    const updateParams = buildTemplateUpdateParams(
      spaceAgentManager,
      params.spaceId,
      template,
      'resync',
      kept
    );

    // Overwrite the kept row first. If the update fails the duplicates stay
    // on disk.
    const updated = workflowManager.updateWorkflow(kept.id, updateParams);
    if (!updated) {
      throw new Error(`Workflow not found: ${kept.id}`);
    }

    // Only now — after the kept row is safely resynced — remove the duplicates.
    // Runs are deleted explicitly because the space_workflow_runs FK is not
    // ON DELETE CASCADE (migration 60 dropped it). Without this the rows
    // would orphan and show up in no UI but still consume disk.
    const deletedIds: string[] = [];
    for (const wf of toDelete) {
      workflowRunRepo.deleteByWorkflowId(wf.id);
      const ok = workflowManager.deleteWorkflow(wf.id);
      if (ok) {
        deletedIds.push(wf.id);
        await internalEventBus
          .publish('spaceWorkflow.deleted', {
            sessionId: 'global',
            spaceId: params.spaceId,
            workflowId: wf.id,
          })
          .catch((err) => {
            log.warn('Failed to emit spaceWorkflow.deleted:', err);
          });
      }
    }

    internalEventBus
      .publish('spaceWorkflow.updated', {
        sessionId: 'global',
        spaceId: params.spaceId,
        workflow: updated,
      })
      .catch((err) => {
        log.warn('Failed to emit spaceWorkflow.updated:', err);
      });

    return { workflow: updated, keptWorkflowId: kept.id, deletedIds };
  });
}
