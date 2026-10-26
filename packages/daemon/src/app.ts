import {
  GitHubWatchInventory,
  reportGitHubWatchHealth,
} from './lib/external-events/github/github-watch-inventory.ts';
import { CodingPrLedgerRepository } from './lib/neo/packs/coding/pr-ledger.ts';
import { createSessionScheduleFire } from './lib/scheduler/session-schedule-fire.ts';
import { createScheduleDelivery } from './lib/scheduler/session-schedule-delivery.ts';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { startSessionDoor } from './lib/messaging/session-door.ts';
import { stampActiveAttempt } from './lib/tasks/direct-attempt-flag.ts';
import { homedir } from 'os';
import { parsePositiveInt, type Config } from './config.ts';
import type { WebSocketData } from './types/websocket.ts';
import { createHttpWsServer, type ServerHandle } from './lib/runtime-server/index.ts';
import { releaseFailedStartup } from './lib/startup-cleanup.ts';
import { createPairRoute } from './lib/pairing/pair-route.ts';
import { createRequestGuard } from './lib/pairing/origin-host.ts';
import { createUpgradeAuthenticator, type UpgradeIdentity } from './lib/pairing/upgrade-auth.ts';
import { daemonPairingLimiter } from './lib/pairing/pairing-limiter.ts';
import { DevicePairingRepository } from './storage/repositories/device-pairing-repository.ts';
import { Database } from './storage/database.ts';
import { migrateSessionToolSelections } from './storage/repositories/session-tool-selection-migration.ts';
import { SessionManager } from './lib/session-manager.ts';
import {
  hasRuntimeWorkerOperations,
  isWorkflowSubSessionIdentity,
} from './lib/session/sub-session-identity.ts';
import { AuthManager } from './lib/auth-manager.ts';
import { DaemonConfigService } from './lib/daemon-config-service.ts';
import { SettingsManager } from './lib/settings-manager.ts';
import { StateProjectionService } from './lib/state-projection-service.ts';
import { BUILD_METADATA } from './lib/build-metadata.ts';
import { writeRuntimeDescriptor } from './lib/runtime-descriptor.ts';
import { createClientEventBridge } from './lib/client-event-bridge.ts';
import {
  MAX_GITHUB_POLLING_INTERVAL_SECONDS,
  MessageHub,
  MessageHubRouter,
} from '@hyperneo/shared';
import type { ProviderRecord } from '@hyperneo/shared';
import type { Provider, ProviderCredentials } from '@hyperneo/shared/provider';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  createDaemonInternalEventBus,
  type DaemonInternalEventMap,
  type InternalEventBus,
} from './lib/internal-event-bus.ts';
import {
  createInternalCommandBus,
  type DaemonCommandMap,
  type InternalCommandBus,
} from './lib/internal-command-bus.ts';
import { createInternalQueryBus, type DaemonQueryMap } from './lib/internal-query-bus.ts';
import { setupRPCHandlers } from './lib/rpc-handlers/index.ts';
import { applyProviderModelAllowlistsToEnv } from './lib/rpc-handlers/settings-handlers.ts';
import { WebSocketServerTransport } from './lib/websocket-server-transport.ts';
import { createWebSocketHandlers } from './routes/setup-websocket.ts';
import { createGitHubService, type GitHubService } from './lib/github/github-service.ts';
import {
  ExternalEventService,
  ExternalEventStore,
  routeExternalEventPublisher,
  SessionExternalEventStore,
  ingestSessionEvent,
} from './lib/external-events/index.ts';
import { mailSessionEvent } from './lib/external-events/session-event-delivery.ts';
import { readLatestSessionPrState } from './lib/external-events/session-external-event-store.ts';
import { replaySessionTerminals } from './lib/external-events/session-terminal-replay.ts';
import {
  routeSessionExternalEvent,
  type SessionEventRouteDeps,
} from './lib/external-events/session-event-routing.ts';
import { deliverMessage } from './lib/agent/message-delivery.ts';
import {
  RESTART_RECOVERY_NOTE,
  RESTART_RECOVERY_PREFIX,
  type RestartRecoveryDeps,
  recoverRestartCutTurns,
} from './lib/agent/restart-turn-recovery.ts';
import { renderAddress } from './lib/mailbox/address.ts';
import { handoffPromptToMailbox } from './lib/mailbox/handoff.ts';
import { SESSION_EVENT_SCOPE } from './lib/external-events/session-external-event-store.ts';
import { ExternalEventExtensionConfigStore } from './lib/external-events/extension-config-store.ts';
import {
  ExternalEventExtensionManager,
  isHttpExtension,
  isRpcExtension,
} from './lib/external-events/extension-manager.ts';
import {
  GitHubEventExtension,
  GITHUB_CREDENTIAL_SERVICE,
  GITHUB_CREDENTIAL_ACCOUNT,
} from './lib/external-events/github/index.ts';
import { createNeoReadCheckoutSync } from './lib/neo/read-checkout-sync.ts';
import { CodingPollFactsRepository } from './lib/neo/packs/coding/poll-facts.ts';
import { pullRequestNumbersOfTopics } from './lib/github/parse-pr-url.ts';
import { readDaemonGithubToken } from './lib/github/runtime-token.ts';
import { composeLongHorizonSubscriptionPattern } from './lib/external-events/long-horizon-subscription-pattern.ts';
import { SessionEventSubscriptionRepository } from './storage/repositories/session-event-subscription-repository.ts';
import { SpaceAgentSubscriptionRepository } from './storage/repositories/space-agent-subscription-repository.ts';
import { SpaceSessionEventSubscriptionRepository } from './storage/repositories/space-session-event-subscription-repository.ts';
import { SpaceWorkflowEventSubscriptionRepository } from './storage/repositories/space-workflow-event-subscription-repository.ts';
import {
  initializeProviders,
  waitForOptionalProviderRegistration,
  disableBuiltInProvidersWithoutEnabledRecord,
} from './lib/providers/factory.js';
import { releaseSessionKeyBridges } from './lib/providers/provider-key-bridge.js';
import { getProviderRegistry } from './lib/providers/registry.js';
import { OAuthRefreshScheduler } from './lib/credentials/oauth-refresh-scheduler.js';
import { ProviderCredentialManager } from './lib/credentials/provider-credential-manager.js';
import { KeychainUnavailableError } from './lib/credentials/credential-store.js';
import { sameCredentialIdentity } from './lib/credentials/credential-identity.js';
import { stripPersistedDiscovery } from './lib/providers/discovery-refresh-pipeline.js';
import { syncAllProviders } from './lib/providers/provider-sync.js';
import {
  clearProviderFailureRecords,
  subscribeProviderFailureChanges,
} from './lib/providers/provider-failure-store.js';
import {
  backfillDeepSeekProvider,
  migrateProvidersIfNeeded,
  refreshGlmDisplayName,
  usesHumanLogin,
} from './lib/credential-discovery.ts';
import { createReactiveDatabase } from './storage/reactive-database.ts';
import { LiveQueryEngine } from './storage/live-query.ts';
import { installProcessFatalLogging } from './lib/process-fatal-logger.ts';
import { dirname } from 'node:path';
import {
  armStallDetectionWhenStartupSettles,
  startEventLoopWatchdog,
  type EventLoopWatchdogHandle,
} from './lib/event-loop-watchdog.ts';
import { startDaemonLagDiagnostics } from './lib/event-loop-lag.ts';
import {
  describeEventLoopStallMarker,
  eventLoopStallMarkerPath,
  eventLoopStallStackPath,
  readAndClearEventLoopStallMarker,
} from './lib/event-loop-stall-marker.ts';
import { WorkflowHookRuntimeService } from './lib/workflows/hook-runtime-service.ts';
import { WorkflowHookStateRepository } from './storage/repositories/workflow-hook-state-repository.ts';
import { SpaceLongHorizonAgentRepository } from './storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceAgentReminderRepository } from './storage/repositories/space-agent-reminder-repository.ts';
import { SpaceAgentRepository } from './storage/repositories/space-agent-repository.ts';
import { SpaceManager } from './lib/space/managers/space-manager.ts';
import type { SpaceRuntimeService } from './lib/space/runtime/space-runtime-service.ts';
import type { TaskAgentManager } from './lib/space/runtime/task-agent-manager.ts';
import type { SpaceWorktreeManager } from './lib/workspaces/worktree-manager.ts';
import {
  cleanupJobsInBatches,
  JobQueueRepository,
} from './storage/repositories/job-queue-repository.ts';
import { purgeWorkFeedSessions } from './storage/work-feed.ts';
import { JobQueueProcessor, applyStaleReclaimJitter } from './storage/job-queue-processor.ts';
import { createCleanupHandler } from './lib/job-handlers/cleanup.handler.ts';
import {
  createMemoryConsolidationHandler,
  enqueueMemoryConsolidationIfMissing,
} from './lib/job-handlers/memory-consolidation.handler.ts';
import { enqueueMailboxExpireIfMissing } from './lib/job-handlers/mailbox-expire.handler.ts';
import { createSkillValidateHandler } from './lib/job-handlers/skill-validate.handler.ts';
import {
  JOB_QUEUE_CLEANUP,
  LONG_HORIZON_AGENT_REMINDER_FIRE,
  MEMORY_CONSOLIDATION,
  MESSAGE_DELIVERY,
  SKILL_VALIDATE,
  TASK_SCHEDULE_FIRE,
  SESSION_SCHEDULE_FIRE,
} from './lib/job-queue-constants.ts';
import { createMessageDeliveryHandler } from './lib/job-handlers/message-delivery.handler.ts';
import { registerMailboxJobs } from './lib/mailbox/registration.ts';
import { boundDeliveryContent } from './lib/handoffs/bound-delivery.ts';
import { resolveMailboxSession } from './lib/mailbox/session-lookup.ts';
import { MAILBOX_LANE } from './lib/mailbox/enqueue.ts';
import { settleMessageDeliveryDeadLetter } from './lib/job-handlers/message-delivery-dead-letter.ts';
import { asMessageDeliveryPayload } from './lib/agent/message-delivery.ts';
import { deliveryMetrics } from './lib/agent/message-delivery-metrics.ts';
import { handleTaskScheduleFire } from './lib/job-handlers/task-schedule-fire.handler.ts';
import {
  backfillLongHorizonAgentReminderNextRunAt,
  enqueueLongHorizonAgentReminderScanIfMissing,
  handleLongHorizonAgentReminderFire,
} from './lib/job-handlers/long-horizon-agent-reminder-fire.handler.ts';
import { readReminderOccurrenceState } from './lib/agents/reminder-delivery-registry.ts';
import { resolveAgentSessionId } from './lib/space/long-term-agent-session.ts';
import { TaskScheduleRepository } from './storage/repositories/task-schedule-repository.ts';
import { SpaceRepository } from './storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from './storage/repositories/space-task-repository.ts';
import { SpaceGoalRepository } from './storage/repositories/space-goal-repository.ts';
import {
  AppMcpLifecycleManager,
  McpImportService,
  seedDefaultMcpEntries,
} from './lib/mcp/index.ts';
import { FileIndex } from './lib/file-index.ts';
import { Logger, installConsoleLogCapture, subscribeToStructuredLogs } from './lib/logger.ts';
import { createStartupPhaseTimer } from './lib/startup-phase-timer.ts';
import { StructuredLogFileSink } from './lib/structured-log-file-sink.ts';
import { EvolutionLogEvidenceService } from './lib/evolution/log-evidence-service.ts';
import { SkillsManager } from './lib/skills-manager.ts';
import {
  cleanupSuspiciousProcesses,
  ProcessWatchdog,
  type ProcessSnapshot,
} from './lib/process-watchdog.ts';
import { sweepOrphanedAgentChildren } from './lib/agent/orphan-child-sweep.ts';
import { AgentChildProcessRepository } from './storage/repositories/agent-child-process-repository.ts';
import { remoteDaemons } from './lib/remote-daemons/registry.ts';
import { RemoteDaemonSecretRepository } from './storage/repositories/remote-daemon-secret-repository.ts';

const mailboxLog = new Logger('mailbox');

interface ReconcilePersistedDiscoveryDeps {
  credentialManager: ProviderCredentialManager;
  db: Pick<Database, 'providers'>;
}

interface ReconcilePersistedDiscoveryCtx {
  deps: ReconcilePersistedDiscoveryDeps;
  providerId: string;
  providerCredentials: ProviderCredentials;
  storedCredentials?: ProviderCredentials | null;
  storedCredentialsInaccessible?: boolean;
  providerRecord?: ProviderRecord | null;
  envCredentials?: boolean;
  strip?: boolean;
}

async function loadPersistedDiscoveryInputs(
  ctx: ReconcilePersistedDiscoveryCtx
): Promise<ReconcilePersistedDiscoveryCtx> {
  let storedCredentials: ProviderCredentials | null = null;
  try {
    storedCredentials = await ctx.deps.credentialManager.getCredentials(ctx.providerId);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const storeStatus = ctx.deps.credentialManager.getCredentialStoreStatus();
  return {
    ...ctx,
    storedCredentials,
    storedCredentialsInaccessible:
      storedCredentials === null &&
      (storeStatus.backend === 'keychain-unavailable' ||
        storeStatus.backend === 'keychain-fallback'),
    providerRecord: ctx.deps.db.providers.getProviderByProviderId(ctx.providerId),
    envCredentials: ctx.deps.credentialManager.hasEnvironmentCredentials(ctx.providerId),
  };
}

function decidePersistedDiscoveryStrip(
  ctx: ReconcilePersistedDiscoveryCtx
): ReconcilePersistedDiscoveryCtx {
  const hasPersistedDiscovery = !!ctx.providerRecord?.configJson?.includes('discoveredModels');
  const strip =
    !ctx.storedCredentialsInaccessible &&
    ((ctx.storedCredentials === null && hasPersistedDiscovery && !ctx.envCredentials) ||
      (ctx.storedCredentials != null &&
        !sameCredentialIdentity(ctx.storedCredentials, ctx.providerCredentials)));
  return { ...ctx, strip };
}

function stripPersistedDiscoveryFromProviderRow(
  ctx: ReconcilePersistedDiscoveryCtx
): ReconcilePersistedDiscoveryCtx {
  const record = ctx.deps.db.providers.getProviderByProviderId(ctx.providerId);
  if (!record) return ctx;
  const strippedConfigJson = stripPersistedDiscovery(record.configJson);
  if (strippedConfigJson === record.configJson) return ctx;
  ctx.deps.db.providers.updateProvider(record.id, { configJson: strippedConfigJson });
  return ctx;
}

const runReconcilePersistedDiscovery = (
  superpipe({
    keepsPersistedDiscovery: (ctx: ReconcilePersistedDiscoveryCtx) => ctx.strip !== true,
  })('reconcile-persisted-discovery') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadPersistedDiscoveryInputs, 'ctx', 'ctx')
  .pipe(decidePersistedDiscoveryStrip, 'ctx', 'ctx')
  .pipe('!keepsPersistedDiscovery', 'ctx')
  .pipe(stripPersistedDiscoveryFromProviderRow, 'ctx', 'ctx')
  .endAsync('ctx') as unknown as (
  ctx: ReconcilePersistedDiscoveryCtx
) => Promise<ReconcilePersistedDiscoveryCtx>;

export async function applyStoredProviderCredentials(
  providers: Provider[],
  credentialManager: ProviderCredentialManager,
  db: Pick<Database, 'providers'>,
  logError: (...args: unknown[]) => void
): Promise<void> {
  for (const provider of providers) {
    try {
      const providerCredentials = await provider.getCredentials?.();
      if (providerCredentials?.type === 'oauth' || providerCredentials?.type === 'api_key') {
        await runReconcilePersistedDiscovery({
          deps: { credentialManager, db },
          providerId: provider.id,
          providerCredentials,
        });
      }
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
  handlePair: (req: Request) => Promise<Response>;
  authenticateUpgrade: (
    req: Request,
    remoteAddress: string | null
  ) => Promise<UpgradeIdentity | null>;
  guardRequest: (req: Request) => Response | null;
  db: Database;
  messageHub: MessageHub;
  sessionManager: SessionManager;
  authManager: AuthManager;
  settingsManager: SettingsManager;
  daemonConfigService: DaemonConfigService;
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
  armShutdownFuse: () => void;
  cleanup: () => Promise<void>;
}

async function invalidateInFlightModelLoads(): Promise<void> {
  try {
    const { clearModelsCache } = await import('./lib/model-service.ts');
    clearModelsCache();
    clearProviderFailureRecords();
  } catch {}
}

export async function createDaemonApp(options: CreateDaemonAppOptions): Promise<DaemonAppContext> {
  const { config, verbose = true, standalone = false } = options;
  let startupLogCaptureCleanup: (() => void) | null = null;
  let unsubscribeProviderFailureChanges: (() => void) | null = null;
  let eventLoopWatchdog: EventLoopWatchdogHandle | null = null;
  let failedStartupCleanup: (() => Promise<void>) | null = null;
  let startupAborted = false;
  let eventLoopLagLogStopped = false;
  let stopEventLoopLagLog = (): void => {
    eventLoopLagLogStopped = true;
  };
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
      const stallMarkerPath = eventLoopStallMarkerPath(dirname(config.dbPath));
      eventLoopWatchdog = await startEventLoopWatchdog({
        deferStallDetection: true,
        markerPath: stallMarkerPath,
        stackPath: eventLoopStallStackPath(dirname(config.dbPath)),
        onNotice: (notice) => {
          if (notice.type === 'stall-detected') {
            console.error(
              `[Daemon] Event loop unresponsive for ${notice.stalledForMs}ms; the daemon is not ` +
                `serving requests. Marker written to ${stallMarkerPath}`
            );
          } else if (notice.type === 'stall-recovered') {
            console.error(`[Daemon] Event loop recovered after ${notice.stalledForMs}ms`);
          } else {
            console.error(`[Daemon] Graceful shutdown overdue by ${notice.overdueMs}ms`);
          }
        },
      });
      const priorStall = readAndClearEventLoopStallMarker(stallMarkerPath);
      if (priorStall) {
        console.error(`[Daemon] ${describeEventLoopStallMarker(priorStall)}`);
      }
    }

    const db = new Database(
      config.dbPath,
      config.sqlQueryObservability
        ? { queryObservability: config.sqlQueryObservability }
        : undefined
    );
    const reactiveDb = createReactiveDatabase(db);
    startupTimer.start('database + auth initialize');
    await db.initialize(reactiveDb);
    if (process.env.NODE_ENV !== 'test') db.warmEmbedder();
    const cutOffSessionIds = db.listProcessingSessionIds();
    const interruptedTurns = await db.markRestartInterruptedTurns();
    const liveQueries = new LiveQueryEngine(db.getDatabase(), reactiveDb);
    const earlySpaceRepo = new SpaceRepository(db.getDatabase());
    const earlyLogEvidenceService = new EvolutionLogEvidenceService({
      evolutionRepo: db.evolution,
      spaceRepo: earlySpaceRepo,
    });
    const unsubscribeEarlyStructuredLogs = subscribeToStructuredLogs((event) => {
      earlyLogEvidenceService.capture(event);
      if (event.level === 'fatal') {
        earlyLogEvidenceService.flush();
      }
    });
    startupLogCaptureCleanup = () => {
      earlyLogEvidenceService.flush();
      unsubscribeEarlyStructuredLogs();
    };

    const logInfo = verbose ? console.log : () => {};
    if (interruptedTurns > 0)
      logInfo(
        `[Daemon] Marked ${interruptedTurns} session turn(s) cut off by the restart as interrupted`
      );
    const logError = verbose ? console.error : () => {};

    if (process.env.NODE_ENV !== 'test') {
      try {
        await sweepOrphanedAgentChildren(
          new AgentChildProcessRepository(db.getDatabase()),
          logInfo,
          logError
        );
      } catch (err) {
        logError('[Daemon] Orphaned agent child sweep failed (non-fatal):', err);
      }
    }

    const internalEventBus = createDaemonInternalEventBus();
    const daemonConfigService = new DaemonConfigService(db.getDatabase(), internalEventBus);
    if (daemonConfigService.seedFromLegacyEnv()) {
      logInfo('[Daemon] Seeded daemon config from legacy environment variables');
    }

    const jobQueue = new JobQueueRepository(db.getDatabase());
    const workflowHookStateRepository = new WorkflowHookStateRepository(db.getDatabase());
    const workflowHookRuntimeService = new WorkflowHookRuntimeService();
    const maxConcurrent = parsePositiveInt(process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT, 5);
    const jobProcessor = new JobQueueProcessor(jobQueue, {
      db: db.gateway,
      pollIntervalMs: 1000,
      maxConcurrent,
      staleThresholdMs: 5 * 60 * 1000,
    });
    const mailboxExpireProcessor = new JobQueueProcessor(jobQueue, {
      db: db.gateway,
      pollIntervalMs: 1000,
      maxConcurrent: 1,
      staleThresholdMs: 5 * 60 * 1000,
    });
    const messageDeliveryMaxConcurrent = parsePositiveInt(
      process.env.HYPERNEO_MESSAGE_DELIVERY_MAX_CONCURRENT,
      64
    );
    const messageDeliveryProcessor = new JobQueueProcessor(jobQueue, {
      db: db.gateway,
      pollIntervalMs: 1000,
      maxConcurrent: messageDeliveryMaxConcurrent,
      staleThresholdMs: 5 * 60 * 1000,
      settlementGraceMs: 35_000,
    });
    jobProcessor.setChangeNotifier(() => {});
    mailboxExpireProcessor.setChangeNotifier(() => {});
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

    const spaceRepo = earlySpaceRepo;
    const spaceManager = new SpaceManager(db.getDatabase(), reactiveDb);

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
    remoteDaemons.restore(
      settingsManager.getGlobalSettings().attachedDaemons ?? [],
      (attachedDaemons) => settingsManager.updateGlobalSettings({ attachedDaemons }),
      new RemoteDaemonSecretRepository(db.getDatabase())
    );

    const credentialManager = ProviderCredentialManager.create(db.getDatabase());
    startupTimer.start('provider import');
    try {
      await migrateProvidersIfNeeded(db, credentialManager);
      await backfillDeepSeekProvider(db, credentialManager);
      refreshGlmDisplayName(db);
    } catch (err) {
      logError('[Daemon] Provider migration failed (non-fatal):', err);
    }

    disableBuiltInProvidersWithoutEnabledRecord(db.providers.listProviders());

    startupTimer.start('providers (register + credentials)');
    const providerRegistry = initializeProviders();
    internalEventBus.subscribe(
      'session.deleted',
      ({ sessionId }) => releaseSessionKeyBridges(sessionId),
      { subscriberName: 'ProviderKeyBridge.sessionDeleted' }
    );
    internalEventBus.subscribe(
      'session.updated',
      ({ sessionId, session }) => {
        if (session?.status === 'archived') releaseSessionKeyBridges(sessionId);
      },
      { subscriberName: 'ProviderKeyBridge.sessionArchived' }
    );
    await waitForOptionalProviderRegistration(providerRegistry);
    await applyStoredProviderCredentials(
      providerRegistry.getAll(),
      credentialManager,
      db,
      logError
    );

    startupTimer.start('provider sync (custom endpoints / registry)');
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
      void import('./lib/model-service.ts')
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

    unsubscribeProviderFailureChanges = subscribeProviderFailureChanges((change) => {
      credentialManager.markProviderHealth(
        change.providerId,
        change.record === null ? 'healthy' : 'unhealthy'
      );
      internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
    });
    const oauthRefreshScheduler = new OAuthRefreshScheduler(credentialManager, {
      registry: providerRegistry,
      recoverDormantProvider: async (providerId) => {
        const { recoverDormantProvider } = await import('./lib/model-service.ts');
        return await recoverDormantProvider(providerId);
      },
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
        const { results, orphanPruned } = await mcpImportService.refreshAll();
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

    const skillsManager = new SkillsManager(db.skills, db.appMcpServers, db, jobQueue);
    await skillsManager.initializeBuiltins();

    try {
      startupTimer.start('skill plugin wrappers');
      await skillsManager.ensureBuiltinPluginWrappers();
    } catch (err) {
      logError('[Daemon] Failed to ensure builtin skill plugin wrappers (non-fatal):', err);
    }

    startupTimer.start('tool selection migration');
    migrateSessionToolSelections(db.getDatabase(), {
      skills: db.skills.findAll(),
      registry: db.appMcpServers.list(),
      overrides: db.mcpEnablement.listAll(),
    });

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
      db.appMcpServers,
      () =>
        readDaemonGithubToken(() =>
          credentialManager
            .getCredentialStore()
            .get(GITHUB_CREDENTIAL_SERVICE, GITHUB_CREDENTIAL_ACCOUNT)
        )
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
      stateManager,
      (task) => stampActiveAttempt(db.getDatabase(), task as TaskCore)
    );
    clientEventBridge.start();

    credentialManager.registerStatusChangeCallback(() => {
      void stateManager.broadcastSystemChange();
      void applyStoredProviderCredentials(
        providerRegistry.getAll(),
        credentialManager,
        db,
        logError
      );
    });

    const collectGitHubPollPage = (
      ...args: Parameters<CodingPollFactsRepository['collectExternalEventPage']>
    ) =>
      new CodingPollFactsRepository(
        db.getDatabase(),
        getGitHubPollingIntervalSeconds() * 1000
      ).collectExternalEventPage(...args);
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
          collectPollPage: collectGitHubPollPage,
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
    const sessionExternalEventStore = new SessionExternalEventStore(db.getDatabase());
    const sessionExternalEventService = new ExternalEventService(
      sessionExternalEventStore,
      internalEventBus,
      (event) => db.gateway.run(ingestSessionEvent, event)
    );
    const sessionEventSubscriptions = new SessionEventSubscriptionRepository(db.getDatabase());
    const spaceSessionEventSubscriptions = new SpaceSessionEventSubscriptionRepository(
      db.getDatabase()
    );
    const spaceWorkflowEventSubscriptions = new SpaceWorkflowEventSubscriptionRepository(
      db.getDatabase()
    );
    const spaceAgentSubscriptions = new SpaceAgentSubscriptionRepository(
      db.getDatabase(),
      new SpaceAgentRepository(db.getDatabase())
    );
    const sessionEventRouteDeps: SessionEventRouteDeps = {
      readEvent: (eventId) => sessionExternalEventStore.getById(eventId),
      listSubscriptions: () => sessionEventSubscriptions.listAll(),
      isSessionBusy: (sessionId) =>
        (sessionManager?.getCachedSession(sessionId)?.getProcessingState().status ?? 'idle') !==
        'idle',
      deliver: async (delivery) => {
        const outcome = await mailSessionEvent(db.getJobQueueRepo(), delivery);
        if (outcome.kind === 'rejected') {
          const reason = `[Daemon] External event for session ${delivery.sessionId} was rejected: ${outcome.reason}`;
          logError(reason);
          throw new Error(reason);
        }
      },
      removeSubscription: (sessionId, topic) => sessionEventSubscriptions.delete(sessionId, topic),
    };
    internalEventBus.subscribe(
      'externalEvent.published',
      async (event) => {
        await routeSessionExternalEvent(sessionEventRouteDeps, event);
      },
      { subscriberName: 'session-external-events', namespaceId: SESSION_EVENT_SCOPE }
    );
    const restartRecoveryDeps: RestartRecoveryDeps = {
      readEvidence: async (sessionId) => {
        await db.waitForSdkMessageColumns(sessionId);
        return db.getSDKMessageRepo().readRestartRecoveryEvidence(sessionId);
      },
      hasActiveDelivery: (sessionId, uuid) =>
        db.getJobQueueRepo().activeDeliveryMessageUuids(sessionId).has(uuid),
      resend: async (sessionId, uuid, enqueueDelivery) => {
        const reopenedId = await db.writeSDKMessage('markDeliveryRetryableByUuid', sessionId, uuid);
        if (!reopenedId) return false;
        void internalEventBus
          .publish('messages.statusChanged', {
            sessionId,
            messageIds: [reopenedId],
            status: 'enqueued',
          })
          .catch(() => {});
        if (enqueueDelivery)
          await deliverMessage(db.getJobQueueRepo(), sessionId, uuid, { origin: 'recovery' });
        return true;
      },
      sendNote: async (sessionId, promptUuid) => {
        const messageUuid = `${RESTART_RECOVERY_PREFIX}${promptUuid}`;
        const outcome = await handoffPromptToMailbox({
          to: renderAddress({ kind: 'session', sessionId }),
          origin: 'recovery',
          messageUuid,
          deliveryMode: 'immediate',
          message: {
            type: 'user',
            message: { role: 'user', content: RESTART_RECOVERY_NOTE },
            parent_tool_use_id: null,
            inputKind: 'system',
            neoWakeEvent: true,
          },
          jobQueue: db.getJobQueueRepo(),
        });
        if (outcome.kind !== 'rejected') return true;
        logError(
          `[Daemon] Restart recovery note for session ${sessionId} was rejected: ${outcome.reason}`
        );
        return false;
      },
    };
    const extensionConfigStore = new ExternalEventExtensionConfigStore(db.getDatabase());
    const sourceConfigTables: Record<string, string[]> = {
      github: ['space_github_watched_repos'],
    };
    const extensionContext = {
      publisher: routeExternalEventPublisher(externalEventService, sessionExternalEventService),
      config: extensionConfigStore,
      onSourceConfigChanged(change: { source: string; spaceId?: string; kind: string }) {
        logInfo('[Daemon] Extension config changed', change);
        for (const table of sourceConfigTables[change.source] ?? []) {
          reactiveDb.notifyChange(table);
        }
      },
    };
    const extensionManager = new ExternalEventExtensionManager();
    const replayRecordedTerminals = (subject = '') =>
      replaySessionTerminals({
        listSubscriptions: () =>
          sessionEventSubscriptions
            .listAll()
            .filter((subscription) => subscription.topic.toLowerCase().startsWith(subject)),
        readLatestPrState: (subject) => db.gateway.run(readLatestSessionPrState, subject),
        publish: (event) => sessionExternalEventService.publish(event),
      });
    const watchInventory = new GitHubWatchInventory(db.getDatabase(), sessionEventSubscriptions);
    let wakePollingConcern = async (_key: string, _text: string): Promise<boolean> => false;
    const githubPollingEnabled = getGitHubPollingIntervalSeconds() > 0;
    await syncGitHubPollingCapability(extensionConfigStore, githubPollingEnabled);
    extensionManager.register(
      new GitHubEventExtension(db.getDatabase(), process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, {
        collectPollPage: collectGitHubPollPage,
        replaySessionTerminals: replayRecordedTerminals,
        recordSessionClosure: async (event) => {
          const result = await db.gateway.run(ingestSessionEvent, event);
          if (result.action === 'invalid') throw new Error(result.reason);
          await replayRecordedTerminals(
            event.topic.slice(0, event.topic.lastIndexOf('.') + 1).toLowerCase()
          );
        },
        syncReadCheckout: createNeoReadCheckoutSync(),
        getPollIntervalMs: () => getGitHubPollingIntervalSeconds() * 1000,
        credentialStore: credentialManager.getCredentialStore(),
        reactiveDb,
        autoReconcileWebhooks: true,
        sessionWatchRepos: () => watchInventory.list(),
        sessionRepoReferenced: (owner, repo) => watchInventory.references(owner, repo),
        reportPollingHealth: (repos, reached, now) =>
          reportGitHubWatchHealth(
            new CodingPrLedgerRepository(db.getDatabase()),
            repos,
            reached,
            wakePollingConcern,
            now
          ),
        subscribedPullRequests: (watched) =>
          pullRequestNumbersOfTopics(
            watched.spaceId === SESSION_EVENT_SCOPE
              ? sessionEventSubscriptions.listAll().map((subscription) => subscription.topic)
              : [
                  ...spaceSessionEventSubscriptions
                    .listBySpace(watched.spaceId)
                    .map((subscription) => subscription.topic),
                  ...spaceWorkflowEventSubscriptions
                    .listBySpace(watched.spaceId)
                    .map((subscription) => subscription.topic),
                  ...spaceAgentSubscriptions
                    .listActiveSubscriptionsBySpace(watched.spaceId)
                    .flatMap((subscription) => {
                      try {
                        return [
                          composeLongHorizonSubscriptionPattern(
                            subscription.source,
                            subscription.topic
                          ),
                        ];
                      } catch {
                        return [];
                      }
                    }),
                ],
            watched.owner,
            watched.repo
          ),
      })
    );

    const githubEventExtension = extensionManager.getExtension('github') as
      | GitHubEventExtension
      | undefined;
    let lastGitHubPollingIntervalSeconds = getGitHubPollingIntervalSeconds();
    internalEventBus.subscribe(
      'settings.updated',
      async (event) => {
        if (event.namespaceId !== 'global') return;
        const nextGitHubPollingIntervalSeconds = getGitHubPollingIntervalSeconds();
        if (nextGitHubPollingIntervalSeconds === lastGitHubPollingIntervalSeconds) return;
        void (async () => {
          await syncGitHubPollingCapability(
            extensionConfigStore,
            getGitHubPollingIntervalSeconds() > 0
          );
          await githubEventExtension?.refreshPollingInterval();
        })();
        await gitHubService?.refreshPolling({ reschedulePending: true });
        lastGitHubPollingIntervalSeconds = nextGitHubPollingIntervalSeconds;
      },
      { subscriberName: 'github-polling-settings' }
    );

    internalEventBus.subscribe(
      'providers.changed',
      () => {
        for (const agentSession of sessionManager?.getCachedSessions() ?? []) {
          agentSession.reevaluateContextBudgetAfterModelSwitch().catch((error) => {
            logError(
              `[Daemon] Context budget re-evaluation failed for session ` +
                `${agentSession.getSessionData().id}:`,
              error
            );
          });
        }
      },
      { subscriberName: 'providers-changed-context-budget' }
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
    const rpcHandlers = await setupRPCHandlers({
      purgeClaudeFeed: (sessionIds) => purgeWorkFeedSessions(db.gateway, 'claude', sessionIds),
      deviceOf: (clientId) => transport.deviceOf(clientId),
      watchSessionRepo: async (owner, repo) =>
        (await githubEventExtension?.watchSessionRepo(owner, repo)) ?? null,
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
      jobQueue,
      jobProcessor,
      reactiveDb,
      liveQueries,
      skillsManager,
      mcpImportService,
    });
    void recoverRestartCutTurns(cutOffSessionIds, restartRecoveryDeps)
      .then((results) => {
        const acted = results.filter((result) => result.resumed).length;
        if (acted > 0) logInfo(`[Daemon] Resumed ${acted} session turn(s) cut off by the restart`);
      })
      .catch((error) => logError('[Daemon] Restart turn recovery failed:', error));
    const cooldownResumeTimers = db.listRestartCooldownResumes().map(({ sessionId, resumeAt }) => {
      const timer = setTimeout(
        () =>
          void db
            .takeRestartCooldownResume(sessionId)
            .then((taken) =>
              taken ? recoverRestartCutTurns([sessionId], restartRecoveryDeps) : []
            )
            .catch((error) =>
              logError(`[Daemon] Cooldown resume for session ${sessionId} failed:`, error)
            ),
        Math.max(0, resumeAt - Date.now())
      );
      timer.unref?.();
      return timer;
    });
    const {
      cleanup: rpcHandlerCleanup,
      spaceRuntimeService,
      spaceWorktreeManager,
      spaceGoalService,
      goalAutomationService,
      spaceAgentInactivityWatchdog,
      cancelInactivityWatchdog,
    } = rpcHandlers;
    wakePollingConcern = rpcHandlers.wakePollingConcern;
    taskAgentManager = rpcHandlers.taskAgentManager;

    startupTimer.start('space runtime ready kickoff + HTTP/WS server bind');
    const spaceRuntimeReadyPromise = spaceRuntimeService.ready();

    const wsHandlers = createWebSocketHandlers(transport, sessionManager);
    const pairing = new DevicePairingRepository(db.getDatabase());
    const handlePair = createPairRoute({
      repo: pairing,
      limiter: daemonPairingLimiter,
      now: Date.now,
    });
    const authenticateUpgrade = createUpgradeAuthenticator({
      db: () => db.gateway,
      now: Date.now,
    });
    const guardRequest = createRequestGuard({
      db: () => db.gateway,
      allowedHosts: () => settingsManager.getGlobalSettings().allowedHosts ?? [],
      exempt: (req) =>
        extensionManager
          .getRegisteredRoutes()
          .some((route) => route.path === new URL(req.url).pathname),
      now: Date.now,
    });

    let server: ServerHandle | undefined;
    let removeRuntimeDescriptorFile = () => {};
    let sessionDoor: Awaited<ReturnType<typeof startSessionDoor>> | null = null;
    let reaperTimer: ReturnType<typeof setInterval> | null = null;
    let inactivityWatchdogTimer: ReturnType<typeof setInterval> | null = null;
    let inactivityScan: Promise<void> | null = null;
    let inactivityShutdownStarted = false;
    failedStartupCleanup = async () => {
      startupAborted = true;
      inactivityShutdownStarted = true;
      await releaseFailedStartup([
        () => server?.stop(true),
        () => removeRuntimeDescriptorFile(),
        () => sessionDoor?.close(),
        () => {
          for (const timer of cooldownResumeTimers) clearTimeout(timer);
          if (reaperTimer !== null) clearInterval(reaperTimer);
          if (inactivityWatchdogTimer !== null) clearInterval(inactivityWatchdogTimer);
        },
        () => cancelInactivityWatchdog(),
        () => db.stopSdkMessageColumnsBackfill(),
        () => clientEventBridge.stop(),
        () => processWatchdog.stop(),
        () => jobProcessor.stopPolling(),
        () => mailboxExpireProcessor.stopPolling(),
        () => messageDeliveryProcessor.stopPolling(),
        () => unsubscribeProviderFailureChanges?.(),
        () => oauthRefreshScheduler.stop(),
        () => jobProcessor.stop(),
        () => mailboxExpireProcessor.stop(),
        () => taskAgentManager?.cleanupAll(),
        () => sessionManager?.cleanup(),
        () => messageDeliveryProcessor.stop(),
        () => messageHub.cleanup(),
        () => rpcHandlerCleanup(),
        () => spaceRuntimeService.stop(),
        () => inactivityScan,
        () => liveQueries.dispose(),
        () => gitHubService?.stop(),
        ...extensionManager
          .getAll()
          .map((extension) => () => extensionManager.stopExtension(extension.sourceId)),
        () =>
          Promise.allSettled(providerRegistry.getAll().map((provider) => provider.shutdown?.())),
        () => fileIndex.dispose(),
        () => {
          const release = startupLogCaptureCleanup;
          startupLogCaptureCleanup = null;
          release?.();
        },
      ]);
      await releaseFailedStartup([() => db.close()]);
    };
    server = await createHttpWsServer({
      hostname: config.host,
      port: config.port,

      async fetch(req, upgrade, client) {
        const url = new URL(req.url);
        const refused = guardRequest(req);
        if (refused) return refused;

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
            device: await authenticateUpgrade(req, client?.remoteAddress ?? null),
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
              version: BUILD_METADATA.version,
              status: 'running',
              dataMigration: db.getDataMigrationStatus(),
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

        if (url.pathname === '/pair' && req.method === 'POST') return handlePair(req);

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
    void db.startSdkMessageColumnsBackfill(() => {
      void stateManager.broadcastSystemChange();
    });
    removeRuntimeDescriptorFile =
      process.env.NODE_ENV === 'test' ? () => {} : writeRuntimeDescriptor(config.host, server.port);
    const openMessageSearchMergeGate = (): void => {
      if (startupAborted) return;
      db.startMessageSearchMerges();
      void db.startSdkMessageColumnsBackfill().then((complete) => {
        if (complete) db.startSdkMessageBodyCopy();
      });
    };
    void spaceRuntimeReadyPromise.then(openMessageSearchMergeGate, openMessageSearchMergeGate);
    void spaceRuntimeReadyPromise.then(() => {
      logInfo('[Daemon] Space runtime startup provisioning complete');
    });
    if (gitHubService && shouldEnableGitHub) {
      await gitHubService.start();
      logInfo('[Daemon] GitHub service started');
    }

    jobProcessor.register(
      SKILL_VALIDATE,
      createSkillValidateHandler(skillsManager, db.appMcpServers)
    );
    jobProcessor.register(
      JOB_QUEUE_CLEANUP,
      createCleanupHandler(jobQueue, (params) => cleanupJobsInBatches(db.gateway, params))
    );
    jobProcessor.register(
      MEMORY_CONSOLIDATION,
      createMemoryConsolidationHandler(db.agentMemory, jobQueue)
    );
    registerMailboxJobs({
      jobQueue,
      jobProcessor,
      mailboxExpireProcessor,
      db,
      internalEventBus,
      sessionManager,
      isSessionHeldByTaskLimit: (sessionId) =>
        taskAgentManager?.isSessionHeldByTaskRateLimit(sessionId) ?? false,
      getSession: (sessionId) => resolveMailboxSession(sessionId, sessionManager, taskAgentManager),
      isSessionArchived: (sessionId: string) =>
        reactiveDb?.db.getSession(sessionId)?.status === 'archived',
      logError: (message) => mailboxLog.error(message),
    });

    messageDeliveryProcessor.register(
      MESSAGE_DELIVERY,
      createMessageDeliveryHandler({
        jobQueue,
        getSession: async (sessionId: string) => {
          const indexed = taskAgentManager?.getSubSession(sessionId);
          if (indexed && sessionManager?.getCachedSession(sessionId) === indexed) {
            return indexed;
          }
          const session = (await sessionManager?.getSessionAsync(sessionId)) ?? null;
          if (
            session &&
            isWorkflowSubSessionIdentity(sessionId) &&
            !hasRuntimeWorkerOperations(session.getSessionData().config)
          ) {
            return null;
          }
          return session;
        },
        getSessionCooldownRetryAt: (sessionId: string) =>
          taskAgentManager?.getRestoredRateLimitRetryAt(sessionId) ?? null,
        getMessageContent: (sessionId: string, messageUuid: string) =>
          reactiveDb?.db.getSDKMessageRepo().getDeliveryContent(sessionId, messageUuid) ?? null,
        prepareContent: (loaded, job) => boundDeliveryContent(db.getDatabase(), job, loaded),
        isSessionArchived: (sessionId: string) =>
          reactiveDb?.db.getSession(sessionId)?.status === 'archived',
        markDeliveryFailed: async (sessionId: string, messageUuid: string) =>
          (await reactiveDb?.db.writeSDKMessage(
            'markDeliveryFailedByUuid',
            sessionId,
            messageUuid
          )) ?? null,
        publishStatusChanged: (sessionId: string, messageIds: string[]) =>
          internalEventBus.publish('messages.statusChanged', {
            sessionId,
            messageIds,
            status: 'failed',
          }),
      }),
      {
        dequeueMode: {
          kind: 'session-fifo',
          releasedPath: '$.released',
          waitsBehind: [{ queue: MAILBOX_LANE, sessionIdPath: '$.to.sessionId' }],
        },
        onDead: (job) => {
          deliveryMetrics.recordDeadLetter();
          const payload = asMessageDeliveryPayload(job.payload);
          if (!payload) return;
          const store = reactiveDb?.db;
          if (!store) return;
          const session =
            taskAgentManager?.getSubSession(payload.sessionId) ??
            sessionManager?.getSession(payload.sessionId);
          void settleMessageDeliveryDeadLetter(payload, {
            markDeliveryFailedByUuid: (sid, uuid) =>
              store.writeSDKMessage('markDeliveryFailedByUuidInclusive', sid, uuid),
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

    jobProcessor.register(
      SESSION_SCHEDULE_FIRE,
      createSessionScheduleFire({
        scheduler: rpcHandlers.sessionScheduler,
        notifyIdle: rpcHandlers.notifyScheduleIdle,
        ...createScheduleDelivery(db, () => sessionManager.getOperationRegistry()),
      })
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

    const lhAgentReminderRepo = new SpaceAgentReminderRepository(
      db.getDatabase(),
      new SpaceAgentRepository(db.getDatabase())
    );
    const lhAgentReminderSpaceRepo = new SpaceRepository(db.getDatabase());
    const lhAgentReminderAgentRepo = new SpaceLongHorizonAgentRepository(db.getDatabase());
    jobProcessor.register(LONG_HORIZON_AGENT_REMINDER_FIRE, async (job) => {
      return handleLongHorizonAgentReminderFire(job, {
        reminderRepo: lhAgentReminderRepo,
        spaceRepo: lhAgentReminderSpaceRepo,
        jobQueue,
        deliver: (args) => spaceRuntimeService.deliverLongHorizonAgentReminder(args),
        getOccurrenceDeliveryState: (spaceId, agentId, idempotencyKey) => {
          const sessionId = resolveAgentSessionId(lhAgentReminderAgentRepo, spaceId, agentId);
          return sessionId
            ? readReminderOccurrenceState(reactiveDb?.db, sessionId, idempotencyKey)
            : 'absent';
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

    if (usesHumanLogin()) {
      oauthRefreshScheduler.start();
      logInfo('[Daemon] OAuth refresh scheduler started');
    } else {
      logInfo('[Daemon] OAuth refresh scheduler skipped: test daemon without the human login');
    }

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
    enqueueMailboxExpireIfMissing(jobQueue, Date.now());
    logInfo('[Daemon] Ensured initial mailbox.expire job');
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
    mailboxExpireProcessor.start();
    logInfo('[Daemon] Mailbox expiration job processor started');
    messageDeliveryProcessor.start();
    logInfo('[Daemon] Message-delivery job processor started');
    sessionDoor =
      process.env.NODE_ENV === 'test' && !process.env.HYPERNEO_DATA_DIR
        ? null
        : await startSessionDoor(() => sessionManager.getOperationRegistry()).catch(
            (error: unknown) => {
              logError('[Daemon] Session door not started:', error);
              return null;
            }
          );
    if (process.env.NODE_ENV !== 'test') {
      processWatchdog.start();
      logInfo('[Daemon] Process watchdog started');
    }

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

    if (process.env.NODE_ENV !== 'test') {
      const scanInactivityWatchdog = (): Promise<void> => {
        if (inactivityScan !== null) return inactivityScan;
        const run = (async () => {
          try {
            const spaces = await spaceManager.listSpaces(false);
            for (const space of spaces) {
              await spaceAgentInactivityWatchdog.scanSpace(space.id);
            }
          } catch (err) {
            logError('[Daemon] Inactivity watchdog scan failed:', err);
          }
        })();
        inactivityScan = run;
        void run.finally(() => {
          inactivityScan = null;
        });
        return run;
      };
      let inactivitySpaceRuntimeReady = false;
      void spaceRuntimeReadyPromise.then(() => {
        inactivitySpaceRuntimeReady = true;
        if (!inactivityShutdownStarted) {
          void scanInactivityWatchdog();
        }
      });
      const INACTIVITY_WATCHDOG_SCAN_INTERVAL_MS = 5 * 60 * 1000;
      inactivityWatchdogTimer = setInterval(() => {
        if (inactivitySpaceRuntimeReady) {
          void scanInactivityWatchdog();
        }
      }, INACTIVITY_WATCHDOG_SCAN_INTERVAL_MS);
      inactivityWatchdogTimer.unref();
    }

    let isCleanedUp = false;
    const cleanup = async () => {
      if (isCleanedUp) {
        return;
      }
      isCleanedUp = true;
      db.stopSdkMessageColumnsBackfill();
      startupLogCaptureCleanup = null;
      for (const timer of cooldownResumeTimers) clearTimeout(timer);

      removeRuntimeDescriptorFile();
      await sessionDoor?.close();

      if (reaperTimer !== null) {
        clearInterval(reaperTimer);
        reaperTimer = null;
      }
      if (inactivityWatchdogTimer !== null) {
        clearInterval(inactivityWatchdogTimer);
        inactivityWatchdogTimer = null;
      }
      inactivityShutdownStarted = true;
      cancelInactivityWatchdog();
      if (inactivityScan !== null) {
        await Promise.race([inactivityScan, new Promise((resolve) => setTimeout(resolve, 5000))]);
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
        await oauthRefreshScheduler.stop();
        logInfo('[Daemon] OAuth refresh scheduler stopped');
        messageDeliveryProcessor.stopPolling();
        logInfo('[Daemon] Message-delivery job polling stopped');
        mailboxExpireProcessor.stopPolling();
        logInfo('[Daemon] Mailbox expiration job polling stopped');
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
        await mailboxExpireProcessor.stop();
        logInfo('[Daemon] Mailbox expiration job processor stopped');
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

        stopEventLoopLagLog();
        logEvidenceService.flush();
        unsubscribeStructuredLogs();
        unsubscribeProviderFailureChanges?.();
        await invalidateInFlightModelLoads();

        await db.close();

        logInfo('[Daemon] Graceful shutdown complete');
      } catch (error) {
        logError('Error during cleanup:', error);
        stopEventLoopLagLog();
        logEvidenceService.flush();
        unsubscribeStructuredLogs();
        unsubscribeProviderFailureChanges?.();
        await invalidateInFlightModelLoads();
        throw error;
      } finally {
        try {
          await closeFileLogCapture();
        } finally {
          stopEventLoopLagLog();
          eventLoopWatchdog?.stop();
        }
      }
    };

    startupTimer.finish();
    armStallDetectionWhenStartupSettles(eventLoopWatchdog, spaceRuntimeReadyPromise, {
      onArm: (reason) => {
        logInfo(`[Daemon] Event-loop stall detection armed (${reason})`);
        if (eventLoopLagLogStopped) return;
        const stop = startDaemonLagDiagnostics(messageHub, (line) => console.error(line));
        stopEventLoopLagLog = () => {
          eventLoopLagLogStopped = true;
          stop();
        };
      },
    });

    return {
      server,
      handlePair,
      authenticateUpgrade,
      guardRequest,
      db,
      messageHub,
      sessionManager,
      authManager,
      settingsManager,
      daemonConfigService,
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
      armShutdownFuse: () => eventLoopWatchdog?.armShutdownFuse(),
      cleanup,
    };
  } catch (error) {
    startupTimer.finish();
    await failedStartupCleanup?.();
    stopEventLoopLagLog();
    eventLoopWatchdog?.stop();
    startupLogCaptureCleanup?.();
    unsubscribeProviderFailureChanges?.();
    await invalidateInFlightModelLoads();
    restoreConsoleCapture();
    strandedStartupFileLogCapture = closeFileLogCapture;
    throw error;
  }
}
