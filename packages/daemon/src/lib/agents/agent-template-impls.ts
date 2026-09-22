import type {
  AgentModelPoolEntry,
  CreateSpaceAgentTemplateParams,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentTemplate,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  type NodeAgentTemplateSource,
  spaceAgentTemplateToNodeSource,
} from '../tasks/spawn-slot-resolution.ts';
import { isReservedAgentHandle } from '../messaging/agent-handle.ts';
import { SpaceAgentTemplateRepository } from '../../storage/repositories/space-agent-template-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { jsonResult } from '../space/tools/tool-result.ts';
import type { ToolResult } from '../space/tools/tool-result.ts';
import {
  getLongHorizonAgentTemplate,
  getLongHorizonAgentTemplates,
} from './long-horizon-templates.ts';
import { deriveAgentTemplate } from './template-derivation.ts';
import { validateAgentModel as validateLongHorizonModel } from './agent-validation.ts';
import { getBuiltInSpaceAgentTemplates, SpaceAgentTemplateManager } from './template-manager.ts';

function longHorizonAgentTools(agent: SpaceLongHorizonAgent): string[] | null {
  const declared = agent.toolPermissions?.tools;
  return Array.isArray(declared)
    ? declared.filter((toolName): toolName is string => typeof toolName === 'string')
    : null;
}

function templateOverridesFromArgs(args: {
  display_name?: string;
  description?: string;
  instructions?: string;
  labels?: string[] | null;
  suggested_autonomy_level?: SpaceAgentAutonomyLevel;
  model?: string | null;
  provider?: string | null;
  model_pool?: AgentModelPoolEntry[] | null;
  thinking_level?: SpaceLongHorizonAgent['thinkingLevel'] | null;
  setting_sources?: SpaceLongHorizonAgent['settingSources'] | null;
  tools?: string[] | null;
}): Partial<CreateSpaceAgentTemplateParams> {
  const overrides: Partial<CreateSpaceAgentTemplateParams> = {};
  if (args.display_name !== undefined) overrides.displayName = args.display_name;
  if (args.description !== undefined) overrides.description = args.description;
  if (args.instructions !== undefined) overrides.instructions = args.instructions;
  if (args.labels !== undefined) overrides.labels = args.labels;
  if (args.suggested_autonomy_level !== undefined)
    overrides.suggestedAutonomyLevel = args.suggested_autonomy_level;
  if (args.model !== undefined) overrides.model = args.model;
  if (args.provider !== undefined) overrides.provider = args.provider;
  if (args.model_pool !== undefined) overrides.modelPool = args.model_pool;
  if (args.thinking_level !== undefined) overrides.thinkingLevel = args.thinking_level;
  if (args.setting_sources !== undefined) overrides.settingSources = args.setting_sources;
  if (args.tools !== undefined) overrides.tools = args.tools;
  return overrides;
}

type AgentTemplateLibrary = {
  source: 'merged-library' | 'builtin-fallback';
  templates: SpaceAgentTemplate[];
};

type AgentTemplateListEntry = {
  template_name: string;
  handle: string;
  display_name: string;
  description: string;
  suggested_autonomy_level: SpaceAgentAutonomyLevel;
  labels: string[];
  builtin: boolean;
  version: number | null;
};

function resolveAgentTemplateLibrary(
  db: BunDatabase | undefined,
  spaceId: string
): AgentTemplateLibrary {
  return db
    ? {
        source: 'merged-library',
        templates: new SpaceAgentTemplateManager(new SpaceAgentTemplateRepository(db)).listIn(
          spaceId
        ),
      }
    : { source: 'builtin-fallback', templates: getBuiltInSpaceAgentTemplates() };
}

function dropReservedFallbackHandles(library: AgentTemplateLibrary): AgentTemplateLibrary {
  if (library.source === 'merged-library') return library;
  return {
    ...library,
    templates: library.templates.filter((template) => !isReservedAgentHandle(template.handle)),
  };
}

function resolveTemplateVersions(
  db: BunDatabase | undefined,
  spaceId: string
): Map<string, number> {
  if (!db) return new Map();
  return new Map(
    new SpaceAgentTemplateRepository(db)
      .listOwnedWithVersions(spaceId)
      .map((template) => [template.key, template.version])
  );
}

function projectAgentTemplateEntries(
  library: AgentTemplateLibrary,
  versions: Map<string, number>
): AgentTemplateListEntry[] {
  const builtinKeys = new Set(getLongHorizonAgentTemplates().map((template) => template.key));
  return library.templates.map((template) => ({
    template_name: template.key,
    handle: template.handle,
    display_name: template.displayName,
    description: template.description,
    suggested_autonomy_level: template.suggestedAutonomyLevel,
    labels: template.labels,
    builtin: builtinKeys.has(template.key),
    version: versions.get(template.key) ?? null,
  }));
}

const runListAgentTemplates = (superpipe()('list-agent-templates') as PipelineAPI)
  .input(['db', 'spaceId'])
  .pipe(resolveAgentTemplateLibrary, ['db', 'spaceId'], 'library')
  .pipe(resolveTemplateVersions, ['db', 'spaceId'], 'versions')
  .pipe(dropReservedFallbackHandles, 'library', 'filteredLibrary')
  .pipe(projectAgentTemplateEntries, ['filteredLibrary', 'versions'], 'entries')
  .end('entries') as (db: BunDatabase | undefined, spaceId: string) => AgentTemplateListEntry[];

function resolveExactAgentTemplate(
  db: BunDatabase | undefined,
  templateName: string,
  spaceId: string
): NodeAgentTemplateSource | null {
  const builtIn = getLongHorizonAgentTemplates().find(
    (candidate) => candidate.key === templateName
  ) as NodeAgentTemplateSource | undefined;
  if (builtIn) return builtIn;
  const stored = db ? new SpaceAgentTemplateRepository(db).getOwned(spaceId, templateName) : null;
  return stored ? spaceAgentTemplateToNodeSource(stored) : null;
}

function fallbackBuiltinAgentTemplate(
  templateName: string,
  exact: NodeAgentTemplateSource | null
): NodeAgentTemplateSource | null {
  if (exact) return exact;
  const builtIn = getLongHorizonAgentTemplates().find(
    (candidate) => candidate.key.toLowerCase() === templateName.toLowerCase()
  ) as NodeAgentTemplateSource | undefined;
  return builtIn ?? null;
}

const runResolveAgentTemplateSource = (superpipe()('resolve-agent-template-source') as PipelineAPI)
  .input(['templateName', 'db', 'spaceId'])
  .pipe(resolveExactAgentTemplate, ['db', 'templateName', 'spaceId'], 'exact')
  .pipe(fallbackBuiltinAgentTemplate, ['templateName', 'exact'], 'template')
  .end('template') as (
  templateName: string,
  db: BunDatabase | undefined,
  spaceId: string
) => NodeAgentTemplateSource | null;

export type AgentTemplateHandlerDeps = {
  spaceId: string;
  db: BunDatabase | undefined;
  logAudit: (toolName: string, paramsSummary: Record<string, unknown>, taskId?: string) => void;
  requireTemplateManager: () => SpaceAgentTemplateManager;
  requireLongHorizonAgentRepo: () => SpaceLongHorizonAgentRepository;
  requireLongHorizonAgentInSpace: (agentId: string) => SpaceLongHorizonAgent;
  requireSessionWriteAutonomy: (toolName: string) => Promise<void>;
  getCallingAgentAutonomyLevel: () => SpaceAgentAutonomyLevel | null;
  ensureUniqueAgentDisplayName: (name: string, excludeId?: string) => void;
  uniqueAgentDisplayName: (base: string) => string;
  uniqueLongHorizonAgentHandle: (name: string) => string;
  emitLongHorizonAgentCreated: (agent: SpaceLongHorizonAgent) => void;
  seedLongHorizonTemplateSubscriptions: (
    agentId: string,
    subscriptions: SpaceLongHorizonAgentTemplate['suggestedEventSubscriptions']
  ) => {
    seeded: Array<{ source: string; topic: string }>;
    skipped: Array<{ source: string; topic: string; reason: string }>;
  };
  seedLongHorizonTemplateReminders: (
    agentId: string,
    reminders: SpaceLongHorizonAgentTemplate['reminderDefaults']
  ) => {
    seeded: Array<{ title: string }>;
    skipped: Array<{ title: string; reason: string }>;
  };
};

export type CreateAgentFromTemplateArgs = {
  template_name: string;
  name?: string;
  model?: string;
  provider?: string;
  thinking_level?: SpaceLongHorizonAgent['thinkingLevel'];
};

export type CreateAgentTemplateArgs = {
  key: string;
  handle: string;
  display_name?: string;
  description?: string;
  instructions?: string;
  labels?: string[];
  suggested_autonomy_level?: SpaceAgentAutonomyLevel;
  model?: string | null;
  provider?: string | null;
  model_pool?: AgentModelPoolEntry[] | null;
  thinking_level?: SpaceLongHorizonAgent['thinkingLevel'] | null;
  setting_sources?: SpaceLongHorizonAgent['settingSources'] | null;
  tools?: string[] | null;
  from_agent_id?: string;
};

export type UpdateAgentTemplateArgs = {
  key: string;
  expected_version?: number;
  display_name?: string;
  description?: string;
  instructions?: string;
  labels?: string[] | null;
  model?: string | null;
  provider?: string | null;
  model_pool?: AgentModelPoolEntry[] | null;
  thinking_level?: SpaceLongHorizonAgent['thinkingLevel'] | null;
  setting_sources?: SpaceLongHorizonAgent['settingSources'] | null;
  tools?: string[] | null;
};

export type DeleteAgentTemplateArgs = {
  key: string;
  expected_version?: number;
};

export async function createAgentFromTemplate(
  deps: AgentTemplateHandlerDeps,
  args: CreateAgentFromTemplateArgs
): Promise<ToolResult> {
  const {
    spaceId,
    db,
    logAudit,
    requireLongHorizonAgentRepo,
    getCallingAgentAutonomyLevel,
    ensureUniqueAgentDisplayName,
    uniqueAgentDisplayName,
    uniqueLongHorizonAgentHandle,
    emitLongHorizonAgentCreated,
    seedLongHorizonTemplateSubscriptions,
    seedLongHorizonTemplateReminders,
  } = deps;
  const templateName = args.template_name.trim();
  if (templateName === '') {
    return jsonResult({ success: false, error: 'template_name is required' });
  }

  const lhTemplate = runResolveAgentTemplateSource(templateName, db, spaceId);
  if (lhTemplate) {
    if (isReservedAgentHandle(lhTemplate.handle)) {
      return jsonResult({
        success: false,
        error:
          `Template "${lhTemplate.key}" uses the reserved handle ` +
          `"${lhTemplate.handle}", which is auto-created for every space and ` +
          `cannot be created here. It already exists — use list_agents / ` +
          `update_agent to inspect or modify it.`,
      });
    }
    const nameOverride = args.name?.trim();
    if (args.name !== undefined && nameOverride === '') {
      return jsonResult({ success: false, error: 'Agent name cannot be empty' });
    }
    try {
      const effectiveModel = args.model ?? lhTemplate.model ?? null;
      const effectiveProvider = args.provider ?? lhTemplate.provider ?? null;
      if (effectiveModel && (args.model !== undefined || args.provider !== undefined)) {
        const modelError = await validateLongHorizonModel(effectiveModel, effectiveProvider);
        if (modelError) return jsonResult({ success: false, error: modelError });
      }
      const repo = requireLongHorizonAgentRepo();
      const callerCeiling = getCallingAgentAutonomyLevel();
      const autonomyLevel: SpaceAgentAutonomyLevel =
        callerCeiling == null || lhTemplate.suggestedAutonomyLevel <= callerCeiling
          ? lhTemplate.suggestedAutonomyLevel
          : callerCeiling;
      const templateDisplayName = nameOverride
        ? (ensureUniqueAgentDisplayName(nameOverride), nameOverride)
        : uniqueAgentDisplayName(lhTemplate.displayName);
      const agent = repo.create({
        spaceId,
        handle: uniqueLongHorizonAgentHandle(
          nameOverride ? templateDisplayName : lhTemplate.handle
        ),
        displayName: templateDisplayName,
        templateKey: lhTemplate.key,
        description: lhTemplate.description,
        instructions: lhTemplate.instructions,
        autonomyLevel,
        model: effectiveModel,
        provider: effectiveProvider,
        thinkingLevel: args.thinking_level ?? lhTemplate.thinkingLevel ?? null,
        settingSources: lhTemplate.settingSources ?? null,
        modelPool: lhTemplate.modelPool ?? undefined,
        toolPermissions: lhTemplate.toolPermissions,
      });
      const subscriptions = seedLongHorizonTemplateSubscriptions(
        agent.id,
        lhTemplate.suggestedEventSubscriptions
      );
      const reminders = seedLongHorizonTemplateReminders(agent.id, lhTemplate.reminderDefaults);
      emitLongHorizonAgentCreated(agent);
      logAudit('create_agent_from_template', {
        template_name: args.template_name,
        name: args.name,
        long_horizon: true,
      });
      return jsonResult({
        success: true,
        agent,
        seeded_subscriptions: subscriptions.seeded,
        skipped_subscriptions: subscriptions.skipped,
        seeded_reminders: reminders.seeded,
        skipped_reminders: reminders.skipped,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResult({ success: false, error: message });
    }
  }

  return jsonResult({
    success: false,
    error: `Agent template not found: ${args.template_name}. Call agent.template.list to discover available templates.`,
  });
}

export async function createAgentTemplate(
  deps: AgentTemplateHandlerDeps,
  args: CreateAgentTemplateArgs
): Promise<ToolResult> {
  const { spaceId, logAudit, requireLongHorizonAgentInSpace, requireTemplateManager } = deps;
  try {
    const { key, handle, from_agent_id } = args;
    const overrides = templateOverridesFromArgs(args);
    let params: CreateSpaceAgentTemplateParams = { key, handle, ...overrides };
    if (from_agent_id !== undefined) {
      const agent = requireLongHorizonAgentInSpace(from_agent_id);
      params = {
        ...deriveAgentTemplate(
          {
            displayName: agent.displayName,
            handle: agent.handle,
            description: agent.description ?? null,
            instructions: agent.instructions,
            model: agent.model,
            provider: agent.provider,
            thinkingLevel: agent.thinkingLevel,
            settingSources: agent.settingSources,
            tools: longHorizonAgentTools(agent),
            modelPool: agent.modelPool ?? null,
            autonomyLevel: agent.autonomyLevel,
          },
          { key }
        ),
        ...overrides,
        key,
        handle,
      };
    }
    const result = await requireTemplateManager().createIn(spaceId, params);
    if (!result.ok) return jsonResult({ success: false, error: result.error });
    logAudit('create_agent_template', { key: args.key, from_agent_id: args.from_agent_id });
    return jsonResult({ success: true, template: result.value });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ success: false, error: message });
  }
}

export async function updateAgentTemplate(
  deps: AgentTemplateHandlerDeps,
  args: UpdateAgentTemplateArgs
): Promise<ToolResult> {
  const { spaceId, logAudit, requireTemplateManager } = deps;
  try {
    if (getLongHorizonAgentTemplate(args.key)) {
      return jsonResult({
        success: false,
        error: `Template "${args.key}" is built-in and cannot be updated; built-ins live in the code registry (packages/daemon/src/lib/agents/long-horizon-templates.ts)`,
      });
    }
    const result = await requireTemplateManager().casUpdateIn(
      spaceId,
      args.key,
      templateOverridesFromArgs(args),
      args.expected_version
    );
    if (!result.ok) return jsonResult({ success: false, error: result.error });
    if (result.value === null) {
      const expected =
        args.expected_version === undefined ? '' : ` (expected version ${args.expected_version})`;
      return jsonResult({
        success: false,
        error: `Template "${args.key}" was modified concurrently${expected}; re-check the template and retry with its current version`,
      });
    }
    logAudit('update_agent_template', {
      key: args.key,
      expected_version: args.expected_version,
    });
    return jsonResult({ success: true, template: result.value });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ success: false, error: message });
  }
}

export async function listAgentTemplates(deps: AgentTemplateHandlerDeps): Promise<ToolResult> {
  const { db, spaceId } = deps;
  const entries = runListAgentTemplates(db, spaceId);
  return jsonResult({ success: true, long_horizon_templates: entries });
}

export async function deleteAgentTemplate(
  deps: AgentTemplateHandlerDeps,
  args: DeleteAgentTemplateArgs
): Promise<ToolResult> {
  const { spaceId, logAudit, requireSessionWriteAutonomy, requireTemplateManager } = deps;
  try {
    await requireSessionWriteAutonomy('delete_agent_template');
    const result = requireTemplateManager().deleteIn(spaceId, args.key, args.expected_version);
    if (!result.ok) return jsonResult({ success: false, error: result.error });
    logAudit('delete_agent_template', { key: args.key, version: args.expected_version });
    return jsonResult({ success: true, deleted: args.key });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ success: false, error: message });
  }
}
