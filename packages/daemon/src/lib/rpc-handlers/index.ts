import type { MessageHub } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SpaceGoalOutcomeNotification } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { DaemonCommandMap, InternalCommandBus } from '../internal-command-bus.ts';
import type { ExternalEventStore } from '../external-events/external-event-store.ts';
import type { ExternalEventService } from '../external-events/external-event-service.ts';
import type { SessionManager } from '../session-manager.ts';
import type { AuthManager } from '../auth-manager.ts';
import type { SettingsManager } from '../settings-manager.ts';
import type { Config } from '../../config.ts';
import type { Database } from '../../storage/database.ts';
import type { ReactiveDatabase } from '../../storage/reactive-database.ts';

import { setupSessionHandlers } from './session-handlers.ts';
import { setupMessageHandlers } from './message-handlers.ts';
import { setupFileHandlers } from './file-handlers.ts';
import { setupSystemHandlers } from './system-handlers.ts';
import { setupAuthHandlers } from './auth-handlers.ts';
import { setupCommandHandlers } from './command-handlers.ts';
import { registerMcpHandlers } from './mcp-handlers.ts';
import { registerSettingsHandlers } from './settings-handlers.ts';
import { registerCustomEndpointHandlers } from './custom-endpoint-handlers.ts';
import { registerVoiceHandlers } from './voice-handlers.ts';
import { setupProviderHandlers } from './provider-handlers.ts';
import { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import { setupConfigHandlers } from './config-handlers.ts';
import { setupTestHandlers } from './test-handlers.ts';
import { setupRewindHandlers } from './rewind-handlers.ts';
import type { GitHubService } from '../github/github-service.ts';
import { Logger } from '../logger.ts';
import { TaskRepository } from '../../storage/repositories/task-repository.ts';
import { setupDialogHandlers } from './dialog-handlers.ts';
import { setupQuestionHandlers } from './question-handlers.ts';
import { setupSpaceHandlers } from './space-handlers.ts';
import { setupSpaceTaskHandlers, type SpaceTaskManagerFactory } from './space-task-handlers.ts';
import { setupSpaceTaskMessageHandlers } from './space-task-message-handlers.ts';
import { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository.ts';
import { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';
import { ReplyRoutingRegistry } from '../space/runtime/reply-routing-registry.ts';
import { SpaceWorktreeManager } from '../space/managers/space-worktree-manager.ts';
import { CodingArtifactProfile } from '../space/workflows/coding-artifact-profile.ts';
import {
  setupSpaceWorkflowHandlers,
  checkBuiltInWorkflowDriftOnStartup,
  restampBuiltInWorkflowsOnStartup,
} from './space-workflow-handlers.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import { SpaceTaskManager } from '../space/managers/space-task-manager.ts';
import { SpaceWorkflowManager } from '../space/managers/space-workflow-manager.ts';
import type { SpaceAgentLookup } from '../space/managers/space-workflow-manager.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository.ts';
import { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository.ts';
import { WorkflowRunArtifactCacheRepository } from '../../storage/repositories/workflow-run-artifact-cache-repository.ts';
import { WorkflowHookStateRepository } from '../../storage/repositories/workflow-hook-state-repository.ts';
import { createConversationFrictionEvidenceHandler } from '../job-handlers/conversation-friction-evidence.handler.ts';
import { handleGoalAutomationExecute } from '../job-handlers/goal-automation-execute.handler.ts';
import { GoalAutomationService } from '../space/goals/goal-automation-service.ts';
import { createSyncArtifactHandlers } from '../job-handlers/space-workflow-run-artifact.handler.ts';
import {
  GOAL_AUTOMATION_EXECUTE,
  SPACE_CONVERSATION_FRICTION_ANALYZE,
  SPACE_WORKFLOW_RUN_SYNC_GATE_ARTIFACTS,
  SPACE_WORKFLOW_RUN_SYNC_COMMITS,
  SPACE_WORKFLOW_RUN_SYNC_FILE_DIFF,
  MESSAGE_DELIVERY,
} from '../job-queue-constants.ts';
import {
  deliveryMetrics,
  type MessageDeliveryDiagnostics,
} from '../agent/message-delivery-metrics.ts';
import { ChannelCycleRepository } from '../../storage/repositories/channel-cycle-repository.ts';
import { PendingAgentMessageRepository } from '../../storage/repositories/pending-agent-message-repository.ts';
import { SpaceAgentInboxRepository } from '../../storage/repositories/space-agent-inbox-repository.ts';
import { SessionRepository } from '../../storage/repositories/session-repository.ts';
import { setupSpaceAgentHandlers } from './space-agent-handlers.ts';
import { setupSpaceLongHorizonAgentHandlers } from './space-long-horizon-agent-handlers.ts';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager.ts';
import { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository.ts';
import { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import {
  awaitDeliveryConsumption,
  deliverAndMarkQueued,
  deliveryConsumptionTimeoutMs,
  isMessageDeliveryV2Enabled,
  withSessionResetCoordination,
} from '../agent/message-delivery.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { JobQueueProcessor } from '../../storage/job-queue-processor.ts';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository.ts';
import { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import { GOAL_OUTCOME_WAKE_ENABLED } from '../space/runtime/goal-outcome-wake-flag.ts';
import { SpaceAgentInactivityWatchdogService } from '../space/agents/inactivity-watchdog-service.ts';
import type { InactivityWatchdogSessionSnapshot } from '../space/agents/inactivity-watchdog-service.ts';
import {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
} from '../../storage/repositories/space-agent-inactivity-repository.ts';
import { setupSpaceWorkflowRunHandlers } from './space-workflow-run-handlers.ts';
import type { SpaceWorkflowRunTaskManagerFactory } from './space-workflow-run-handlers.ts';
import { setupNodeExecutionHandlers } from './space-node-execution-handlers.ts';
import { setupSpaceExportImportHandlers } from './space-export-import-handlers.ts';
import { setupLiveQueryHandlers } from './live-query-handlers.ts';
import { setupReferenceHandlers } from './reference-handlers.ts';
import { FileIndex } from '../file-index.ts';
import { LiveQueryEngine } from '../../storage/live-query.ts';
import type { AppMcpLifecycleManager, McpImportService } from '../mcp/index.ts';
import { registerAppMcpHandlers, setupAppMcpHandlers } from './app-mcp-handlers.ts';
import { setupSpaceMcpHandlers } from './space-mcp-handlers.ts';
import { registerSkillHandlers } from './skill-handlers.ts';
import type { SkillsManager } from '../skills-manager.ts';
import { setupWorkspaceHandlers } from './workspace-handlers.ts';
import { setupGitHandlers } from './git-handlers.ts';
import { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository.ts';
import { TaskScheduleRepository } from '../../storage/repositories/task-schedule-repository.ts';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { setupTaskScheduleHandlers } from './task-schedule-handlers.ts';
import { setupAgentMemoryHandlers } from './agent-memory-handlers.ts';
import { setupSpaceGoalHandlers } from './space-goal-handlers.ts';
import { setupEvolutionHandlers } from './evolution-handlers.ts';
import { EvolutionConversationAnalysisService } from '../space/evolution-conversation-analysis-service.ts';
import { EvolutionEpisodeService } from '../space/evolution-episode-service.ts';
import { EvolutionScopeService } from '../space/evolution-scope-service.ts';
import { EvolutionTraceEvidenceService } from '../space/evolution-trace-evidence-service.ts';
import { ScheduleService } from '../space/schedule/schedule-service.ts';
import { SpaceGoalEventRepository } from '../../storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalOutcomeNotificationRepository } from '../../storage/repositories/space-goal-outcome-notification-repository.ts';
import { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository.ts';
import { SpaceGoalService } from '../space/goals/goal-service.ts';
import { ExternalEventExtensionConfigStore } from '../external-events/extension-config-store.ts';
import { mergeEvolutionPolicy } from '../space/evolution-scope-service.ts';
import {
  isHttpExtension,
  isRpcExtension,
  type ExternalEventExtensionManager,
} from '../external-events/extension-manager.ts';
import type {
  ExternalEventDeliveryState,
  ExternalEventExtensionContext,
} from '../external-events/types.ts';
const EXTERNAL_EVENT_DELIVERY_STATES: ExternalEventDeliveryState[] = [
  'pending',
  'delivered',
  'failed',
];

import {
  validateCompletedTaskThreshold,
  validateGoalAutomationSelfNagPolicy,
} from '../space/goals/evolution-policy-validation.ts';
export { validateCompletedTaskThreshold, validateGoalAutomationSelfNagPolicy };
import {
  readSelfNagScheduleScopeId,
  syncGoalAutomationSelfNagScheduleForScope,
} from '../space/goals/goal-automation-schedule-sync.ts';
export { readSelfNagScheduleScopeId, syncGoalAutomationSelfNagScheduleForScope };

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
        log.warn('could not create Forge self-nag schedule', err);
      }
    }
  }
}

export interface RPCHandlerDependencies {
  messageHub: MessageHub;
  sessionManager: SessionManager;
  authManager: AuthManager;
  credentialManager?: ProviderCredentialManager;
  settingsManager: SettingsManager;
  config: Config;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  commandBus: InternalCommandBus<DaemonCommandMap>;
  externalEventStore: ExternalEventStore;
  externalEventService: ExternalEventService;
  externalEventExtensionManager: ExternalEventExtensionManager;
  externalEventExtensionConfigStore: ExternalEventExtensionConfigStore;
  externalEventExtensionContext: ExternalEventExtensionContext;
  db: Database;
  gitHubService?: GitHubService;
  spaceManager: SpaceManager;
  spaceAgentManager: SpaceAgentManager;
  jobQueue: JobQueueRepository;
  jobProcessor: JobQueueProcessor;
  messageDeliveryProcessor: JobQueueProcessor;
  reactiveDb: ReactiveDatabase;
  liveQueries: LiveQueryEngine;
  appMcpManager: AppMcpLifecycleManager;
  skillsManager: SkillsManager;
  mcpImportService: McpImportService;
}

const log = new Logger('rpc-handlers');

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function setupExternalEventExtensionHandlers(deps: RPCHandlerDependencies): void {
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

  deps.messageHub.onRequest('externalEvents.extensions.list', async () => {
    const extensions = [];
    for (const extension of deps.externalEventExtensionManager.getAll()) {
      const config = await deps.externalEventExtensionConfigStore.getGlobalConfig(
        extension.sourceId
      );
      extensions.push({
        source: extension.sourceId,
        status: deps.externalEventExtensionManager.isStarted(extension.sourceId)
          ? 'started'
          : 'stopped',
        config,
      });
    }
    return { extensions };
  });

  deps.messageHub.onRequest('externalEvents.extensions.setGlobalEnabled', async (data) => {
    const params = data as { source?: string; enabled?: boolean };
    if (!params.source || typeof params.enabled !== 'boolean') {
      throw new Error('source and enabled are required');
    }
    const extension = deps.externalEventExtensionManager.getExtension(params.source);
    if (!extension)
      throw new Error(`External event extension "${params.source}" is not registered`);
    const current = await deps.externalEventExtensionConfigStore.getGlobalConfig(params.source);
    const config = { ...current, globallyEnabled: params.enabled };
    if (params.enabled) {
      await deps.externalEventExtensionConfigStore.setGlobalConfig(params.source, config);
      try {
        await deps.externalEventExtensionManager.startExtension(
          params.source,
          deps.externalEventExtensionContext
        );
        if (isHttpExtension(extension)) {
          deps.externalEventExtensionManager.registerRoutes(
            extension.routes,
            deps.externalEventExtensionContext
          );
        }
        if (isRpcExtension(extension) && config.capabilities.rpcConfig) {
          deps.externalEventExtensionManager.registerRpcHandlers(
            params.source,
            deps.messageHub,
            deps.externalEventExtensionContext
          );
        }
      } catch (error) {
        await deps.externalEventExtensionConfigStore.setGlobalConfig(params.source, current);
        await deps.externalEventExtensionManager.stopExtension(params.source);
        throw error;
      }
    } else {
      try {
        await deps.externalEventExtensionManager.stopExtension(params.source);
      } finally {
        await deps.externalEventExtensionConfigStore.setGlobalConfig(params.source, config);
      }
    }
    return { source: params.source, globallyEnabled: params.enabled };
  });
}

export type RPCHandlerCleanup = () => void | Promise<void>;

export interface RPCHandlerSetupResult {
  cleanup: RPCHandlerCleanup;
  spaceRuntimeService: SpaceRuntimeService;
  taskAgentManager: TaskAgentManager;
  spaceWorktreeManager: SpaceWorktreeManager;
  spaceGoalService: SpaceGoalService;
  goalAutomationService: GoalAutomationService;
  spaceAgentInactivityWatchdog: SpaceAgentInactivityWatchdogService;
  cancelInactivityWatchdog: () => void;
}

export function setupRPCHandlers(deps: RPCHandlerDependencies): RPCHandlerSetupResult {
  const pendingInactivityRunNow = new Set<Promise<void>>();
  let inactivityRunNowCancelled = false;
  let inactivityAborted = false;
  setupMessageHandlers(deps.messageHub, deps.sessionManager, deps.db);
  setupCommandHandlers(deps.messageHub, deps.sessionManager);
  setupFileHandlers(deps.messageHub, deps.sessionManager);
  setupSystemHandlers(deps.messageHub, deps.sessionManager, deps.authManager, deps.config);
  setupAuthHandlers(
    deps.messageHub,
    deps.authManager,
    deps.credentialManager,
    deps.internalEventBus
  );
  registerMcpHandlers(deps.messageHub, deps.sessionManager, deps.appMcpManager);
  registerSettingsHandlers(
    deps.messageHub,
    deps.settingsManager,
    deps.internalEventBus,
    deps.db,
    deps.mcpImportService,
    deps.credentialManager
  );
  registerCustomEndpointHandlers(
    deps.messageHub,
    deps.settingsManager,
    deps.internalEventBus,
    deps.db,
    deps.credentialManager
  );
  registerVoiceHandlers(deps.messageHub, deps.settingsManager, deps.credentialManager);

  const providerCredentialManager =
    deps.credentialManager ?? ProviderCredentialManager.create(deps.db.getDatabase());
  setupProviderHandlers({
    messageHub: deps.messageHub,
    providerRepo: deps.db.providers,
    credentialManager: providerCredentialManager,
    internalEventBus: deps.internalEventBus,
  });

  setupConfigHandlers(deps.messageHub, deps.sessionManager, deps.internalEventBus);
  setupTestHandlers(deps.messageHub, deps.reactiveDb.db);
  setupRewindHandlers(deps.messageHub, deps.sessionManager, deps.internalEventBus);

  setupDialogHandlers(deps.messageHub);

  setupQuestionHandlers(deps.messageHub, deps.sessionManager, deps.internalEventBus);

  const fileIndex = new FileIndex(deps.config.workspaceRoot);
  fileIndex.init().catch((err) => {
    log.warn('FileIndex init failed:', err);
  });
  setupReferenceHandlers(deps.messageHub, {
    db: deps.db.getDatabase(),
    reactiveDb: deps.reactiveDb,
    shortIdAllocator: deps.db.getShortIdAllocator(),
    sessionManager: deps.sessionManager,
    taskRepo: new TaskRepository(deps.db.getDatabase(), deps.reactiveDb),
    goalRepo: deps.db.getGoalRepo(),
    workspaceRoot: deps.config.workspaceRoot,
    fileIndex,
  });

  const unsubLiveQuery = setupLiveQueryHandlers(
    deps.messageHub,
    deps.liveQueries,
    deps.db.getDatabase()
  );

  registerAppMcpHandlers(deps.messageHub, {
    db: deps.db,
    internalEventBus: deps.internalEventBus,
  });

  setupAppMcpHandlers(deps.messageHub, deps.internalEventBus, deps.db);

  setupSpaceMcpHandlers(
    deps.messageHub,
    deps.internalEventBus,
    deps.db,
    deps.spaceManager,
    deps.mcpImportService
  );
  setupAgentMemoryHandlers(deps.messageHub, { memoryRepo: deps.db.agentMemory });
  setupExternalEventExtensionHandlers(deps);

  registerSkillHandlers(deps.messageHub, deps.skillsManager, deps.internalEventBus, undefined);

  const workspaceHistoryRepo = new WorkspaceHistoryRepository(deps.db.getDatabase());
  setupWorkspaceHandlers(
    deps.messageHub,
    workspaceHistoryRepo,
    deps.mcpImportService,
    deps.internalEventBus
  );

  setupGitHandlers(deps.messageHub, deps.sessionManager.getWorktreeManager(), deps.sessionManager);

  const spaceTaskRepo = new SpaceTaskRepository(deps.db.getDatabase(), deps.reactiveDb);
  const spaceWorkflowRunRepo = new SpaceWorkflowRunRepository(deps.db.getDatabase());
  const artifactRepo = new WorkflowRunArtifactRepository(deps.db.getDatabase(), deps.reactiveDb);
  const artifactCacheRepo = new WorkflowRunArtifactCacheRepository(deps.db.getDatabase());
  const channelCycleRepo = new ChannelCycleRepository(deps.db.getDatabase());
  const pendingMessageRepo = new PendingAgentMessageRepository(
    deps.db.getDatabase(),
    deps.reactiveDb
  );
  const spaceAgentInboxRepo = new SpaceAgentInboxRepository(deps.db.getDatabase());
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
  const spaceGoalService = new SpaceGoalService({
    goalRepo: spaceGoalRepo,
    goalEventRepo: spaceGoalEventRepo,
    taskRepo: spaceTaskRepo,
    spaceRepo,
    scheduleService,
    db: deps.db.getDatabase(),
    longHorizonAgentRepo,
    outcomeNotificationRepo,
    evolutionScopeService,
    reactiveDb: deps.reactiveDb,
    eventHub: {
      publish: (event, data) => deps.internalEventBus.publish(event as never, data as never),
    },
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
  spaceWorkflowRunRepo.backfillDefinitionPins((id) => spaceWorkflowRepo.getWorkflow(id));
  const spaceAgentRepo = new SpaceAgentRepository(deps.db.getDatabase());
  const agentLookup: SpaceAgentLookup = {
    getAgentById(spaceId: string, id: string) {
      const agent = spaceAgentRepo.getById(id);
      if (!agent || agent.spaceId !== spaceId) return null;
      return { id: agent.id, name: agent.name };
    },
  };
  const spaceWorkflowManager = new SpaceWorkflowManager(spaceWorkflowRepo, agentLookup);

  const spaceTaskManagerFactory: SpaceTaskManagerFactory = (spaceId: string) => {
    return new SpaceTaskManager(
      deps.db.getDatabase(),
      spaceId,
      deps.reactiveDb,
      evolutionScopeService,
      (taskId) => spaceGoalService.supersedeOutcomeNotificationsForTask(taskId),
      (taskId, fromStatus) =>
        spaceGoalService.handleTaskTerminal(taskId, { fromStatus, deferPostCommitEffects: true })
    );
  };

  setupSpaceWorkflowHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceWorkflowManager,
    deps.internalEventBus,
    deps.spaceAgentManager,
    spaceWorkflowRunRepo
  );

  void restampBuiltInWorkflowsOnStartup(
    spaceWorkflowManager,
    deps.spaceManager,
    deps.spaceAgentManager,
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

  const spaceRuntimeService: SpaceRuntimeService = new SpaceRuntimeService({
    db: deps.db.getDatabase(),
    dbPath: deps.db.getDatabasePath(),
    spaceManager: deps.spaceManager,
    spaceAgentManager: deps.spaceAgentManager,
    longHorizonAgentRepo,
    spaceWorkflowManager,
    workflowRunRepo: spaceWorkflowRunRepo,
    taskRepo: spaceTaskRepo,
    nodeExecutionRepo,
    reactiveDb: deps.reactiveDb,
    channelCycleRepo,
    sessionManager: deps.sessionManager,
    internalEventBus: deps.internalEventBus,
    artifactRepo,
    pendingMessageRepo,
    spaceAgentInboxRepo,
    actorRegistryRepos: {
      spaceRepo,
      sessionRepo,
      spaceAgentRepo,
      longHorizonAgentRepo,
      workflowRepo: spaceWorkflowRepo,
      workflowRunRepo: spaceWorkflowRunRepo,
      nodeExecutionRepo,
      pendingMessageRepo,
    },
    scheduleService,
    commandBus: deps.commandBus,
    externalEventStore: deps.externalEventStore,
    externalEventService: deps.externalEventService,
    replyRoutingRegistry,
    memoryRepo: deps.db.agentMemory,
    goalService: spaceGoalService,
    evolutionScopeService,
    evolutionEpisodeService,
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
          pendingOtherAcceptedDelivery: (pendingRow?.n ?? 0) > 0,
        };
      },
      isNagDeliveryPending: (spaceId, agentId, claimKey) => {
        const agent = longHorizonAgentRepo.getById(agentId);
        if (agent === null || agent.spaceId !== spaceId || agent.sessionId === null) return false;
        const row = deps.db
          .getDatabase()
          .prepare(
            `SELECT send_status FROM sdk_messages
             WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'user'`
          )
          .get(agent.sessionId, claimKey) as { send_status?: string | null } | null;
        const status = row?.send_status ?? null;
        return status === 'enqueued' || status === 'submitted' || status === 'deferred';
      },
      isNagDeliveryFailed: (spaceId, agentId, claimKey) => {
        const agent = longHorizonAgentRepo.getById(agentId);
        if (agent === null || agent.spaceId !== spaceId || agent.sessionId === null) return false;
        const row = deps.db
          .getDatabase()
          .prepare(
            `SELECT send_status FROM sdk_messages
             WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'user'`
          )
          .get(agent.sessionId, claimKey) as { send_status?: string | null } | null;
        return row?.send_status === 'failed';
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
    spaceRuntimeService.recoverLongTermAgentInboxForSpace(spaceId);
    void spaceRuntimeService.recoverPendingOutcomeNotificationsForSpace(spaceId);
  });

  setupSpaceAgentHandlers(
    deps.messageHub,
    deps.internalEventBus,
    deps.spaceAgentManager,
    deps.spaceManager,
    deps.db,
    spaceRuntimeService
  );

  setupSessionHandlers(
    deps.messageHub,
    deps.sessionManager,
    deps.internalEventBus,
    deps.spaceManager,
    spaceRuntimeService
  );

  setupSpaceTaskHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceWorkflowManager,
    spaceTaskManagerFactory,
    deps.internalEventBus,
    spaceRuntimeService
  );

  setupTaskScheduleHandlers(deps.messageHub, {
    scheduleService,
    spaceManager: deps.spaceManager,
  });

  setupSpaceGoalHandlers(deps.messageHub, {
    goalService: spaceGoalService,
    spaceManager: deps.spaceManager,
    longHorizonAgentRepo,
    internalEventBus: deps.internalEventBus,
  });

  setupSpaceLongHorizonAgentHandlers(
    deps.messageHub,
    deps.spaceManager,
    longHorizonAgentRepo,
    deps.spaceAgentManager,
    spaceRuntimeService,
    deps.internalEventBus
  );

  setupSpaceHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceTaskRepo,
    spaceWorkflowRunRepo,
    deps.internalEventBus,
    deps.spaceAgentManager,
    spaceWorkflowManager,
    deps.sessionManager,
    spaceRuntimeService,
    { longHorizonAgentRepo }
  );

  deps.messageHub.onRequest('space.externalEvents.queueHealth', async () => {
    return spaceRuntimeService.getQueueHealthSnapshot();
  });

  deps.messageHub.onRequest(
    'messageDelivery.diagnostics',
    async (): Promise<MessageDeliveryDiagnostics> => {
      const counts = deps.jobQueue.countByStatus(MESSAGE_DELIVERY);
      const staleThresholdMs = 5 * 60 * 1000;
      const staleProcessing = deps.jobQueue.countStaleProcessing(
        MESSAGE_DELIVERY,
        Date.now() - staleThresholdMs
      );
      return {
        lane: MESSAGE_DELIVERY,
        statusCounts: counts,
        staleProcessing,
        activeProcessing: Math.max(0, counts.processing - staleProcessing),
        oldestProcessingLeaseAgeMs: deps.jobQueue.oldestProcessingLeaseAgeMs(MESSAGE_DELIVERY),
        processor: deps.messageDeliveryProcessor.snapshot(MESSAGE_DELIVERY),
        metrics: deliveryMetrics.snapshot(),
      };
    }
  );

  const spaceWorktreeManager = new SpaceWorktreeManager(deps.db.getDatabase());

  const sessionManagerRef = deps.sessionManager;
  const spaceAgentInjector = async (
    spaceId: string,
    message: string,
    replyToSessionId?: string | null,
    explicitMessageId?: string
  ): Promise<void> => {
    let sessionId = replyToSessionId || `space:chat:${spaceId}`;
    let session = await sessionManagerRef.getSessionAsync(sessionId);
    if (!session && replyToSessionId) {
      sessionId = `space:chat:${spaceId}`;
      session = await sessionManagerRef.getSessionAsync(sessionId);
    }
    if (!session) {
      throw new Error(`Session not found for Space Agent reply routing: ${sessionId}`);
    }
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
    if (isMessageDeliveryV2Enabled()) {
      const sdkMessageRepo = deps.reactiveDb.db.getSDKMessageRepo();
      const existing = sdkMessageRepo.getDeliveryContent(sessionId, messageId);
      const fresh = !existing;
      if (!existing) {
        const dbId = deps.reactiveDb.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued');
        await deps.internalEventBus
          .publish('messages.statusChanged', {
            sessionId,
            messageIds: [dbId],
            status: 'enqueued',
          })
          .catch(() => {});
      } else if (existing.sendStatus === 'consumed') {
        return;
      } else if (existing.sendStatus === 'failed') {
        const reopenedDbId = sdkMessageRepo.reopenDeliveryByUuid(sessionId, messageId);
        if (reopenedDbId) {
          await deps.internalEventBus
            .publish('messages.statusChanged', {
              sessionId,
              messageIds: [reopenedDbId],
              status: 'enqueued',
            })
            .catch(() => {});
        }
      }
      await awaitDeliveryConsumption({
        sessionId,
        messageUuid: messageId,
        timeoutMs: deliveryConsumptionTimeoutMs(session.getSessionData?.().config?.provider),
        deliver: () =>
          withSessionResetCoordination(sessionId, async () =>
            deliverAndMarkQueued({
              jobQueue: deps.reactiveDb.db.getJobQueueRepo(),
              stateManager: session.stateManager,
              sessionId,
              messageUuid: messageId,
              origin: 'space_agent',
              onEnqueueFailure: () => {
                const failedDbId = sdkMessageRepo.markDeliveryFailedByUuid(sessionId, messageId);
                if (failedDbId) {
                  void deps.internalEventBus
                    .publish('messages.statusChanged', {
                      sessionId,
                      messageIds: [failedDbId],
                      status: 'failed',
                    })
                    .catch(() => {});
                }
              },
            })
          ),
        ...(fresh
          ? {
              terminalizeOnTimeout: () => {
                const failedDbId = sdkMessageRepo.markDeliveryFailedByUuid(sessionId, messageId);
                if (failedDbId) {
                  void deps.internalEventBus
                    .publish('messages.statusChanged', {
                      sessionId,
                      messageIds: [failedDbId],
                      status: 'failed',
                    })
                    .catch(() => {});
                }
              },
            }
          : {}),
      });
    } else {
      await withSessionResetCoordination(sessionId, async () => {
        await session.ensureQueryStarted();
        const dbId = deps.reactiveDb.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued');
        await deps.internalEventBus
          .publish('messages.statusChanged', {
            sessionId,
            messageIds: [dbId],
            status: 'enqueued',
          })
          .catch(() => {});
        await session.messageQueue.enqueueWithId(messageId, message);
      });
    }
  };

  const taskAgentManager = new TaskAgentManager({
    db: deps.reactiveDb.db,
    sessionManager: deps.sessionManager,
    reactiveDb: deps.reactiveDb,
    spaceManager: deps.spaceManager,
    spaceAgentManager: deps.spaceAgentManager,
    spaceWorkflowManager,
    spaceRuntimeService,
    taskRepo: spaceTaskRepo,
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
    pendingMessageRepo,
    spaceAgentInjector,
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

  spaceRuntimeService.setTaskAgentManager(taskAgentManager);
  deps.sessionManager.setSpaceRuntimeMcpProvider(spaceRuntimeService);
  spaceRuntimeService.start();

  setupSpaceTaskMessageHandlers(
    deps.messageHub,
    taskAgentManager,
    deps.db,
    deps.internalEventBus,
    nodeExecutionRepo,
    channelCycleRepo,
    async (runId, nodeId) => {
      await spaceRuntimeService.activateWorkflowNode(runId, nodeId);
    },
    pendingMessageRepo
  );

  setupSpaceExportImportHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceAgentRepo,
    spaceWorkflowRepo,
    spaceWorkflowManager,
    deps.db.getDatabase(),
    deps.internalEventBus,
    spaceRuntimeService
  );

  const spaceWorkflowRunTaskManagerFactory: SpaceWorkflowRunTaskManagerFactory = (spaceId) => {
    return new SpaceTaskManager(
      deps.db.getDatabase(),
      spaceId,
      deps.reactiveDb,
      evolutionScopeService,
      (taskId) => spaceGoalService.supersedeOutcomeNotificationsForTask(taskId),
      (taskId, fromStatus) =>
        spaceGoalService.handleTaskTerminal(taskId, { fromStatus, deferPostCommitEffects: true })
    );
  };
  const hookStateRepo = new WorkflowHookStateRepository(deps.db.getDatabase());
  setupSpaceWorkflowRunHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceWorkflowManager,
    spaceWorkflowRunRepo,
    spaceRuntimeService,
    spaceWorkflowRunTaskManagerFactory,
    deps.internalEventBus,
    spaceTaskRepo,
    spaceWorktreeManager,
    artifactRepo,
    artifactCacheRepo,
    deps.jobQueue,
    hookStateRepo
  );

  const artifactSyncHandlers = createSyncArtifactHandlers({
    cacheRepo: artifactCacheRepo,
    workflowRunRepo: spaceWorkflowRunRepo,
    spaceTaskRepo,
    spaceManager: deps.spaceManager,
    spaceWorktreeManager,
    internalEventBus: deps.internalEventBus,
  });
  deps.jobProcessor.register(
    SPACE_WORKFLOW_RUN_SYNC_GATE_ARTIFACTS,
    artifactSyncHandlers.gateArtifacts
  );
  deps.jobProcessor.register(SPACE_WORKFLOW_RUN_SYNC_COMMITS, artifactSyncHandlers.commits);
  deps.jobProcessor.register(SPACE_WORKFLOW_RUN_SYNC_FILE_DIFF, artifactSyncHandlers.fileDiff);

  setupNodeExecutionHandlers(deps.messageHub, nodeExecutionRepo, spaceWorkflowRunRepo);

  return {
    cleanup: async () => {
      inactivityRunNowCancelled = true;
      await Promise.allSettled(pendingInactivityRunNow);
      unsubLiveQuery();
      await spaceRuntimeService.stop();
      fileIndex.dispose();
    },
    spaceRuntimeService,
    taskAgentManager,
    spaceWorktreeManager,
    spaceGoalService,
    goalAutomationService,
    spaceAgentInactivityWatchdog,
    cancelInactivityWatchdog: () => {
      inactivityAborted = true;
      inactivityRunNowCancelled = true;
    },
  };
}
