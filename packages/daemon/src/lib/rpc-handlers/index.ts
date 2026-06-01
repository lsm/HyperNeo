/**
 * RPC Handler Registration
 *
 * Registers all RPC handlers on MessageHub.
 * Organized by domain for better maintainability.
 */

import type { EvolutionScope, MessageHub } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import type { UUID } from 'crypto';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { DaemonCommandMap, InternalCommandBus } from '../internal-command-bus';
import type { ExternalEventStore } from '../external-events/external-event-store';
import type { ExternalEventService } from '../external-events/external-event-service';
import type { SessionManager } from '../session-manager';
import type { AuthManager } from '../auth-manager';
import type { SettingsManager } from '../settings-manager';
import type { Config } from '../../config';
import type { Database } from '../../storage/database';
import type { ReactiveDatabase } from '../../storage/reactive-database';

import { setupSessionHandlers } from './session-handlers';
import { setupMessageHandlers } from './message-handlers';
import { setupFileHandlers } from './file-handlers';
import { setupSystemHandlers } from './system-handlers';
import { setupAuthHandlers } from './auth-handlers';
import { setupCommandHandlers } from './command-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerCustomEndpointHandlers } from './custom-endpoint-handlers';
import { setupProviderHandlers } from './provider-handlers';
import { ProviderCredentialManager } from '../credentials/provider-credential-manager';
import { setupConfigHandlers } from './config-handlers';
import { setupTestHandlers } from './test-handlers';
import { setupRewindHandlers } from './rewind-handlers';
import type { GitHubService } from '../github/github-service';
import { Logger } from '../logger';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { setupDialogHandlers } from './dialog-handlers';
import { setupQuestionHandlers } from './question-handlers';
// Space handlers
import { setupSpaceHandlers } from './space-handlers';
import { setupSpaceTaskHandlers, type SpaceTaskManagerFactory } from './space-task-handlers';
import { setupSpaceTaskMessageHandlers } from './space-task-message-handlers';
import { NodeExecutionRepository } from '../../storage/repositories/node-execution-repository';
import { TaskAgentManager } from '../space/runtime/task-agent-manager';
import { ReplyRoutingRegistry } from '../space/runtime/reply-routing-registry';
import { SpaceWorktreeManager } from '../space/managers/space-worktree-manager';
import {
  setupSpaceWorkflowHandlers,
  checkBuiltInWorkflowDriftOnStartup,
  restampBuiltInWorkflowsOnStartup,
} from './space-workflow-handlers';
import type { SpaceManager } from '../space/managers/space-manager';
import { SpaceTaskManager } from '../space/managers/space-task-manager';
import { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentLookup } from '../space/managers/space-workflow-manager';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import { GateDataRepository } from '../../storage/repositories/gate-data-repository';
import { GateOpenStateRepository } from '../../storage/repositories/gate-open-state-repository';
import { WorkflowRunArtifactRepository } from '../../storage/repositories/workflow-run-artifact-repository';
import { WorkflowRunArtifactCacheRepository } from '../../storage/repositories/workflow-run-artifact-cache-repository';
import { createConversationFrictionEvidenceHandler } from '../job-handlers/conversation-friction-evidence.handler';
import { handleGoalAutomationExecute } from '../job-handlers/goal-automation-execute.handler';
import {
  GoalAutomationService,
  readAutomationPolicyForScope,
} from '../space/goals/goal-automation-service';
import { createSyncArtifactHandlers } from '../job-handlers/space-workflow-run-artifact.handler';
import {
  GOAL_AUTOMATION_EXECUTE,
  SPACE_CONVERSATION_FRICTION_ANALYZE,
  SPACE_WORKFLOW_RUN_SYNC_GATE_ARTIFACTS,
  SPACE_WORKFLOW_RUN_SYNC_COMMITS,
  SPACE_WORKFLOW_RUN_SYNC_FILE_DIFF,
} from '../job-queue-constants';
import { ChannelCycleRepository } from '../../storage/repositories/channel-cycle-repository';
import { PendingAgentMessageRepository } from '../../storage/repositories/pending-agent-message-repository';
import { SpaceAgentInboxRepository } from '../../storage/repositories/space-agent-inbox-repository';
import { SessionRepository } from '../../storage/repositories/session-repository';
import { setupSpaceAgentHandlers } from './space-agent-handlers';
import { setupSpaceLongHorizonAgentHandlers } from './space-long-horizon-agent-handlers';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository';
import { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { JobQueueProcessor } from '../../storage/job-queue-processor';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';
import { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { setupSpaceWorkflowRunHandlers } from './space-workflow-run-handlers';
import type { SpaceWorkflowRunTaskManagerFactory } from './space-workflow-run-handlers';
import { setupNodeExecutionHandlers } from './space-node-execution-handlers';
import { setupSpaceExportImportHandlers } from './space-export-import-handlers';
import { setupLiveQueryHandlers } from './live-query-handlers';
import { setupReferenceHandlers } from './reference-handlers';
import { FileIndex } from '../file-index';
import { LiveQueryEngine } from '../../storage/live-query';
import type { AppMcpLifecycleManager, McpImportService } from '../mcp';
import { registerAppMcpHandlers, setupAppMcpHandlers } from './app-mcp-handlers';
import { setupSpaceMcpHandlers } from './space-mcp-handlers';
import { registerSkillHandlers } from './skill-handlers';
import type { SkillsManager } from '../skills-manager';
import { setupWorkspaceHandlers } from './workspace-handlers';
import { setupGitHandlers } from './git-handlers';
import { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository';
import { TaskScheduleRepository } from '../../storage/repositories/task-schedule-repository';
import { SpaceRepository } from '../../storage/repositories/space-repository';
import { setupTaskScheduleHandlers } from './task-schedule-handlers';
import { setupAgentMemoryHandlers } from './agent-memory-handlers';
import { setupSpaceGoalHandlers } from './space-goal-handlers';
import { setupEvolutionHandlers } from './evolution-handlers';
import { EvolutionConversationAnalysisService } from '../space/evolution-conversation-analysis-service';
import { EvolutionEpisodeService } from '../space/evolution-episode-service';
import { EvolutionScopeService } from '../space/evolution-scope-service';
import { EvolutionTraceEvidenceService } from '../space/evolution-trace-evidence-service';
import { ScheduleService } from '../space/schedule/schedule-service';
import { getNextRunAt, isValidCronExpression } from '../space/schedule/cron-utils';
import { SpaceGoalEventRepository } from '../../storage/repositories/space-goal-event-repository';
import { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository';
import { SpaceGoalService } from '../space/goals/goal-service';
import { ExternalEventExtensionConfigStore } from '../external-events/extension-config-store';
import {
  isHttpExtension,
  isRpcExtension,
  type ExternalEventExtensionManager,
} from '../external-events/extension-manager';
import type { ExternalEventExtensionContext } from '../external-events/types';

export function validateGoalAutomationSelfNagPolicy(params: {
  policy?: EvolutionScope['policy'];
}): void {
  const policy = readAutomationPolicyForScope({
    policy: params.policy,
  } as EvolutionScope);
  const threshold = policy.completedTaskThreshold;
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold <= 0)) {
    throw new Error('Completed-task automation threshold must be a positive integer');
  }
  const expression = policy.selfNagCronExpression;
  if (!expression) return;
  if (!isValidCronExpression(expression)) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }
  const timezone = policy.selfNagTimezone ?? 'UTC';
  if (getNextRunAt(expression, timezone) === null) {
    throw new Error(`Invalid timezone or cron expression for self-nag schedule: ${timezone}`);
  }
}

export function syncGoalAutomationSelfNagScheduleForScope(params: {
  goalRepo: SpaceGoalRepository;
  scheduleService: ScheduleService;
  scope: EvolutionScope;
  db?: import('bun:sqlite').Database;
}): void {
  const { goalRepo, scheduleService, scope, db } = params;
  const run = () => {
    const policy = readAutomationPolicyForScope(scope);
    // Find all automation schedules for this scope across any goal, including
    // completed ones (so reconciliation can recreate after goal reactivation).
    const allScopeSchedules = scheduleService
      .listSchedules(scope.spaceId)
      .filter(
        (schedule) =>
          schedule.createdByAgent === 'goal-automation-service' &&
          readSelfNagScheduleScopeId(schedule) === scope.id
      );
    // Pause any active schedule whose goalId no longer matches the current scope
    // goal (e.g. scope was reassigned from goal A to goal B).
    for (const sched of allScopeSchedules) {
      if (
        sched.status === 'active' &&
        sched.goalId !== null &&
        sched.goalId !== scope.spaceGoalId
      ) {
        try {
          scheduleService.pauseSchedule(sched.id);
        } catch {
          // Schedule may have been concurrently modified; best-effort.
        }
      }
    }

    // If scope has no goal linkage or goal is inactive, pause active schedules
    // and stop — reconciliation on goal relink/resume will re-enable.
    if (!scope.spaceGoalId) {
      for (const sched of allScopeSchedules) {
        if (sched.status === 'active') {
          try {
            scheduleService.pauseSchedule(sched.id);
          } catch {
            // Best-effort.
          }
        }
      }
      return;
    }
    const goal = goalRepo.getById(scope.spaceGoalId);
    if (!goal || goal.status !== 'active') return;
    const scopeLabel = `scope:${scope.id}`;
    // Find the current-goal schedule (excluding completed — reconciliation recreates those).
    const existing = allScopeSchedules
      .filter((schedule) => schedule.goalId === goal.id)
      .find((schedule) => schedule.status !== 'completed');
    if (!policy.selfNagCronExpression) {
      if (existing?.status === 'active') scheduleService.pauseSchedule(existing.id);
      return;
    }
    if (existing) {
      // Update cron/timezone *before* resume so resumeSchedule computes
      // nextRunAt from the new (valid) trigger config instead of the
      // stale config persisted when the schedule was paused.
      scheduleService.updateSchedule(existing.id, {
        title: `Forge self-nag: ${goal.title}`,
        description: `Run Forge automation for goal: ${goal.title}`,
        priority: goal.priority,
        labels: ['forge', 'automation', `goal:${goal.id}`, scopeLabel],
        cronExpression: policy.selfNagCronExpression,
        timezone: policy.selfNagTimezone ?? 'UTC',
      });
      if (existing.status === 'paused') scheduleService.resumeSchedule(existing.id);
      return;
    }
    scheduleService.createGoalSchedule({
      spaceId: goal.spaceId,
      goalId: goal.id,
      title: `Forge self-nag: ${goal.title}`,
      description: `Run Forge automation for goal: ${goal.title}`,
      priority: goal.priority,
      labels: ['forge', 'automation', `goal:${goal.id}`, scopeLabel],
      metadata: goalAutomationSelfNagMetadata(scope.id),
      triggerType: 'cron',
      cronExpression: policy.selfNagCronExpression,
      timezone: policy.selfNagTimezone ?? 'UTC',
      createdByAgent: 'goal-automation-service',
    });
  }; // end run()
  if (db) {
    db.transaction(run)();
  } else {
    run();
  }
}

export function readSelfNagScheduleScopeId(schedule: {
  metadata?: Record<string, unknown>;
}): string | null {
  const scopeId = schedule.metadata?.goalAutomationScopeId;
  return typeof scopeId === 'string' && scopeId.trim() ? scopeId : null;
}

function goalAutomationSelfNagMetadata(scopeId: string): Record<string, unknown> {
  return { goalAutomationKind: 'self_nag', goalAutomationScopeId: scopeId };
}

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
  /** Semantic internal event bus for daemon domain events. */
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  commandBus: InternalCommandBus<DaemonCommandMap>;
  externalEventStore: ExternalEventStore;
  /** External event service available to runtime subscribers when direct publishing is needed. */
  externalEventService: ExternalEventService;
  externalEventExtensionManager: ExternalEventExtensionManager;
  externalEventExtensionConfigStore: ExternalEventExtensionConfigStore;
  externalEventExtensionContext: ExternalEventExtensionContext;
  db: Database;
  gitHubService?: GitHubService;
  /** Space manager instance — shared with DaemonAppContext (single source of truth) */
  spaceManager: SpaceManager;
  spaceAgentManager: SpaceAgentManager;
  /**
   * Persistent job queue repository.
   */
  jobQueue: JobQueueRepository;
  /**
   * Persistent job queue processor.
   * TODO: consumed by Milestones 2–5 handlers for registering queue handlers.
   */
  jobProcessor: JobQueueProcessor;
  /** Reactive database wrapper for change event emission */
  reactiveDb: ReactiveDatabase;
  /** Live query engine for reactive SQL subscriptions */
  liveQueries: LiveQueryEngine;
  /** Application-level MCP lifecycle manager */
  appMcpManager: AppMcpLifecycleManager;
  /** Application-level Skills manager */
  skillsManager: SkillsManager;
  /**
   * MCP `.mcp.json` import service — scans project + user-level files and
   * upserts `source='imported'` rows. Injected here so workspace and
   * settings RPC handlers can trigger scans on workspace.add and
   * settings.mcp.refreshImports.
   */
  mcpImportService: McpImportService;
}

const log = new Logger('rpc-handlers');

export function setupExternalEventExtensionHandlers(deps: RPCHandlerDependencies): void {
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

/**
 * Cleanup function type for RPC handlers.
 *
 * Returns a Promise to allow async teardown (e.g. awaiting in-flight SpaceRuntime ticks
 * before the database is closed).
 */
export type RPCHandlerCleanup = () => void | Promise<void>;

/**
 * Result returned by setupRPCHandlers — includes both the cleanup function
 * and any services that need to be surfaced in DaemonAppContext.
 */
export interface RPCHandlerSetupResult {
  cleanup: RPCHandlerCleanup;
  spaceRuntimeService: SpaceRuntimeService;
  taskAgentManager: TaskAgentManager;
  spaceWorktreeManager: SpaceWorktreeManager;
  spaceGoalService: SpaceGoalService;
  goalAutomationService: GoalAutomationService;
}

/**
 * Register all RPC handlers on MessageHub
 * Returns a result with cleanup function and exposed services
 */
export function setupRPCHandlers(deps: RPCHandlerDependencies): RPCHandlerSetupResult {
  // setupSessionHandlers is registered below, after spaceRuntimeService is
  // constructed, so session.create can synchronously attach space-agent-tools
  // to ad-hoc Space sessions (avoids a race with query startup).
  setupMessageHandlers(deps.messageHub, deps.sessionManager, deps.db);
  setupCommandHandlers(deps.messageHub, deps.sessionManager);
  setupFileHandlers(deps.messageHub, deps.sessionManager);
  setupSystemHandlers(deps.messageHub, deps.sessionManager, deps.authManager, deps.config);
  setupAuthHandlers(deps.messageHub, deps.authManager, deps.credentialManager);
  registerMcpHandlers(deps.messageHub, deps.sessionManager, deps.appMcpManager);
  registerSettingsHandlers(
    deps.messageHub,
    deps.settingsManager,
    deps.internalEventBus,
    deps.db,
    deps.mcpImportService
  );
  registerCustomEndpointHandlers(
    deps.messageHub,
    deps.settingsManager,
    deps.internalEventBus,
    deps.db
  );

  // Provider registry handlers (unified CRUD over providers table)
  const providerCredentialManager =
    deps.credentialManager ?? ProviderCredentialManager.create(deps.db.getDatabase());
  setupProviderHandlers({
    messageHub: deps.messageHub,
    providerRepo: deps.db.providers,
    credentialManager: providerCredentialManager,
  });

  setupConfigHandlers(deps.messageHub, deps.sessionManager, deps.internalEventBus);
  // Use reactiveDb.db so test-injected sdk_messages rows also invalidate LiveQuery.
  setupTestHandlers(deps.messageHub, deps.reactiveDb.db);
  setupRewindHandlers(deps.messageHub, deps.sessionManager, deps.internalEventBus);

  // Dialog handlers (native OS dialogs)
  setupDialogHandlers(deps.messageHub);

  // Question handlers (AskUserQuestion respond / saveDraft / cancel)
  setupQuestionHandlers(deps.messageHub, deps.sessionManager, deps.internalEventBus);

  // Reference handlers (@ mention system — search + resolve tasks, goals, files, folders)
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

  // LiveQuery subscribe/unsubscribe handlers
  const unsubLiveQuery = setupLiveQueryHandlers(
    deps.messageHub,
    deps.liveQueries,
    deps.db.getDatabase()
  );

  // App-level MCP registry handlers
  registerAppMcpHandlers(deps.messageHub, {
    db: deps.db,
    internalEventBus: deps.internalEventBus,
  });

  // MCP enablement RPC handlers
  setupAppMcpHandlers(deps.messageHub, deps.internalEventBus, deps.db);

  // Per-space MCP enablement RPC handlers + `.mcp.json` import refresh.
  setupSpaceMcpHandlers(deps.messageHub, deps.internalEventBus, deps.db, deps.spaceManager);
  setupAgentMemoryHandlers(deps.messageHub, { memoryRepo: deps.db.agentMemory });
  setupExternalEventExtensionHandlers(deps);

  // Skills registry RPC handlers
  registerSkillHandlers(deps.messageHub, deps.skillsManager, deps.internalEventBus, undefined);

  // Workspace history RPC handlers.
  // The import service is passed in so `workspace.add` can trigger a
  // per-workspace `.mcp.json` scan right after the path is persisted.
  const workspaceHistoryRepo = new WorkspaceHistoryRepository(deps.db.getDatabase());
  setupWorkspaceHandlers(deps.messageHub, workspaceHistoryRepo, deps.mcpImportService);

  // Git context RPC handlers — drives workspace pickers and the session Git panel.
  setupGitHandlers(deps.messageHub, deps.sessionManager.getWorktreeManager(), deps.sessionManager);

  // Space handlers (spaceManager injected from deps — single instance shared with DaemonAppContext)
  const spaceTaskRepo = new SpaceTaskRepository(deps.db.getDatabase(), deps.reactiveDb);
  const gateDataRepo = new GateDataRepository(deps.db.getDatabase());
  const gateOpenStateRepo = new GateOpenStateRepository(deps.db.getDatabase());
  const spaceWorkflowRunRepo = new SpaceWorkflowRunRepository(
    deps.db.getDatabase(),
    gateOpenStateRepo
  );
  const artifactRepo = new WorkflowRunArtifactRepository(deps.db.getDatabase(), deps.reactiveDb);
  const artifactCacheRepo = new WorkflowRunArtifactCacheRepository(deps.db.getDatabase());
  const channelCycleRepo = new ChannelCycleRepository(deps.db.getDatabase());
  const pendingMessageRepo = new PendingAgentMessageRepository(deps.db.getDatabase());
  const spaceAgentInboxRepo = new SpaceAgentInboxRepository(deps.db.getDatabase());
  const taskScheduleRepo = new TaskScheduleRepository(deps.db.getDatabase());
  const spaceRepo = new SpaceRepository(deps.db.getDatabase());
  const sessionRepo = new SessionRepository(deps.db.getDatabase());

  // Centralised TaskSchedule lifecycle service — used by both the RPC
  // handlers (`taskSchedule.*`) and the agent-facing MCP tools so validation,
  // the atomic create+enqueue transaction, and pendingJobId bookkeeping live
  // in exactly one place.
  const scheduleService = new ScheduleService({
    db: deps.db.getDatabase(),
    scheduleRepo: taskScheduleRepo,
    jobQueue: deps.jobQueue,
    spaceRepo,
  });

  // Space Goal service — goal lifecycle, terminal handling, schedule sync.
  const spaceGoalRepo = new SpaceGoalRepository(deps.db.getDatabase(), deps.reactiveDb);
  const spaceGoalEventRepo = new SpaceGoalEventRepository(deps.db.getDatabase(), deps.reactiveDb);
  const spaceGoalService = new SpaceGoalService({
    goalRepo: spaceGoalRepo,
    goalEventRepo: spaceGoalEventRepo,
    taskRepo: spaceTaskRepo,
    spaceRepo,
    scheduleService,
    db: deps.db.getDatabase(),
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
  });

  // Space workflow manager — created early so space.create can call seedBuiltInWorkflows
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
  const spaceAgentRepo = new SpaceAgentRepository(deps.db.getDatabase());
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(deps.db.getDatabase());
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
      evolutionScopeService
    );
  };

  // Space agent handlers
  setupSpaceAgentHandlers(
    deps.messageHub,
    deps.internalEventBus,
    deps.spaceAgentManager,
    deps.spaceManager,
    deps.db
  );
  setupSpaceLongHorizonAgentHandlers(deps.messageHub, deps.spaceManager, longHorizonAgentRepo);

  setupSpaceWorkflowHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceWorkflowManager,
    deps.internalEventBus,
    deps.spaceAgentManager,
    spaceWorkflowRunRepo
  );

  // PR 3/5: narrow auto re-stamp pass — applies the template fields that are
  // safe to update in-place on built-in-seeded rows: `postApproval`,
  // `completionAutonomyLevel`, `templateHash`, and per-node
  // `agents[i].customPrompt` content. Node `id` and agent `agentId` are
  // preserved so in-flight workflow runs continue to resolve correctly.
  //
  // What is NOT covered by this auto-pass: channel / gate structural
  // changes or the addition / removal of whole nodes. Those still surface
  // as drift warnings via `checkBuiltInWorkflowDriftOnStartup` (below) and
  // require a UI-driven re-sync, because re-generating channel or node IDs
  // would break live run references. If a future PR introduces that kind
  // of template delta, `checkBuiltInWorkflowDriftOnStartup` still logs the
  // warning after this pass — the re-stamp only zeroes out hash drift for
  // rows it was actually able to fully update.
  void restampBuiltInWorkflowsOnStartup(
    spaceWorkflowManager,
    deps.spaceManager,
    deps.spaceAgentManager
  )
    .then(() => {
      // Proactive drift detection — fire-and-forget; logs warnings for any
      // workflows that have drifted from their built-in templates since the
      // last sync (e.g. when the re-stamp pass couldn't fully update a row).
      void checkBuiltInWorkflowDriftOnStartup(spaceWorkflowManager, deps.spaceManager);
    })
    .catch((err: unknown) => {
      // Defensive — the re-stamp helper already `try/catch`es internally,
      // but surface any unhandled failure here rather than letting it sink
      // into an unhandled-rejection.
      log.warn('built-in workflow restamp failed:', err);
    });

  // Space Runtime Service — wraps SpaceRuntime with per-space lifecycle API.
  // Not started yet: TaskAgentManager is created next and injected before start().
  // gateDataRepo is injected so notifyGateDataChanged() can trigger lazy node activation
  // after gate data is written externally (e.g. approveGate RPC, writeGateData RPC).
  // sessionManager and internalEventBus are injected so space:chat:${spaceId} sessions are
  // provisioned with MCP tools and system prompts on startup and on space.created.
  const nodeExecutionRepo = new NodeExecutionRepository(deps.db.getDatabase());
  // Reply Routing Registry — shared between space-agent-tools (register)
  // and task-agent-tools / node-agent-tools (lookup).
  const replyRoutingRegistry = new ReplyRoutingRegistry();
  const evolutionEpisodeService = new EvolutionEpisodeService({
    evolutionRepo: deps.db.evolution,
    spaceRepo,
    taskRepo: spaceTaskRepo,
    workflowRunRepo: spaceWorkflowRunRepo,
    artifactRepo,
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
      taskCreatedEventHub: {
        publish: (event, data) => deps.internalEventBus.publish(event as never, data as never),
      },
    })
  );
  setupEvolutionHandlers(deps.messageHub, evolutionScopeService, evolutionEpisodeService, {
    beforeScopeCreate: (params) => {
      validateGoalAutomationSelfNagPolicy(params);
    },
    beforeScopeUpdate: (existing, params) => {
      validateGoalAutomationSelfNagPolicy({
        policy: params.policy ? { ...existing.policy, ...params.policy } : existing.policy,
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
  });

  const spaceRuntimeService = new SpaceRuntimeService({
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
    gateDataRepo,
    gateOpenStateRepo,
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
  });

  // When a space is resumed/started, re-seed skipped schedules and re-run restart
  // stalled recovery for active runs that were skipped while inactive.
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
  });

  // Session handlers — registered here (after spaceRuntimeService is built) so
  // session.create can synchronously call attachSpaceToolsToMemberSession for
  // ad-hoc Space sessions. Doing this via the internalEventBus 'session.created' event
  // would be racy: the query can start (and freeze its MCP config) before the
  // event handler completes.
  setupSessionHandlers(
    deps.messageHub,
    deps.sessionManager,
    deps.internalEventBus,
    deps.spaceManager,
    spaceRuntimeService
  );

  // Space task handlers — registered after spaceRuntimeService so the resume
  // path for pending completion actions can delegate to the runtime.
  setupSpaceTaskHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceWorkflowManager,
    spaceTaskManagerFactory,
    deps.internalEventBus,
    spaceRuntimeService,
    spaceGoalService
  );

  // Task schedule handlers — create/list/get/update/pause/resume/delete schedules.
  setupTaskScheduleHandlers(deps.messageHub, {
    scheduleService,
    spaceManager: deps.spaceManager,
  });

  // Space goal handlers — create/list/get/update/pause/resume/createImmediateTask.
  setupSpaceGoalHandlers(deps.messageHub, {
    goalService: spaceGoalService,
    spaceManager: deps.spaceManager,
  });

  // Register Space RPC handlers now that spaceRuntimeService exists.
  // spaceRuntimeService is passed so space.create can call setupSpaceAgentSession()
  // directly after session creation, avoiding reliance on the internalEventBus event.
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

  // Space Worktree Manager — one worktree per task, shared by all node agents.
  const spaceWorktreeManager = new SpaceWorktreeManager(deps.db.getDatabase());

  // Space Agent injector — routes Task Agent → Space Agent escalations into the
  // `space:chat:${spaceId}` session via SessionManager. Shared between
  // TaskAgentManager (for queue flush) and task-agent tool wiring.
  const sessionManagerRef = deps.sessionManager;
  const spaceAgentInjector = async (
    spaceId: string,
    message: string,
    replyToSessionId?: string | null
  ): Promise<void> => {
    let sessionId = replyToSessionId || `space:chat:${spaceId}`;
    let session = await sessionManagerRef.getSessionAsync(sessionId);
    // Fallback: if the routed-to session no longer exists (e.g. ad-hoc member
    // session ended), fall back to the canonical space chat session so the
    // reply is not silently dropped.
    if (!session && replyToSessionId) {
      sessionId = `space:chat:${spaceId}`;
      session = await sessionManagerRef.getSessionAsync(sessionId);
    }
    if (!session) {
      throw new Error(`Session not found for Space Agent reply routing: ${sessionId}`);
    }
    const messageId = generateUUID();
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
    await session.ensureQueryStarted();
    deps.reactiveDb.db.saveUserMessage(sessionId, sdkUserMessage, 'enqueued');
    await session.messageQueue.enqueueWithId(messageId, message);
  };

  // Task Agent Manager — manages Task Agent session lifecycle and message injection.
  // Must be created after spaceRuntimeService so it can get WorkflowExecutors via
  // spaceRuntimeService.createOrGetRuntime(spaceId).
  const taskAgentManager = new TaskAgentManager({
    // Use reactiveDb.db so Task Agent session writes invalidate LiveQuery tables.
    db: deps.reactiveDb.db,
    sessionManager: deps.sessionManager,
    reactiveDb: deps.reactiveDb,
    spaceManager: deps.spaceManager,
    spaceAgentManager: deps.spaceAgentManager,
    spaceWorkflowManager,
    spaceRuntimeService,
    taskRepo: spaceTaskRepo,
    workflowRunRepo: spaceWorkflowRunRepo,
    gateDataRepo,
    gateOpenStateRepo,
    channelCycleRepo,
    messageHub: deps.messageHub,
    getApiKey: () => deps.authManager.getCurrentApiKey(),
    defaultModel: deps.config.defaultModel,
    appMcpManager: deps.appMcpManager,
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
        command.deliveryMode ?? 'immediate'
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  });

  // Wire TaskAgentManager into the SpaceRuntime so the tick loop can spawn
  // Task Agent sessions for pending tasks. Resolves circular dependency:
  // SpaceRuntimeService → SpaceRuntime needed TaskAgentManager, which in turn
  // needed SpaceRuntimeService. Both are now created; inject via setter.
  spaceRuntimeService.setTaskAgentManager(taskAgentManager);
  spaceRuntimeService.start();

  // Human ↔ Task Agent message routing handlers (require taskAgentManager).
  // `channelCycleRepo` is passed so `space.task.sendMessage` can reset the
  // per-channel cycle counters on human touch.
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

  // Space export/import handlers
  setupSpaceExportImportHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceAgentRepo,
    spaceWorkflowRepo,
    spaceWorkflowManager,
    deps.db.getDatabase(),
    deps.internalEventBus
  );

  // Space workflow run handlers — reuse the same factory pattern as spaceTask handlers
  const spaceWorkflowRunTaskManagerFactory: SpaceWorkflowRunTaskManagerFactory = (spaceId) => {
    return new SpaceTaskManager(
      deps.db.getDatabase(),
      spaceId,
      deps.reactiveDb,
      evolutionScopeService
    );
  };
  setupSpaceWorkflowRunHandlers(
    deps.messageHub,
    deps.spaceManager,
    spaceWorkflowManager,
    spaceWorkflowRunRepo,
    gateDataRepo,
    spaceRuntimeService,
    spaceWorkflowRunTaskManagerFactory,
    deps.internalEventBus,
    spaceTaskRepo,
    spaceWorktreeManager,
    artifactRepo,
    artifactCacheRepo,
    deps.jobQueue
  );

  // Register background sync handlers that populate workflow_run_artifact_cache.
  // The RPC handlers above (getGateArtifacts / getCommits / getFileDiff /
  // getCommitFileDiff) now serve from this cache and enqueue a refresh job
  // when the cache is stale or missing.
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

  // Node execution handlers
  setupNodeExecutionHandlers(deps.messageHub, nodeExecutionRepo, spaceWorkflowRunRepo);

  // Return result with cleanup function and exposed services
  return {
    cleanup: async () => {
      unsubLiveQuery();
      await spaceRuntimeService.stop();
      fileIndex.dispose();
    },
    spaceRuntimeService,
    taskAgentManager,
    spaceWorktreeManager,
    spaceGoalService,
    goalAutomationService,
  };
}
