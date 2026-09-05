import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  MessageHub,
  Space,
  SpaceWorkerAgent,
  SpaceWorkflow,
  CreateSpaceWorkflowParams,
  WorkflowNodeInput,
  SpaceExportBundle,
  ExportedSpaceWorkerAgent,
  ExportedSpaceWorkflow,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager.ts';
import type { CreateSpaceLongHorizonAgentParams, SpaceLongHorizonAgent } from '@hyperneo/shared';
import {
  coordinatorLongHorizonAgentId,
  type SpaceLongHorizonAgentRepository,
} from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository.ts';
import { exportBundle, validateExportBundle, normalizeOverride } from '../space/export-format.ts';
import { isRunnableUnifiedAgent } from '../space/agents/worker-long-horizon-mapper.ts';
import {
  publishUnifiedAgentCreated,
  publishUnifiedAgentUpdated,
} from '../space/agents/unified-agent-events.ts';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit } from '../space/slug.ts';
import { getLongHorizonAgentTemplate } from '../space/agents/long-horizon-agent-templates.ts';
import { Logger } from '../logger.ts';

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
  deferredUnifiedUpdates?: Array<{ spaceId: string; agentId: string }>;
}

async function requireSpace(spaceManager: SpaceManager, spaceId: string): Promise<Space> {
  if (!spaceId) throw new Error('spaceId is required');
  const space = await spaceManager.getSpace(spaceId);
  if (!space) throw new Error(`Space not found: ${spaceId}`);
  return space;
}

export function longHorizonAgentToWorkerView(agent: SpaceLongHorizonAgent): SpaceWorkerAgent {
  const toolEntries = agent.toolPermissions.tools;
  return {
    id: agent.id,
    spaceId: agent.spaceId,
    name: agent.displayName,
    handle: agent.handle,
    description: agent.description,
    model: agent.model ?? undefined,
    thinkingLevel: agent.thinkingLevel ?? undefined,
    provider: agent.provider ?? undefined,
    customPrompt: agent.instructions,
    tools: Array.isArray(toolEntries)
      ? toolEntries.filter((tool): tool is string => typeof tool === 'string')
      : undefined,
    settingSources: agent.settingSources ?? undefined,
    modelPool: agent.modelPool,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function unifiedExportAgents(
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository,
  spaceId: string
): SpaceWorkerAgent[] {
  const coordinatorByHandle = longHorizonAgentRepo.getCoordinator(spaceId);
  const unifiedRows = longHorizonAgentRepo.listBySpaceId(spaceId);
  return unifiedRows
    .filter((a) => a.id !== coordinatorLongHorizonAgentId(spaceId))
    .filter((a) => !coordinatorByHandle || a.id !== coordinatorByHandle.id)
    .filter((a) => a.status === 'active')
    .filter((a) => a.autonomyLevel == null)
    .map(longHorizonAgentToWorkerView);
}

function assertExportableAgentNames(agents: Array<{ id: string; name: string }>): void {
  const idByName = new Map<string, string>();
  for (const agent of agents) {
    const key = nameKey(agent.name);
    const existingId = idByName.get(key);
    if (existingId && existingId !== agent.id) {
      throw new Error(
        `Cannot export: duplicate agent name "${agent.name}" in this space. ` +
          `Rename one of the agents and retry.`
      );
    }
    idByName.set(key, agent.id);
  }
}

function nonRunnableUnifiedIds(
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository,
  spaceId: string
): Set<string> {
  return new Set(
    longHorizonAgentRepo
      .listBySpaceId(spaceId)
      .filter((a) => !isRunnableUnifiedAgent(a))
      .map((a) => a.id)
  );
}

function reservedCoordinatorNames(
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository,
  spaceId: string
): Set<string> {
  const rows = longHorizonAgentRepo.listBySpaceId(spaceId);
  const canonical = rows.find((a) => a.id === coordinatorLongHorizonAgentId(spaceId));
  const byHandle = longHorizonAgentRepo.getCoordinator(spaceId);
  const names = new Set<string>();
  for (const row of [canonical, byHandle]) {
    if (row && (row.displayName ?? '').trim() !== '') {
      names.add(nameKey(row.displayName));
    }
  }
  return names;
}

function findDuplicateBundleAgentNames(agents: Array<{ name: string }>): string[] {
  const seen = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const agent of agents) {
    const key = nameKey(agent.name);
    const first = seen.get(key);
    if (first !== undefined) {
      duplicates.add(`"${first}" / "${agent.name}"`);
    } else {
      seen.set(key, agent.name);
    }
  }
  return [...duplicates].map(
    (pair) =>
      `Bundle contains agent names that normalize to the same value: ${pair}. ` +
      `Rename one of them in the bundle and retry.`
  );
}

function findAmbiguousAgentNames(agents: Array<{ name: string; id: string }>): string[] {
  const idsByName = new Map<string, Set<string>>();
  for (const agent of agents) {
    const key = nameKey(agent.name);
    idsByName.set(key, (idsByName.get(key) ?? new Set()).add(agent.id));
  }
  return [...idsByName.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(
      ([name]) =>
        `Cannot import: agent name "${name.trim()}" is ambiguous in this space ` +
        `(multiple agents normalize to it). Rename one of them and retry.`
    );
}

function assertUnambiguousAgentNames(agents: Array<{ name: string; id: string }>): void {
  const ambiguities = findAmbiguousAgentNames(agents);
  if (ambiguities.length > 0) throw new Error(ambiguities[0]);
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function generateUniqueName(baseName: string, existingNames: Set<string>): string {
  const normalized = new Set([...existingNames].map((n) => nameKey(n)));
  if (!normalized.has(nameKey(baseName))) return baseName;
  let counter = 1;
  while (counter < 10_000 && normalized.has(nameKey(`${baseName} (${counter})`))) counter++;
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
): CreateSpaceLongHorizonAgentParams {
  const handle = shouldPreserveAgentHandle(exported.handle, usedAgentHandles)
    ? exported.handle!
    : slugifyWithinLimit(name, [...(usedAgentHandles ?? []), ...RESERVED_SPACE_AGENT_HANDLES]);
  const params: CreateSpaceLongHorizonAgentParams = { spaceId, displayName: name, handle };
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
  params: CreateSpaceLongHorizonAgentParams,
  exported: ExportedSpaceWorkerAgent
): void {
  if (exported.description !== undefined) params.description = exported.description;
  if (exported.model !== undefined) params.model = exported.model;
  if (exported.thinkingLevel !== undefined) params.thinkingLevel = exported.thinkingLevel;
  if (exported.provider !== undefined) params.provider = exported.provider;
  const parts = [exported.systemPrompt, exported.instructions].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  if (parts.length > 0) params.instructions = parts.join('\n\n');
  if (exported.tools !== undefined)
    params.toolPermissions = exported.tools.length > 0 ? { tools: [...exported.tools] } : {};
  if (exported.settingSources !== undefined) params.settingSources = exported.settingSources;
  if (exported.modelPool !== undefined && exported.modelPool.length > 0)
    params.modelPool = exported.modelPool;
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

  const normalizedImportedAgentNameToId = new Map(
    [...importedAgentNameToId].map(([n, id]) => [nameKey(n), id])
  );
  const normalizedExistingAgentNameToId = new Map(
    [...existingAgentNameToId].map(([n, id]) => [nameKey(n), id])
  );

  const nodeNameToId = new Map<string, string>();
  for (const node of exported.nodes) {
    nodeNameToId.set(node.name, generateUUID());
  }

  const nodes: WorkflowNodeInput[] = exported.nodes.map((exportedNode) => {
    const agents = exportedNode.agents.map((a) => {
      const entry: {
        agentId: string;
        templateKey?: string;
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
        agentId: '',
        name: a.name,
      };
      const templateKey = a.templateKey?.trim();
      if (templateKey) {
        entry.templateKey = templateKey;
      } else {
        const agentRef = a.agentRef?.trim() ?? '';
        const agentId =
          normalizedImportedAgentNameToId.get(nameKey(agentRef)) ??
          normalizedExistingAgentNameToId.get(nameKey(agentRef)) ??
          null;
        if (!agentId) {
          warnings.push(`node "${exportedNode.name}" references unknown agent "${agentRef}"`);
        }
        entry.agentId = agentId ?? '';
      }
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
      const templateKey = a.templateKey?.trim();
      if (templateKey) {
        if (!getLongHorizonAgentTemplate(templateKey)) {
          errors.push(`node "${node.name}" references unknown template "${templateKey}"`);
        }
        continue;
      }
      const agentRef = a.agentRef?.trim() ?? '';
      if (
        agentRef &&
        !importedAgentNames.has(nameKey(agentRef)) &&
        !existingAgentNameToId.has(nameKey(agentRef))
      ) {
        errors.push(
          `node "${node.name}" references unknown agent "${agentRef}" — not found in bundle or target space`
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
  longHorizonAgentRepo: SpaceLongHorizonAgentRepository,
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

    let agents: SpaceWorkerAgent[] = unifiedExportAgents(longHorizonAgentRepo, params.spaceId);
    if (params.agentIds?.length) {
      const idSet = new Set(params.agentIds);
      agents = agents.filter((a) => idSet.has(a.id));
    }
    assertExportableAgentNames(agents);

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

    const allAgents = unifiedExportAgents(longHorizonAgentRepo, params.spaceId);

    const referencedAgentIds = new Set<string>();
    for (const wf of workflows) {
      for (const node of wf.nodes ?? []) {
        for (const a of node.agents ?? []) {
          if (a.agentId?.trim()) referencedAgentIds.add(a.agentId.trim());
        }
      }
    }
    const liveById = new Map(allAgents.map((a) => [a.id, a]));
    const allSpaceAgents = longHorizonAgentRepo.listBySpaceId(params.spaceId);
    const coordinatorByHandle = longHorizonAgentRepo.getCoordinator(params.spaceId);
    const unexportable = [...referencedAgentIds].filter((id) => !liveById.has(id));
    if (unexportable.length > 0) {
      const details = unexportable.map((id) => {
        if (
          id === coordinatorLongHorizonAgentId(params.spaceId) ||
          coordinatorByHandle?.id === id
        ) {
          return `${id} (the space coordinator is not exportable)`;
        }
        const lha = allSpaceAgents.find((a) => a.id === id);
        if (!lha) return `${id} (missing in this space)`;
        if (lha.status === 'active' && lha.autonomyLevel != null) {
          return `${id} (agent has an autonomy ceiling the export format cannot carry)`;
        }
        return `${id} (agent is ${lha.status}; only active agents are exportable)`;
      });
      throw new Error(
        `Cannot export workflows: referenced agent(s) cannot be exported: ` +
          details.join(', ') +
          `. Activate them, or remove the workflow reference(s) first.`
      );
    }
    for (const agentId of referencedAgentIds) {
      const liveMatch = liveById.get(agentId);
      const lhaMatch = allSpaceAgents.find((a) => a.id === agentId);
      if (!liveMatch && !lhaMatch) continue;
      const referencedName = nameKey(liveMatch?.name ?? lhaMatch?.displayName ?? '');
      if (!referencedName) continue;
      const clashes = allAgents.filter((a) => nameKey(a.name) === referencedName);
      if (clashes.length > 1) {
        throw new Error(
          `Cannot export: agent name "${liveMatch?.name ?? lhaMatch?.displayName}" is ambiguous in this space ` +
            `(matched ${clashes.length} agents). Rename one of them and retry.`
        );
      }
    }

    const full = exportBundle(allAgents, workflows, `${space.name} workflows`, {
      exportedFrom: params.spaceId,
    });

    const referencedNames = new Set<string>();
    for (const wf of full.workflows) {
      for (const node of wf.nodes) {
        for (const a of node.agents) {
          if (a.agentRef?.trim()) referencedNames.add(a.agentRef.trim());
        }
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

    let agents = unifiedExportAgents(longHorizonAgentRepo, params.spaceId);
    if (params.agentIds?.length) {
      const idSet = new Set(params.agentIds);
      agents = agents.filter((a) => idSet.has(a.id));
    }
    assertExportableAgentNames(agents);

    let workflows = workflowRepo.listWorkflows(params.spaceId);
    if (params.workflowIds?.length) {
      const idSet = new Set(params.workflowIds);
      workflows = workflows.filter((w) => idSet.has(w.id));
    }

    const referencedAgentIds = new Set<string>();
    for (const wf of workflows) {
      for (const node of wf.nodes ?? []) {
        for (const a of node.agents ?? []) {
          if (a.agentId?.trim()) referencedAgentIds.add(a.agentId.trim());
        }
      }
    }
    const exportedIdSet = new Set(agents.map((a) => a.id));
    const missingRefs = [...referencedAgentIds].filter((id) => !exportedIdSet.has(id));
    if (missingRefs.length > 0) {
      throw new Error(
        `Cannot export bundle: workflow(s) reference agent(s) not included in this export: ` +
          missingRefs.join(', ') +
          `. Include those agents or exclude the workflows referencing them.`
      );
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

    const coordinatorByHandle = longHorizonAgentRepo.getCoordinator(params.spaceId);
    const existingAgents = longHorizonAgentRepo
      .listBySpaceId(params.spaceId)
      .filter(
        (a) =>
          a.status !== 'archived' &&
          a.id !== coordinatorLongHorizonAgentId(params.spaceId) &&
          (!coordinatorByHandle || a.id !== coordinatorByHandle.id)
      )
      .map(longHorizonAgentToWorkerView);
    const existingWorkflows = workflowRepo.listWorkflows(params.spaceId);

    const agentNameAmbiguities = findAmbiguousAgentNames(existingAgents);
    const existingAgentByName = new Map(existingAgents.map((a) => [nameKey(a.name), a]));
    const existingWorkflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
    const nonRunnableIds = nonRunnableUnifiedIds(longHorizonAgentRepo, params.spaceId);
    const existingAgentNameToId = new Map(
      existingAgents.filter((a) => !nonRunnableIds.has(a.id)).map((a) => [nameKey(a.name), a.id])
    );

    const agentNameToRole = new Map<string, string>(
      existingAgents.map((a) => [nameKey(a.name), a.name])
    );

    const agentPreviews: ImportPreview[] = bundle.agents.map((a) => {
      const existing = existingAgentByName.get(nameKey(a.name));
      if (existing) return { name: a.name, action: 'conflict', existingId: existing.id };
      return { name: a.name, action: 'create' };
    });

    const workflowPreviews: ImportPreview[] = [];
    const validationErrors: string[] = [];

    const importedAgentNames = new Set(
      bundle.agents
        .filter((a) => {
          const existing = existingAgentByName.get(nameKey(a.name));
          return !existing || !nonRunnableIds.has(existing.id);
        })
        .map((a) => nameKey(a.name))
    );

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

    const coordinatorNameCollisions = bundle.agents
      .filter((a) =>
        reservedCoordinatorNames(longHorizonAgentRepo, params.spaceId).has(nameKey(a.name))
      )
      .map(
        (a) =>
          `Cannot import: agent name "${a.name}" is reserved by the space coordinator. ` +
          `Rename the agent in the bundle and retry.`
      );
    validationErrors.push(...agentNameAmbiguities);
    validationErrors.push(...coordinatorNameCollisions);
    validationErrors.push(...findDuplicateBundleAgentNames(bundle.agents));
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
    const deferredUnifiedUpdates: Array<{ spaceId: string; agentId: string }> = [];
    const executeImport = db.transaction(
      (spaceId: string, res: ImportConflictResolution): ImportExecuteResult => {
        const coordinatorByHandle = longHorizonAgentRepo.getCoordinator(spaceId);
        const existingAgents = longHorizonAgentRepo
          .listBySpaceId(spaceId)
          .filter(
            (a) =>
              a.status !== 'archived' &&
              a.id !== coordinatorLongHorizonAgentId(spaceId) &&
              (!coordinatorByHandle || a.id !== coordinatorByHandle.id)
          )
          .map(longHorizonAgentToWorkerView);
        const existingWorkflows = workflowRepo.listWorkflows(spaceId);

        assertUnambiguousAgentNames(existingAgents);
        const duplicateBundleNames = findDuplicateBundleAgentNames(bundle.agents);
        if (duplicateBundleNames.length > 0) throw new Error(duplicateBundleNames[0]);
        const coordinatorCollision = bundle.agents.find((a) =>
          reservedCoordinatorNames(longHorizonAgentRepo, spaceId).has(nameKey(a.name))
        );
        if (coordinatorCollision) {
          throw new Error(
            `Cannot import: agent name "${coordinatorCollision.name}" is reserved by the space coordinator.`
          );
        }
        const existingAgentByName = new Map(existingAgents.map((a) => [nameKey(a.name), a]));
        const existingWorkflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
        const nonRunnableIds = nonRunnableUnifiedIds(longHorizonAgentRepo, spaceId);
        const existingAgentNameToId = new Map(
          existingAgents
            .filter((a) => !nonRunnableIds.has(a.id))
            .map((a) => [nameKey(a.name), a.id])
        );

        const usedAgentNames = new Set(existingAgents.map((a) => nameKey(a.name)));
        const usedAgentHandles = new Set<string>([
          ...existingAgents.map((a) => a.handle).filter(Boolean),
          ...longHorizonAgentRepo.listBySpaceId(spaceId).map((a) => a.handle),
        ]);
        const usedWorkflowNames = new Set(existingWorkflows.map((w) => w.name));
        const usedWorkflowHandles = new Set(
          existingWorkflows.map((w) => w.handle).filter((h): h is string => !!h)
        );

        const replacedAgentByName = new Map<string, SpaceWorkerAgent>();
        const preservedReplaceHandleByName = new Map<string, string>();
        const fallbackReplaceHandleByName = new Map<string, string>();
        const fallbackBaseHandles = new Set<string>();
        for (const exportedAgent of bundle.agents) {
          const existing = existingAgentByName.get(nameKey(exportedAgent.name));
          if (!existing) continue;
          const strategy: ConflictResolutionStrategy = res.agents?.[exportedAgent.name] ?? 'skip';
          if (strategy !== 'replace') continue;
          replacedAgentByName.set(exportedAgent.name, existing);
          usedAgentHandles.delete(existing.handle);
          fallbackBaseHandles.add(existing.handle);
        }
        if (replacedAgentByName.size > 0) {
          const now = Date.now();
          const parkAgentHandle = db.prepare(
            `UPDATE space_long_horizon_agents SET handle = ?, updated_at = ? WHERE id = ?`
          );
          for (const agent of replacedAgentByName.values()) {
            const twin = longHorizonAgentRepo.getById(agent.id);
            if (!twin) continue;
            let parked = `${twin.handle}-${agent.id}`;
            let holder = longHorizonAgentRepo.getByHandle(spaceId, parked);
            while (holder && holder.id !== agent.id) {
              parked = `${parked}-2`;
              holder = longHorizonAgentRepo.getByHandle(spaceId, parked);
            }
            parkAgentHandle.run(parked, now, agent.id);
            usedAgentHandles.add(parked);
          }
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

        const importedAgentNameToId = new Map<string, string>();
        const agentResults: ImportedItem[] = [];
        const allWarnings: string[] = [];

        for (const exportedAgent of bundle.agents) {
          const existing = existingAgentByName.get(nameKey(exportedAgent.name));

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
            const created = longHorizonAgentRepo.create(createParams);
            usedAgentNames.add(nameKey(exportedAgent.name));
            usedAgentHandles.add(created.handle);
            importedAgentNameToId.set(nameKey(exportedAgent.name), created.id);
            agentResults.push({ name: exportedAgent.name, id: created.id, action: 'created' });
            continue;
          }

          const strategy: ConflictResolutionStrategy = res.agents?.[exportedAgent.name] ?? 'skip';

          if (strategy === 'skip') {
            if (!nonRunnableIds.has(existing.id)) {
              importedAgentNameToId.set(nameKey(exportedAgent.name), existing.id);
            }

            agentResults.push({ name: exportedAgent.name, id: existing.id, action: 'skipped' });
          } else if (strategy === 'replace') {
            const replaceParts = [exportedAgent.systemPrompt, exportedAgent.instructions].filter(
              (s): s is string => typeof s === 'string' && s.length > 0
            );
            const preservedHandle = preservedReplaceHandleByName.get(exportedAgent.name);
            const targetHandle =
              preservedHandle ?? fallbackReplaceHandleByName.get(exportedAgent.name);
            warnOnAgentHandleRewrite(
              exportedAgent,
              exportedAgent.name,
              usedAgentHandles,
              allWarnings,
              preservedHandle
            );
            longHorizonAgentRepo.update(existing.id, {
              displayName: exportedAgent.name,
              description: exportedAgent.description ?? null,
              model: exportedAgent.model ?? null,
              thinkingLevel: (exportedAgent.thinkingLevel ??
                null) as SpaceLongHorizonAgent['thinkingLevel'],
              provider: exportedAgent.provider ?? null,
              instructions: replaceParts.length > 0 ? replaceParts.join('\n\n') : '',
              settingSources: exportedAgent.settingSources ?? null,
              modelPool: exportedAgent.modelPool ?? null,
              handle: targetHandle,
              toolPermissions:
                exportedAgent.tools && exportedAgent.tools.length > 0
                  ? { tools: [...exportedAgent.tools] }
                  : {},
            });
            deferredUnifiedUpdates.push({ spaceId: existing.spaceId, agentId: existing.id });
            const id = existing.id;
            if (exportedAgent.provider == null) providerClearedAgentIds.push(id);
            if (!nonRunnableIds.has(existing.id)) {
              importedAgentNameToId.set(nameKey(exportedAgent.name), id);
            }
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
            const created = longHorizonAgentRepo.create(createParams);
            usedAgentNames.add(nameKey(finalName));
            usedAgentHandles.add(created.handle);
            importedAgentNameToId.set(nameKey(exportedAgent.name), created.id);
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
          deferredUnifiedUpdates,
        };
      }
    );

    const importResult = executeImport(params.spaceId, resolution);

    for (const ref of importResult.deferredUnifiedUpdates ?? []) {
      const unified = longHorizonAgentRepo.getById(ref.agentId);
      if (unified) {
        void publishUnifiedAgentUpdated(internalEventBus, unified, `space:${ref.spaceId}`);
      }
    }

    for (const agentId of providerClearedAgentIds) {
      await runtimeService?.clearLongTermAgentSessionProvider(params.spaceId, agentId);
    }

    const spaceId = params.spaceId;

    const deferredAgentIds = new Set(
      (importResult.deferredUnifiedUpdates ?? []).map((ref) => ref.agentId)
    );
    for (const item of importResult.agents) {
      if (item.action === 'skipped') continue;
      if (deferredAgentIds.has(item.id)) continue;
      const mirror = longHorizonAgentRepo.getById(item.id);
      if (!mirror) {
        log.warn(`Imported agent "${item.name}" has no unified record; skipping agent events`);
        continue;
      }
      if (item.action === 'replaced') {
        void publishUnifiedAgentUpdated(internalEventBus, mirror, `space:${spaceId}`);
      } else {
        void publishUnifiedAgentCreated(internalEventBus, mirror, `space:${spaceId}`);
      }
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
