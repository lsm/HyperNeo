import type {
  AgentModelPoolEntry,
  CreateSpaceAgentTemplateParams,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentTemplate,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ActorResolver } from '../../../../../messaging/src/contracts.ts';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types.ts';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceAgentGoalScopeRepository } from '../../../storage/repositories/space-agent-goal-scope-repository.ts';
import type { SpaceAgentReminderRepository } from '../../../storage/repositories/space-agent-reminder-repository.ts';
import type { SpaceAgentSubscriptionRepository } from '../../../storage/repositories/space-agent-subscription-repository.ts';
import { SpaceAgentTemplateRepository } from '../../../storage/repositories/space-agent-template-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import { createAgentEventSubscriptionImpls } from '../../external-events/agent-event-subscription-impls.ts';
import { validateSource } from '../../external-events/topic-validator.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import type { SessionManager } from '../../session/session-manager.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../../session-resolution/target.ts';
import { isReservedAgentHandle } from '../../messaging/agent-handle.ts';
import {
  getLongHorizonAgentTemplate,
  getLongHorizonAgentTemplates,
} from '../../agents/long-horizon-templates.ts';
import { deriveAgentTemplate } from '../../agents/template-derivation.ts';
import { validateAgentModel as validateLongHorizonModel } from '../../agents/agent-validation.ts';
import {
  type OwnedAgentLookup,
  publishSpaceAgentV2Mirror,
  publishUnifiedAgentCreated,
} from '../../agents/unified-agent-events.ts';
import {
  getBuiltInSpaceAgentTemplates,
  SpaceAgentTemplateManager,
} from '../../agents/template-manager.ts';
import type { SpaceManager } from '../managers/space-manager.ts';
import type { SpaceTaskManager } from '../../tasks/task-manager.ts';
import type { SpaceWorkflowManager } from '../../workflows/workflow-manager.ts';
import type { ReplyRoutingRegistry } from '../../messaging/reply-routing-registry.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import type { SpaceRuntime } from '../runtime/space-runtime.ts';
import {
  type NodeAgentTemplateSource,
  spaceAgentTemplateToNodeSource,
} from '../../tasks/spawn-slot-resolution.ts';
import type { TaskAgentManager } from '../runtime/task-agent-manager.ts';
import { getNextRunAt, isValidCronExpression } from '../../schedule/cron-utils.ts';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit } from '../slug.ts';
import {
  decideAutonomyAdmission,
  getToolAutonomyRequirement,
  resolveEffectiveAutonomyLevel,
} from '../tools/tool-admission-gates.ts';
import type { ToolResult } from '../tools/tool-result.ts';
import { jsonResult } from '../tools/tool-result.ts';

type SkippedTemplateSubscription = {
  source: string;
  topic: string;
  reason: string;
};

type SkippedTemplateReminder = {
  title: string;
  reason: string;
};

export function validateTemplateReminder(
  reminder: SpaceLongHorizonAgentTemplate['reminderDefaults'][number]
): { ok: true } | { ok: false; reason: string } {
  if (reminder.triggerType === 'cron') {
    const cronExpression = reminder.cronExpression?.trim() ?? '';
    if (cronExpression === '') {
      return { ok: false, reason: 'cron reminder is missing cronExpression' };
    }
    if (!isValidCronExpression(cronExpression)) {
      return { ok: false, reason: `invalid cron expression "${cronExpression}"` };
    }
  }
  return { ok: true };
}

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

export interface SpaceAgentToolsConfig {
  spaceId: string;
  db?: BunDatabase;
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  goalScopeRepo?: SpaceAgentGoalScopeRepository;
  subscriptionRepo?: SpaceAgentSubscriptionRepository;
  reminderRepo?: SpaceAgentReminderRepository;
  runtime: SpaceRuntime;
  workflowManager: SpaceWorkflowManager;
  spaceManager?: Pick<
    SpaceManager,
    'getSpace' | 'resolveWorkspaceSelection' | 'validateDefaultTaskWorkspace'
  >;
  taskRepo: SpaceTaskRepository;
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  isWorkflowRunActive?: (runId: string) => boolean;
  taskManager: SpaceTaskManager;
  sessionManager?: Pick<SessionManager, 'getCachedSession' | 'getSessionAsync' | 'sendUserMessage'>;
  clearLongTermAgentSessionProvider?: (spaceId: string, agentId: string) => Promise<void>;
  taskAgentManager?: TaskAgentManager;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  ownedAgents?: OwnedAgentLookup;
  activateNode?: (runId: string, nodeId: string) => Promise<void>;
  ensureTargetSession?: (target: SessionTarget) => Promise<EnsureSessionOutcome>;
  getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
  myAgentName?: string;
  myAgentNameAliases?: string[];
  myAgentId?: string;
  mySessionId?: string;
  callerRole?: SpaceMcpSessionRole;

  onRestoreNodeAgent?: (args: { reason?: string }) => Promise<void> | void;
  auditLogRepo?: McpAuditLogRepository;
  scheduleService?: import('../../schedule/schedule-service.ts').ScheduleService;
  replyRoutingRegistry?: ReplyRoutingRegistry;
  goalService?: import('../../goals/service.ts').SpaceGoalService;
  evolutionScopeService?: import('../../evolution/scope-service.ts').EvolutionScopeService;
  goalRepo?: import('../../../storage/repositories/space-goal-repository.ts').SpaceGoalRepository;
  messageResolver?: ActorResolver;
  longTermAgentDelivery?: {
    deliverToSession?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
    queueForActivation?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
  };
  externalEventStore?: ExternalEventStore;
  inactivityConfigRepo?: import('../../../storage/repositories/space-agent-inactivity-repository.ts').SpaceAgentInactivityConfigRepository;
  inactivityClaimRepo?: import('../../../storage/repositories/space-agent-inactivity-repository.ts').SpaceAgentInactivityClaimRepository;
  inactivityRunNow?: (spaceId: string, agentId: string) => Promise<void>;
  templateManager?: import('../../agents/template-manager.ts').SpaceAgentTemplateManager;
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

export function createSpaceAgentToolHandlers(config: SpaceAgentToolsConfig) {
  const uniqueAgentDisplayName = (base: string): string => {
    let candidate = base;
    let counter = 1;
    const taken = (name: string) => {
      const normalized = name.trim().toLowerCase();
      if (
        requireLongHorizonAgentRepo()
          .listBySpaceId(spaceId)
          .some(
            (existing) =>
              existing.status !== 'archived' &&
              (existing.displayName ?? '').trim().toLowerCase() === normalized
          )
      ) {
        return true;
      }
      return false;
    };
    while (taken(candidate)) {
      counter += 1;
      candidate = `${base} (${counter})`;
    }
    return candidate;
  };

  const ensureUniqueAgentDisplayName = (name: string, excludeId?: string): void => {
    const target = name.trim().toLowerCase();
    if (!target) return;
    const unifiedConflict = requireLongHorizonAgentRepo()
      .listBySpaceId(spaceId)
      .find(
        (candidate) =>
          candidate.status !== 'archived' &&
          candidate.id !== excludeId &&
          (candidate.displayName ?? '').trim().toLowerCase() === target
      );
    if (unifiedConflict) {
      throw new Error(`Agent name "${name}" is already used by another agent in this space`);
    }
  };

  const {
    spaceId,
    runtime,
    internalEventBus,
    getSpaceAutonomyLevel,
    myAgentName,
    myAgentId,
    mySessionId,
  } = config;

  const agentEventSubscriptions = createAgentEventSubscriptionImpls({
    spaceId,
    runtime,
    longHorizonAgentRepo: config.longHorizonAgentRepo,
    subscriptionRepo: config.subscriptionRepo,
    auditLogRepo: config.auditLogRepo,
    myAgentName,
    mySessionId,
  });

  function getCallingAgentAutonomyLevel(): SpaceAgentAutonomyLevel | null {
    if (!myAgentId) return null;
    const repo = config.longHorizonAgentRepo;
    if (!repo) return null;
    const agent = repo.getById(myAgentId);
    if (agent) {
      if (agent.spaceId !== spaceId) return null;
      return agent.autonomyLevel ?? null;
    }
    return 1;
  }

  async function requireSessionWriteAutonomy(toolName: string): Promise<void> {
    const spaceLevel = getSpaceAutonomyLevel ? await getSpaceAutonomyLevel(spaceId) : 1;
    const agentLevel = getCallingAgentAutonomyLevel();
    const { level } = resolveEffectiveAutonomyLevel({ spaceLevel, agentLevel });
    const required = getToolAutonomyRequirement(toolName);
    if (required === undefined) return;
    const admission = decideAutonomyAdmission({
      toolName,
      level,
      required,
      agentLevel,
      spaceLevel,
    });
    if (admission.action === 'allow') return;
    if (admission.reason === 'agent_autonomy_ceiling') {
      logAudit(toolName, {
        blocked: true,
        reason: admission.reason,
        agentLevel: admission.agentLevel,
        spaceLevel: admission.spaceLevel,
        required: admission.required,
      });
    }
    throw new Error(admission.message);
  }

  function requireLongHorizonAgentRepo(): SpaceLongHorizonAgentRepository {
    if (!config.longHorizonAgentRepo)
      throw new Error('Long-horizon agent management not available');
    return config.longHorizonAgentRepo;
  }

  function requireSubscriptionRepo(): SpaceAgentSubscriptionRepository {
    if (!config.subscriptionRepo) throw new Error('Long-horizon agent management not available');
    return config.subscriptionRepo;
  }

  function requireReminderRepo(): SpaceAgentReminderRepository {
    if (!config.reminderRepo) throw new Error('Long-horizon agent management not available');
    return config.reminderRepo;
  }

  function requireTemplateManager() {
    if (!config.templateManager) throw new Error('Agent template management not available');
    return config.templateManager;
  }

  function getLongHorizonAgentInSpace(agentId: string) {
    const existing = requireLongHorizonAgentRepo().getById(agentId);
    return existing?.spaceId === spaceId ? existing : null;
  }

  function requireLongHorizonAgentInSpace(agentId: string) {
    const agent = getLongHorizonAgentInSpace(agentId);
    if (!agent) throw new Error(`Long-horizon agent not found: ${agentId}`);
    return agent;
  }

  function uniqueLongHorizonAgentHandle(name: string): string {
    return slugifyWithinLimit(name, [
      ...requireLongHorizonAgentRepo()
        .listBySpaceId(spaceId)
        .map((agent) => agent.handle),
      ...RESERVED_SPACE_AGENT_HANDLES,
    ]);
  }

  function emitLongHorizonAgentCreated(agent: SpaceLongHorizonAgent): void {
    void publishUnifiedAgentCreated(internalEventBus, agent, mySessionId ?? 'space-agent-tools');
    void publishSpaceAgentV2Mirror(
      internalEventBus,
      config.ownedAgents,
      agent.spaceId,
      agent.id,
      'created'
    );
  }

  function logAudit(
    toolName: string,
    paramsSummary: Record<string, unknown>,
    taskId?: string
  ): void {
    if (config.auditLogRepo) {
      try {
        config.auditLogRepo.createEntry({
          agentName: myAgentName,
          sessionId: mySessionId,
          toolName,
          paramsSummary: JSON.stringify(paramsSummary),
          spaceId,
          taskId,
        });
      } catch {}
    }
  }

  function seedLongHorizonTemplateSubscriptions(
    agentId: string,
    subscriptions: SpaceLongHorizonAgentTemplate['suggestedEventSubscriptions']
  ): {
    seeded: Array<{ source: string; topic: string }>;
    skipped: SkippedTemplateSubscription[];
  } {
    const repo = requireSubscriptionRepo();
    const seeded: Array<{ source: string; topic: string }> = [];
    const skipped: SkippedTemplateSubscription[] = [];
    for (const sub of subscriptions) {
      const sourceCheck = validateSource(sub.source);
      if (!sourceCheck.valid) {
        skipped.push({
          source: sub.source,
          topic: sub.topic,
          reason: sourceCheck.reason ?? 'invalid source',
        });
        continue;
      }
      let stored: ReturnType<SpaceAgentSubscriptionRepository['upsertSubscription']> | undefined;
      try {
        stored = repo.upsertSubscription({
          spaceId,
          agentId,
          source: sub.source,
          topic: sub.topic,
          filter: sub.filter ?? {},
          status: 'active',
        });
        const refresh = runtime.refreshLongHorizonSubscription(spaceId, stored.id);
        if (!refresh.success) {
          try {
            repo.deleteSubscription(stored.id);
          } catch {}
          skipped.push({
            source: sub.source,
            topic: sub.topic,
            reason: refresh.error ?? 'invalid pattern',
          });
          continue;
        }
        seeded.push({ source: stored.source, topic: stored.topic });
      } catch (err) {
        if (stored) {
          try {
            repo.deleteSubscription(stored.id);
          } catch {}
        }
        skipped.push({
          source: sub.source,
          topic: sub.topic,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { seeded, skipped };
  }

  function seedLongHorizonTemplateReminders(
    agentId: string,
    reminders: SpaceLongHorizonAgentTemplate['reminderDefaults']
  ): { seeded: Array<{ title: string }>; skipped: SkippedTemplateReminder[] } {
    const repo = requireReminderRepo();
    const seeded: Array<{ title: string }> = [];
    const skipped: SkippedTemplateReminder[] = [];
    for (const reminder of reminders) {
      const check = validateTemplateReminder(reminder);
      if (!check.ok) {
        skipped.push({ title: reminder.title, reason: check.reason });
        continue;
      }
      try {
        const nextRunAt =
          reminder.triggerType === 'cron' && reminder.cronExpression
            ? getNextRunAt(reminder.cronExpression, reminder.timezone ?? 'UTC')
            : null;
        repo.createReminder({
          spaceId,
          agentId,
          title: reminder.title,
          body: reminder.body,
          triggerType: reminder.triggerType,
          cronExpression: reminder.cronExpression,
          timezone: reminder.timezone,
          nextRunAt,
          status: 'active',
          createdBySession: mySessionId ?? null,
        });
        seeded.push({ title: reminder.title });
      } catch (err) {
        skipped.push({
          title: reminder.title,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { seeded, skipped };
  }

  return {
    async create_agent_from_template(args: {
      template_name: string;
      name?: string;
      model?: string;
      provider?: string;
      thinking_level?: SpaceLongHorizonAgent['thinkingLevel'];
    }): Promise<ToolResult> {
      const templateName = args.template_name.trim();
      if (templateName === '') {
        return jsonResult({ success: false, error: 'template_name is required' });
      }

      const lhTemplate = runResolveAgentTemplateSource(templateName, config.db, spaceId);
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
        error: `Agent template not found: ${args.template_name}. Call list_agent_templates to discover available templates.`,
      });
    },

    async create_agent_template(args: {
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
    }): Promise<ToolResult> {
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
    },

    async update_agent_template(args: {
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
    }): Promise<ToolResult> {
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
            args.expected_version === undefined
              ? ''
              : ` (expected version ${args.expected_version})`;
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
    },

    async list_agent_templates(): Promise<ToolResult> {
      const entries = runListAgentTemplates(config.db, spaceId);
      return jsonResult({ success: true, long_horizon_templates: entries });
    },

    async delete_agent_template(args: {
      key: string;
      expected_version?: number;
    }): Promise<ToolResult> {
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
    },

    async subscribe_agent_event(args: {
      agent_id: string;
      topic_pattern: string;
      label?: string;
    }): Promise<ToolResult> {
      return agentEventSubscriptions.subscribeAgentEvent(args);
    },

    async unsubscribe_agent_event(args: {
      agent_id: string;
      topic_pattern: string;
      label?: string;
    }): Promise<ToolResult> {
      return agentEventSubscriptions.unsubscribeAgentEvent(args);
    },

    async list_agent_event_subscriptions(args: { agent_id: string }): Promise<ToolResult> {
      return agentEventSubscriptions.listAgentEventSubscriptions(args);
    },
  };
}
