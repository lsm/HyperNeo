import type { MessageHub } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type {
  CreateSpaceWorkflowParams,
  UpdateSpaceWorkflowParams,
  DuplicateDriftReport,
  SpaceWorkflow,
  SpaceWorkflowSyncDiff,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import {
  getBuiltInWorkflows,
  resolveBuiltInWorkflowTemplate,
  seedBuiltInWorkflows,
} from '../space/workflows/built-in-workflows';
import { computeWorkflowHash } from '../space/workflows/template-hash';
import { getPresetAgentTemplates, retireRemovedPresetAgents } from '../space/agents/seed-agents';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import { Logger } from '../logger';

const log = new Logger('space-workflow-handlers');

const DRIFT_SUMMARY_MAX_CHARS = 900;

function formatDriftEntry(spaceName: string, workflowName: string, customized: boolean): string {
  const suffix = customized ? ' (customized)' : '';
  if (spaceName.length + workflowName.length + suffix.length + 1 <= DRIFT_SUMMARY_MAX_CHARS) {
    return `${spaceName}/${workflowName}${suffix}`;
  }
  const half = Math.floor((DRIFT_SUMMARY_MAX_CHARS - suffix.length - 1) / 2);
  return `${squeezeDriftName(spaceName, half)}/${squeezeDriftName(workflowName, half)}${suffix}`;
}

function squeezeDriftName(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 6) return value.slice(0, max);
  return `${value.slice(0, max - 6)}...${value.slice(-3)}`;
}

const PRESET_AGENT_NAMES_LOWER = new Set(
  getPresetAgentTemplates().map((p) => p.name.toLowerCase())
);

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
        if (PRESET_AGENT_NAMES_LOWER.has(a.agentId.toLowerCase())) {
          throw new Error(
            `Cannot ${errorVerb}: preset agent "${a.agentId}" is missing from space "${spaceId}" ` +
              `(this Space was likely created before the "${a.agentId}" preset was added). ` +
              `Run the backfill migration or re-trigger preset seeding to restore it.`
          );
        }
        throw new Error(
          `Cannot ${errorVerb}: no SpaceWorkerAgent found with name "${a.agentId}" in space "${spaceId}".`
        );
      }
      return { ...a, agentId: resolvedId };
    });
    return {
      id: nodeIdMap.get(node.id)!,
      name: node.name,
      agents: resolvedAgents,
      ...(node.postApproval ? { postApproval: { ...node.postApproval } } : {}),
      ...(node.transitions?.length ? { transitions: node.transitions.map((t) => ({ ...t })) } : {}),
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
  const templateHash = computeWorkflowHash(template);

  return {
    name: template.name,
    description: template.description ?? null,
    instructions: template.instructions ?? null,
    nodes: newNodes,
    startNodeId: newStartNodeId,
    endNodeId: newEndNodeId ?? null,
    channels: newChannels,
    hooks: template.hooks ? [...template.hooks] : null,
    tags: [...template.tags],
    completionAutonomyLevel: template.completionAutonomyLevel,
    templateName: template.name,
    templateHash,
    postApproval: null,
  };
}

function buildWorkflowSyncDiff(
  workflow: SpaceWorkflow,
  template: SpaceWorkflow
): SpaceWorkflowSyncDiff {
  const diff: SpaceWorkflowSyncDiff = {};

  if ((workflow.description ?? '') !== (template.description ?? '')) {
    diff.description = { before: workflow.description ?? '', after: template.description ?? '' };
  }
  if ((workflow.instructions ?? '') !== (template.instructions ?? '')) {
    diff.instructions = {
      before: workflow.instructions ?? '',
      after: template.instructions ?? '',
    };
  }

  const beforeNodes = workflow.nodes.map((n) => n.name);
  const afterNodes = template.nodes.map((n) => n.name);
  if (!nameSetsEqual(beforeNodes, afterNodes)) {
    const beforeSet = new Set(beforeNodes);
    const afterSet = new Set(afterNodes);
    diff.nodes = {
      before: beforeNodes,
      after: afterNodes,
      added: afterNodes.filter((n) => !beforeSet.has(n)),
      removed: beforeNodes.filter((n) => !afterSet.has(n)),
    };
  }

  return diff;
}

function nameSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const name of b) {
    if (!setA.has(name)) return false;
  }
  return true;
}

export async function checkBuiltInWorkflowDriftOnStartup(
  workflowManager: SpaceWorkflowManager,
  spaceManager: SpaceManager
): Promise<void> {
  try {
    const spaces = await spaceManager.listSpaces();
    if (spaces.length === 0) return;

    const updatesAvailable: Array<{
      spaceName: string;
      workflowName: string;
      templateName: string;
      customized: boolean;
    }> = [];
    let customizedOnlyCount = 0;

    for (const space of spaces) {
      const workflows = workflowManager.listWorkflows(space.id);
      for (const workflow of workflows) {
        if (!workflow.templateName) continue;
        const template = resolveBuiltInWorkflowTemplate(workflow.templateName);
        if (!template) continue;

        const currentTemplateHash = computeWorkflowHash(template);
        const storedHash = workflow.templateHash ?? null;
        const rowHash = computeWorkflowHash(workflow);

        const updateAvailable = currentTemplateHash !== storedHash;
        const customized = rowHash !== storedHash;

        if (updateAvailable) {
          updatesAvailable.push({
            spaceName: space.name,
            workflowName: workflow.name,
            templateName: workflow.templateName,
            customized,
          });
        } else if (customized) {
          customizedOnlyCount += 1;
        }
      }
    }

    if (updatesAvailable.length === 0 && customizedOnlyCount === 0) return;

    if (updatesAvailable.length > 0) {
      const entries = updatesAvailable.map(({ spaceName, workflowName, customized }) =>
        formatDriftEntry(spaceName, workflowName, customized)
      );
      const header =
        `[startup] ${updatesAvailable.length} workflow(s) have a template update available ` +
        `(open the Workflow List in the UI and click "Sync" to apply)`;
      const single = `${header}: ${entries.join(', ')}`;
      if (single.length <= DRIFT_SUMMARY_MAX_CHARS) {
        log.warn(single);
      } else {
        log.warn(`${header}. Affected workflows (chunked to fit the log line cap):`);
        const chunkPrefix = '[startup] workflow template updates (cont.) — ';
        const chunkBudget = DRIFT_SUMMARY_MAX_CHARS - chunkPrefix.length;
        let line = '';
        for (const entry of entries) {
          const candidate = line ? `${line}, ${entry}` : entry;
          if (candidate.length > chunkBudget && line) {
            log.warn(`${chunkPrefix}${line},`);
            line = entry;
          } else {
            line = candidate;
          }
        }
        if (line) log.warn(`${chunkPrefix}${line}`);
      }
    }
    if (customizedOnlyCount > 0) {
      log.info(
        `[startup] ${customizedOnlyCount} built-in workflow(s) have local customizations ` +
          `(no template update pending).`
      );
    }
  } catch (err) {
    log.warn('[startup] Workflow drift check failed (non-fatal):', err);
  }
}

export async function restampBuiltInWorkflowsOnStartup(
  workflowManager: SpaceWorkflowManager,
  spaceManager: SpaceManager,
  spaceAgentManager: SpaceAgentManager,
  hasActiveRuns?: (workflowId: string) => boolean
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
          (name) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase())?.id,
          hasActiveRuns
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

        const referencedAgentIds = new Set<string>();
        for (const wf of workflowManager.listWorkflows(space.id)) {
          for (const node of wf.nodes) {
            for (const slot of node.agents) {
              if (slot.agentId) referencedAgentIds.add(slot.agentId);
            }
          }
        }
        const retiredAgents = retireRemovedPresetAgents(space.id, {
          agentManager: spaceAgentManager,
          referencedAgentIds,
        });
        if (retiredAgents.length > 0) {
          log.info(
            `[startup] Retired removed preset agent(s) in space "${space.name}" ` +
              `(${space.id}): ${retiredAgents.join(', ')}`
          );
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
  messageHub.onRequest('spaceWorkflow.create', async (data) => {
    const params = data as CreateSpaceWorkflowParams;

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }
    if (!params.name || params.name.trim() === '') {
      throw new Error('name is required');
    }

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const workflow = workflowManager.createWorkflow(params);

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

  messageHub.onRequest('spaceWorkflow.list', async (data) => {
    const params = data as { spaceId: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const workflows = workflowManager.listWorkflowSummaries(params.spaceId);
    return { workflows };
  });

  messageHub.onRequest('spaceWorkflow.listBuiltInTemplates', async (data) => {
    const params = data as { spaceId: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const workflows: SpaceWorkflow[] = getBuiltInWorkflows();
    return { workflows };
  });

  messageHub.onRequest('spaceWorkflow.get', async (data) => {
    const params = data as { id?: string; handle?: string; spaceId?: string };

    if (!params.id && !params.handle) {
      throw new Error('id or handle is required');
    }

    if (params.spaceId) {
      const space = await spaceManager.getSpace(params.spaceId);
      if (!space) {
        throw new Error(`Space not found: ${params.spaceId}`);
      }
    }

    let workflow: SpaceWorkflow | null = null;
    if (params.id) {
      workflow = workflowManager.getWorkflow(params.id);
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

    if (params.spaceId && workflow.spaceId !== params.spaceId) {
      throw new Error(`Workflow not found: ${params.id ?? params.handle}`);
    }

    return { workflow };
  });

  messageHub.onRequest('spaceWorkflow.update', async (data) => {
    const params = data as { id: string; spaceId?: string } & UpdateSpaceWorkflowParams;

    if (!params.id) {
      throw new Error('id is required');
    }

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

  messageHub.onRequest('spaceWorkflow.delete', async (data) => {
    const params = data as { id: string; spaceId?: string };

    if (!params.id) {
      throw new Error('id is required');
    }

    if (params.spaceId) {
      const space = await spaceManager.getSpace(params.spaceId);
      if (!space) {
        throw new Error(`Space not found: ${params.spaceId}`);
      }
    }

    const workflow = workflowManager.getWorkflow(params.id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

    if (params.spaceId && workflow.spaceId !== params.spaceId) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

    const deleted = workflowManager.deleteWorkflow(params.id);
    if (!deleted) {
      throw new Error(`Workflow not found: ${params.id}`);
    }

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

    if (!workflow.templateName) {
      return {
        updateAvailable: false,
        customized: false,
        templateName: null,
        currentTemplateHash: null,
        workflowContentHash: null,
        storedHash: workflow.templateHash ?? null,
      };
    }

    const template = resolveBuiltInWorkflowTemplate(workflow.templateName);
    if (!template) {
      return {
        updateAvailable: false,
        customized: false,
        templateName: workflow.templateName,
        currentTemplateHash: null,
        workflowContentHash: null,
        storedHash: workflow.templateHash ?? null,
      };
    }

    const currentTemplateHash = computeWorkflowHash(template);
    const workflowContentHash = computeWorkflowHash(workflow);
    const storedHash = workflow.templateHash ?? null;

    return {
      updateAvailable: currentTemplateHash !== storedHash,
      customized: workflowContentHash !== storedHash,
      templateName: workflow.templateName,
      currentTemplateHash,
      workflowContentHash,
      storedHash,
    };
  });

  messageHub.onRequest('spaceWorkflow.previewTemplateSync', async (data) => {
    const params = data as { id: string; spaceId: string };

    if (!params.id) throw new Error('id is required');
    if (!params.spaceId) throw new Error('spaceId is required');

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) throw new Error(`Space not found: ${params.spaceId}`);

    const workflow = workflowManager.getWorkflow(params.id);
    if (!workflow) throw new Error(`Workflow not found: ${params.id}`);
    if (workflow.spaceId !== params.spaceId) {
      throw new Error(`Workflow not found: ${params.id}`);
    }
    if (!workflow.templateName) {
      throw new Error(
        `Workflow "${workflow.name}" is not linked to a built-in template and cannot be synced.`
      );
    }

    const template = resolveBuiltInWorkflowTemplate(workflow.templateName);
    if (!template) {
      throw new Error(
        `Built-in template "${workflow.templateName}" not found. It may have been removed.`
      );
    }

    const liveHash = computeWorkflowHash(template);
    const rowHash = computeWorkflowHash(workflow);
    const storedHash = workflow.templateHash ?? null;
    const diff = buildWorkflowSyncDiff(workflow, template);

    return {
      preview: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        templateName: workflow.templateName,
        storedHash,
        liveHash,
        rowHash,
        updateAvailable: storedHash !== liveHash,
        customized: rowHash !== storedHash,
        diff,
      },
    };
  });

  messageHub.onRequest('spaceWorkflow.syncFromTemplate', async (data) => {
    const params = data as { id: string; spaceId: string; expectedRowHash?: string };

    if (!params.id) {
      throw new Error('id is required');
    }
    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

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

    if (params.expectedRowHash !== undefined) {
      const currentRowHash = computeWorkflowHash(workflow);
      if (currentRowHash !== params.expectedRowHash) {
        throw new Error(
          'This workflow changed since you opened the review. Close and reopen the diff to refresh.'
        );
      }
    }

    const template = resolveBuiltInWorkflowTemplate(workflow.templateName);
    if (!template) {
      throw new Error(
        `Built-in template "${workflow.templateName}" not found. It may have been removed.`
      );
    }

    const updateParams = buildTemplateUpdateParams(
      spaceAgentManager,
      params.spaceId,
      template,
      'sync',
      workflow
    );

    updateParams.templateName = workflow.templateName;

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

  messageHub.onRequest('spaceWorkflow.detectDuplicateDrift', async (data) => {
    const params = data as { spaceId: string };

    if (!params.spaceId) {
      throw new Error('spaceId is required');
    }

    const space = await spaceManager.getSpace(params.spaceId);
    if (!space) {
      throw new Error(`Space not found: ${params.spaceId}`);
    }

    const builtInNames = new Set(getBuiltInWorkflows().map((w) => w.name));

    const workflows = workflowManager.listWorkflowSummaries(params.spaceId);

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

    const template = resolveBuiltInWorkflowTemplate(params.templateName);
    if (!template) {
      throw new Error(
        `Built-in template "${params.templateName}" not found. Resync is only available for built-in workflows.`
      );
    }

    const all = workflowManager.listWorkflows(params.spaceId);
    const group = all.filter((w) => w.templateName === params.templateName);
    if (group.length === 0) {
      throw new Error(
        `No workflows found for templateName "${params.templateName}" in space "${params.spaceId}".`
      );
    }

    group.sort((a, b) => b.createdAt - a.createdAt);
    const kept = group[0];
    const toDelete = group.slice(1);

    const updateParams = buildTemplateUpdateParams(
      spaceAgentManager,
      params.spaceId,
      template,
      'resync',
      kept
    );

    const updated = workflowManager.updateWorkflow(kept.id, updateParams);
    if (!updated) {
      throw new Error(`Workflow not found: ${kept.id}`);
    }

    const deletedIds: string[] = [];
    const skippedDueToExecutableRuns: string[] = [];
    for (const wf of toDelete) {
      if (workflowManager.hasExecutableRuns(wf.id)) {
        skippedDueToExecutableRuns.push(wf.id);
        log.warn(
          `[resync] Kept duplicate workflow "${wf.name}" (${wf.id}): ` +
            `it has executable run(s) (in progress or not archived) — archive the task(s) and re-resync`
        );
        continue;
      }
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

    return { workflow: updated, keptWorkflowId: kept.id, deletedIds, skippedDueToExecutableRuns };
  });
}
