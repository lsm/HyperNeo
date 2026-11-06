import { setupAgentMemoryHandlers } from '../../rpc-handlers/agent-memory-handlers.ts';
import { createWorkflowTaskRecoveryExecutor } from '../../tasks/recovery-executor.ts';
import { recoverTaskExecution } from '../../tasks/recover-task-execution.ts';
import { createCompletionGateBindings } from '../../tasks/complete-task-gates.ts';
import { isCoderOwnedMergeWorkflow } from '../../workflows/post-approval-router.ts';
import { createSpaceCallerScopeResolver } from '../../session-resolution/space-caller-scope.ts';
import { createSpaceScopeResolver } from '../runtime/space-scope-resolver.ts';
import { createDatabaseDirectTaskWorkerResolver } from '../../tasks/direct-task-worker-identity.ts';
import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { AgentSession } from '../../agent/agent-session.ts';
import { setupSpaceTaskMessageHandlers } from '../../../../../space/src/rpc/space-task-message-handlers.ts';
import { createDefaultSessionResolutionDeps } from '../runtime/session-resolution-deps.ts';
import { ensureSession } from '../../session-resolution/ensure-session.ts';
import { TaskAgentManager } from '../runtime/task-agent-manager.ts';
import { spaceTaskWriter } from '../../../storage/repositories/space-task-repository.ts';
import { WorkflowHookStateRepository } from '../../../storage/repositories/workflow-hook-state-repository.ts';
import {
  deliverSpaceAgentMessage,
  type SessionInjectionOutcome,
} from '../../messaging/session-message-delivery.ts';
import { resolveDeliverySession } from '../../session-resolution/resolve-delivery-session.ts';
import { setupSpaceWorkflowRunHandlers } from '../../../../../space/src/rpc/space-workflow-run-handlers.ts';
import { setupNodeExecutionHandlers } from '../../../../../space/src/rpc/space-node-execution-handlers.ts';
import { setupSpaceExportImportHandlers } from '../../../../../space/src/rpc/space-export-import-handlers.ts';
import type { TaskAgentManagerConfig } from '../runtime/task-agent-manager.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import type { SessionReportHandler } from '../../messaging/message-send.ts';
import type { createNeoCodingReaders } from '../../neo/packs/runtime.ts';

type CodingPrStateReader = ReturnType<typeof createNeoCodingReaders>['readPrState'];
import { stampActiveAttemptList } from '../../tasks/direct-attempt-flag.ts';
import { registerDirectStartJobs } from '../../tasks/direct-start-jobs.ts';
import {
  createDirectOutcomeRequester,
  registerDirectOutcomeJobs,
} from '../../tasks/direct-outcome-jobs.ts';
import { settleTaskDependents } from '../../tasks/settle-dependents.ts';
import { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import { createSpaceOperationRegistryProvider } from '../../tasks/operations.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import type { SessionMetadata, SpaceTask } from '@hyperneo/shared';
import type { SpaceGoalOutcomeNotification } from '@hyperneo/shared';
import { Logger } from '../../logger.ts';
import { setupSpaceHandlers } from '../../../../../space/src/rpc/space-handlers.ts';
import { publishUnifiedAgentCreated } from '../../agents/unified-agent-events.ts';
import { createResolveClones } from '../../session/clone-cascade.ts';
import { nameClonedAgent } from '../../agents/agent-identity.ts';
import { nodeWorkspaceValidationIo } from '../../workspaces/validation-pipeline.ts';
import { createCloneLifecycleEffects } from '../../rpc-handlers/session-handlers.ts';
import { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import { ReplyRoutingRegistry } from '../../messaging/reply-routing-registry.ts';
import { SpaceWorktreeManager } from '../../workspaces/worktree-manager.ts';
import { CodingArtifactProfile } from '../../workflows/coding-artifact-profile.ts';
import {
  setupSpaceWorkflowHandlers,
  checkBuiltInWorkflowDriftOnStartup,
  restampBuiltInWorkflowsOnStartup,
} from '../../../../../space/src/rpc/space-workflow-handlers.ts';
import { SpaceTaskManager } from '../../tasks/task-manager.ts';
import { SpaceWorkflowManager, createSpaceAgentLookup } from '../../workflows/workflow-manager.ts';
import type { SpaceAgentLookup } from '../../workflows/workflow-manager.ts';
import { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../storage/repositories/workflow-run-artifact-repository.ts';
import { createConversationFrictionEvidenceHandler } from '../../../../../space/src/job-handlers/conversation-friction-evidence.handler.ts';
import { handleGoalAutomationExecute } from '../../../../../space/src/job-handlers/goal-automation-execute.handler.ts';
import { GoalAutomationService } from '../../../../../space/src/goals/automation-service.ts';
import {
  GOAL_AUTOMATION_EXECUTE,
  SPACE_CONVERSATION_FRICTION_ANALYZE,
} from '../../job-queue-constants.ts';
import { ChannelCycleRepository } from '../../../storage/repositories/channel-cycle-repository.ts';
import { SessionRepository } from '../../../storage/repositories/session-repository.ts';
import { setupSpaceAgentReminderHandlers } from '../../../../../space/src/rpc/space-agent-reminder-handlers.ts';
import { setupSpaceAgentSubscriptionHandlers } from '../../../../../space/src/rpc/space-agent-subscription-handlers.ts';
import { setupSpaceAgentTemplateHandlers } from '../../../../../space/src/rpc/space-agent-template-handlers.ts';
import {
  buildAgentCreate,
  type SpaceAgentV2Deps,
  setupSpaceAgentV2Handlers,
} from '../../../../../space/src/rpc/space-agent-v2-handlers.ts';
import { buildTemplateExtrasSeeder } from '../../agents/template-extras-seeding.ts';
import { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository.ts';
import {
  SpaceLongHorizonAgentRepository,
  templateInstanceScanFromRepo,
} from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceAgentTemplateRepository } from '../../../storage/repositories/space-agent-template-repository.ts';
import { SpaceAgentGoalScopeRepository } from '../../../storage/repositories/space-agent-goal-scope-repository.ts';
import { SpaceAgentRepository } from '../../../storage/repositories/space-agent-repository.ts';
import { SpaceAgentReminderRepository } from '../../../storage/repositories/space-agent-reminder-repository.ts';
import { SpaceAgentSubscriptionRepository } from '../../../storage/repositories/space-agent-subscription-repository.ts';
import { SpaceSessionEventSubscriptionRepository } from '../../../storage/repositories/space-session-event-subscription-repository.ts';
import { SpaceAgentTemplateManager } from '../../agents/template-manager.ts';
import { createAgentTemplateResolverFactory } from '../../workflows/run-template-snapshot.ts';
import type { EvolutionRepository } from '../../../storage/repositories/evolution-repository.ts';
import { SpaceRuntimeService } from '../runtime/space-runtime-service.ts';
import { GOAL_OUTCOME_WAKE_ENABLED } from '../runtime/goal-outcome-wake-flag.ts';
import { SpaceAgentInactivityWatchdogService } from '../../agents/inactivity-watchdog-service.ts';
import type { InactivityWatchdogSessionSnapshot } from '../../agents/inactivity-watchdog-service.ts';
import {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
} from '../../../storage/repositories/space-agent-inactivity-repository.ts';
import { TaskScheduleRepository } from '../../../storage/repositories/task-schedule-repository.ts';
import { SpaceRepository } from '../../../storage/repositories/space-repository.ts';
import { setupTaskScheduleHandlers } from '../../../../../space/src/rpc/task-schedule-handlers.ts';
import { setupSpaceGoalHandlers } from '../../../../../space/src/rpc/space-goal-handlers.ts';
import { subscribeAgentActivationOutcomeRedelivery } from '../../../../../space/src/goals/agent-activation-outcome-redelivery.ts';
import { subscribeGoalOwnerChangeOutcomeRedelivery } from '../../../../../space/src/goals/owner-change-outcome-redelivery.ts';
import { setupEvolutionHandlers } from '../../../../../space/src/rpc/evolution-handlers.ts';
import { EvolutionConversationAnalysisService } from '../../../../../space/src/evolution/conversation-analysis-service.ts';
import { EvolutionEpisodeService } from '../../../../../space/src/evolution/episode-service.ts';
import { EvolutionScopeService } from '../../../../../space/src/evolution/scope-service.ts';
import { EvolutionTraceEvidenceService } from '../../../../../space/src/evolution/trace-evidence-service.ts';
import { ScheduleService } from '../../schedule/schedule-service.ts';
import { SpaceGoalEventRepository } from '../../../storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalOutcomeNotificationRepository } from '../../../storage/repositories/space-goal-outcome-notification-repository.ts';
import { SpaceGoalRepository } from '../../../storage/repositories/space-goal-repository.ts';
import { SpaceGoalService } from '../../../../../space/src/goals/service.ts';
import { mergeEvolutionPolicy } from '../../../../../space/src/evolution/scope-service.ts';
import type { RPCHandlerDependencies } from '../../rpc-handlers/index.ts';
import type { ExternalEventService } from '../../external-events/external-event-service.ts';
import type { ExternalEventStore } from '../../../../../space/src/external-events/external-event-store.ts';
import type { ExternalEventDeliveryState } from '../../external-events/types.ts';
import type { SpaceRpcHost } from '../../rpc-handlers/space-rpc.ts';
import { createSpaceSessionPort } from '../runtime/space-session-port.ts';
import type { FamilyOperationContext } from '../../rpc-handlers/family-operations/context.ts';
import {
  collectSpaceFamilyOperations,
  createSessionSpacePort,
} from '../../../../../space/src/rpc/family-operations/space.ts';
import { setupSpaceMcpHandlers } from '../../../../../space/src/rpc/space-mcp-handlers.ts';
import { archiveAgentSessions } from '../../../../../space/src/rpc/space-agent-v2-handlers.ts';
import type { SessionTarget } from '../../session-resolution/target.ts';
import type { SpaceManager } from '../../../../../space/src/managers/space-manager.ts';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { OperationRegistry } from '../../operations/registry.ts';

import { validateGoalAutomationSelfNagPolicy } from '../../../../../space/src/evolution/evolution-policy-validation.ts';
import { syncGoalAutomationSelfNagScheduleForScope } from '../../../../../space/src/goals/automation-schedule-sync.ts';

const log = new Logger('rpc-handlers');

function createGoalAutomationSelfNagSchedules(
  goalRepo: SpaceGoalRepository,
  scheduleService: ScheduleService,
  evolutionRepo: EvolutionRepository
): void {
  for (const goal of goalRepo.listAllActive()) {
    for (const scope of evolutionRepo.listScopes({ spaceId: goal.spaceId, spaceGoalId: goal.id })) {
      try {
        syncGoalAutomationSelfNagScheduleForScope({ goalRepo, scheduleService, scope });
      } catch (err) {
        log.warn('could not create Evolution self-nag schedule', err);
      }
    }
  }
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export interface SpaceRpcDependencies extends RPCHandlerDependencies {
  spaceManager: SpaceManager;
  externalEventStore: ExternalEventStore;
  externalEventService: ExternalEventService;
}

const EXTERNAL_EVENT_DELIVERY_STATES: ExternalEventDeliveryState[] = [
  'pending',
  'delivered',
  'failed',
];

function setupSpaceExternalEventHandlers(deps: SpaceRpcDependencies): void {
  deps.messageHub.onRequest('space.externalEvents.listDeliveries', async (data) => {
    const params = (data ?? {}) as {
      spaceId?: string;
      status?: ExternalEventDeliveryState;
      eventId?: string;
      agentName?: string;
      limit?: number;
      offset?: number;
    };
    if (!params.spaceId || typeof params.spaceId !== 'string') {
      throw new Error('spaceId is required');
    }
    if (params.status && !EXTERNAL_EVENT_DELIVERY_STATES.includes(params.status)) {
      throw new Error(`Invalid delivery status: ${params.status}`);
    }
    const deliveries = deps.externalEventStore.listDeliveryLog({
      spaceId: params.spaceId,
      status: params.status,
      eventId: params.eventId,
      agentName: params.agentName,
      limit: params.limit,
      offset: params.offset,
    });
    return { deliveries };
  });
}

async function setupSpaceServices(
  deps: SpaceRpcDependencies,
  {
    spaceOperationRegistryProvider,
  }: {
    spaceOperationRegistryProvider: () => OperationRegistry;
  }
) {
  const pendingInactivityRunNow = new Set<Promise<void>>();
  let inactivityRunNowCancelled = false;
  let inactivityAborted = false;

  const spaceTaskRepo = new SpaceTaskRepository(deps.db.getDatabase(), deps.reactiveDb);
  const spaceWorkflowRunRepo = new SpaceWorkflowRunRepository(deps.db.getDatabase());
  const artifactRepo = new WorkflowRunArtifactRepository(deps.db.getDatabase(), deps.reactiveDb);
  const channelCycleRepo = new ChannelCycleRepository(deps.db.getDatabase());
  const taskScheduleRepo = new TaskScheduleRepository(deps.db.getDatabase());
  const spaceRepo = new SpaceRepository(deps.db.getDatabase());
  const sessionRepo = new SessionRepository(deps.db.getDatabase());

  const scheduleService = new ScheduleService({
    db: deps.db.getDatabase(),
    scheduleRepo: taskScheduleRepo,
    jobQueue: deps.jobQueue,
    spaceRepo,
  });

  const spaceGoalRepo = new SpaceGoalRepository(deps.db.getDatabase(), deps.reactiveDb);
  const spaceGoalEventRepo = new SpaceGoalEventRepository(deps.db.getDatabase(), deps.reactiveDb);
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(deps.db.getDatabase());
  const outcomeNotificationRepo = new SpaceGoalOutcomeNotificationRepository(deps.db.getDatabase());
  const evolutionTraceEvidenceService = new EvolutionTraceEvidenceService({
    db: deps.db.getDatabase(),
    evolutionRepo: deps.db.evolution,
    taskRepo: spaceTaskRepo,
  });
  const evolutionConversationAnalysisService = new EvolutionConversationAnalysisService({
    db: deps.db.getDatabase(),
    evolutionRepo: deps.db.evolution,
    taskRepo: spaceTaskRepo,
    spaceRepo,
  });
  deps.jobProcessor.register(
    SPACE_CONVERSATION_FRICTION_ANALYZE,
    createConversationFrictionEvidenceHandler(evolutionConversationAnalysisService)
  );
  const evolutionScopeService = new EvolutionScopeService({
    evolutionRepo: deps.db.evolution,
    spaceRepo,
    goalRepo: spaceGoalRepo,
    taskRepo: spaceTaskRepo,
    workflowRunRepo: spaceWorkflowRunRepo,
    artifactRepo,
    traceEvidenceService: evolutionTraceEvidenceService,
    jobQueue: deps.jobQueue,
  });
  let deliverOutcomeWake: (notification: SpaceGoalOutcomeNotification) => void = () => {};
  const spaceAgentRepo = new SpaceAgentRepository(deps.db.getDatabase());
  const spaceAgentGoalScopeRepo = new SpaceAgentGoalScopeRepository(
    deps.db.getDatabase(),
    spaceAgentRepo
  );

  const spaceGoalService = new SpaceGoalService({
    goalRepo: spaceGoalRepo,
    goalEventRepo: spaceGoalEventRepo,
    taskRepo: spaceTaskRepo,
    spaceRepo,
    scheduleService,
    db: deps.db.getDatabase(),
    goalScopeRepo: spaceAgentGoalScopeRepo,
    agentRepo: spaceAgentRepo,
    outcomeNotificationRepo,
    evolutionScopeService,
    reactiveDb: deps.reactiveDb,
    eventHub: {
      publish: (event, data) => deps.internalEventBus.publish(event as never, data as never),
    },
    resolveWorkspacePath: (spaceId, rawPath) =>
      deps.spaceManager.resolveRegisteredWorkspacePath(spaceId, rawPath),
    onGoalResumed: (goalId, spaceId) => {
      for (const scope of deps.db.evolution.listScopes({ spaceId, spaceGoalId: goalId })) {
        try {
          syncGoalAutomationSelfNagScheduleForScope({
            goalRepo: spaceGoalRepo,
            scheduleService,
            scope,
            db: deps.db.getDatabase(),
          });
        } catch (err) {
          log.warn('could not sync self-nag schedule on goal resume', err);
        }
      }
    },
    onOutcomeNotification: (notification) => {
      try {
        deliverOutcomeWake(notification);
      } catch (err) {
        log.warn(
          `Goal outcome wake delivery threw for notification "${notification.id}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  });
  const goalAutomationService = new GoalAutomationService({
    goalRepo: spaceGoalRepo,
    taskRepo: spaceTaskRepo,
    evolutionRepo: deps.db.evolution,
    cursorRepo: deps.db.goalAutomationCursors,
    jobQueue: deps.jobQueue,
    evolutionScopeService,
  });
  spaceGoalService.setGoalAutomationService(goalAutomationService);
  createGoalAutomationSelfNagSchedules(spaceGoalRepo, scheduleService, deps.db.evolution);
  deps.internalEventBus.subscribe(
    'externalEvent.published',
    (event) => {
      goalAutomationService.onExternalEventPublished(event);
    },
    { subscriberName: 'goal-automation-service' }
  );

  const spaceWorkflowRepo = new SpaceWorkflowRepository(deps.db.getDatabase());
  spaceWorkflowRepo.backfillExistingDefinitionVersions();
  const spaceAgentTemplateRepo = new SpaceAgentTemplateRepository(deps.db.getDatabase());
  const agentTemplateResolverFor = createAgentTemplateResolverFactory(spaceAgentTemplateRepo);
  await spaceWorkflowRunRepo.backfillDefinitionPins(
    (id) => spaceWorkflowRepo.getWorkflow(id),
    agentTemplateResolverFor
  );
  await spaceWorkflowRunRepo.migrateSnapshotlessPins(agentTemplateResolverFor, (id) =>
    spaceWorkflowRepo.getWorkflow(id)
  );
  const agentLookup: SpaceAgentLookup = createSpaceAgentLookup(longHorizonAgentRepo);
  const spaceWorkflowManager = new SpaceWorkflowManager(
    spaceWorkflowRepo,
    agentLookup,
    spaceAgentTemplateRepo
  );

  const emitClaimedTaskUpdate = (taskId: string) => {
    const task = spaceTaskRepo.getTask(taskId);
    if (!task) return;
    void deps.internalEventBus
      .publish('space.task.updated', {
        sessionId: 'global',
        spaceId: task.spaceId,
        taskId: task.id,
        task,
      })
      .catch((error) => log.warn('Failed to emit direct claim task update:', error));
  };

  registerDirectStartJobs({
    db: deps.db.getDatabase(),
    reactiveDb: deps.reactiveDb,
    sessionDb: deps.db,
    sessionManager: deps.sessionManager,
    defaultModel: deps.config.defaultModel,
    jobQueue: deps.jobQueue,
    jobProcessor: deps.jobProcessor,
    onTaskReopened: (taskId) => spaceGoalService.supersedeOutcomeNotificationsForTask(taskId),
    onTaskClaimed: emitClaimedTaskUpdate,
    onTaskActivated: emitClaimedTaskUpdate,
  });

  registerDirectOutcomeJobs({
    db: deps.db.getDatabase(),
    reactiveDb: deps.reactiveDb,
    sessionManager: deps.sessionManager,
    jobQueue: deps.jobQueue,
    jobProcessor: deps.jobProcessor,
    onAttemptRetired: emitClaimedTaskUpdate,
    onTaskUpdated: (task) =>
      void deps.internalEventBus
        .publish('space.task.updated', {
          sessionId: 'global',
          spaceId: task.spaceId,
          taskId: task.id,
          task,
        })
        .catch((error) => log.warn('Failed to emit direct outcome task update:', error)),
    settleDependents: (task) => settleEndedTask(task),
    onTaskReopened: (taskId) => spaceGoalService.supersedeOutcomeNotificationsForTask(taskId),
    onTerminalTransition: (taskId, fromStatus) =>
      spaceGoalService.handleTaskTerminal(taskId, { fromStatus, deferPostCommitEffects: true }),
  });

  const settleEndedTask = (task: SpaceTask) =>
    settleTaskDependents(task, {
      getTaskManager: spaceTaskManagerFactory,
      getActiveAttempt: (taskId) =>
        new DirectTaskExecutionRepository(deps.db.getDatabase()).getActive(taskId),
      stopForStatus: (spaceId, taskId, params, expected) =>
        spaceRuntimeService.stopWorkflowBackedTaskForStatus(spaceId, taskId, params, expected),
      requestDirectOutcome: createDirectOutcomeRequester(deps.db.getDatabase(), deps.jobQueue),
    });

  const spaceTaskManagerFactory = (spaceId: string): SpaceTaskManager => {
    return new SpaceTaskManager(
      deps.db.getDatabase(),
      spaceId,
      deps.reactiveDb,
      evolutionScopeService,
      (taskId) => spaceGoalService.supersedeOutcomeNotificationsForTask(taskId),
      (taskId, fromStatus) =>
        spaceGoalService.handleTaskTerminal(taskId, { fromStatus, deferPostCommitEffects: true }),
      (rawPath) => deps.spaceManager.resolveRegisteredWorkspacePath(spaceId, rawPath),
      settleEndedTask
    );
  };

  setupSpaceWorkflowHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceWorkflowManager,
    deps.internalEventBus,
    spaceWorkflowRunRepo
  );

  void restampBuiltInWorkflowsOnStartup(
    spaceWorkflowManager,
    deps.spaceManager,
    (workflowId) =>
      spaceWorkflowRunRepo
        .listByWorkflow(workflowId)
        .some(
          (run) =>
            run.status === 'in_progress' || run.status === 'blocked' || run.status === 'pending'
        ) || spaceTaskRepo.hasApprovedTaskForWorkflow(workflowId)
  )
    .then(() => {
      void checkBuiltInWorkflowDriftOnStartup(spaceWorkflowManager, deps.spaceManager);
    })
    .catch((err: unknown) => {
      log.warn('built-in workflow restamp failed:', err);
    });

  const nodeExecutionRepo = new NodeExecutionRepository(deps.db.getDatabase(), deps.reactiveDb);
  const pendingCompletion: Parameters<typeof createSpaceOperationRegistryProvider>[3] = {
    getSession: (id) => deps.db.getSession(id),
    getTask: (id) => spaceTaskRepo.getTask(id),
    getTaskManager: spaceTaskManagerFactory,
    policyContext: { taskRepo: spaceTaskRepo, nodeExecutionRepo, longHorizonAgentRepo },
    getSpaceAutonomyLevel: async (spaceId) => {
      const space = await deps.spaceManager.getSpace(spaceId);
      return space?.autonomyLevel ?? 1;
    },
    dispatchApproval: (spaceId, taskId, source, approvalReason, guard) =>
      spaceRuntimeService.dispatchPostApproval(spaceId, taskId, source, { approvalReason }, guard),
    warn: (operationName, taskId, detail) =>
      log.warn(`${operationName}: dispatch failed after approval for ${taskId}: ${detail}`),
    emitTaskUpdated: async (spaceId, task) => {
      await deps.internalEventBus.publish('space.task.updated', {
        sessionId: 'global',
        spaceId,
        taskId: task.id,
        task,
      });
    },
    audit: (operationName, session, previous, input) => {
      new McpAuditLogRepository(deps.db.getDatabase()).createEntry({
        sessionId: session.id,
        agentName: session.metadata.promptProvenance?.agentName,
        toolName: operationName,
        spaceId: previous.spaceId,
        taskId: input.taskId,
        paramsSummary: JSON.stringify({
          approved: input.approved,
          reason: input.reason,
          previousStatus: previous.status,
        }),
      });
    },
  };
  const replyRoutingRegistry = new ReplyRoutingRegistry();
  const artifactProfile = new CodingArtifactProfile({
    db: deps.db.getDatabase(),
    artifactRepo,
    resolvePrReadyHookIds: (runId: string) => {
      const run = spaceWorkflowRunRepo.getRun(runId);
      if (!run?.workflowId) return undefined;
      const wf = spaceWorkflowManager.getWorkflowForRun(run);
      if (!wf) return undefined;
      const ids = new Set<string>();
      for (const h of wf.hooks ?? []) {
        if (h.validator?.kind === 'built_in' && h.validator.id === 'pr_ready') ids.add(h.id);
      }
      return ids;
    },
  });
  const evolutionEpisodeService = new EvolutionEpisodeService({
    evolutionRepo: deps.db.evolution,
    spaceRepo,
    taskRepo: spaceTaskRepo,
    workflowRunRepo: spaceWorkflowRunRepo,
    artifactRepo,
    artifactProfile,
    goalService: spaceGoalService,
    db: deps.db.getDatabase(),
    taskCreatedEventHub: {
      publish: (event, data) => deps.internalEventBus.publish(event as never, data as never),
    },
  });
  deps.jobProcessor.register(GOAL_AUTOMATION_EXECUTE, async (job) =>
    handleGoalAutomationExecute(job, {
      db: deps.db.getDatabase(),
      goalRepo: spaceGoalRepo,
      taskRepo: spaceTaskRepo,
      evolutionRepo: deps.db.evolution,
      cursorRepo: deps.db.goalAutomationCursors,
      episodeService: evolutionEpisodeService,
      jobQueue: deps.jobQueue,
      taskCreatedEventHub: {
        publish: (event, data) => deps.internalEventBus.publish(event as never, data as never),
      },
    })
  );
  setupEvolutionHandlers(
    deps.messageHub,
    evolutionScopeService,
    evolutionEpisodeService,
    {
      beforeScopeCreate: (params) => {
        validateGoalAutomationSelfNagPolicy(params);
      },
      beforeScopeUpdate: (existing, params) => {
        validateGoalAutomationSelfNagPolicy({
          policy: params.policyPatch
            ? mergeEvolutionPolicy(existing.policy, params.policyPatch)
            : params.policy
              ? { ...existing.policy, ...params.policy }
              : existing.policy,
        });
      },
      onScopeSaved: (scope) => {
        syncGoalAutomationSelfNagScheduleForScope({
          goalRepo: spaceGoalRepo,
          scheduleService,
          scope,
          db: deps.db.getDatabase(),
        });
      },
    },
    deps.db.getDatabase()
  );

  const spaceAgentInactivityConfigRepo = new SpaceAgentInactivityConfigRepository(
    deps.db.getDatabase()
  );
  const spaceAgentInactivityClaimRepo = new SpaceAgentInactivityClaimRepository(
    deps.db.getDatabase()
  );

  const spaceAgentReminderRepo = new SpaceAgentReminderRepository(
    deps.db.getDatabase(),
    spaceAgentRepo
  );
  const spaceAgentSubscriptionRepo = new SpaceAgentSubscriptionRepository(
    deps.db.getDatabase(),
    spaceAgentRepo
  );
  const spaceSessionEventSubscriptionRepo = new SpaceSessionEventSubscriptionRepository(
    deps.db.getDatabase()
  );

  const spaceRuntimeService: SpaceRuntimeService = new SpaceRuntimeService({
    ownedAgents: spaceAgentRepo,
    db: deps.db.getDatabase(),
    dbPath: deps.db.getDatabasePath(),
    spaceManager: deps.spaceManager,
    longHorizonAgentRepo,
    goalScopeRepo: spaceAgentGoalScopeRepo,
    subscriptionRepo: spaceAgentSubscriptionRepo,
    sessionSubscriptionRepo: spaceSessionEventSubscriptionRepo,
    reminderRepo: spaceAgentReminderRepo,
    spaceWorkflowManager,
    workflowRunRepo: spaceWorkflowRunRepo,
    taskRepo: spaceTaskRepo,
    nodeExecutionRepo,
    reactiveDb: deps.reactiveDb,
    channelCycleRepo,
    sessionManager: deps.sessionManager,
    internalEventBus: deps.internalEventBus,
    artifactRepo,
    actorRegistryRepos: {
      spaceRepo,
      sessionRepo,
      longHorizonAgentRepo,
      workflowRepo: spaceWorkflowRepo,
      workflowRunRepo: spaceWorkflowRunRepo,
      nodeExecutionRepo,
    },
    scheduleService,
    commandBus: deps.commandBus,
    externalEventStore: deps.externalEventStore,
    externalEventService: deps.externalEventService,
    replyRoutingRegistry,
    memoryRepo: deps.db.agentMemory,
    goalService: spaceGoalService,
    evolutionScopeService,
    artifactProfile,
    outcomeNotificationRepo,
    enableGoalOutcomeWake: GOAL_OUTCOME_WAKE_ENABLED,
    inactivityConfigRepo: spaceAgentInactivityConfigRepo,
    inactivityClaimRepo: spaceAgentInactivityClaimRepo,
    inactivityRunNow: (spaceId, agentId) => {
      const sessionId = longHorizonAgentRepo.getById(agentId)?.sessionId;
      const db = deps.db.getDatabase();
      const anchorRow =
        sessionId !== null && sessionId !== undefined
          ? (db
              .prepare(
                `SELECT MAX(timestamp) AS ts FROM sdk_messages
                 WHERE session_id = ? AND COALESCE(send_status, 'consumed') = 'consumed'
                   AND timestamp < (
                     SELECT MAX(timestamp) FROM sdk_messages
                     WHERE session_id = ? AND COALESCE(send_status, 'consumed') = 'consumed'
                       AND message_type = 'user'
                   )`
              )
              .get(sessionId, sessionId) as { ts?: string | number | null } | null)
          : null;
      const invokingUserRow =
        sessionId !== null && sessionId !== undefined
          ? (db
              .prepare(
                `SELECT MAX(timestamp) AS ts FROM sdk_messages
                 WHERE session_id = ? AND COALESCE(send_status, 'consumed') = 'consumed'
                   AND message_type = 'user'`
              )
              .get(sessionId) as { ts?: string | number | null } | null)
          : null;
      const activityBaseline = toEpochMs(anchorRow?.ts) ?? undefined;
      const invokingUserMsgAt = toEpochMs(invokingUserRow?.ts);
      const invokedAt = Date.now();
      let task: Promise<void>;
      const run = async () => {
        try {
          while (!inactivityRunNowCancelled) {
            if (sessionId !== null && sessionId !== undefined) {
              const row = db
                .prepare(`SELECT processing_state FROM sessions WHERE id = ?`)
                .get(sessionId) as { processing_state?: string | null } | null;
              let status = 'idle';
              try {
                const parsed = row?.processing_state
                  ? (JSON.parse(row.processing_state) as { status?: unknown })
                  : null;
                if (parsed && typeof parsed.status === 'string') status = parsed.status;
              } catch {}
              if (
                status !== 'processing' &&
                status !== 'queued' &&
                status !== 'running' &&
                status !== 'waiting_for_input' &&
                status !== 'rate_limit_cooldown'
              ) {
                break;
              }
            } else {
              break;
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2000);
              timer.unref();
            });
          }
          if (!inactivityRunNowCancelled) {
            await spaceAgentInactivityWatchdog
              .scanAgent(spaceId, agentId, activityBaseline, invokedAt, invokingUserMsgAt)
              .catch(() => {});
          }
        } finally {
          pendingInactivityRunNow.delete(task);
        }
      };
      task = run();
      pendingInactivityRunNow.add(task);
      void task.catch(() => {});
      return Promise.resolve();
    },
  });
  const spaceAgentInactivityWatchdog: SpaceAgentInactivityWatchdogService =
    new SpaceAgentInactivityWatchdogService({
      configRepo: spaceAgentInactivityConfigRepo,
      claimRepo: spaceAgentInactivityClaimRepo,
      agentRepo: longHorizonAgentRepo,
      spaceManager: deps.spaceManager,
      scannerToken: `inactivity-scanner:${deps.db.getDatabasePath()}`,
      shouldAbort: () => inactivityAborted,
      getSessionSnapshot: (spaceId, agentId): InactivityWatchdogSessionSnapshot | null => {
        const agent = longHorizonAgentRepo.getById(agentId);
        if (agent === null || agent.spaceId !== spaceId || agent.sessionId === null) return null;
        const db = deps.db.getDatabase();
        const sessionRow = db
          .prepare(`SELECT created_at, status, processing_state FROM sessions WHERE id = ?`)
          .get(agent.sessionId) as {
          created_at?: string | number;
          status?: string | null;
          processing_state?: string | null;
        } | null;
        if (
          sessionRow !== null &&
          (sessionRow.status === 'archived' || sessionRow.status === 'ended')
        ) {
          return null;
        }
        const consumedRow = db
          .prepare(
            `SELECT MAX(timestamp) AS ts FROM sdk_messages
           WHERE session_id = ? AND COALESCE(send_status, 'consumed') = 'consumed'`
          )
          .get(agent.sessionId) as { ts?: string | number | null } | null;
        const consumedUserRow = db
          .prepare(
            `SELECT MAX(timestamp) AS ts FROM sdk_messages
           WHERE session_id = ? AND COALESCE(send_status, 'consumed') = 'consumed'
             AND message_type = 'user'`
          )
          .get(agent.sessionId) as { ts?: string | number | null } | null;
        const pendingRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM sdk_messages
           WHERE session_id = ? AND send_status IN ('enqueued', 'submitted', 'deferred')`
          )
          .get(agent.sessionId) as { n?: number } | null;
        const pendingMailboxRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM job_queue
           WHERE queue = 'mailbox' AND status IN ('pending', 'processing')
             AND json_extract(payload, '$.to.sessionId') = ?`
          )
          .get(agent.sessionId) as { n?: number } | null;
        let status = 'idle';
        const liveSession = deps.sessionManager?.getCachedSession(agent.sessionId);
        if (liveSession) {
          status = liveSession.stateManager.getState().status;
        } else {
          try {
            const parsed = sessionRow?.processing_state
              ? (JSON.parse(sessionRow.processing_state) as { status?: unknown })
              : null;
            if (parsed && typeof parsed.status === 'string') status = parsed.status;
          } catch {}
        }
        return {
          latestConsumedMessageAt: toEpochMs(consumedRow?.ts),
          latestConsumedUserMessageAt: toEpochMs(consumedUserRow?.ts),
          sessionCreatedAt: toEpochMs(sessionRow?.created_at),
          busyWithOtherWork:
            status === 'processing' ||
            status === 'queued' ||
            status === 'running' ||
            status === 'rate_limit_cooldown' ||
            status === 'waiting_for_input',
          pendingOtherAcceptedDelivery: (pendingRow?.n ?? 0) > 0 || (pendingMailboxRow?.n ?? 0) > 0,
        };
      },
      isNagDeliveryPending: (spaceId, agentId, claimKey) => {
        const agent = longHorizonAgentRepo.getById(agentId);
        if (agent === null || agent.spaceId !== spaceId || agent.sessionId === null) return false;
        const sessionId = agent.sessionId;
        const row = deps.db
          .getDatabase()
          .prepare(
            `SELECT send_status FROM sdk_messages
             WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'user'`
          )
          .get(sessionId, claimKey) as { send_status?: string | null } | null;
        const status = row?.send_status ?? null;
        if (status === 'enqueued' || status === 'submitted' || status === 'deferred') return true;
        return (
          deps.db.getJobQueueRepo().listActiveByPayload('mailbox', {
            'to.sessionId': sessionId,
            messageUuid: claimKey,
          }).length > 0
        );
      },
      isNagDeliveryFailed: (spaceId, agentId, claimKey) => {
        const agent = longHorizonAgentRepo.getById(agentId);
        if (agent === null || agent.spaceId !== spaceId || agent.sessionId === null) return false;
        const sessionId = agent.sessionId;
        const row = deps.db
          .getDatabase()
          .prepare(
            `SELECT send_status FROM sdk_messages
             WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'user'`
          )
          .get(sessionId, claimKey) as { send_status?: string | null } | null;
        const activeMailbox =
          deps.db.getJobQueueRepo().listActiveByPayload('mailbox', {
            'to.sessionId': sessionId,
            messageUuid: claimKey,
          }).length > 0;
        if (row?.send_status === 'failed') return !activeMailbox;
        if (row == null) {
          return (
            !activeMailbox &&
            deps.db.getJobQueueRepo().getLatestByPayload('mailbox', {
              'to.sessionId': sessionId,
              messageUuid: claimKey,
            })?.status === 'dead'
          );
        }
        return false;
      },
      deliverNag: (args) =>
        spaceRuntimeService.deliverLongHorizonAgentNag({
          spaceId: args.spaceId,
          agentId: args.agentId,
          message: args.prompt,
          idempotencyKey: args.idempotencyKey,
          expectedConfigRevision: args.configRevision,
        }),
    });

  deliverOutcomeWake = (notification) => {
    void spaceRuntimeService.deliverGoalOutcomeWake(notification).catch((err) => {
      log.warn(
        `Goal outcome wake delivery failed for notification "${notification.id}": ${err instanceof Error ? err.message : String(err)}`
      );
    });
  };

  deps.spaceManager.onSpaceResumedRegister((spaceId) => {
    try {
      const recovered = scheduleService.recoverSchedulesForSpace(spaceId);
      if (recovered > 0) {
        log.info('recovered schedules after space resume', { spaceId, recovered });
      }
    } catch (err) {
      log.error('schedule recovery after space resume failed (non-fatal)', err);
    }
    spaceRuntimeService.recoverStalledWorkflowRunsAfterSpaceResume(spaceId);
    void spaceRuntimeService.recoverPendingOutcomeNotificationsForSpace(spaceId);
  });

  subscribeGoalOwnerChangeOutcomeRedelivery({
    internalEventBus: deps.internalEventBus,
    recoverPendingOutcomeNotificationsForGoal: (goalId) =>
      spaceRuntimeService.recoverPendingOutcomeNotificationsForGoal(goalId),
  });

  subscribeAgentActivationOutcomeRedelivery({
    internalEventBus: deps.internalEventBus,
    listAgentGoalLinks: (agentId) => spaceAgentGoalScopeRepo.listGoals(agentId),
    recoverPendingOutcomeNotificationsForGoal: (goalId) =>
      spaceRuntimeService.recoverPendingOutcomeNotificationsForGoal(goalId),
  });

  const spaceAgentTemplateManager = new SpaceAgentTemplateManager(
    spaceAgentTemplateRepo,
    undefined,
    templateInstanceScanFromRepo(longHorizonAgentRepo)
  );

  setupSpaceAgentTemplateHandlers(deps.messageHub, {
    spaceManager: deps.spaceManager,
    templateManager: spaceAgentTemplateManager,
  });

  setupSpaceAgentSubscriptionHandlers(deps.messageHub, {
    subscriptions: spaceAgentSubscriptionRepo,
    agents: spaceAgentRepo,
    runtimeService: spaceRuntimeService,
  });

  setupSpaceAgentReminderHandlers(deps.messageHub, { reminders: spaceAgentReminderRepo });

  const spaceAgentV2Deps: SpaceAgentV2Deps = {
    agents: spaceAgentRepo,
    templates: spaceAgentTemplateRepo,
    spaceExists: async (spaceId) => (await deps.spaceManager.getSpace(spaceId)) !== null,
    getSession: (sessionId) => deps.db.getSession(sessionId),
    internalEventBus: deps.internalEventBus,
    legacyAgents: longHorizonAgentRepo,
    reminders: spaceAgentReminderRepo,
    removeAgentSubscriptions: (spaceId, agentId) =>
      spaceRuntimeService.removeLongHorizonAgentSubscriptions(spaceId, agentId),
    refreshAgentSubscriptions: (spaceId, agentId) =>
      spaceRuntimeService.refreshLongHorizonAgentSubscriptions(spaceId, agentId),
    clearSessionProvider: (spaceId, agentId) =>
      spaceRuntimeService.clearLongTermAgentSessionProvider(spaceId, agentId),
    seedTemplateExtras: buildTemplateExtrasSeeder({
      store: {
        upsertSubscription: (params) => spaceAgentSubscriptionRepo.upsertSubscription(params),
        deleteSubscription: (id) => spaceAgentSubscriptionRepo.deleteSubscription(id),
        createReminder: (params) => spaceAgentReminderRepo.createReminder(params),
      },
      refreshSubscription: (spaceId, subscriptionId) =>
        spaceRuntimeService.refreshLongHorizonSubscription(spaceId, subscriptionId),
    }),
  };

  const cloneLifecycle = createCloneLifecycleEffects(
    deps.sessionManager,
    deps.spaceManager,
    deps.internalEventBus,
    (id) => deps.db.getSession(id)
  );
  const stampProvenance = async (
    sessionId: string,
    promptProvenance: NonNullable<SessionMetadata['promptProvenance']>
  ) => {
    const current = deps.db.getSession(sessionId);
    if (current) {
      await deps.db.updateSession(sessionId, {
        metadata: { ...current.metadata, promptProvenance },
      });
    }
  };
  spaceAgentV2Deps.stampProvenance = stampProvenance;
  const resolveClones = createResolveClones({
    listChildren: (parentId) => deps.db.listChildSessions(parentId),
    detach: async (sessionId) => {
      await deps.db.detachSessionFromParent(sessionId);
    },
    agents: {
      agentOwning: (sessionId) => {
        const id = spaceAgentRepo.getBySessionId(sessionId)?.id;
        return id ? longHorizonAgentRepo.getById(id) : null;
      },
      listAgents: (spaceId) => longHorizonAgentRepo.listBySpaceId(spaceId),
      nameAgent: nameClonedAgent,
      createAgent: (params) => {
        const agent = longHorizonAgentRepo.create(params);
        const created = spaceAgentRepo.getById(agent.id);
        if (created) {
          deps.internalEventBus
            .publish('spaceAgentV2.created', {
              sessionId: `space:${agent.spaceId}`,
              spaceId: agent.spaceId,
              agent: created,
            })
            .catch(() => {});
          void publishUnifiedAgentCreated(deps.internalEventBus, agent).catch(() => {});
        }
        return agent;
      },
      stampProvenance,
    },
    ...cloneLifecycle,
  });
  spaceAgentV2Deps.resolveClones = resolveClones;
  spaceAgentV2Deps.retirePrimarySession = (sessionId, action) =>
    action === 'delete'
      ? cloneLifecycle.deleteChild(sessionId)
      : cloneLifecycle.archiveChild(sessionId);
  spaceAgentV2Deps.listClones = (parentId) => deps.db.listChildSessions(parentId);
  spaceAgentV2Deps.commitsAhead = (worktree, alsoDeleting) =>
    deps.sessionManager.getWorktreeManager().getCommitsAhead(worktree, undefined, { alsoDeleting });

  setupSpaceAgentV2Handlers(deps.messageHub, spaceAgentV2Deps);

  const createSeedAgent = buildAgentCreate(spaceAgentV2Deps);
  const seedSpaceAgents = async (spaceId: string, templateKeys: readonly string[]) => {
    const errors: { key: string; error: string }[] = [];
    for (const key of templateKeys) {
      try {
        await createSeedAgent({ spaceId, templateKey: key });
      } catch (error) {
        errors.push({ key, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { errors };
  };

  setupTaskScheduleHandlers(deps.messageHub, {
    scheduleService,
    spaceManager: deps.spaceManager,
  });

  setupSpaceGoalHandlers(deps.messageHub, {
    goalService: spaceGoalService,
    spaceManager: deps.spaceManager,
    goalScopeRepo: spaceAgentGoalScopeRepo,
    operations: () => spaceOperationRegistryProvider(),
    internalEventBus: deps.internalEventBus,
  });

  setupSpaceHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceTaskRepo,
    spaceWorkflowRunRepo,
    deps.internalEventBus,
    spaceWorkflowManager,
    deps.sessionManager,
    spaceRuntimeService,
    seedSpaceAgents,
    (tasks) => stampActiveAttemptList(deps.db.getDatabase(), tasks),
    (path) => nodeWorkspaceValidationIo.canHostTaskWorktree(path)
  );

  deps.messageHub.onRequest('space.externalEvents.queueHealth', async () => {
    return spaceRuntimeService.getQueueHealthSnapshot();
  });

  const spaceWorktreeManager = new SpaceWorktreeManager(deps.db.getDatabase());

  return {
    stopInactivityRunNow: async () => {
      inactivityRunNowCancelled = true;
      await Promise.allSettled(pendingInactivityRunNow);
    },
    cancelInactivityWatchdog: () => {
      inactivityAborted = true;
      inactivityRunNowCancelled = true;
    },
    spaceTaskRepo,
    spaceWorkflowRunRepo,
    artifactRepo,
    channelCycleRepo,
    taskScheduleRepo,
    spaceRepo,
    scheduleService,
    spaceGoalRepo,
    spaceGoalEventRepo,
    longHorizonAgentRepo,
    evolutionScopeService,
    spaceAgentRepo,
    spaceAgentGoalScopeRepo,
    spaceGoalService,
    goalAutomationService,
    spaceWorkflowRepo,
    spaceAgentTemplateRepo,
    spaceWorkflowManager,
    emitClaimedTaskUpdate,
    spaceTaskManagerFactory,
    nodeExecutionRepo,
    pendingCompletion,
    replyRoutingRegistry,
    artifactProfile,
    evolutionEpisodeService,
    spaceAgentInactivityConfigRepo,
    spaceAgentInactivityClaimRepo,
    spaceAgentReminderRepo,
    spaceAgentSubscriptionRepo,
    spaceSessionEventSubscriptionRepo,
    spaceRuntimeService,
    spaceAgentInactivityWatchdog,
    spaceAgentTemplateManager,
    spaceAgentV2Deps,
    resolveClones,
    spaceWorktreeManager,
  };
}

type SpaceServices = Awaited<ReturnType<typeof setupSpaceServices>>;

function setupSpaceTaskAgents(
  deps: SpaceRpcDependencies,
  services: SpaceServices,
  {
    readGithubPr,
    readGithubReviewThreads,
  }: Pick<TaskAgentManagerConfig, 'readGithubPr' | 'readGithubReviewThreads'>
) {
  const {
    spaceTaskRepo,
    spaceWorkflowRunRepo,
    artifactRepo,
    channelCycleRepo,
    scheduleService,
    longHorizonAgentRepo,
    evolutionScopeService,
    spaceGoalService,
    spaceAgentTemplateRepo,
    spaceWorkflowManager,
    nodeExecutionRepo,
    replyRoutingRegistry,
    artifactProfile,
    spaceRuntimeService,
    spaceWorktreeManager,
  } = services;
  let sessionResolutionDeps: ReturnType<typeof createDefaultSessionResolutionDeps>;
  const sessionMessageInjector = async (
    spaceId: string,
    message: string,
    replyToSessionId?: string | null,
    explicitMessageId?: string,
    injectorOptions?: {
      onConsumed?: (settledSessionId: string) => void;
      lateSettlement?: import('../../messaging/session-message-delivery.ts').SessionLateSettlementOwner;
      onLateFailure?: () => void;
    }
  ): Promise<SessionInjectionOutcome> => {
    const { sessionId, session } = await resolveDeliverySession<AgentSession>(
      spaceId,
      replyToSessionId,
      sessionResolutionDeps,
      (sessionId) => deps.sessionManager.getSessionAsync(sessionId)
    );
    const messageId = explicitMessageId ?? generateUUID();
    const sdkUserMessage: SDKUserMessage & { isSynthetic: boolean } = {
      type: 'user' as const,
      uuid: messageId as UUID,
      session_id: sessionId,
      parent_tool_use_id: null,
      isSynthetic: true,
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: message }],
      },
    };
    return await deliverSpaceAgentMessage(
      {
        db: deps.db.getDatabase(),
        sdkMessageRepo: deps.reactiveDb.db.getSDKMessageRepo(),
        publishStatusChanged: async (sid, dbId, status) => {
          await deps.internalEventBus
            .publish('messages.statusChanged', {
              sessionId: sid,
              messageIds: [dbId],
              status,
            })
            .catch(() => {});
        },
        jobQueue: deps.reactiveDb.db.getJobQueueRepo(),
        stateManager: session.stateManager,
        onConsumed: injectorOptions?.onConsumed,
        lateSettlement: injectorOptions?.lateSettlement,
        onLateFailure: injectorOptions?.onLateFailure,
      },
      {
        sessionId,
        messageId,
        sdkUserMessage,
      }
    );
  };

  const taskAgentManager = new TaskAgentManager({
    db: deps.reactiveDb.db,
    readGithubPr,
    readGithubReviewThreads,
    sessionManager: deps.sessionManager,
    reactiveDb: deps.reactiveDb,
    spaceManager: deps.spaceManager,
    longHorizonAgentRepo,
    templateRepo: spaceAgentTemplateRepo,
    spaceWorkflowManager,
    spaceRuntimeService,
    taskRepo: spaceTaskRepo,
    writeTask: spaceTaskWriter(deps.reactiveDb.db.getDatabase(), deps.reactiveDb),
    workflowRunRepo: spaceWorkflowRunRepo,
    channelCycleRepo,
    messageHub: deps.messageHub,
    getApiKey: () => deps.authManager.getCurrentApiKey(),
    defaultModel: deps.config.defaultModel,
    worktreeManager: spaceWorktreeManager,
    skillsManager: deps.skillsManager,
    appMcpServerRepo: deps.reactiveDb.db.appMcpServers,
    nodeExecutionRepo,
    dbPath: deps.db.getDatabasePath(),
    artifactRepo,
    sessionMessageInjector,
    messageResolverFactory: (spaceId, context) =>
      spaceRuntimeService.createMessageResolver(spaceId, context),
    longTermAgentDelivery: spaceRuntimeService.longTermAgentDeliveryCallbacks(),
    scheduleService,
    internalEventBus: deps.internalEventBus,
    replyRoutingRegistry,
    memoryRepo: deps.db.agentMemory,
    goalService: spaceGoalService,
    evolutionScopeService,
    externalEventStore: deps.externalEventStore,
    artifactProfile,
  });

  deps.commandBus.register('agent.message.inject', async (command) => {
    if (!taskAgentManager) {
      return { ok: false, error: 'TaskAgentManager unavailable' };
    }
    try {
      await taskAgentManager.injectSubSessionMessage(
        command.sessionId,
        command.message,
        true,
        undefined,
        command.deliveryMode ?? 'immediate',
        'system'
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  });

  const directTaskExecutionRepo = new DirectTaskExecutionRepository(deps.db.getDatabase());
  const directTaskWorkerResolver = createDatabaseDirectTaskWorkerResolver(deps.db.getDatabase());

  return {
    taskAgentManager,
    directTaskExecutionRepo,
    directTaskWorkerResolver,
    sessionResolutionDeps: () => sessionResolutionDeps,
    setSessionResolutionDeps: (resolved: ReturnType<typeof createDefaultSessionResolutionDeps>) => {
      sessionResolutionDeps = resolved;
    },
  };
}

function completeSpaceSetup(
  deps: SpaceRpcDependencies,
  services: SpaceServices,
  agents: ReturnType<typeof setupSpaceTaskAgents>,
  familyOperations: readonly OperationDefinition[],
  handleWorkerQuestion: SessionReportHandler,
  readPrState: (prUrl: string) => ReturnType<CodingPrStateReader>
) {
  const {
    spaceTaskRepo,
    spaceWorkflowRunRepo,
    artifactRepo,
    channelCycleRepo,
    spaceRepo,
    longHorizonAgentRepo,
    spaceGoalService,
    spaceWorkflowRepo,
    spaceWorkflowManager,
    emitClaimedTaskUpdate,
    spaceTaskManagerFactory,
    nodeExecutionRepo,
    pendingCompletion,
    replyRoutingRegistry,
    artifactProfile,
    spaceRuntimeService,
  } = services;
  const {
    taskAgentManager,
    directTaskExecutionRepo,
    directTaskWorkerResolver,
    sessionResolutionDeps,
    setSessionResolutionDeps,
  } = agents;
  const spaceOperationRegistryProvider = createSpaceOperationRegistryProvider(
    deps.db,
    deps.jobQueue,
    {
      blockExecution: (spaceId, taskId, params) =>
        spaceRuntimeService.stopWorkflowBackedTask(spaceId, taskId, params),
      stopForStatus: (spaceId, taskId, params) =>
        spaceRuntimeService.stopWorkflowBackedTaskForStatus(spaceId, taskId, params),
      getSession: (sessionId) => deps.db.getSession(sessionId),
      getTaskManager: spaceTaskManagerFactory,
      getWorkflow: (workflowId) => spaceWorkflowManager.getWorkflow(workflowId),
      recoverWorkflowTask: (spaceId, taskId, targetStatus, options) =>
        recoverTaskExecution(
          createWorkflowTaskRecoveryExecutor(spaceId, spaceRuntimeService, options),
          taskId,
          targetStatus
        ),
      handoffWorkerSession: (spaceId, taskId) =>
        spaceRuntimeService.recoverWorkflowBackedTask(spaceId, taskId, 'in_progress', {
          manualHandoff: true,
        }),
      taskRepo: spaceTaskRepo,
      nodeExecutionRepo,
      longHorizonAgentRepo,
      hasDirectWorkerProvenance: (sessionId) =>
        directTaskExecutionRepo.hasSessionProvenance(sessionId),
      resolveDirectWorker: directTaskWorkerResolver,
      runOp: deps.db.runSpaceTaskOp,
      workflowRunRepo: spaceWorkflowRunRepo,
      getWorkflowForRun: (run) => spaceWorkflowManager.getWorkflowForRun(run),
      taskAgentManager,
      ensureTargetSession: (target) => spaceRuntimeService.ensureToolTargetSession(target),
      activateNode: async (runId, nodeId) => {
        await spaceRuntimeService.activateWorkflowNode(runId, nodeId);
      },
      messageResolverFactory: (spaceId, context) =>
        spaceRuntimeService.createMessageResolver(spaceId, context),
      longTermAgentDelivery: spaceRuntimeService.longTermAgentDeliveryCallbacks(),
      replyRoutingRegistry,
      emitTaskUpdated: async (spaceId, task) => {
        await deps.internalEventBus.publish('space.task.updated', {
          sessionId: 'global',
          spaceId,
          taskId: task.id,
          task,
        });
      },
      emitTaskCreated: async (spaceId, task) => {
        await deps.internalEventBus.publish('space.task.created', {
          sessionId: 'global',
          spaceId,
          taskId: task.id,
          task,
        });
      },
      getSpace: (spaceId) => deps.spaceManager.getSpace(spaceId),
      validateDefaultTaskWorkspace: (spaceId) =>
        deps.spaceManager.validateDefaultTaskWorkspace(spaceId),
      resolveResultArtifactSummary: (task) =>
        task.workflowRunId
          ? (artifactProfile.summarizeRunOutcome(task.workflowRunId) ?? null)
          : null,
      sessionManager: deps.sessionManager,
      ...createCompletionGateBindings({
        resolveWorkflowForTask: (task) => {
          const run = task.workflowRunId ? spaceWorkflowRunRepo.getRun(task.workflowRunId) : null;
          return run?.workflowId ? (spaceWorkflowManager.getWorkflowForRun(run) ?? null) : null;
        },
        isCoderOwnedMergeWorkflow,
        resolvePrUrl: (task) =>
          task.workflowRunId
            ? artifactProfile.resolveInitialPrimaryLinkUrl(task.workflowRunId)
            : '',
        getPrState: async (prUrl) => {
          const outcome = await readPrState(prUrl);
          if ('reason' in outcome) throw new Error(outcome.reason);
          return outcome.value;
        },
        workflowDeclaresPostApprovalRoute: (taskId) =>
          spaceRuntimeService.workflowDeclaresPostApprovalRoute(taskId),
      }),
    },
    pendingCompletion,
    {
      reactiveDb: deps.reactiveDb,
      onTaskReopened: (taskId) => spaceGoalService.supersedeOutcomeNotificationsForTask(taskId),
      onTaskClaimed: emitClaimedTaskUpdate,
    },
    {
      getSession: (sessionId) => deps.db.getSession(sessionId),
      getTaskManager: spaceTaskManagerFactory,
      taskRepo: spaceTaskRepo,
      nodeExecutionRepo,
      longHorizonAgentRepo,
      hasDirectWorkerProvenance: (sessionId) =>
        directTaskExecutionRepo.hasSessionProvenance(sessionId),
      resolveDirectWorker: directTaskWorkerResolver,
      runOp: deps.db.runSpaceTaskOp,
      emitTaskUpdated: async (spaceId, task) => {
        await deps.internalEventBus.publish('space.task.updated', {
          sessionId: 'global',
          spaceId,
          taskId: task.id,
          task,
        });
      },
      isWorkflowRunActive: (workflowRunId) =>
        spaceRuntimeService.isWorkflowRunActive(workflowRunId),
      recoverTransition: (spaceId, taskId, status, expected) =>
        recoverTaskExecution(
          createWorkflowTaskRecoveryExecutor(spaceId, spaceRuntimeService, expected),
          taskId,
          status
        ),
      stopForStatus: (spaceId, taskId, params, expected) =>
        spaceRuntimeService.stopWorkflowBackedTaskForStatus(spaceId, taskId, params, expected),
      parkStopped: (spaceId, taskId, expected) =>
        spaceRuntimeService.parkStoppedWorkflowTask(spaceId, taskId, expected),
    },
    familyOperations,
    handleWorkerQuestion
  );

  deps.sessionManager.setDefaultOperationRegistryProvider(spaceOperationRegistryProvider);
  deps.sessionManager.setCallerScopeResolver(
    createSpaceCallerScopeResolver({
      getSession: (sessionId) => deps.db.getSession(sessionId),
      hasDirectWorkerProvenance: (sessionId) =>
        directTaskExecutionRepo.hasSessionProvenance(sessionId),
      resolveDirectWorker: directTaskWorkerResolver,
      taskRepo: spaceTaskRepo,
      nodeExecutionRepo,
      longHorizonAgentRepo,
    })
  );

  deps.sessionManager.setSpaceScopeResolver(
    createSpaceScopeResolver({
      getSession: (sessionId) => deps.db.getSession(sessionId),
      getSpace: (spaceId) => spaceRepo.getSpace(spaceId),
      hasDirectWorkerProvenance: (sessionId) =>
        directTaskExecutionRepo.hasSessionProvenance(sessionId),
      resolveDirectWorker: directTaskWorkerResolver,
      taskRepo: spaceTaskRepo,
      nodeExecutionRepo,
      longHorizonAgentRepo,
    })
  );

  spaceRuntimeService.setTaskAgentManager(taskAgentManager);
  deps.sessionManager.setSpaceRuntimeMcpProvider(spaceRuntimeService);
  spaceRuntimeService.start();

  setSessionResolutionDeps(
    createDefaultSessionResolutionDeps({
      sessionManager: deps.sessionManager,
      taskAgentManager,
      spaceRuntimeService,
      nodeExecutionRepo,
      taskRepo: spaceTaskRepo,
      longHorizonAgentRepo,
    })
  );
  setupSpaceTaskMessageHandlers(
    deps.messageHub,
    taskAgentManager,
    deps.db,
    deps.internalEventBus,
    nodeExecutionRepo,
    channelCycleRepo,
    undefined,
    (target) => ensureSession(target, sessionResolutionDeps())
  );

  setupSpaceExportImportHandlers(
    deps.messageHub,
    deps.spaceManager,
    longHorizonAgentRepo,
    spaceWorkflowRepo,
    spaceWorkflowManager,
    deps.db.getDatabase(),
    deps.internalEventBus,
    spaceRuntimeService
  );

  const hookStateRepo = new WorkflowHookStateRepository(deps.db.getDatabase());
  setupSpaceWorkflowRunHandlers(
    deps.messageHub,
    spaceWorkflowManager,
    spaceWorkflowRunRepo,
    spaceTaskManagerFactory,
    deps.internalEventBus,
    artifactRepo,
    hookStateRepo,
    (runId, sessionId) =>
      nodeExecutionRepo
        .listByAgentSessionId(sessionId)
        .some((execution) => execution.workflowRunId === runId),
    (sessionId) => taskAgentManager.isRetryableActionRestorePending(sessionId)
  );

  setupNodeExecutionHandlers(deps.messageHub, nodeExecutionRepo, spaceWorkflowRunRepo);

  return spaceOperationRegistryProvider;
}

export async function createSpaceRpc(deps: SpaceRpcDependencies, host: SpaceRpcHost) {
  setupAgentMemoryHandlers(deps.messageHub, { memoryRepo: deps.db.agentMemory });
  setupSpaceExternalEventHandlers(deps);
  setupSpaceMcpHandlers(
    deps.messageHub,
    deps.internalEventBus,
    deps.db,
    deps.spaceManager,
    deps.mcpImportService
  );
  let registryProvider: () => OperationRegistry;
  const services = await setupSpaceServices(deps, {
    spaceOperationRegistryProvider: () => registryProvider(),
  });
  deps.db.spaceSessions = createSpaceSessionPort(
    deps.db.getDatabase(),
    services.spaceTaskRepo,
    services.nodeExecutionRepo,
    services.longHorizonAgentRepo
  );
  const agents = setupSpaceTaskAgents(deps, services, host);
  const { taskAgentManager, directTaskExecutionRepo, directTaskWorkerResolver } = agents;
  const family = {
    deps,
    spaceManager: deps.spaceManager,
    externalEventStore: deps.externalEventStore,
    spaceRuntimeService: services.spaceRuntimeService,
    taskAgentManager,
    spaceTaskManagerFactory: services.spaceTaskManagerFactory,
    spaceTaskRepo: services.spaceTaskRepo,
    nodeExecutionRepo: services.nodeExecutionRepo,
    longHorizonAgentRepo: services.longHorizonAgentRepo,
    spaceAgentRepo: services.spaceAgentRepo,
    spaceAgentGoalScopeRepo: services.spaceAgentGoalScopeRepo,
    spaceAgentTemplateRepo: services.spaceAgentTemplateRepo,
    spaceAgentTemplateManager: services.spaceAgentTemplateManager,
    spaceAgentReminderRepo: services.spaceAgentReminderRepo,
    spaceAgentSubscriptionRepo: services.spaceAgentSubscriptionRepo,
    spaceSessionEventSubscriptionRepo: services.spaceSessionEventSubscriptionRepo,
    hasDirectWorkerProvenance: (sessionId: string) =>
      directTaskExecutionRepo.hasSessionProvenance(sessionId),
    resolveDirectWorker: directTaskWorkerResolver,
    spaceAgentInactivityConfigRepo: services.spaceAgentInactivityConfigRepo,
    spaceAgentInactivityClaimRepo: services.spaceAgentInactivityClaimRepo,
    spaceGoalService: services.spaceGoalService,
    spaceGoalRepo: services.spaceGoalRepo,
    spaceGoalEventRepo: services.spaceGoalEventRepo,
    goalAutomationService: services.goalAutomationService,
    evolutionScopeService: services.evolutionScopeService,
    evolutionEpisodeService: services.evolutionEpisodeService,
    scheduleService: services.scheduleService,
    taskScheduleRepo: services.taskScheduleRepo,
    spaceWorkflowRepo: services.spaceWorkflowRepo,
    spaceWorkflowRunRepo: services.spaceWorkflowRunRepo,
    spaceWorkflowManager: services.spaceWorkflowManager,
    artifactRepo: services.artifactRepo,
    artifactProfile: services.artifactProfile,
    channelCycleRepo: services.channelCycleRepo,
    replyRoutingRegistry: services.replyRoutingRegistry,
    archiveAgentSessions: (agent: SpaceLongHorizonAgent) =>
      agent.sessionId
        ? archiveAgentSessions(services.spaceAgentV2Deps, agent.sessionId)
        : Promise.resolve({ ok: true as const }),
  };
  return {
    services: {
      spaceRuntimeService: services.spaceRuntimeService,
      taskAgentManager,
      spaceWorktreeManager: services.spaceWorktreeManager,
      spaceGoalService: services.spaceGoalService,
      goalAutomationService: services.goalAutomationService,
      spaceAgentInactivityWatchdog: services.spaceAgentInactivityWatchdog,
      cancelInactivityWatchdog: services.cancelInactivityWatchdog,
    },
    sessionSpace: createSessionSpacePort(family),
    membership: deps.spaceManager,
    ensureSession: (target: SessionTarget) => ensureSession(target, agents.sessionResolutionDeps()),
    resolveClones: services.resolveClones,
    primaryAgentFor: (sessionId: string) => {
      const agent = services.spaceAgentRepo.getBySessionId(sessionId);
      return agent ? { id: agent.id, displayName: agent.displayName } : null;
    },
    familyOperations: (core: FamilyOperationContext) =>
      collectSpaceFamilyOperations({ ...core, ...family }),
    complete: (
      familyOperations: readonly OperationDefinition[],
      handleWorkerQuestion: SessionReportHandler,
      readPrState: (prUrl: string) => ReturnType<CodingPrStateReader>
    ) => {
      registryProvider = completeSpaceSetup(
        deps,
        services,
        agents,
        familyOperations,
        handleWorkerQuestion,
        readPrState
      );
    },
    stop: async () => {
      await services.stopInactivityRunNow();
      await services.spaceRuntimeService.stop();
    },
  };
}
