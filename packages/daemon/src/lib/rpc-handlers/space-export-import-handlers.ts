import type { Database as BunDatabase } from '../../storage/sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type {
  MessageHub,
  Space,
  SpaceWorkerAgent,
  SpaceWorkflow,
  CreateSpaceWorkerAgentParams,
  UpdateSpaceWorkerAgentParams,
  CreateSpaceWorkflowParams,
  WorkflowNodeInput,
  SpaceExportBundle,
  ExportedSpaceWorkerAgent,
  ExportedSpaceWorkflow,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import { exportBundle, validateExportBundle, normalizeOverride } from '../space/export-format';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit } from '../space/slug';
import { Logger } from '../logger';

const log = new Logger('space-export-import-handlers');
const RESERVED_AGENT_HANDLE_SET = new Set<string>(RESERVED_SPACE_AGENT_HANDLES);

export interface ImportPreview {
  name: string;
  action: 'create' | 'conflict';
  existingId?: string;
}

export interface ImportPreviewResult {
  agents: ImportPreview[];
  workflows: ImportPreview[];
  validationErrors: string[];
}

export type ConflictResolutionStrategy = 'skip' | 'rename' | 'replace';

export interface ImportConflictResolution {
  agents?: Record<string, ConflictResolutionStrategy>;
  workflows?: Record<string, ConflictResolutionStrategy>;
}

export interface ImportedItem {
  name: string;
  id: string;
  action: 'created' | 'skipped' | 'renamed' | 'replaced';
  previousId?: string;
}

export interface ImportExecuteResult {
  agents: ImportedItem[];
  workflows: ImportedItem[];
  warnings: string[];
}

async function requireSpace(spaceManager: SpaceManager, spaceId: string): Promise<Space> {
  if (!spaceId) throw new Error('spaceId is required');
  const space = await spaceManager.getSpace(spaceId);
  if (!space) throw new Error(`Space not found: ${spaceId}`);
  return space;
}

function generateUniqueName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) return baseName;
  let counter = 1;
  while (counter < 10_000 && existingNames.has(`${baseName} (${counter})`)) counter++;
  if (counter >= 10_000) {
    throw new Error(`Cannot generate a unique name for "${baseName}": too many existing variants`);
  }
  return `${baseName} (${counter})`;
}

function buildAgentCreateParams(
  spaceId: string,
  name: string,
  exported: ExportedSpaceWorkerAgent,
  usedAgentHandles?: Set<string>
): CreateSpaceWorkerAgentParams {
  const params: CreateSpaceWorkerAgentParams = { spaceId, name };
  if (shouldPreserveAgentHandle(exported.handle, usedAgentHandles)) {
    params.handle = exported.handle;
  } else if (usedAgentHandles) {
    params.handle = slugifyWithinLimit(name, [
      ...usedAgentHandles,
      ...RESERVED_SPACE_AGENT_HANDLES,
    ]);
  }
  applyExportedAgentFields(params, exported);
  return params;
}

function shouldPreserveAgentHandle(
  handle: string | undefined,
  usedAgentHandles?: Set<string>
): boolean {
  if (handle === undefined || handle.trim() === '') return false;
  if (RESERVED_AGENT_HANDLE_SET.has(handle)) return false;
  return !usedAgentHandles?.has(handle);
}

function warnOnAgentHandleRewrite(
  exported: ExportedSpaceWorkerAgent,
  finalName: string,
  usedAgentHandles: Set<string>,
  warnings: string[],
  preservedHandle?: string
): void {
  const exportedHandle = typeof exported.handle === 'string' ? exported.handle.trim() : '';
  if (!exportedHandle || exportedHandle === preservedHandle) return;
  if (RESERVED_AGENT_HANDLE_SET.has(exportedHandle)) {
    warnings.push(
      `Agent "${finalName}": exported handle "${exportedHandle}" is reserved; a new handle was auto-generated`
    );
  } else if (usedAgentHandles.has(exportedHandle)) {
    warnings.push(
      `Agent "${finalName}": exported handle "${exportedHandle}" already exists in the target space; a new handle was auto-generated`
    );
  }
}

function generateAgentFallbackHandle(
  existing: SpaceWorkerAgent,
  usedAgentHandles: Set<string>,
  fallbackBaseHandles: Set<string>
): string {
  if (!usedAgentHandles.has(existing.handle) && !fallbackBaseHandles.has(existing.handle)) {
    return existing.handle;
  }
  return slugifyWithinLimit(existing.name, [
    ...usedAgentHandles,
    ...fallbackBaseHandles,
    ...RESERVED_SPACE_AGENT_HANDLES,
  ]);
}

function applyExportedAgentFields(
  params: UpdateSpaceWorkerAgentParams,
  exported: ExportedSpaceWorkerAgent
): void {
  if (exported.description !== undefined) params.description = exported.description;
  if (exported.model !== undefined) params.model = exported.model;
  if (exported.thinkingLevel !== undefined) params.thinkingLevel = exported.thinkingLevel;
  if (exported.provider !== undefined) params.provider = exported.provider;
  const parts = [exported.systemPrompt, exported.instructions].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  if (parts.length > 0) params.customPrompt = parts.join('\n\n');
  if (exported.tools !== undefined) params.tools = exported.tools;
  if (exported.settingSources !== undefined) params.settingSources = exported.settingSources;
}

export function buildWorkflowCreateParams(
  spaceId: string,
  name: string,
  exported: ExportedSpaceWorkflow,
  importedAgentNameToId: Map<string, string>,
  existingAgentNameToId: Map<string, string>,
  usedWorkflowHandles?: Set<string>
): { params: CreateSpaceWorkflowParams; nodeNameToId: Map<string, string>; warnings: string[] } {
  const warnings: string[] = [];

  const nodeNameToId = new Map<string, string>();
  for (const node of exported.nodes) {
    nodeNameToId.set(node.name, generateUUID());
  }

  const nodes: WorkflowNodeInput[] = exported.nodes.map((exportedNode) => {
    const agents = exportedNode.agents.map((a) => {
      const agentId =
        importedAgentNameToId.get(a.agentRef) ?? existingAgentNameToId.get(a.agentRef) ?? null;
      if (!agentId) {
        warnings.push(`node "${exportedNode.name}" references unknown agent "${a.agentRef}"`);
      }
      const entry: {
        agentId: string;
        name: string;
        model?: string;
        thinkingLevel?: import('@hyperneo/shared').ThinkingLevel;
        customPrompt?: import('@hyperneo/shared').WorkflowNodeAgentOverride;
        replaceAgentPrompt?: boolean;
        disabledSkillIds?: string[];
        extraMcpServers?: import('@hyperneo/shared').WorkflowNodeAgent['extraMcpServers'];
        timeoutMs?: number;
        toolGuards?: import('@hyperneo/shared').DeclarativeToolGuard[];
        eventInterests?: import('@hyperneo/shared').EventInterest[];
        resetContextPerTurn?: boolean;
      } = {
        agentId: agentId ?? '',
        name: a.name,
      };
      if (typeof a.model === 'string' && a.model.trim()) entry.model = a.model.trim();
      if (a.thinkingLevel !== undefined) entry.thinkingLevel = a.thinkingLevel;
      const normalizedSP = normalizeOverride(a.systemPrompt);
      const normalizedInst = normalizeOverride(a.instructions);
      if (normalizedSP !== undefined || normalizedInst !== undefined) {
        const parts = [normalizedSP?.value, normalizedInst?.value].filter(
          (s): s is string => typeof s === 'string' && s.length > 0
        );
        if (parts.length > 0) entry.customPrompt = { value: parts.join('\n\n') };
      }
      if (a.replaceAgentPrompt === true) entry.replaceAgentPrompt = true;
      if (a.disabledSkillIds !== undefined) entry.disabledSkillIds = a.disabledSkillIds;
      if (a.extraMcpServers !== undefined)
        entry.extraMcpServers = a.extraMcpServers as Record<
          string,
          import('@hyperneo/shared').McpServerConfig
        >;
      if (typeof a.timeoutMs === 'number') entry.timeoutMs = a.timeoutMs;
      if (a.toolGuards !== undefined) entry.toolGuards = a.toolGuards;
      if (a.eventInterests !== undefined) entry.eventInterests = a.eventInterests;
      if (a.resetContextPerTurn !== undefined) entry.resetContextPerTurn = a.resetContextPerTurn;
      return entry;
    });

    const node: WorkflowNodeInput = {
      id: nodeNameToId.get(exportedNode.name)!,
      name: exportedNode.name,
      agents,
      postApproval: exportedNode.postApproval,
    };
    if (exportedNode.transitions && exportedNode.transitions.length > 0) {
      node.transitions = exportedNode.transitions.map((t) => ({ ...t }));
    }

    return node;
  });

  const startNodeId = nodeNameToId.get(exported.startNode);
  const endNodeId = exported.endNode ? nodeNameToId.get(exported.endNode) : undefined;

  const params: CreateSpaceWorkflowParams = {
    spaceId,
    name,
    nodes,
    tags: exported.tags,
    completionAutonomyLevel: exported.completionAutonomyLevel ?? 3,
  };
  if (startNodeId) params.startNodeId = startNodeId;
  if (endNodeId) params.endNodeId = endNodeId;
  if (exported.description !== undefined) params.description = exported.description;
  if (exported.channels && exported.channels.length > 0) {
    params.channels = exported.channels.map((ch) => ({ ...ch }));
  }
  if (exported.hooks && exported.hooks.length > 0) params.hooks = exported.hooks;
  if (exported.disabled !== undefined) params.disabled = exported.disabled;
  if (
    exported.handle !== undefined &&
    exported.handle.trim() !== '' &&
    (!usedWorkflowHandles || !usedWorkflowHandles.has(exported.handle))
  ) {
    params.handle = exported.handle;
  }

  return { params, nodeNameToId, warnings };
}

function validateWorkflowForPreview(
  exported: ExportedSpaceWorkflow,
  importedAgentNames: Set<string>,
  existingAgentNameToId: Map<string, string>,
  agentNameToRole: Map<string, string>
): string[] {
  const errors: string[] = [];

  for (const node of exported.nodes) {
    for (const a of node.agents) {
      if (!importedAgentNames.has(a.agentRef) && !existingAgentNameToId.has(a.agentRef)) {
        errors.push(
          `node "${node.name}" references unknown agent "${a.agentRef}" — not found in bundle or target space`
        );
      }
    }
  }

  if (exported.channels && exported.channels.length > 0) {
    for (let ci = 0; ci < exported.channels.length; ci++) {
      const ch = exported.channels[ci];
      const loc = `channels[${ci}]`;
      if (!ch.from || !ch.from.trim()) {
        errors.push(`${loc}: 'from' must be a non-empty node name string`);
      }
      const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
      if (toList.length === 0) {
        errors.push(`${loc}: 'to' must not be empty`);
      }
    }
  }

  const transitionHookIds = new Set<string>();
  for (const hook of exported.hooks ?? []) {
    if (hook?.id) transitionHookIds.add(hook.id);
  }
  const transitionTargetDestinations = new Map<string, Set<string>>();
  const countTargetDest = (name: string | undefined, key: string) => {
    if (!name) return;
    const set = transitionTargetDestinations.get(name) ?? new Set<string>();
    set.add(key);
    transitionTargetDestinations.set(name, set);
  };
  exported.nodes.forEach((n, idx) => {
    countTargetDest(n.name, `node:${idx}`);
    for (const a of n.agents ?? []) countTargetDest(a.name, `slot:${idx}`);
  });
  for (const node of exported.nodes) {
    const transitions = node.transitions;
    if (!transitions || transitions.length === 0) continue;
    for (let ti = 0; ti < transitions.length; ti++) {
      const t = transitions[ti];
      const loc = `node "${node.name}".transitions[${ti}]`;
      if (t.target !== '*') {
        const dests = transitionTargetDestinations.get(t.target);
        if (!dests || dests.size === 0) {
          errors.push(
            `${loc}.target "${t.target}" does not reference a known node name or agent slot name`
          );
        } else if (dests.size > 1) {
          errors.push(
            `${loc}.target "${t.target}" is ambiguous — matches ${dests.size} destinations`
          );
        }
      }
      if (t.hookId !== undefined && !transitionHookIds.has(t.hookId)) {
        errors.push(`${loc}.hookId "${t.hookId}" does not reference a known hook`);
      }
    }
  }

  void agentNameToRole;

  return errors;
}

export function setupSpaceExportImportHandlers(
  messageHub: MessageHub,
  spaceManager: SpaceManager,
  agentRepo: SpaceAgentRepository,
  workflowRepo: SpaceWorkflowRepository,
  workflowManager: SpaceWorkflowManager,
  db: BunDatabase,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  runtimeService?: {
    clearLongTermAgentSessionProvider(spaceId: string, agentId: string): Promise<void>;
  }
): void {
  messageHub.onRequest('spaceExport.agents', async (data) => {
    const params = data as { spaceId: string; agentIds?: string[] };
    const space = await requireSpace(spaceManager, params.spaceId);

    let agents: SpaceWorkerAgent[] = agentRepo.getBySpaceId(params.spaceId);
    if (params.agentIds?.length) {
      const idSet = new Set(params.agentIds);
      agents = agents.filter((a) => idSet.has(a.id));
    }

    const bundle = exportBundle(agents, [], `${space.name} agents`, {
      exportedFrom: params.spaceId,
    });
    return { bundle };
  });

  messageHub.onRequest('spaceExport.workflows', async (data) => {
    const params = data as { spaceId: string; workflowIds?: string[] };
    const space = await requireSpace(spaceManager, params.spaceId);

    let workflows = workflowRepo.listWorkflows(params.spaceId);
    if (params.workflowIds?.length) {
      const idSet = new Set(params.workflowIds);
      workflows = workflows.filter((w) => idSet.has(w.id));
    }

    const allAgents = agentRepo.getBySpaceId(params.spaceId);

    const full = exportBundle(allAgents, workflows, `${space.name} workflows`, {
      exportedFrom: params.spaceId,
    });

    const referencedNames = new Set<string>();
    for (const wf of full.workflows) {
      for (const node of wf.nodes) {
        for (const a of node.agents) referencedNames.add(a.agentRef);
      }
    }

    const bundle: SpaceExportBundle = {
      ...full,
      agents: full.agents.filter((a) => referencedNames.has(a.name)),
    };

    return { bundle };
  });

  messageHub.onRequest('spaceExport.bundle', async (data) => {
    const params = data as { spaceId: string; agentIds?: string[]; workflowIds?: string[] };
    const space = await requireSpace(spaceManager, params.spaceId);

    let agents = agentRepo.getBySpaceId(params.spaceId);
    if (params.agentIds?.length) {
      const idSet = new Set(params.agentIds);
      agents = agents.filter((a) => idSet.has(a.id));
    }

    let workflows = workflowRepo.listWorkflows(params.spaceId);
    if (params.workflowIds?.length) {
      const idSet = new Set(params.workflowIds);
      workflows = workflows.filter((w) => idSet.has(w.id));
    }

    const bundle = exportBundle(agents, workflows, `${space.name} bundle`, {
      exportedFrom: params.spaceId,
    });
    return { bundle };
  });

  messageHub.onRequest('spaceImport.preview', async (data) => {
    const params = data as { bundle: unknown; spaceId: string };
    await requireSpace(spaceManager, params.spaceId);

    const validation = validateExportBundle(params.bundle);
    if (!validation.ok) {
      const result: ImportPreviewResult = {
        agents: [],
        workflows: [],
        validationErrors: [validation.error],
      };
      return result;
    }
    const bundle = validation.value;

    const existingAgents = agentRepo.getBySpaceId(params.spaceId);
    const existingWorkflows = workflowRepo.listWorkflows(params.spaceId);

    const existingAgentByName = new Map(existingAgents.map((a) => [a.name, a]));
    const existingWorkflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
    const existingAgentNameToId = new Map(existingAgents.map((a) => [a.name, a.id]));

    const agentNameToRole = new Map<string, string>(existingAgents.map((a) => [a.name, a.name]));

    const agentPreviews: ImportPreview[] = bundle.agents.map((a) => {
      const existing = existingAgentByName.get(a.name);
      if (existing) return { name: a.name, action: 'conflict', existingId: existing.id };
      return { name: a.name, action: 'create' };
    });

    const workflowPreviews: ImportPreview[] = [];
    const validationErrors: string[] = [];

    const importedAgentNames = new Set(bundle.agents.map((a) => a.name));

    for (const wf of bundle.workflows) {
      const existing = existingWorkflowByName.get(wf.name);
      if (existing) {
        workflowPreviews.push({ name: wf.name, action: 'conflict', existingId: existing.id });
      } else {
        workflowPreviews.push({ name: wf.name, action: 'create' });
      }

      const errors = validateWorkflowForPreview(
        wf,
        importedAgentNames,
        existingAgentNameToId,
        agentNameToRole
      );
      for (const err of errors) {
        validationErrors.push(`Workflow "${wf.name}": ${err}`);
      }
    }

    const result: ImportPreviewResult = {
      agents: agentPreviews,
      workflows: workflowPreviews,
      validationErrors,
    };
    return result;
  });

  messageHub.onRequest('spaceImport.execute', async (data) => {
    const params = data as {
      spaceId: string;
      bundle: unknown;
      conflictResolution?: ImportConflictResolution;
    };
    await requireSpace(spaceManager, params.spaceId);

    const validation = validateExportBundle(params.bundle);
    if (!validation.ok) {
      throw new Error(`Invalid bundle: ${validation.error}`);
    }
    const bundle = validation.value;
    const resolution = params.conflictResolution ?? {};

    const providerClearedAgentIds: string[] = [];
    const executeImport = db.transaction(
      (spaceId: string, res: ImportConflictResolution): ImportExecuteResult => {
        const existingAgents = agentRepo.getBySpaceId(spaceId);
        const existingWorkflows = workflowRepo.listWorkflows(spaceId);

        const existingAgentByName = new Map(existingAgents.map((a) => [a.name, a]));
        const existingWorkflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
        const existingAgentNameToId = new Map(existingAgents.map((a) => [a.name, a.id]));

        const usedAgentNames = new Set(existingAgents.map((a) => a.name));
        const usedAgentHandles = new Set(existingAgents.map((a) => a.handle).filter(Boolean));
        const usedWorkflowNames = new Set(existingWorkflows.map((w) => w.name));
        const usedWorkflowHandles = new Set(
          existingWorkflows.map((w) => w.handle).filter((h): h is string => !!h)
        );

        const replacedAgentByName = new Map<string, SpaceWorkerAgent>();
        const preservedReplaceHandleByName = new Map<string, string>();
        const fallbackReplaceHandleByName = new Map<string, string>();
        const fallbackBaseHandles = new Set<string>();
        for (const exportedAgent of bundle.agents) {
          const existing = existingAgentByName.get(exportedAgent.name);
          if (!existing) continue;
          const strategy: ConflictResolutionStrategy = res.agents?.[exportedAgent.name] ?? 'skip';
          if (strategy !== 'replace') continue;
          replacedAgentByName.set(exportedAgent.name, existing);
          usedAgentHandles.delete(existing.handle);
          fallbackBaseHandles.add(existing.handle);
        }
        for (const exportedAgent of bundle.agents) {
          const existing = replacedAgentByName.get(exportedAgent.name);
          if (!existing) continue;
          if (shouldPreserveAgentHandle(exportedAgent.handle, usedAgentHandles)) {
            preservedReplaceHandleByName.set(exportedAgent.name, exportedAgent.handle!);
            usedAgentHandles.add(exportedAgent.handle!);
            continue;
          }
          fallbackBaseHandles.delete(existing.handle);
          const fallbackHandle = generateAgentFallbackHandle(
            existing,
            usedAgentHandles,
            fallbackBaseHandles
          );
          fallbackReplaceHandleByName.set(exportedAgent.name, fallbackHandle);
          usedAgentHandles.add(fallbackHandle);
        }
        if (replacedAgentByName.size > 0) {
          const now = Date.now();
          const clearAgentHandle = db.prepare(
            `UPDATE space_agents SET handle = NULL, updated_at = ? WHERE id = ?`
          );
          for (const agent of replacedAgentByName.values()) {
            clearAgentHandle.run(now, agent.id);
          }
        }

        const importedAgentNameToId = new Map<string, string>();
        const agentResults: ImportedItem[] = [];
        const allWarnings: string[] = [];

        for (const exportedAgent of bundle.agents) {
          const existing = existingAgentByName.get(exportedAgent.name);

          if (!existing) {
            const createParams = buildAgentCreateParams(
              spaceId,
              exportedAgent.name,
              exportedAgent,
              usedAgentHandles
            );
            warnOnAgentHandleRewrite(
              exportedAgent,
              exportedAgent.name,
              usedAgentHandles,
              allWarnings
            );
            const created = agentRepo.create(createParams);
            usedAgentNames.add(exportedAgent.name);
            usedAgentHandles.add(created.handle);
            importedAgentNameToId.set(exportedAgent.name, created.id);
            agentResults.push({ name: exportedAgent.name, id: created.id, action: 'created' });
            continue;
          }

          const strategy: ConflictResolutionStrategy = res.agents?.[exportedAgent.name] ?? 'skip';

          if (strategy === 'skip') {
            importedAgentNameToId.set(exportedAgent.name, existing.id);
            agentResults.push({ name: exportedAgent.name, id: existing.id, action: 'skipped' });
          } else if (strategy === 'replace') {
            const replaceParts = [exportedAgent.systemPrompt, exportedAgent.instructions].filter(
              (s): s is string => typeof s === 'string' && s.length > 0
            );
            const updateParams: UpdateSpaceWorkerAgentParams = {
              description: exportedAgent.description ?? null,
              model: exportedAgent.model ?? null,
              thinkingLevel: exportedAgent.thinkingLevel ?? null,
              provider: exportedAgent.provider ?? null,
              customPrompt: replaceParts.length > 0 ? replaceParts.join('\n\n') : null,
              tools: exportedAgent.tools ?? null,
              settingSources: exportedAgent.settingSources ?? null,
            };
            const preservedHandle = preservedReplaceHandleByName.get(exportedAgent.name);
            updateParams.handle =
              preservedHandle ?? fallbackReplaceHandleByName.get(exportedAgent.name);
            warnOnAgentHandleRewrite(
              exportedAgent,
              exportedAgent.name,
              usedAgentHandles,
              allWarnings,
              preservedHandle
            );
            const updated = agentRepo.update(existing.id, updateParams);
            const id = updated?.id ?? existing.id;
            if (updateParams.provider === null) providerClearedAgentIds.push(id);
            importedAgentNameToId.set(exportedAgent.name, id);
            agentResults.push({ name: exportedAgent.name, id, action: 'replaced' });
          } else {
            const finalName = generateUniqueName(exportedAgent.name, usedAgentNames);
            const createParams = buildAgentCreateParams(
              spaceId,
              finalName,
              exportedAgent,
              usedAgentHandles
            );
            warnOnAgentHandleRewrite(exportedAgent, finalName, usedAgentHandles, allWarnings);
            const created = agentRepo.create(createParams);
            usedAgentNames.add(finalName);
            usedAgentHandles.add(created.handle);
            importedAgentNameToId.set(exportedAgent.name, created.id);
            agentResults.push({ name: finalName, id: created.id, action: 'renamed' });
          }
        }

        const replacedIdByName = new Map<string, string>();
        for (const exportedWorkflow of bundle.workflows) {
          const existing = existingWorkflowByName.get(exportedWorkflow.name);
          if (!existing) continue;
          const strategy: ConflictResolutionStrategy =
            res.workflows?.[exportedWorkflow.name] ?? 'skip';
          if (strategy === 'replace') {
            if (workflowManager.hasExecutableRuns(existing.id)) {
              allWarnings.push(
                `Workflow "${exportedWorkflow.name}": replace skipped — existing ` +
                  `workflow has executable run(s) (in progress or not archived); ` +
                  `archive the task(s) and re-import to replace`
              );
              continue;
            }
            workflowManager.deleteWorkflow(existing.id);
            replacedIdByName.set(exportedWorkflow.name, existing.id);
            usedWorkflowNames.delete(exportedWorkflow.name);
            if (existing.handle) usedWorkflowHandles.delete(existing.handle);
          }
        }

        const workflowResults: ImportedItem[] = [];

        for (const exportedWorkflow of bundle.workflows) {
          const existing = existingWorkflowByName.get(exportedWorkflow.name);

          let finalName = exportedWorkflow.name;
          let action: ImportedItem['action'] = 'created';
          let replacedOldId: string | undefined;

          if (!existing) {
            // No conflict — create as-is
          } else {
            const strategy: ConflictResolutionStrategy =
              res.workflows?.[exportedWorkflow.name] ?? 'skip';

            if (strategy === 'skip') {
              workflowResults.push({
                name: exportedWorkflow.name,
                id: existing.id,
                action: 'skipped',
              });
              continue;
            }

            if (strategy === 'replace') {
              if (!replacedIdByName.has(exportedWorkflow.name)) {
                workflowResults.push({
                  name: exportedWorkflow.name,
                  id: existing.id,
                  action: 'skipped',
                });
                continue;
              }
              replacedOldId = replacedIdByName.get(exportedWorkflow.name);
              action = 'replaced';
            } else {
              finalName = generateUniqueName(exportedWorkflow.name, usedWorkflowNames);
              action = 'renamed';
            }
          }

          usedWorkflowNames.add(finalName);

          const { params: createParams, warnings } = buildWorkflowCreateParams(
            spaceId,
            finalName,
            exportedWorkflow,
            importedAgentNameToId,
            existingAgentNameToId,
            usedWorkflowHandles
          );

          const exportedHandle =
            typeof exportedWorkflow.handle === 'string' ? exportedWorkflow.handle.trim() : '';
          if (exportedHandle && usedWorkflowHandles.has(exportedHandle)) {
            allWarnings.push(
              `Workflow "${finalName}": exported handle "${exportedHandle}" already exists in the target space; a new handle was auto-generated`
            );
          }

          if (warnings.length > 0) {
            for (const w of warnings) {
              allWarnings.push(`Workflow "${finalName}": ${w}`);
            }
            throw new Error(
              `Cannot import workflow "${finalName}": unresolved agent reference(s) — run spaceImport.preview to see details`
            );
          }

          const created = workflowManager.createWorkflow(createParams);
          if (created.handle) usedWorkflowHandles.add(created.handle);
          const wfItem: ImportedItem = { name: finalName, id: created.id, action };
          if (action === 'replaced' && typeof replacedOldId !== 'undefined') {
            wfItem.previousId = replacedOldId;
          }
          workflowResults.push(wfItem);
        }

        return {
          agents: agentResults,
          workflows: workflowResults,
          warnings: allWarnings,
        };
      }
    );

    const importResult = executeImport(params.spaceId, resolution);

    for (const agentId of providerClearedAgentIds) {
      await runtimeService?.clearLongTermAgentSessionProvider(params.spaceId, agentId);
    }

    const spaceId = params.spaceId;

    for (const item of importResult.agents) {
      if (item.action === 'skipped') continue;
      const agent: SpaceWorkerAgent | null = agentRepo.getById(item.id);
      if (!agent) continue;
      const eventName = item.action === 'replaced' ? 'spaceAgent.updated' : 'spaceAgent.created';
      internalEventBus
        .publish(eventName, {
          sessionId: `space:${spaceId}`,
          spaceId,
          agent,
        })
        .catch((err) => {
          log.warn(`Failed to emit ${eventName} for imported agent "${item.name}":`, err);
        });
    }

    for (const item of importResult.workflows) {
      if (item.action === 'skipped') continue;
      const workflow: SpaceWorkflow | null = workflowRepo.getWorkflow(item.id);
      if (!workflow) continue;

      if (item.action === 'replaced' && item.previousId) {
        internalEventBus
          .publish('spaceWorkflow.deleted', {
            sessionId: 'global',
            spaceId,
            workflowId: item.previousId,
          })
          .catch((err) => {
            log.warn(
              `Failed to emit spaceWorkflow.deleted for replaced workflow "${item.name}":`,
              err
            );
          });
        internalEventBus
          .publish('spaceWorkflow.created', {
            sessionId: 'global',
            spaceId,
            workflow,
          })
          .catch((err) => {
            log.warn(
              `Failed to emit spaceWorkflow.created for replaced workflow "${item.name}":`,
              err
            );
          });
      } else {
        internalEventBus
          .publish('spaceWorkflow.created', {
            sessionId: 'global',
            spaceId,
            workflow,
          })
          .catch((err) => {
            log.warn(
              `Failed to emit spaceWorkflow.created for imported workflow "${item.name}":`,
              err
            );
          });
      }
    }

    return importResult;
  });
}
