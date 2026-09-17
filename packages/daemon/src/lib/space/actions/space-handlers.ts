import type {
  SpaceAgentAutonomyLevel,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentTemplate,
} from '@hyperneo/shared';
import type { ActorResolver } from '../../../../../messaging/src/contracts.ts';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types.ts';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceAgentGoalScopeRepository } from '../../../storage/repositories/space-agent-goal-scope-repository.ts';
import type { SpaceAgentReminderRepository } from '../../../storage/repositories/space-agent-reminder-repository.ts';
import type { SpaceAgentSubscriptionRepository } from '../../../storage/repositories/space-agent-subscription-repository.ts';
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
import {
  createAgentFromTemplate,
  createAgentTemplate,
  deleteAgentTemplate,
  listAgentTemplates,
  updateAgentTemplate,
  type AgentTemplateHandlerDeps,
  type CreateAgentFromTemplateArgs,
  type CreateAgentTemplateArgs,
  type DeleteAgentTemplateArgs,
  type UpdateAgentTemplateArgs,
} from '../../agents/agent-template-impls.ts';
import {
  type OwnedAgentLookup,
  publishSpaceAgentV2Mirror,
  publishUnifiedAgentCreated,
} from '../../agents/unified-agent-events.ts';
import type { SpaceManager } from '../managers/space-manager.ts';
import type { SpaceTaskManager } from '../../tasks/task-manager.ts';
import type { SpaceWorkflowManager } from '../../workflows/workflow-manager.ts';
import type { ReplyRoutingRegistry } from '../../messaging/reply-routing-registry.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import type { SpaceRuntime } from '../runtime/space-runtime.ts';
import type { TaskAgentManager } from '../runtime/task-agent-manager.ts';
import { getNextRunAt, isValidCronExpression } from '../../schedule/cron-utils.ts';
import { RESERVED_SPACE_AGENT_HANDLES, slugifyWithinLimit } from '../slug.ts';
import {
  decideAutonomyAdmission,
  getToolAutonomyRequirement,
  resolveEffectiveAutonomyLevel,
} from '../tools/tool-admission-gates.ts';
import type { ToolResult } from '../tools/tool-result.ts';

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

  const agentTemplateDeps: AgentTemplateHandlerDeps = {
    spaceId,
    db: config.db,
    logAudit,
    requireTemplateManager,
    requireLongHorizonAgentRepo,
    requireLongHorizonAgentInSpace,
    requireSessionWriteAutonomy,
    getCallingAgentAutonomyLevel,
    ensureUniqueAgentDisplayName,
    uniqueAgentDisplayName,
    uniqueLongHorizonAgentHandle,
    emitLongHorizonAgentCreated,
    seedLongHorizonTemplateSubscriptions,
    seedLongHorizonTemplateReminders,
  };

  return {
    async create_agent_from_template(args: CreateAgentFromTemplateArgs): Promise<ToolResult> {
      return createAgentFromTemplate(agentTemplateDeps, args);
    },

    async create_agent_template(args: CreateAgentTemplateArgs): Promise<ToolResult> {
      return createAgentTemplate(agentTemplateDeps, args);
    },

    async update_agent_template(args: UpdateAgentTemplateArgs): Promise<ToolResult> {
      return updateAgentTemplate(agentTemplateDeps, args);
    },

    async list_agent_templates(): Promise<ToolResult> {
      return listAgentTemplates(agentTemplateDeps);
    },

    async delete_agent_template(args: DeleteAgentTemplateArgs): Promise<ToolResult> {
      return deleteAgentTemplate(agentTemplateDeps, args);
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
