import { homedir } from 'os';
import { parsePositiveInt, type Config } from './config';
import type { WebSocketData } from './types/websocket';
import { createHttpWsServer, type ServerHandle } from './lib/runtime-server';
import { Database } from './storage/database';
import {
  prefetchAgentMemoryEmbeddingModel,
  abortAgentMemoryEmbeddingModelPrefetch,
} from './storage/repositories/agent-memory-transformers';
import { SessionManager } from './lib/session-manager';
import { AuthManager } from './lib/auth-manager';
import { SettingsManager } from './lib/settings-manager';
import { StateProjectionService } from './lib/state-projection-service';
import { createClientEventBridge } from './lib/client-event-bridge';
import {
  MAX_GITHUB_POLLING_INTERVAL_SECONDS,
  MessageHub,
  MessageHubRouter,
} from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import {
  createDaemonInternalEventBus,
  type DaemonInternalEventMap,
  type InternalEventBus,
} from './lib/internal-event-bus';
import {
  createInternalCommandBus,
  type DaemonCommandMap,
  type InternalCommandBus,
} from './lib/internal-command-bus';
import { createInternalQueryBus, type DaemonQueryMap } from './lib/internal-query-bus';
import { setupRPCHandlers } from './lib/rpc-handlers';
import { applyProviderModelAllowlistsToEnv } from './lib/rpc-handlers/settings-handlers';
import { WebSocketServerTransport } from './lib/websocket-server-transport';
import { createWebSocketHandlers } from './routes/setup-websocket';
import { createGitHubService, type GitHubService } from './lib/github/github-service';
import { ExternalEventService, ExternalEventStore } from './lib/external-events';
import { ExternalEventExtensionConfigStore } from './lib/external-events/extension-config-store';
import {
  ExternalEventExtensionManager,
  isHttpExtension,
  isRpcExtension,
} from './lib/external-events/extension-manager';
import { GitHubEventExtension } from './lib/external-events/github';
import {
  initializeProviders,
  waitForOptionalProviderRegistration,
  markBuiltInProviderDisabled,
} from './lib/providers/factory.js';
import { getProviderRegistry } from './lib/providers/registry.js';
import { OAuthRefreshScheduler } from './lib/credentials/oauth-refresh-scheduler.js';
import { ProviderCredentialManager } from './lib/credentials/provider-credential-manager.js';
import { KeychainUnavailableError } from './lib/credentials/credential-store.js';
import { syncAllProviders } from './lib/providers/provider-sync.js';
import {
  clearProviderFailureRecords,
  subscribeProviderFailureChanges,
} from './lib/providers/provider-failure-store.js';
import {
  backfillDeepSeekProvider,
  migrateProvidersIfNeeded,
  refreshGlmDisplayName,
} from './lib/credential-discovery';
import { createReactiveDatabase } from './storage/reactive-database';
import { LiveQueryEngine } from './storage/live-query';
import { SpaceAgentRepository } from './storage/repositories/space-agent-repository';
import { installProcessFatalLogging } from './lib/process-fatal-logger';
import { WorkflowHookRuntimeService } from './lib/space/workflow-hook-runtime-service';
import { WorkflowHookStateRepository } from './storage/repositories/workflow-hook-state-repository';
import { SpaceLongHorizonAgentRepository } from './storage/repositories/space-long-horizon-agent-repository';
import { SpaceAgentManager } from './lib/space/managers/space-agent-manager';
import { SpaceManager } from './lib/space/managers/space-manager';
import type { SpaceRuntimeService } from './lib/space/runtime/space-runtime-service';
import type { TaskAgentManager } from './lib/space/runtime/task-agent-manager';
import type { SpaceWorktreeManager } from './lib/space/managers/space-worktree-manager';
import { JobQueueRepository } from './storage/repositories/job-queue-repository';
import { JobQueueProcessor, applyStaleReclaimJitter } from './storage/job-queue-processor';
import { createCleanupHandler } from './lib/job-handlers/cleanup.handler';
import {
  createMemoryConsolidationHandler,
  enqueueMemoryConsolidationIfMissing,
} from './lib/job-handlers/memory-consolidation.handler';
import { createSkillValidateHandler } from './lib/job-handlers/skill-validate.handler';
import {
  JOB_QUEUE_CLEANUP,
  LONG_HORIZON_AGENT_REMINDER_FIRE,
  MEMORY_CONSOLIDATION,
  MESSAGE_DELIVERY,
  SKILL_VALIDATE,
  TASK_SCHEDULE_FIRE,
} from './lib/job-queue-constants';
import { createMessageDeliveryHandler } from './lib/job-handlers/message-delivery.handler';
import { settleMessageDeliveryDeadLetter } from './lib/job-handlers/message-delivery-dead-letter';
import { asMessageDeliveryPayload } from './lib/agent/message-delivery';
import { deliveryMetrics } from './lib/agent/message-delivery-metrics';
import { handleTaskScheduleFire } from './lib/job-handlers/task-schedule-fire.handler';
import {
  backfillLongHorizonAgentReminderNextRunAt,
  enqueueLongHorizonAgentReminderScanIfMissing,
  handleLongHorizonAgentReminderFire,
} from './lib/job-handlers/long-horizon-agent-reminder-fire.handler';
import { longTermAgentSessionId } from './lib/space/long-term-agent-session';
import { TaskScheduleRepository } from './storage/repositories/task-schedule-repository';
import { SpaceRepository } from './storage/repositories/space-repository';
import { SpaceTaskRepository } from './storage/repositories/space-task-repository';
import { SpaceGoalRepository } from './storage/repositories/space-goal-repository';
import { AppMcpLifecycleManager, McpImportService, seedDefaultMcpEntries } from './lib/mcp';
import { FileIndex } from './lib/file-index';
import { installConsoleLogCapture, subscribeToStructuredLogs } from './lib/logger';
import { createStartupPhaseTimer } from './lib/startup-phase-timer';
import { StructuredLogFileSink } from './lib/structured-log-file-sink';
import { EvolutionLogEvidenceService } from './lib/space/evolution-log-evidence-service';
import { SkillsManager } from './lib/skills-manager';
import {
  cleanupSuspiciousProcesses,
  ProcessWatchdog,
  type ProcessSnapshot,
} from './lib/process-watchdog';

async function applyStoredProviderCredentials(
  providers: Provider[],
  credentialManager: ProviderCredentialManager,
  logError: (...args: unknown[]) => void
): Promise<void> {
  for (const provider of providers) {
    try {
      const providerCredentials = await provider.getCredentials?.();
      if (providerCredentials?.type === 'oauth') {
        await credentialManager.storeOAuthTokens(provider.id, providerCredentials);
        continue;
      }
      if (providerCredentials?.type === 'api_key') {
        await credentialManager.storeApiKey(provider.id, providerCredentials.apiKey);
        continue;
      }

      const credentials = await credentialManager.getCredentials(provider.id);
      if (credentials && provider.setCredentials) {
        provider.setCredentials(credentials);
      }
    } catch (error) {
      if (error instanceof KeychainUnavailableError) {
        continue;
      }
      credentialManager.markProviderHealth(provider.id, 'unhealthy');
      logError(`[Daemon] Failed to load stored credentials for ${provider.id}:`, error);
    }
  }
}

export async function syncGitHubPollingCapability(
  extensionConfigStore: Pick<
    ExternalEventExtensionConfigStore,
    'getGlobalConfig' | 'setGlobalConfig'
  >,
  pollingEnabled: boolean
): Promise<void> {
  const githubGlobalConfig = await extensionConfigStore.getGlobalConfig('github');
  await extensionConfigStore.setGlobalConfig('github', {
    ...githubGlobalConfig,
    capabilities: {
      ...githubGlobalConfig.capabilities,
      polling: pollingEnabled,
    },
  });
}

let strandedStartupFileLogCapture: (() => Promise<void>) | null = null;

export async function releaseStartupFileLogCapture(): Promise<void> {
  const release = strandedStartupFileLogCapture;
  strandedStartupFileLogCapture = null;
  await release?.();
}

export interface CreateDaemonAppOptions {
  config: Config;
  verbose?: boolean;
  standalone?: boolean;
  onStructuredLogSinkReady?: (flush: () => Promise<void>) => void;
}

export interface DaemonAppContext {
  server: ServerHandle;
  db: Database;
  messageHub: MessageHub;
  sessionManager: SessionManager;
  authManager: AuthManager;
  settingsManager: SettingsManager;
  stateManager: StateProjectionService;
  transport: WebSocketServerTransport;
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  commandBus: InternalCommandBus<DaemonCommandMap>;
  queryBus: ReturnType<typeof createInternalQueryBus<DaemonQueryMap>>;
  gitHubService: GitHubService | null;
  externalEventStore: ExternalEventStore;
  externalEventService: ExternalEventService;
  extensionManager: ExternalEventExtensionManager;
  reactiveDb: ReturnType<typeof createReactiveDatabase>;
  liveQueries: LiveQueryEngine;
  spaceAgentManager: SpaceAgentManager;
  spaceManager: SpaceManager;
  spaceRuntimeService: SpaceRuntimeService;
  taskAgentManager: TaskAgentManager;
  spaceWorktreeManager: SpaceWorktreeManager;
  workflowHookStateRepository: WorkflowHookStateRepository;
  workflowHookRuntimeService: WorkflowHookRuntimeService;
  jobQueue: JobQueueRepository;
  jobProcessor: JobQueueProcessor;
  appMcpManager: AppMcpLifecycleManager;
  skillsManager: SkillsManager;
  fileIndex: FileIndex;
  flushStructuredLogs: () => Promise<void>;
  cleanup: () => Promise<void>;
}

async function invalidateInFlightModelLoads(): Promise<void> {
  try {
    const { clearModelsCache } = await import('./lib/model-service');
    clearModelsCache();
    clearProviderFailureRecords();
  } catch {}
}

export async function createDaemonApp(options: CreateDaemonAppOptions): Promise<DaemonAppContext> {
  const { config, verbose = true, standalone = false } = options;
  let startupLogCaptureCleanup: (() => void) | null = null;
  let unsubscribeProviderFailureChanges: (() => void) | null = null;
  await releaseStartupFileLogCapture().catch(() => {});
  const structuredLogSink = config.structuredLogFilePath
    ? new StructuredLogFileSink({
        path: config.structuredLogFilePath,
        maxBytes: config.structuredLogMaxBytes,
        retainedFiles: config.structuredLogRetainedFiles,
        maxPendingBytes: config.structuredLogMaxPendingBytes,
      })
    : null;
  const unsubscribeFileLogs = structuredLogSink
    ? subscribeToStructuredLogs((event) => structuredLogSink.capture(event))
    : () => {};
  const restoreConsoleCapture = installConsoleLogCapture();
  const disposeProcessFatalLogging =
    process.env.NODE_ENV === 'test'
      ? null
      : installProcessFatalLogging({
          flush: () => structuredLogSink?.flush() ?? Promise.resolve(),
        });
  let fileLogCaptureClosed = false;
  const closeFileLogCapture = async (): Promise<void> => {
    if (fileLogCaptureClosed) return;
    fileLogCaptureClosed = true;
    unsubscribeFileLogs();
    restoreConsoleCapture();
    disposeProcessFatalLogging?.();
    await structuredLogSink?.close();
  };
  const startupTimer = createStartupPhaseTimer(verbose ? console.log : null);

  try {
    options.onStructuredLogSinkReady?.(() => structuredLogSink?.flush() ?? Promise.resolve());

    delete process.env.CLAUDECODE;

    if (process.env.NODE_ENV !== 'test') {
      const prefetchLogInfo = verbose ? console.log : () => {};
      const prefetchLogError = verbose ? console.error : () => {};
      void prefetchAgentMemoryEmbeddingModel({
        logInfo: prefetchLogInfo,
        logError: prefetchLogError,
      });
    }

    const db = new Database(config.dbPath);
    const reactiveDb = createReactiveDatabase(db);
    startupTimer.start('database + auth initialize');
    await db.initialize(reactiveDb);
    const liveQueries = new LiveQueryEngine(db.getDatabase(), reactiveDb);
    const earlySpaceRepo = new SpaceRepository(db.getDatabase());
    const earlyLogEvidenceService = new EvolutionLogEvidenceService({
      evolutionRepo: db.evolution,
      spaceRepo: earlySpaceRepo,
    });
    const unsubscribeEarlyStructuredLogs = subscribeToStructuredLogs((event) => {
      earlyLogEvidenceService.capture(event);
      if (event.level === 'warn' || event.level === 'error' || event.level === 'fatal') {
        earlyLogEvidenceService.flush();
      }
    });
    startupLogCaptureCleanup = () => {
      earlyLogEvidenceService.flush();
      unsubscribeEarlyStructuredLogs();
    };

    const logInfo = verbose ? console.log : () => {};
    const logError = verbose ? console.error : () => {};

    const jobQueue = new JobQueueRepository(db.getDatabase());
    const workflowHookStateRepository = new WorkflowHookStateRepository(db.getDatabase());
    const workflowHookRuntimeService = new WorkflowHookRuntimeService();
    const maxConcurrent = parsePositiveInt(process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT, 5);
    const jobProcessor = new JobQueueProcessor(jobQueue, {
      pollIntervalMs: 1000,
      maxConcurrent,
      staleThresholdMs: 5 * 60 * 1000,
    });
    const messageDeliveryMaxConcurrent = parsePositiveInt(
      process.env.HYPERNEO_MESSAGE_DELIVERY_MAX_CONCURRENT,
      64
    );
    const messageDeliveryProcessor = new JobQueueProcessor(jobQueue, {
      pollIntervalMs: 1000,
      maxConcurrent: messageDeliveryMaxConcurrent,
      staleThresholdMs: 5 * 60 * 1000,
      settlementGraceMs: 35_000,
    });
    jobProcessor.setChangeNotifier(() => {});
    messageDeliveryProcessor.setChangeNotifier((table, scope) => {
      reactiveDb.notifyChange(table, scope);
    });
    let sessionManager: SessionManager | null = null;
    let taskAgentManager: TaskAgentManager | null = null;
    const processWatchdog = new ProcessWatchdog(undefined, () =>
      cleanupSuspiciousProcesses({
        getRootPids: (snapshot?: ProcessSnapshot[]) => {
          const live: number[] = [];
          const exited: number[] = [];
          if (sessionManager) {
            const split = sessionManager.getTrackedAgentRootPidsSplit(snapshot);
            live.push(...split.live);
            exited.push(...split.exited);
          }
          if (taskAgentManager) {
            const split = taskAgentManager.getTrackedAgentRootPidsSplit();
            live.push(...split.live);
            exited.push(...split.exited);
          }
          return { live, exited };
        },
      })
    );

    const spaceAgentManager = new SpaceAgentManager(
      new SpaceAgentRepository(db.getDatabase()),
      new SpaceLongHorizonAgentRepository(db.getDatabase())
    );

    const spaceRepo = earlySpaceRepo;
    const spaceManager = new SpaceManager(db.getDatabase());

    const authManager = new AuthManager(db, config);
    await authManager.initialize();

    const settingsManager = new SettingsManager(
      db,
      process.env.HYPERNEO_WORKSPACE_PATH ?? homedir()
    );
    const getGitHubPollingIntervalSeconds = () => {
      const value = settingsManager.getGlobalSettings().githubPollingInterval;
      if (value === undefined || !Number.isFinite(value)) return 120;
      return Math.min(MAX_GITHUB_POLLING_INTERVAL_SECONDS, Math.max(0, Math.trunc(value)));
    };
    applyProviderModelAllowlistsToEnv(settingsManager.getGlobalSettings().providerModelAllowlists);

    for (const record of db.providers.listProviders()) {
      if (record.kind === 'built_in' && record.isEnabled === false) {
        markBuiltInProviderDisabled(record.providerId);
      }
    }

    startupTimer.start('providers (register + credentials)');
    const providerRegistry = initializeProviders();
    await waitForOptionalProviderRegistration(providerRegistry);
    const credentialManager = ProviderCredentialManager.create(db.getDatabase());
    await applyStoredProviderCredentials(providerRegistry.getAll(), credentialManager, logError);

    startupTimer.start('provider sync (migrate / custom endpoints / registry)');
    try {
      await migrateProvidersIfNeeded(db, credentialManager);
      await backfillDeepSeekProvider(db, credentialManager);
      refreshGlmDisplayName(db);
    } catch (err) {
      logError('[Daemon] Provider migration failed (non-fatal):', err);
    }

    {
      const { syncCustomEndpointProviders } = await import('./lib/providers/factory.js');
      const { filterDisabledCustomEndpoints } = await import(
        './lib/rpc-handlers/custom-endpoint-handlers.js'
      );
      const endpoints = settingsManager.getGlobalSettings().customEndpoints ?? [];
      const syncEndpoints = filterDisabledCustomEndpoints(endpoints, db);
      await syncCustomEndpointProviders(syncEndpoints);
    }

    try {
      await syncAllProviders(() => db.providers.listEnabledProviders(), credentialManager);
    } catch (err) {
      logError('[Daemon] Provider sync failed (non-fatal):', err);
    }

    const authStatus = await authManager.getAuthStatus();
    const anthropicProvider = providerRegistry.get('anthropic');
    const hasAnthropicAuth =
      authStatus.isAuthenticated || (anthropicProvider?.isAvailable() ?? false);

    if (hasAnthropicAuth) {
      void import('./lib/model-service')
        .then(({ initializeModels }) => initializeModels())
        .catch((err) => {
          logError('[Daemon] Background model initialization failed (non-fatal):', err);
        });
    } /* v8 ignore next 3 */ else {
      logInfo('[Daemon] NO CREDENTIALS DETECTED - set ANTHROPIC_API_KEY or authenticate via OAuth');
      logInfo('[Daemon] Model initialization skipped - no credentials available');
    }

    startupTimer.start('message hub + MCP setup');
    const router = new MessageHubRouter({
      logger: console,
      debug: config.nodeEnv === 'development',
      maxSubscriptionsPerClient: config.maxSubscriptionsPerClient,
    });

    const messageHub = new MessageHub({
      defaultSessionId: 'global',
      debug: config.nodeEnv === 'development',
    });

    messageHub.registerRouter(router);

    const transport = new WebSocketServerTransport({
      name: 'websocket-server',
      debug: config.nodeEnv === 'development',
      router,
    });

    messageHub.registerTransport(transport);

    const internalEventBus = createDaemonInternalEventBus();
    unsubscribeProviderFailureChanges = subscribeProviderFailureChanges(() => {
      internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
    });
    const oauthRefreshScheduler = new OAuthRefreshScheduler(credentialManager, {
      registry: providerRegistry,
      onProviderChanged: () => {
        internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
      },
    });
    const logEvidenceService = earlyLogEvidenceService;
    const unsubscribeStructuredLogs = unsubscribeEarlyStructuredLogs;

    const commandBus = createInternalCommandBus<DaemonCommandMap>();

    const queryBus = createInternalQueryBus<DaemonQueryMap>();

    const appMcpManager = new AppMcpLifecycleManager(db);
    seedDefaultMcpEntries(db);

    const mcpImportService = new McpImportService(db);
    startupTimer.start('mcp import sweep (.mcp.json)');
    if (process.env.NODE_ENV !== 'test') {
      try {
        const workspacePaths = db.workspaceHistory.list(100).map((row) => row.path);
        const { results, orphanPruned } = mcpImportService.refreshAll(workspacePaths);
        const added = results.reduce((s, r) => s + r.added, 0);
        const updated = results.reduce((s, r) => s + r.updated, 0);
        const removed = results.reduce((s, r) => s + r.removed, 0) + orphanPruned;
        const skippedFiles = results.filter((r) => r.status !== 'ok').length;
        logInfo(
          `[Daemon] MCP import sweep: ${added} added, ${updated} updated, ${removed} removed` +
            (skippedFiles > 0 ? `, ${skippedFiles} file(s) skipped` : '') +
            ` across ${results.length} scanned`
        );
      } catch (err) {
        logError('[Daemon] MCP import sweep failed (non-fatal):', err);
      }
    }

    const skillsManager = new SkillsManager(db.skills, db.appMcpServers, jobQueue);
    skillsManager.initializeBuiltins();

    try {
      startupTimer.start('skill plugin wrappers');
      await skillsManager.ensureBuiltinPluginWrappers();
    } catch (err) {
      logError('[Daemon] Failed to ensure builtin skill plugin wrappers (non-fatal):', err);
    }

    startupTimer.start('session manager');
    sessionManager = new SessionManager(
      reactiveDb.db,
      messageHub,
      authManager,
      settingsManager,
      internalEventBus,
      {
        defaultModel: config.defaultModel,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      },
      jobQueue,
      jobProcessor,
      skillsManager,
      db.appMcpServers
    );

    sessionManager.start();

    startupTimer.start('state projection service');
    const stateManager = new StateProjectionService(
      messageHub,
      sessionManager,
      authManager,
      settingsManager,
      config,
      db,
      internalEventBus,
      undefined,
      credentialManager,
      reactiveDb
    );

    const clientEventGateway = stateManager.getClientEventGateway();
    const clientEventBridge = createClientEventBridge(
      internalEventBus,
      clientEventGateway,
      stateManager
    );
    clientEventBridge.start();

    credentialManager.registerStatusChangeCallback(() => {
      void stateManager.broadcastSystemChange();
      void applyStoredProviderCredentials(providerRegistry.getAll(), credentialManager, logError);
    });

    startupTimer.start('github + external event setup');
    let gitHubService: GitHubService | null = null;
    const shouldEnableGitHub = config.githubWebhookSecret || getGitHubPollingIntervalSeconds() > 0;

    if (hasAnthropicAuth) {
      const storedCredentials = await anthropicProvider?.getCredentials?.();
      const apiKey =
        config.anthropicApiKey ||
        config.claudeCodeOAuthToken ||
        config.anthropicAuthToken ||
        (storedCredentials?.type === 'api_key' ? storedCredentials.apiKey : undefined) ||
        (storedCredentials?.type === 'oauth' ? storedCredentials.accessToken : undefined);
      const apiKeyType: 'api_key' | 'oauth' | undefined =
        storedCredentials?.type === 'api_key'
          ? 'api_key'
          : storedCredentials?.type === 'oauth'
            ? 'oauth'
            : apiKey === config.claudeCodeOAuthToken || apiKey === config.anthropicAuthToken
              ? 'oauth'
              : apiKey === config.anthropicApiKey
                ? 'api_key'
                : undefined;

      if (apiKey) {
        gitHubService = createGitHubService({
          db,
          internalEventBus,
          config,
          apiKey,
          apiKeyType,
          githubToken: process.env.GITHUB_TOKEN,
          jobQueue,
          jobProcessor,
          getPollingIntervalSeconds: getGitHubPollingIntervalSeconds,
        });

        if (shouldEnableGitHub) {
          logInfo('[Daemon] GitHub integration enabled', {
            webhook: !!config.githubWebhookSecret,
            polling: getGitHubPollingIntervalSeconds() > 0,
          });
        } else {
          logInfo('[Daemon] GitHub integration initialized; polling disabled by settings');
        }
      } else {
        logInfo('[Daemon] GitHub integration disabled - no API key available for AI agents');
      }
    } else if (shouldEnableGitHub) {
      logInfo('[Daemon] GitHub integration disabled - authentication required');
    }

    const fileIndex = new FileIndex(config.workspaceRoot);
    void fileIndex.init();

    const externalEventStore = new ExternalEventStore(db.getDatabase(), reactiveDb);
    const externalEventService = new ExternalEventService(externalEventStore, internalEventBus);
    const extensionConfigStore = new ExternalEventExtensionConfigStore(db.getDatabase());
    const sourceConfigTables: Record<string, string[]> = {
      github: ['space_github_watched_repos'],
    };
    const extensionContext = {
      publisher: externalEventService,
      config: extensionConfigStore,
      onSourceConfigChanged(change: { source: string; spaceId?: string; kind: string }) {
        logInfo('[Daemon] Extension config changed', change);
        for (const table of sourceConfigTables[change.source] ?? []) {
          reactiveDb.notifyChange(table);
        }
      },
    };
    const extensionManager = new ExternalEventExtensionManager();
    const githubPollingEnabled = getGitHubPollingIntervalSeconds() > 0;
    await syncGitHubPollingCapability(extensionConfigStore, githubPollingEnabled);
    extensionManager.register(
      new GitHubEventExtension(db.getDatabase(), process.env.GITHUB_TOKEN, {
        getPollIntervalMs: () => getGitHubPollingIntervalSeconds() * 1000,
        credentialStore: credentialManager.getCredentialStore(),
        reactiveDb,
        autoReconcileWebhooks: true,
      })
    );

    const githubEventExtension = extensionManager.getExtension('github') as
      | GitHubEventExtension
      | undefined;
    let lastGitHubPollingIntervalSeconds = getGitHubPollingIntervalSeconds();
    internalEventBus.subscribe(
      'settings.updated',
      (event) => {
        if (event.namespaceId !== 'global') return;
        const nextGitHubPollingIntervalSeconds = getGitHubPollingIntervalSeconds();
        if (nextGitHubPollingIntervalSeconds === lastGitHubPollingIntervalSeconds) return;
        lastGitHubPollingIntervalSeconds = nextGitHubPollingIntervalSeconds;
        gitHubService?.refreshPolling({ reschedulePending: true });
        void (async () => {
          await syncGitHubPollingCapability(
            extensionConfigStore,
            getGitHubPollingIntervalSeconds() > 0
          );
          await githubEventExtension?.refreshPollingInterval();
        })();
      },
      { subscriberName: 'github-polling-settings' }
    );

    startupTimer.start('external event extensions');
    for (const extension of extensionManager.getAll()) {
      const globalConfig = await extensionContext.config.getGlobalConfig(extension.sourceId);
      if (!globalConfig.globallyEnabled) continue;

      if (isHttpExtension(extension)) {
        extensionManager.registerRoutes(extension.routes, extensionContext);
      }
      if (isRpcExtension(extension) && globalConfig.capabilities.rpcConfig) {
        extensionManager.registerRpcHandlers(extension.sourceId, messageHub, extensionContext);
      }

      await extensionManager.startExtension(extension.sourceId, extensionContext);
      logInfo(`[Daemon] Started external event extension: ${extension.sourceId}`);
    }

    startupTimer.start('rpc handlers + space runtime provision');
    const rpcHandlers = setupRPCHandlers({
      messageHub,
      sessionManager,
      authManager,
      credentialManager,
      settingsManager,
      config,
      internalEventBus,
      commandBus,
      externalEventStore,
      db,
      gitHubService: gitHubService ?? undefined,
      externalEventService,
      externalEventExtensionManager: extensionManager,
      externalEventExtensionConfigStore: extensionConfigStore,
      externalEventExtensionContext: extensionContext,
      spaceManager,
      spaceAgentManager,
      jobQueue,
      jobProcessor,
      messageDeliveryProcessor,
      reactiveDb,
      liveQueries,
      appMcpManager,
      skillsManager,
      mcpImportService,
    });
    const {
      cleanup: rpcHandlerCleanup,
      spaceRuntimeService,
      spaceWorktreeManager,
      spaceGoalService,
      goalAutomationService,
    } = rpcHandlers;
    taskAgentManager = rpcHandlers.taskAgentManager;

    startupTimer.start('space runtime ready kickoff + HTTP/WS server bind');
    const spaceRuntimeReadyPromise = spaceRuntimeService.ready();

    const wsHandlers = createWebSocketHandlers(transport, sessionManager);

    const server = await createHttpWsServer({
      hostname: config.host,
      port: config.port,

      async fetch(req, upgrade) {
        const url = new URL(req.url);

        if (req.method === 'OPTIONS') {
          return new Response(null, {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            },
          });
        }

        if (url.pathname === '/ws') {
          const upgradeResponse = upgrade(req, {
            connectionSessionId: 'global',
          });

          if (upgradeResponse) {
            return upgradeResponse;
          }

          return new Response('WebSocket upgrade failed', { status: 500 });
        }

        if (standalone && url.pathname === '/') {
          return Response.json(
            {
              name: 'HyperNeo Daemon',
              version: '0.1.1',
              status: 'running',
              protocol: 'WebSocket-only (MessageHub RPC + Pub/Sub)',
              endpoints: {
                webSocket: '/ws',
              },
              note: 'All operations use MessageHub protocol with bidirectional RPC and Pub/Sub. Session routing via message.sessionId field. REST API has been removed.',
            },
            {
              headers: { 'Access-Control-Allow-Origin': '*' },
            }
          );
        }

        const extensionRoute = extensionManager
          .getRegisteredRoutes()
          .find((route) => route.path === url.pathname && route.method === req.method);
        if (extensionRoute) {
          return extensionRoute.handle(req);
        }

        if (url.pathname === '/hello' && req.method === 'GET') {
          return new Response('Hello World', {
            status: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }

        return new Response('Not found', {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      },

      websocket: wsHandlers,

      onError(error) {
        logError('Server error:', error);
        return new Response(
          JSON.stringify({
            error: 'Internal server error',
            message: error instanceof Error ? error.message : String(error),
          }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      },
    });

    startupTimer.start('post-bind jobs + background services');
    const openMessageSearchMergeGate = (): void => db.startMessageSearchMerges();
    void spaceRuntimeReadyPromise.then(openMessageSearchMergeGate, openMessageSearchMergeGate);
    void spaceRuntimeReadyPromise.then(() => {
      logInfo('[Daemon] Space runtime startup provisioning complete');
    });
    if (gitHubService && shouldEnableGitHub) {
      gitHubService.start();
      logInfo('[Daemon] GitHub service started');
    }

    jobProcessor.register(
      SKILL_VALIDATE,
      createSkillValidateHandler(skillsManager, db.appMcpServers)
    );
    jobProcessor.register(JOB_QUEUE_CLEANUP, createCleanupHandler(jobQueue));
    jobProcessor.register(
      MEMORY_CONSOLIDATION,
      createMemoryConsolidationHandler(db.agentMemory, jobQueue)
    );

    messageDeliveryProcessor.register(
      MESSAGE_DELIVERY,
      createMessageDeliveryHandler({
        jobQueue,
        getSession: (sessionId: string) =>
          taskAgentManager?.getSubSession(sessionId) ??
          sessionManager?.getSession(sessionId) ??
          null,
        getMessageContent: (sessionId: string, messageUuid: string) =>
          reactiveDb?.db.getSDKMessageRepo().getDeliveryContent(sessionId, messageUuid) ?? null,
        isSessionArchived: (sessionId: string) =>
          reactiveDb?.db.getSession(sessionId)?.status === 'archived',
        markDeliveryFailed: (sessionId: string, messageUuid: string) =>
          reactiveDb?.db.getSDKMessageRepo().markDeliveryFailedByUuid(sessionId, messageUuid) ??
          null,
        publishStatusChanged: (sessionId: string, messageIds: string[]) =>
          internalEventBus.publish('messages.statusChanged', {
            sessionId,
            messageIds,
            status: 'failed',
          }),
      }),
      {
        exemptJobs: { path: '$.role', equals: 'steer' },
        onDead: (job) => {
          deliveryMetrics.recordDeadLetter();
          const payload = asMessageDeliveryPayload(job.payload);
          if (!payload) return;
          const sdkRepo = reactiveDb?.db.getSDKMessageRepo();
          if (!sdkRepo) return;
          const session =
            taskAgentManager?.getSubSession(payload.sessionId) ??
            sessionManager?.getSession(payload.sessionId);
          void settleMessageDeliveryDeadLetter(payload, {
            markDeliveryFailedByUuid: (sid, uuid) =>
              sdkRepo.markDeliveryFailedByUuidInclusive(sid, uuid),
            publishStatusChanged: (sid, messageIds) =>
              internalEventBus.publish('messages.statusChanged', {
                sessionId: sid,
                messageIds,
                status: 'failed',
              }),
            publishSessionError: (sid, error) =>
              internalEventBus.publish('session.error', { sessionId: sid, error }),
            settleSkippedDelivery: (uuid) =>
              session?.settleSkippedDelivery(uuid) ?? Promise.resolve(),
            resetStuckProcessingState: (sid, uuid) =>
              session?.clearStuckProcessingState(uuid) ?? Promise.resolve(),
          }).catch(() => {});
        },
      }
    );

    const taskScheduleRepo = new TaskScheduleRepository(db.getDatabase());
    const taskScheduleSpaceRepo = new SpaceRepository(db.getDatabase());
    const taskScheduleTaskRepo = new SpaceTaskRepository(db.getDatabase(), reactiveDb);
    jobProcessor.register(TASK_SCHEDULE_FIRE, async (job) => {
      return handleTaskScheduleFire(job, {
        db: db.getDatabase(),
        scheduleRepo: taskScheduleRepo,
        jobQueue,
        spaceRepo: taskScheduleSpaceRepo,
        taskRepo: taskScheduleTaskRepo,
        eventHub: internalEventBus,
        goalService: spaceGoalService,
        goalRepo: new SpaceGoalRepository(db.getDatabase(), reactiveDb),
        goalAutomationService,
      });
    });

    const lhAgentReminderRepo = new SpaceLongHorizonAgentRepository(db.getDatabase());
    const lhAgentReminderSpaceRepo = new SpaceRepository(db.getDatabase());
    jobProcessor.register(LONG_HORIZON_AGENT_REMINDER_FIRE, async (job) => {
      return handleLongHorizonAgentReminderFire(job, {
        reminderRepo: lhAgentReminderRepo,
        spaceRepo: lhAgentReminderSpaceRepo,
        jobQueue,
        deliver: (args) => spaceRuntimeService.deliverLongHorizonAgentReminder(args),
        getOccurrenceDeliveryState: (spaceId, agentId, idempotencyKey) => {
          const sessionId = longTermAgentSessionId(spaceId, agentId);
          const messageDb = reactiveDb?.db;
          if (!messageDb) return 'absent';
          if (messageDb.getMessageByStatusAndUuid(sessionId, 'consumed', idempotencyKey) != null) {
            return 'consumed';
          }
          if (messageDb.getMessageByStatusAndUuid(sessionId, 'enqueued', idempotencyKey) != null) {
            return 'enqueued';
          }
          return 'absent';
        },
      });
    });

    if (process.env.NODE_ENV !== 'test') {
      const now = Date.now();

      const isJobLost = (status: string | undefined): boolean =>
        status === undefined ||
        status === 'completed' ||
        status === 'failed' ||
        status === 'dead' ||
        status === 'cancelled';

      const reseedSchedule = (scheduleId: string, scheduleNextRunAt: number | null): void => {
        const runAt =
          scheduleNextRunAt !== null && scheduleNextRunAt > now ? scheduleNextRunAt : now;
        const newJob = jobQueue.enqueue({
          queue: TASK_SCHEDULE_FIRE,
          payload: { scheduleId },
          runAt,
        });
        taskScheduleRepo.updatePendingJobId(scheduleId, newJob.id);
        logInfo('[Daemon] Re-seeded lost job for schedule', {
          scheduleId,
          newJobId: newJob.id,
        });
      };

      try {
        const activeSchedules = taskScheduleRepo.listActiveWithPendingJob();
        for (const schedule of activeSchedules) {
          if (!schedule.pendingJobId) continue;
          const job = jobQueue.getJob(schedule.pendingJobId);
          if (isJobLost(job?.status)) {
            reseedSchedule(schedule.id, schedule.nextRunAt);
          }
        }

        const RECOVERY_PAGE_SIZE = 200;
        let totalReseeded = 0;
        while (true) {
          const dueSchedules = taskScheduleRepo.listActiveDue(now, RECOVERY_PAGE_SIZE);
          let pageReseeded = 0;
          for (const schedule of dueSchedules) {
            if (schedule.pendingJobId) continue;
            reseedSchedule(schedule.id, schedule.nextRunAt);
            pageReseeded++;
          }
          totalReseeded += pageReseeded;
          if (dueSchedules.length < RECOVERY_PAGE_SIZE || pageReseeded === 0) break;
        }
        if (totalReseeded > 0) {
          logInfo('[Daemon] Re-seeded due schedules with no pending job', {
            count: totalReseeded,
          });
        }
      } catch (err) {
        logError('[Daemon] Task schedule startup re-seed failed (non-fatal):', err);
      }
    }

    oauthRefreshScheduler.start();
    logInfo('[Daemon] OAuth refresh scheduler started');

    const pendingCleanup = jobQueue.listJobs({
      queue: JOB_QUEUE_CLEANUP,
      status: 'pending',
      limit: 1,
    });
    if (pendingCleanup.length === 0) {
      jobQueue.enqueue({ queue: JOB_QUEUE_CLEANUP, payload: {}, runAt: Date.now() });
      logInfo('[Daemon] Enqueued initial job_queue.cleanup job');
    }
    enqueueMemoryConsolidationIfMissing(jobQueue, Date.now());
    logInfo('[Daemon] Ensured initial memory_consolidation job');
    enqueueLongHorizonAgentReminderScanIfMissing(jobQueue, Date.now());
    logInfo('[Daemon] Ensured initial longHorizonAgentReminder.fire scan job');
    if (process.env.NODE_ENV !== 'test') {
      try {
        const backfilled = backfillLongHorizonAgentReminderNextRunAt(lhAgentReminderRepo);
        if (backfilled > 0) {
          logInfo('[Daemon] Backfilled next_run_at for LH agent reminders', {
            count: backfilled,
          });
        }
      } catch (err) {
        logError('[Daemon] LH agent reminder backfill failed (non-fatal):', err);
      }
    }

    jobProcessor.start();
    logInfo('[Daemon] Job queue processor started');
    messageDeliveryProcessor.start();
    logInfo('[Daemon] Message-delivery job processor started');
    if (process.env.NODE_ENV !== 'test') {
      processWatchdog.start();
      logInfo('[Daemon] Process watchdog started');
    }

    let reaperTimer: ReturnType<typeof setInterval> | null = null;
    if (process.env.NODE_ENV !== 'test') {
      const worktreeStartupCleanup = async () => {
        try {
          const spaces = await spaceManager.listSpaces(false);
          for (const space of spaces) {
            await spaceWorktreeManager.cleanupOrphaned(space.id);
          }
          logInfo('[Daemon] Worktree orphan cleanup complete');
        } catch (err) {
          logError('[Daemon] Worktree orphan cleanup failed:', err);
        }

        try {
          await spaceWorktreeManager.reapExpiredWorktrees();
          logInfo('[Daemon] Worktree TTL reaper complete');
        } catch (err) {
          logError('[Daemon] Worktree TTL reaper failed:', err);
        }
      };
      void worktreeStartupCleanup();

      const WORKTREE_REAPER_INTERVAL_MS = 60 * 60 * 1000;
      reaperTimer = setInterval(() => {
        spaceWorktreeManager.reapExpiredWorktrees().catch((err) => {
          logError('[Daemon] Periodic worktree TTL reaper failed:', err);
        });
      }, WORKTREE_REAPER_INTERVAL_MS);
      reaperTimer.unref();
    }

    let isCleanedUp = false;
    const cleanup = async () => {
      if (isCleanedUp) {
        return;
      }
      isCleanedUp = true;
      startupLogCaptureCleanup = null;

      abortAgentMemoryEmbeddingModelPrefetch();

      if (reaperTimer !== null) {
        clearInterval(reaperTimer);
        reaperTimer = null;
      }

      try {
        clientEventBridge.stop();

        try {
          server.stop();
        } catch {}

        const pendingCallsCount = messageHub.getPendingCallCount();
        if (pendingCallsCount > 0) {
          let checkInterval: ReturnType<typeof setInterval> | null = null;
          let resolved = false;
          await Promise.race([
            new Promise((resolve) => {
              checkInterval = setInterval(() => {
                const remaining = messageHub.getPendingCallCount();
                if (remaining === 0) {
                  clearInterval(checkInterval!);
                  checkInterval = null;
                  resolved = true;
                  logInfo('[Daemon] All pending calls completed');
                  resolve(null);
                }
              }, 100);
            }),
            new Promise((resolve) =>
              setTimeout(() => {
                if (!resolved) {
                  const remaining = messageHub.getPendingCallCount();
                  logInfo(`[Daemon] Timeout: ${remaining} calls still pending after 3s`);
                }
                resolve(null);
              }, 3000)
            ),
          ]);
          if (checkInterval) {
            clearInterval(checkInterval);
          }
        }

        processWatchdog.stop();
        logInfo('[Daemon] Process watchdog stopped');
        oauthRefreshScheduler.stop();
        logInfo('[Daemon] OAuth refresh scheduler stopped');
        messageDeliveryProcessor.stopPolling();
        logInfo('[Daemon] Message-delivery job polling stopped');
        jobProcessor.stopPolling();
        logInfo('[Daemon] Job queue polling stopped');
        try {
          const requeued = jobQueue.requeueAllProcessing(MESSAGE_DELIVERY, Date.now());
          if (requeued.length > 0) {
            logInfo(
              `[Daemon] Requeued ${requeued.length} in-flight message_delivery job(s) for restart`
            );
            applyStaleReclaimJitter(jobQueue, requeued, Math.random, (jobId, error) => {
              logError(`[Daemon] stale-reclaim jitter reschedule failed for job ${jobId}`, error);
            });
          }
        } catch {}
        await jobProcessor.stop();
        logInfo('[Daemon] Job queue processor stopped');
        await taskAgentManager.cleanupAll();
        await sessionManager.cleanup();
        logInfo('[Daemon] Active agent sessions stopped');

        await messageDeliveryProcessor.stop();
        logInfo('[Daemon] Message-delivery job processor stopped');

        messageHub.cleanup();

        await rpcHandlerCleanup();

        liveQueries.dispose();

        if (gitHubService) {
          gitHubService.stop();
          logInfo('[Daemon] GitHub service stopped');
        }
        for (const extension of extensionManager.getAll()) {
          await extensionManager.stopExtension(extension.sourceId);
        }
        logInfo('[Daemon] External event extensions stopped');

        const providerRegistry = getProviderRegistry();
        await Promise.allSettled(
          providerRegistry.getAll().flatMap((p) => (p.shutdown ? [p.shutdown()] : []))
        );

        fileIndex.dispose();

        logEvidenceService.flush();
        unsubscribeStructuredLogs();
        unsubscribeProviderFailureChanges?.();
        await invalidateInFlightModelLoads();

        db.close();

        logInfo('[Daemon] Graceful shutdown complete');
      } catch (error) {
        logError('Error during cleanup:', error);
        logEvidenceService.flush();
        unsubscribeStructuredLogs();
        unsubscribeProviderFailureChanges?.();
        await invalidateInFlightModelLoads();
        throw error;
      } finally {
        await closeFileLogCapture();
      }
    };

    startupTimer.finish();

    return {
      server,
      db,
      messageHub,
      sessionManager,
      authManager,
      settingsManager,
      stateManager,
      transport,
      internalEventBus,
      commandBus,
      queryBus,
      gitHubService,
      externalEventStore,
      externalEventService,
      extensionManager,
      reactiveDb,
      liveQueries,
      spaceAgentManager,
      spaceManager,
      spaceRuntimeService,
      taskAgentManager,
      spaceWorktreeManager,
      workflowHookStateRepository,
      workflowHookRuntimeService,
      jobQueue,
      jobProcessor,
      appMcpManager,
      skillsManager,
      fileIndex,
      flushStructuredLogs: () => structuredLogSink?.flush() ?? Promise.resolve(),
      cleanup,
    };
  } catch (error) {
    startupTimer.finish();
    startupLogCaptureCleanup?.();
    unsubscribeProviderFailureChanges?.();
    await invalidateInFlightModelLoads();
    abortAgentMemoryEmbeddingModelPrefetch();
    restoreConsoleCapture();
    strandedStartupFileLogCapture = closeFileLogCapture;
    throw error;
  }
}
