import { createSessionToolActivationOperation } from '../tools/session-tool-activation.ts';
import {
  createSessionToolPreferenceWriter,
  type SessionToolPreferenceWriter,
} from '../tools/write-session-tool-preferences.ts';
import { createNeoHomeOperations } from '../neo/home/operations.ts';
import { createNeoHomeGithubOperation } from '../neo/home/github.ts';
import { NeoHomeRepository } from '../neo/home/repository.ts';
import { neoFolderPath } from '../neo/folder.ts';
import { homedir } from 'node:os';
import { SessionScheduler } from '../scheduler/session-schedules.ts';
import { createSessionScheduleOperations } from '../scheduler/operations.ts';
import { claudeInboxName } from '../drivers/claude-inbox.ts';
import { createClaudeInboxDriver } from '../drivers/claude-inbox-driver.ts';
import { ClaudeInboxRouteRepository } from '../../storage/repositories/claude-inbox-route-repository.ts';
import { createClaudeDesktopModsDriver } from '../drivers/claude-desktop-mods-driver.ts';
import { readLiveClaudeSessions } from '../drivers/claude-desktop-adapter.ts';
import { spawnProcess } from '../runtime-spawn/index.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import { join, resolve } from 'node:path';
import { createWorkflowTaskRecoveryExecutor } from '../tasks/recovery-executor.ts';
import { recoverTaskExecution } from '../tasks/recover-task-execution.ts';
import { createSpaceOperationRegistryProvider } from '../tasks/operations.ts';
import { collectFamilyOperations, type FamilyOperationContext } from './family-operations/index.ts';
import { createNeoService, neoPacksExtension } from '../neo/packs/runtime.ts';
import { setupSpaceServices } from './space-setup.ts';
import { createDaemonExtensionsOperation, type DaemonExtensions } from '../extensions/contract.ts';
import {
  NEO_DRIVER_REFRESH,
  refreshNeoDriverWork,
  scheduleDriverRefresh,
} from '../neo/driver-refresh.ts';
import { NEO_PACK_SWEEP, schedulePackSweep, sweepNeoPacks } from '../neo/pack-sweep.ts';
import {
  runTurnEmbedding,
  scheduleTurnEmbedding,
  WORK_TURN_EMBED,
} from '../drivers/turn-embedding.ts';
import {
  claudeProjectsRoot,
  runClaudeFeed,
  scheduleClaudeFeed,
  WORK_FEED_CLAUDE,
} from '../drivers/claude-feed.ts';
import {
  codexSessionsRoot,
  ownCodexSessions,
  runCodexFeed,
  scheduleCodexFeed,
  WORK_FEED_CODEX,
} from '../drivers/codex-feed.ts';
import { ensureNeoProject, fileNeoSessions } from '../neo/folder.ts';
import { readStartedWork } from '../../storage/work-started-sessions.ts';
import { CLAUDE_DESKTOP_SESSIONS, ownClaudeSessions } from './family-operations/drivers.ts';
import { neoCoordinatorBinding } from '../neo/session-policy.ts';
import { createNeoOperations, neoReorganizeRuntime } from '../neo/operations.ts';
import { createNeoProjectsReorganizer } from '../neo/reorganize-operation.ts';
import {
  NEO_REORGANIZE_IDLE_MS,
  NEO_TOPICS_REORGANIZE_NIGHTLY,
  runNeoNightlyReorganize,
  scheduleNeoNightlyReorganize,
} from '../neo/reorganize-nightly.ts';
import { loadNeoFilePacks } from '../neo/packs/file-packs.ts';
import { adoptNeoFilePacks } from '../neo/packs/index.ts';
import { getDataDir } from '../data-dir.ts';
import { createCompletionGateBindings } from '../tasks/complete-task-gates.ts';
import { isCoderOwnedMergeWorkflow } from '../workflows/post-approval-router.ts';
import { setupOperationHandlers } from './operation-handlers.ts';
import type { UpgradeIdentity } from '../pairing/upgrade-auth.ts';
import { createSpaceCallerScopeResolver } from '../space/runtime/space-caller-scope.ts';
import { createSpaceScopeResolver } from '../space/runtime/space-scope-resolver.ts';
import { createDatabaseDirectTaskWorkerResolver } from '../tasks/direct-task-worker-identity.ts';
import { DirectTaskExecutionRepository } from '../../storage/repositories/direct-task-execution-repository.ts';
import type { MessageHub } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { DaemonCommandMap, InternalCommandBus } from '../internal-command-bus.ts';
import type { ExternalEventStore } from '../external-events/external-event-store.ts';
import type { ExternalEventService } from '../external-events/external-event-service.ts';
import type { SessionManager } from '../session-manager.ts';
import type { AgentSession } from '../agent/agent-session.ts';
import type { AuthManager } from '../auth-manager.ts';
import type { SettingsManager } from '../settings-manager.ts';
import type { Config } from '../../config.ts';
import type { Database } from '../../storage/database.ts';
import type { ReactiveDatabase, TableChangeEvent } from '../../storage/reactive-database.ts';

import { setupSessionHandlers } from './session-handlers.ts';
import { setupMessageHandlers } from './message-handlers.ts';
import { setupSystemHandlers } from './system-handlers.ts';
import { setupAuthHandlers } from './auth-handlers.ts';
import { registerMcpHandlers } from './mcp-handlers.ts';
import { publishGlobalSettings, registerSettingsHandlers } from './settings-handlers.ts';
import { registerCustomEndpointHandlers } from './custom-endpoint-handlers.ts';
import { registerVoiceHandlers } from './voice-handlers.ts';
import { setupProviderHandlers } from './provider-handlers.ts';
import { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import { setupRewindHandlers } from './rewind-handlers.ts';
import type { GitHubService } from '../github/github-service.ts';
import { Logger } from '../logger.ts';
import { setupDialogHandlers } from './dialog-handlers.ts';
import { setupQuestionHandlers } from './question-handlers.ts';
import { setupSpaceTaskMessageHandlers } from './space-task-message-handlers.ts';
import { createDefaultSessionResolutionDeps } from '../session-resolution/default-deps.ts';
import { ensureSession } from '../session-resolution/ensure-session.ts';
import { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';
import { SpaceWorktreeManager } from '../workspaces/worktree-manager.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import { spaceTaskWriter } from '../../storage/repositories/space-task-repository.ts';
import { WorkflowHookStateRepository } from '../../storage/repositories/workflow-hook-state-repository.ts';
import { GoalAutomationService } from '../goals/automation-service.ts';
import { archiveAgentSessions } from './space-agent-v2-handlers.ts';
import {
  deliverSpaceAgentMessage,
  type SessionInjectionOutcome,
} from '../messaging/session-message-delivery.ts';
import { resolveDeliverySession } from '../session-resolution/resolve-delivery-session.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { JobQueueProcessor } from '../../storage/job-queue-processor.ts';
import { SpaceRuntimeService } from '../space/runtime/space-runtime-service.ts';
import { SpaceAgentInactivityWatchdogService } from '../agents/inactivity-watchdog-service.ts';
import { setupSpaceWorkflowRunHandlers } from './space-workflow-run-handlers.ts';
import { setupNodeExecutionHandlers } from './space-node-execution-handlers.ts';
import { setupSpaceExportImportHandlers } from './space-export-import-handlers.ts';
import { setupLiveQueryHandlers } from './live-query-handlers.ts';
import { readLiveSessionList } from '../../storage/repositories/session-list-live-read.ts';
import { setupReferenceHandlers } from './reference-handlers.ts';
import { FileIndex } from '../file-index.ts';
import { LiveQueryEngine } from '../../storage/live-query.ts';
import type { McpImportService } from '../mcp/index.ts';
import { registerAppMcpHandlers, setupAppMcpHandlers } from './app-mcp-handlers.ts';
import { setupSpaceMcpHandlers } from './space-mcp-handlers.ts';
import { registerSkillHandlers } from './skill-handlers.ts';
import type { SkillsManager } from '../skills-manager.ts';
import { setupWorkspaceHandlers } from './workspace-handlers.ts';
import { setupGitHandlers } from './git-handlers.ts';
import { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository.ts';
import { setupAgentMemoryHandlers } from './agent-memory-handlers.ts';
import { SpaceGoalService } from '../goals/service.ts';
import { ExternalEventExtensionConfigStore } from '../external-events/extension-config-store.ts';
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

import { validateGoalAutomationSelfNagPolicy } from '../evolution/evolution-policy-validation.ts';
export { validateGoalAutomationSelfNagPolicy };
import {
  readSelfNagScheduleScopeId,
  syncGoalAutomationSelfNagScheduleForScope,
} from '../goals/automation-schedule-sync.ts';
export { readSelfNagScheduleScopeId, syncGoalAutomationSelfNagScheduleForScope };

export interface RPCHandlerDependencies {
  extensions: DaemonExtensions;
  watchSessionRepo?: (owner: string, repo: string) => Promise<string | null>;
  messageHub: MessageHub;
  deviceOf: (clientId: string) => UpgradeIdentity | null;
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
  jobQueue: JobQueueRepository;
  jobProcessor: JobQueueProcessor;
  purgeClaudeFeed?: (sessionIds: string[]) => Promise<void>;
  reactiveDb: ReactiveDatabase;
  liveQueries: LiveQueryEngine;
  skillsManager: SkillsManager;
  mcpImportService: McpImportService;
}

const log = new Logger('rpc-handlers');

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
  sessionScheduler: SessionScheduler;
  prepareNeoInput: ReturnType<typeof createNeoService>['speech']['prepareInput'];
  notifyScheduleIdle: ReturnType<typeof createNeoService>['notifyScheduleIdle'];
  wakePollingConcern: (key: string, text: string) => Promise<boolean>;
}

export async function setupRPCHandlers(
  deps: RPCHandlerDependencies
): Promise<RPCHandlerSetupResult> {
  let taskAgentManager: TaskAgentManager;
  const persistToolPreferences: SessionToolPreferenceWriter = (id, request, tools) =>
    createSessionToolPreferenceWriter(deps.db, async () => {
      const stored = deps.db.getSession(id);
      if (!stored) return;
      const live = new Set([
        taskAgentManager?.getCachedAgentSessionById(id),
        deps.sessionManager.getCachedSession(id),
      ]);
      for (const session of live)
        if (session)
          session.getSessionData().config = {
            ...session.getSessionData().config,
            toolSelection: stored.config.toolSelection,
            tools: stored.config.tools,
          };
      await deps.internalEventBus.publish('session.updated', {
        sessionId: id,
        source: 'tool-preferences',
        session: { config: stored.config },
      });
      if (request.kind === 'skills')
        await (
          taskAgentManager?.getCachedAgentSessionById(id) ??
          deps.sessionManager.getCachedSession(id)
        )?.refreshToolsContextUsage();
    })(id, request, tools);
  const preferenceWrites = new Map<string, Promise<unknown>>();
  const exclusiveToolPreferences = <T>(id: string, write: () => Promise<T>): Promise<T> => {
    const previous = preferenceWrites.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(write);
    preferenceWrites.set(id, next);
    void next
      .finally(() => {
        if (preferenceWrites.get(id) === next) preferenceWrites.delete(id);
      })
      .catch(() => {});
    return next;
  };
  const writeToolPreferences: SessionToolPreferenceWriter = (id, request, tools) =>
    exclusiveToolPreferences(id, () => persistToolPreferences(id, request, tools));
  setupMessageHandlers(deps.messageHub, deps.sessionManager, deps.db);
  setupOperationHandlers(
    deps.messageHub,
    () => deps.sessionManager.getOperationRegistry(),
    deps.deviceOf
  );
  setupSystemHandlers(deps.messageHub, deps.sessionManager, () => deps.db.getDataMigrationStatus());
  setupAuthHandlers(
    deps.messageHub,
    deps.authManager,
    deps.credentialManager,
    deps.internalEventBus,
    deps.db.providers
  );
  registerMcpHandlers(deps.messageHub, deps.sessionManager, writeToolPreferences);
  registerSettingsHandlers(
    deps.messageHub,
    deps.settingsManager,
    deps.internalEventBus,
    deps.db,
    deps.credentialManager
  );
  registerCustomEndpointHandlers(
    deps.messageHub,
    deps.settingsManager,
    deps.internalEventBus,
    deps.db,
    deps.credentialManager
  );
  registerVoiceHandlers(deps.messageHub, deps.settingsManager, deps.credentialManager, {
    db: deps.db.getDatabase(),
    deviceOf: deps.deviceOf,
  });

  const providerCredentialManager =
    deps.credentialManager ?? ProviderCredentialManager.create(deps.db.getDatabase());
  setupProviderHandlers({
    messageHub: deps.messageHub,
    providerRepo: deps.db.providers,
    credentialManager: providerCredentialManager,
    internalEventBus: deps.internalEventBus,
  });

  setupRewindHandlers(deps.messageHub, deps.sessionManager, deps.internalEventBus);

  setupDialogHandlers(deps.messageHub);

  setupQuestionHandlers(deps.messageHub, deps.sessionManager, deps.internalEventBus);

  const fileIndex = new FileIndex(deps.config.workspaceRoot);
  fileIndex.init().catch((err) => {
    log.warn('FileIndex init failed:', err);
  });
  setupReferenceHandlers(deps.messageHub, {
    sessionManager: deps.sessionManager,
    workspaceRoot: deps.config.workspaceRoot,
    fileIndex,
  });

  const unsubLiveQuery = setupLiveQueryHandlers(
    deps.messageHub,
    deps.liveQueries,
    deps.db.getDatabase(),
    (args) => deps.db.getMessageFeedAsync(args),
    (includeArchived) => deps.db.gateway.call(readLiveSessionList, 'read', includeArchived)
  );

  registerAppMcpHandlers(deps.messageHub, {
    db: deps.db,
    internalEventBus: deps.internalEventBus,
  });

  setupAppMcpHandlers(deps.messageHub, deps.internalEventBus, deps.db, writeToolPreferences);

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

  setupGitHandlers(
    deps.messageHub,
    deps.sessionManager.getWorktreeManager(),
    deps.sessionManager,
    (sessionId) => !!neoCoordinatorBinding(deps.db, sessionId)
  );

  const {
    stopInactivityRunNow,
    cancelInactivityWatchdog: cancelSpaceInactivityWatchdog,
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
  } = await setupSpaceServices(deps, {
    spaceOperationRegistryProvider: () => spaceOperationRegistryProvider(),
  });

  setupSessionHandlers(
    deps.messageHub,
    deps.sessionManager,
    deps.internalEventBus,
    deps.spaceManager,
    spaceRuntimeService,
    {
      writeToolPreferences,
      ensureSession: (target) => ensureSession(target, sessionResolutionDeps),
      resolveClones,
      listClones: (parentId) => deps.db.listChildSessions(parentId),
      primaryAgentFor: (sessionId) => {
        const agent = spaceAgentRepo.getBySessionId(sessionId);
        return agent ? { id: agent.id, displayName: agent.displayName } : null;
      },
    }
  );

  let sessionResolutionDeps: ReturnType<typeof createDefaultSessionResolutionDeps>;
  const sessionMessageInjector = async (
    spaceId: string,
    message: string,
    replyToSessionId?: string | null,
    explicitMessageId?: string,
    injectorOptions?: {
      onConsumed?: (settledSessionId: string) => void;
      lateSettlement?: import('../messaging/session-message-delivery.ts').SessionLateSettlementOwner;
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

  taskAgentManager = new TaskAgentManager({
    db: deps.reactiveDb.db,
    readGithubPr: (url, workspacePath) => neoService.readConnectorPr(url, workspacePath),
    readGithubReviewThreads: (url, workspacePath) =>
      neoService.readReviewThreads(url, workspacePath),
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
  const claudeInbox = createClaudeInboxDriver({
    name: claudeInboxName(resolve(deps.config.dbPath)),
    routes: new ClaudeInboxRouteRepository(deps.db.getDatabase()),
    registrationsDir: join(homedir(), '.claude', 'sessions'),
    liveSessions: () => readLiveClaudeSessions(spawnProcess),
    hasSession: (sessionId) => {
      const session = deps.sessionManager.getSessionFromDB(sessionId);
      return !!session && !['archived', 'ended'].includes(session.status);
    },
    handoff: (args) => handoffPromptToMailbox({ ...args, jobQueue: deps.jobQueue }),
    onError: (error) => log.warn('Claude inbox reply could not be persisted', error),
  });
  void claudeInbox.listen().catch((error) => log.warn('Claude reply inbox not reopened', error));
  const claudeDesktopMods = createClaudeDesktopModsDriver({
    db: deps.db.getDatabase(),
    env: process.env,
    registrationsDir: join(homedir(), '.claude', 'sessions'),
    liveSessions: () => readLiveClaudeSessions(spawnProcess),
    hasSession: (id) => {
      const session = deps.sessionManager.getSessionFromDB(id);
      return !!session && !['archived', 'ended'].includes(session.status);
    },
    onError: (error) => log.warn('Claude Desktop mods bridge unavailable', error),
  });
  const sessionScheduler = new SessionScheduler(deps.db.getDatabase(), deps.jobQueue);
  const driverCleanup: (() => Promise<void>)[] = [];
  const familyContext: FamilyOperationContext = {
    driverCleanup,
    sessionScheduler,
    neoPacks: () => neoService.packs(),
    extensionAdapters: (host) => deps.extensions.adapters(host),
    claudeDesktopMods,
    claudeInbox,
    deps,
    spaceRuntimeService,
    taskAgentManager,
    spaceTaskManagerFactory,
    spaceTaskRepo,
    nodeExecutionRepo,
    longHorizonAgentRepo,
    spaceAgentRepo,
    spaceAgentGoalScopeRepo,
    spaceAgentTemplateRepo,
    spaceAgentTemplateManager,
    spaceAgentReminderRepo,
    spaceAgentSubscriptionRepo,
    spaceSessionEventSubscriptionRepo,
    hasDirectWorkerProvenance: (sessionId: string) =>
      directTaskExecutionRepo.hasSessionProvenance(sessionId),
    resolveDirectWorker: directTaskWorkerResolver,
    spaceAgentInactivityConfigRepo,
    spaceAgentInactivityClaimRepo,
    spaceGoalService,
    spaceGoalRepo,
    spaceGoalEventRepo,
    goalAutomationService,
    evolutionScopeService,
    evolutionEpisodeService,
    scheduleService,
    taskScheduleRepo,
    spaceWorkflowRepo,
    spaceWorkflowRunRepo,
    spaceWorkflowManager,
    artifactRepo,
    artifactProfile,
    channelCycleRepo,
    replyRoutingRegistry,
    archiveAgentSessions: (agent) =>
      agent.sessionId
        ? archiveAgentSessions(spaceAgentV2Deps, agent.sessionId)
        : Promise.resolve({ ok: true }),
  };
  const neoService = createNeoService(
    deps.db,
    deps.sessionManager,
    deps.messageHub,
    deps.internalEventBus,
    (settings) => publishGlobalSettings(deps.internalEventBus, settings, deps.credentialManager)
  );
  deps.extensions.register(neoPacksExtension(neoService));
  deps.reactiveDb.on('change:neo_session_messages', () => neoService.notifyChanged());
  neoService.filePacks = adoptNeoFilePacks(
    loadNeoFilePacks({
      root: join(getDataDir(), 'neo-packs'),
      warn: (id, error) => log.warn(`Neo file pack ${id} was not loaded`, error),
    })
  );
  const neoHome = new NeoHomeRepository(neoFolderPath(), neoService.repo);
  const familyOperations = [
    createSessionToolActivationOperation({
      write: persistToolPreferences,
      exclusive: exclusiveToolPreferences,
      getLiveSession: (id) =>
        taskAgentManager?.getCachedAgentSessionById(id) ?? deps.sessionManager.getCachedSession(id),
    }),
    ...collectFamilyOperations({
      ...familyContext,
      driverHealthNotice: async (id, text) => {
        const root = neoService.repo.defaultBinding()?.sessionId;
        if (!root) return false;
        await neoService.deliverForward(root, id, text, root, 'event');
        return true;
      },
      goalMandateChange: (ref, revision) => neoHome.changedRevision(ref, revision),
      executionPreparations: () => neoService.packs(),
    }),
    ...deps.extensions.operations(),
    createDaemonExtensionsOperation(deps.extensions),
    ...createNeoOperations(neoService),
    ...createNeoHomeOperations(neoService, neoHome),
    createNeoHomeGithubOperation(neoService, neoHome),
    ...createSessionScheduleOperations(sessionScheduler),
  ];
  sessionScheduler.recover();
  let progressRefresh: Promise<void> | undefined;
  const progressRequested = new Set<string | undefined>();
  let progressClosed = false;
  const refreshScheduleProgress = (sessionId?: string) => {
    progressRequested.add(sessionId);
    if (progressRefresh || progressClosed) return;
    progressRefresh = (async () => {
      while (progressRequested.size && !progressClosed) {
        const targets = progressRequested.has(undefined) ? [undefined] : [...progressRequested];
        progressRequested.clear();
        for (const target of targets) await sessionScheduler.refreshProgress(target);
      }
    })()
      .catch((error) => log.warn('Schedule progress refresh failed', error))
      .finally(() => {
        progressRefresh = undefined;
        if (progressRequested.size && !progressClosed) refreshScheduleProgress();
      });
  };
  const onScheduleProgress = (...args: unknown[]) => {
    const { tables, scope } = args[0] as TableChangeEvent;
    if (
      tables.some((table) => ['neo_goals', 'goal_journal', 'neo_asks', 'neo_todos'].includes(table))
    )
      refreshScheduleProgress();
    else if (tables.includes('sdk_messages')) refreshScheduleProgress(scope?.sessionId);
  };
  deps.reactiveDb.on('change', onScheduleProgress);
  const offScheduleProgress = deps.internalEventBus.subscribe(
    'neo.changed',
    () => refreshScheduleProgress(),
    { subscriberName: 'session-schedule-progress' }
  );
  driverCleanup.push(async () => {
    progressClosed = true;
    offScheduleProgress();
    deps.reactiveDb.off('change', onScheduleProgress);
    await progressRefresh;
  });

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
          const outcome = await neoService.readPrState(prUrl);
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
    neoService.handleWorkerQuestion
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

  sessionResolutionDeps = createDefaultSessionResolutionDeps({
    sessionManager: deps.sessionManager,
    taskAgentManager,
    spaceRuntimeService,
    nodeExecutionRepo,
    taskRepo: spaceTaskRepo,
    longHorizonAgentRepo,
  });
  setupSpaceTaskMessageHandlers(
    deps.messageHub,
    taskAgentManager,
    deps.db,
    deps.internalEventBus,
    nodeExecutionRepo,
    channelCycleRepo,
    undefined,
    (target) => ensureSession(target, sessionResolutionDeps)
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

  if (process.env.NODE_ENV !== 'test') {
    const neoFolder = ensureNeoProject(deps.db.workspaceHistory);
    void fileNeoSessions(deps.db, neoService.repo, neoFolder)
      .catch((error) => log.warn('Neo sessions not filed', error))
      .then(() => neoService.openDefault())
      .catch((error) => log.warn('Neo default session not opened', error));
  }
  void neoService.recover();
  deps.jobProcessor.register(NEO_DRIVER_REFRESH, () =>
    refreshNeoDriverWork(deps.jobQueue, neoService)
  );
  scheduleDriverRefresh(deps.jobQueue);
  deps.jobProcessor.register(NEO_PACK_SWEEP, () => sweepNeoPacks(deps.jobQueue, neoService));
  schedulePackSweep(deps.jobQueue, 0);
  const reorganizeTopics = createNeoProjectsReorganizer(neoReorganizeRuntime(neoService));
  deps.jobProcessor.register(NEO_TOPICS_REORGANIZE_NIGHTLY, (job) =>
    runNeoNightlyReorganize(job, deps.jobQueue, {
      now: () => Date.now(),
      lastHumanAt: () => {
        const root = neoService.repo.defaultBinding()?.sessionId;
        return root ? deps.db.getSDKMessageRepo().lastHumanPromptAt(root) : null;
      },
      reorganize: () => reorganizeTopics({ apply: 'unattended' }),
      log: (line) => neoService.logReorganize(line),
    })
  );
  scheduleNeoNightlyReorganize(deps.jobQueue, Date.now() + NEO_REORGANIZE_IDLE_MS, null);
  deps.jobProcessor.register(WORK_TURN_EMBED, () =>
    runTurnEmbedding(deps.jobQueue, deps.db, deps.db.getEmbedder())
  );
  const startedWork = () =>
    deps.settingsManager.getGlobalSettings().workFeedScope === 'own'
      ? readStartedWork(deps.db.getDatabase())
      : null;
  deps.jobProcessor.register(WORK_FEED_CLAUDE, async () => {
    const started = startedWork();
    return {
      ...(await runClaudeFeed(
        deps.jobQueue,
        deps.db.getDatabase(),
        claudeProjectsRoot(),
        Date.now(),
        deps.purgeClaudeFeed,
        started && (await ownClaudeSessions(started, CLAUDE_DESKTOP_SESSIONS))
      )),
    };
  });
  deps.jobProcessor.register(WORK_FEED_CODEX, async () => {
    const started = startedWork();
    return {
      ...(await runCodexFeed(
        deps.jobQueue,
        deps.db.getDatabase(),
        codexSessionsRoot(),
        Date.now(),
        started && ownCodexSessions(started)
      )),
    };
  });
  if (process.env.NODE_ENV !== 'test') {
    scheduleTurnEmbedding(deps.jobQueue);
    await scheduleCodexFeed(deps.jobQueue);
    await scheduleClaudeFeed(deps.jobQueue);
  }

  return {
    cleanup: async () => {
      try {
        try {
          try {
            await Promise.all(driverCleanup.map((close) => close()));
          } finally {
            await claudeDesktopMods?.close();
          }
        } finally {
          await claudeInbox.close();
        }
      } finally {
        await neoService.dispose();
        await stopInactivityRunNow();
        unsubLiveQuery();
        await spaceRuntimeService.stop();
        fileIndex.dispose();
      }
    },
    spaceRuntimeService,
    taskAgentManager,
    spaceWorktreeManager,
    spaceGoalService,
    goalAutomationService,
    spaceAgentInactivityWatchdog,
    cancelInactivityWatchdog: cancelSpaceInactivityWatchdog,
    sessionScheduler,
    wakePollingConcern: (key: string, text: string) => neoService.wakeNeo(key, text),
    notifyScheduleIdle: neoService.notifyScheduleIdle,
    prepareNeoInput: neoService.speech.prepareInput.bind(neoService.speech),
  };
}
