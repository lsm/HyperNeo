import type { Server } from 'bun';
import { homedir } from 'os';
import type { Config } from './config';
import type { WebSocketData } from './types/websocket';
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
import { MAX_GITHUB_POLLING_INTERVAL_SECONDS, MessageHub, MessageHubRouter } from '@neokai/shared';
import type { Provider } from '@neokai/shared/provider';
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
import { migrateProvidersIfNeeded } from './lib/credential-discovery';
import { createReactiveDatabase } from './storage/reactive-database';
import { LiveQueryEngine } from './storage/live-query';
import { SpaceAgentRepository } from './storage/repositories/space-agent-repository';
import { WorkflowHookRuntimeService } from './lib/space/workflow-hook-runtime-service';
import { WorkflowHookStateRepository } from './storage/repositories/workflow-hook-state-repository';
import { SpaceLongHorizonAgentRepository } from './storage/repositories/space-long-horizon-agent-repository';
import { SpaceAgentManager } from './lib/space/managers/space-agent-manager';
import { SpaceManager } from './lib/space/managers/space-manager';
import type { SpaceRuntimeService } from './lib/space/runtime/space-runtime-service';
import type { TaskAgentManager } from './lib/space/runtime/task-agent-manager';
import type { SpaceWorktreeManager } from './lib/space/managers/space-worktree-manager';
import { JobQueueRepository } from './storage/repositories/job-queue-repository';
import { JobQueueProcessor } from './storage/job-queue-processor';
import { createCleanupHandler } from './lib/job-handlers/cleanup.handler';
import {
  createMemoryConsolidationHandler,
  enqueueMemoryConsolidationIfMissing,
} from './lib/job-handlers/memory-consolidation.handler';
import { createSkillValidateHandler } from './lib/job-handlers/skill-validate.handler';
import {
  JOB_QUEUE_CLEANUP,
  MEMORY_CONSOLIDATION,
  SKILL_VALIDATE,
  TASK_SCHEDULE_FIRE,
} from './lib/job-queue-constants';
import { handleTaskScheduleFire } from './lib/job-handlers/task-schedule-fire.handler';
import { TaskScheduleRepository } from './storage/repositories/task-schedule-repository';
import { SpaceRepository } from './storage/repositories/space-repository';
import { SpaceTaskRepository } from './storage/repositories/space-task-repository';
import { SpaceGoalRepository } from './storage/repositories/space-goal-repository';
import { AppMcpLifecycleManager, McpImportService, seedDefaultMcpEntries } from './lib/mcp';
import { FileIndex } from './lib/file-index';
import { installConsoleLogCapture, subscribeToStructuredLogs } from './lib/logger';
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
        // Keychain unavailable (locked / no GUI session) — credentials will load
        // from env / settings.json fallback. Don't mark unhealthy; don't spam logs.
        // KeychainStatusCredentialStore normally converts read failures to null,
        // but provider.getCredentials implementations that hit the keychain
        // directly can re-throw it through here.
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

export interface CreateDaemonAppOptions {
  config: Config;
  /**
   * Whether to log initialization steps to console.
   * Default: true
   */
  verbose?: boolean;
  /**
   * Whether this is running in standalone mode.
   * In standalone mode, adds a GET / route with daemon info.
   * In embedded mode (default), skips the root route.
   * Default: false
   */
  standalone?: boolean;
}

export interface DaemonAppContext {
  server: Server<WebSocketData>;
  db: Database;
  messageHub: MessageHub;
  sessionManager: SessionManager;
  authManager: AuthManager;
  settingsManager: SettingsManager;
  stateManager: StateProjectionService;
  transport: WebSocketServerTransport;
  /**
   * Semantic internal event bus for daemon domain events.
   * See docs/plans/internal-event-command-query-architecture.md.
   */
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  /** Semantic internal command bus for action dispatch */
  commandBus: InternalCommandBus<DaemonCommandMap>;
  /** Semantic internal query bus for point-in-time reads */
  queryBus: ReturnType<typeof createInternalQueryBus<DaemonQueryMap>>;
  /**
   * GitHub service instance (null if not configured)
   */
  gitHubService: GitHubService | null;
  /** Source-agnostic external event persistence and delivery lifecycle store */
  externalEventStore: ExternalEventStore;
  /** External event publisher used by source extensions */
  externalEventService: ExternalEventService;
  /** External event extension manager */
  extensionManager: ExternalEventExtensionManager;
  /** Phase 2: Reactive database wrapper for change event emission */
  reactiveDb: ReturnType<typeof createReactiveDatabase>;
  /** Phase 2: Live query engine for reactive SQL queries */
  liveQueries: LiveQueryEngine;
  /** Space agent manager for Space multi-agent system */
  spaceAgentManager: SpaceAgentManager;
  /** Space manager for Space CRUD and workspace path validation */
  spaceManager: SpaceManager;
  /** Space runtime service for workflow run lifecycle management */
  spaceRuntimeService: SpaceRuntimeService;
  /** Task Agent Manager — manages Task Agent session lifecycle for space tasks */
  taskAgentManager: TaskAgentManager;
  /** Space Worktree Manager — one git worktree per task, shared by all node agents */
  spaceWorktreeManager: SpaceWorktreeManager;
  /** Persistent workflow hook-local state repository */
  workflowHookStateRepository: WorkflowHookStateRepository;
  /** Runtime helper for hook caller and result validation */
  workflowHookRuntimeService: WorkflowHookRuntimeService;
  /** Persistent job queue repository */
  jobQueue: JobQueueRepository;
  /** Persistent job queue processor */
  jobProcessor: JobQueueProcessor;
  /** Application-level MCP lifecycle manager — converts registry entries to SDK configs */
  appMcpManager: AppMcpLifecycleManager;
  /** Application-level Skills manager — registry CRUD and validation */
  skillsManager: SkillsManager;
  /** Workspace file index for fast fuzzy file/folder search */
  fileIndex: FileIndex;
  /**
   * Cleanup function for graceful shutdown.
   * Closes all connections, stops sessions, and closes database.
   */
  cleanup: () => Promise<void>;
}

/**
 * Creates and initializes the NeoKai daemon application.
 *
 * This factory function sets up:
 * - Database connection
 * - Authentication manager
 * - MessageHub with WebSocket transport
 * - Session manager for Claude Agent SDK
 * - State synchronization channels
 * - RPC handlers
 *
 * @param options Configuration and options
 * @returns Initialized Bun server and context for management
 */
export async function createDaemonApp(options: CreateDaemonAppOptions): Promise<DaemonAppContext> {
  const { config, verbose = true, standalone = false } = options;
  let startupLogCaptureCleanup: (() => void) | null = null;
  // Startup phase fences. Each heavy init step logs `[startup N] <name>` with
  // elapsed-since-previous (+ms = duration of the prior phase) and cumulative
  // total, so a slow/hanging phase is obvious. verbose-gated to mirror logInfo.
  let __startupStep = 0;
  let __startupStart = 0;
  let __startupPrev = 0;
  const startupPhase = (name: string) => {
    const now = Date.now();
    if (__startupStart === 0) {
      __startupStart = now;
      __startupPrev = now;
    }
    const delta = now - __startupPrev;
    __startupPrev = now;
    if (verbose) {
      console.log(
        `[startup ${++__startupStep}] ${name} (+${delta}ms, total ${now - __startupStart}ms)`
      );
    }
  };

  try {
    // Clear CLAUDECODE env var so SDK subprocesses don't refuse to start.
    // The daemon may run inside a Claude Code session (e.g., during development),
    // but its spawned agent sessions are independent and must not be blocked.
    delete process.env.CLAUDECODE;

    // Background-prefetch the agent-memory embedding model as early as possible
    // so it shares work with the memory backfill that runs during database init.
    // Use direct console methods here because console capture is installed later.
    // Skip under test so unit-test app instances never hit the network.
    if (process.env.NODE_ENV !== 'test') {
      const prefetchLogInfo = verbose ? console.log : () => {};
      const prefetchLogError = verbose ? console.error : () => {};
      void prefetchAgentMemoryEmbeddingModel({
        logInfo: prefetchLogInfo,
        logError: prefetchLogError,
      });
    }

    // Initialize database
    const db = new Database(config.dbPath);
    // Create reactiveDb before initialize() so GoalRepository can receive it
    const reactiveDb = createReactiveDatabase(db);
    startupPhase('database initialize (open + migrate)');
    await db.initialize(reactiveDb);
    const liveQueries = new LiveQueryEngine(db.getDatabase(), reactiveDb);
    const earlySpaceRepo = new SpaceRepository(db.getDatabase());
    const earlyLogEvidenceService = new EvolutionLogEvidenceService({
      evolutionRepo: db.evolution,
      spaceRepo: earlySpaceRepo,
    });
    const restoreEarlyConsoleCapture = installConsoleLogCapture();
    const unsubscribeEarlyStructuredLogs = subscribeToStructuredLogs((event) => {
      earlyLogEvidenceService.capture(event);
      if (event.level === 'warn' || event.level === 'error' || event.level === 'fatal') {
        earlyLogEvidenceService.flush();
      }
    });
    startupLogCaptureCleanup = () => {
      earlyLogEvidenceService.flush();
      unsubscribeEarlyStructuredLogs();
      restoreEarlyConsoleCapture();
    };

    // Bind shared loggers after console capture is installed so all subsequent
    // startup/shutdown logs flow through the structured-log subscriber.
    const logInfo = verbose ? console.log : () => {};
    const logError = verbose ? console.error : () => {};

    // Initialize job queue
    const jobQueue = new JobQueueRepository(db.getDatabase());
    const workflowHookStateRepository = new WorkflowHookStateRepository(db.getDatabase());
    const workflowHookRuntimeService = new WorkflowHookRuntimeService();
    const maxConcurrent = Number(process.env.NEOKAI_JOB_QUEUE_MAX_CONCURRENT) || 5;
    const jobProcessor = new JobQueueProcessor(jobQueue, {
      pollIntervalMs: 1000,
      maxConcurrent,
      staleThresholdMs: 5 * 60 * 1000,
    });
    // --- setInterval inventory (out-of-scope for job-queue migration) ---
    // The following subsystems intentionally retain their own setInterval timers.
    // They were audited as part of the background-task migration (milestone 6) and
    // determined to be out-of-scope because they are not "business tasks" that
    // belong in the job queue:
    //
    //   • JobQueueProcessor.pollTimer (job-queue-processor.ts)
    //       IS the job-queue infrastructure itself — migrating it is circular.
    //   • JobQueueProcessor drain-check in stop() (job-queue-processor.ts)
    //       Short-lived shutdown poll (50 ms); not a recurring business task.
    //   • WebSocketServerTransport.staleCheckTimer (websocket-server-transport.ts)
    //       Transport-layer health check; no business logic, not schedulable.
    //   • SpaceRuntime.tickTimer (space/runtime/space-runtime.ts)
    //       Drives the SpaceRuntime workflow engine; migrate in a dedicated follow-up.
    //   • TaskAgentManager concurrent-spawn poll (space/runtime/task-agent-manager.ts)
    //       Ephemeral, within a single async call; cleaned up before the call returns.
    //   • app.ts graceful-shutdown readiness check (this file, waitForPendingCalls)
    //       One-shot shutdown polling with hard timeout; not a recurring task.
    //   • ProcessWatchdog timer (process-watchdog.ts)
    //       Last-resort OS process leak safety net; intentionally independent from the job queue.
    jobProcessor.setChangeNotifier((table) => {
      reactiveDb.notifyChange(table);
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

    // Initialize Space agent manager
    const spaceAgentManager = new SpaceAgentManager(
      new SpaceAgentRepository(db.getDatabase()),
      new SpaceLongHorizonAgentRepository(db.getDatabase())
    );

    // Initialize Space manager
    const spaceRepo = earlySpaceRepo;
    const spaceManager = new SpaceManager(db.getDatabase());

    // Initialize authentication manager
    const authManager = new AuthManager(db, config);
    await authManager.initialize();

    // Initialize settings manager.
    // When NEOKAI_WORKSPACE_PATH is set (e.g., in tests via createDaemonServer), use
    // that directory so each test instance writes file-only settings to its own temp
    // workspace, preventing state leakage across tests.
    // Otherwise fall back to homedir() so global MCP config (~/.claude/.mcp.json) is
    // discovered. Room-scoped sessions use their own defaultPath for project-level
    // MCP resolution and are not affected by this global instance.
    const settingsManager = new SettingsManager(db, process.env.NEOKAI_WORKSPACE_PATH ?? homedir());
    const getGitHubPollingIntervalSeconds = () => {
      const value = settingsManager.getGlobalSettings().githubPollingInterval;
      if (value === undefined || !Number.isFinite(value)) return 120;
      return Math.min(MAX_GITHUB_POLLING_INTERVAL_SECONDS, Math.max(0, Math.trunc(value)));
    };
    applyProviderModelAllowlistsToEnv(settingsManager.getGlobalSettings().providerModelAllowlists);

    // Seed disabled built-in state so initializeProviders() won't register
    // providers that were explicitly disabled or deleted in a prior run.
    for (const record of db.providers.listProviders()) {
      if (record.kind === 'built_in' && record.isEnabled === false) {
        markBuiltInProviderDisabled(record.providerId);
      }
    }

    startupPhase('providers (register + credentials)');
    const providerRegistry = initializeProviders();
    await waitForOptionalProviderRegistration(providerRegistry);
    const credentialManager = ProviderCredentialManager.create(db.getDatabase());
    await applyStoredProviderCredentials(providerRegistry.getAll(), credentialManager, logError);
    const oauthRefreshScheduler = new OAuthRefreshScheduler(credentialManager, {
      registry: providerRegistry,
    });

    // One-time migration: env vars / auth files / customEndpoints → providers table.
    startupPhase('provider sync (migrate / custom endpoints / registry)');
    try {
      await migrateProvidersIfNeeded(db, credentialManager);
    } catch (err) {
      logError('[Daemon] Provider migration failed (non-fatal):', err);
    }

    // Register user-defined OpenAI-compatible endpoints (LM Studio, vLLM, LiteLLM, etc.)
    // stored under `settings.customEndpoints`. Synchronous failure is non-fatal — bad
    // endpoint configs are logged and skipped rather than blocking daemon startup.
    {
      const { syncCustomEndpointProviders } = await import('./lib/providers/factory.js');
      const { filterDisabledCustomEndpoints } = await import(
        './lib/rpc-handlers/custom-endpoint-handlers.js'
      );
      const endpoints = settingsManager.getGlobalSettings().customEndpoints ?? [];
      const syncEndpoints = filterDisabledCustomEndpoints(endpoints, db);
      await syncCustomEndpointProviders(syncEndpoints);
    }

    // Sync all enabled providers from the providers table into the registry.
    try {
      await syncAllProviders(() => db.providers.listEnabledProviders(), credentialManager);
    } catch (err) {
      logError('[Daemon] Provider sync failed (non-fatal):', err);
    }

    // Check authentication status.
    // AuthManager only checks env vars; also consider stored provider credentials
    // so that startup gates work when the sole auth source is the credential store.
    const authStatus = await authManager.getAuthStatus();
    const anthropicProvider = providerRegistry.get('anthropic');
    const hasAnthropicAuth =
      authStatus.isAuthenticated || (anthropicProvider?.isAvailable() ?? false);

    // Initialize dynamic models in the background. Startup can serve with static
    // fallback metadata; provider model catalogs refresh into the global cache.
    if (hasAnthropicAuth) {
      startupPhase('model service init (background)');
      void import('./lib/model-service')
        .then(({ initializeModels }) => initializeModels())
        .catch((err) => {
          logError('[Daemon] Background model initialization failed (non-fatal):', err);
        });
    } /* v8 ignore next 3 */ else {
      logInfo('[Daemon] NO CREDENTIALS DETECTED - set ANTHROPIC_API_KEY or authenticate via OAuth');
      logInfo('[Daemon] Model initialization skipped - no credentials available');
    }

    // PHASE 3 ARCHITECTURE (FIXED): MessageHub owns Router, Transport is pure I/O
    // 1. Initialize MessageHubRouter (routing layer - pure routing, no app logic)
    const router = new MessageHubRouter({
      logger: console,
      debug: config.nodeEnv === 'development',
    });

    // 2. Initialize MessageHub (protocol layer)
    const messageHub = new MessageHub({
      defaultSessionId: 'global',
      debug: config.nodeEnv === 'development',
    });

    // 3. Register Router with MessageHub (MessageHub owns routing)
    messageHub.registerRouter(router);

    // 4. Initialize Transport (I/O layer) - needs router for client management
    const transport = new WebSocketServerTransport({
      name: 'websocket-server',
      debug: config.nodeEnv === 'development',
      router, // For client management only, not routing
    });

    // 5. Register Transport with MessageHub
    messageHub.registerTransport(transport);

    // Initialize InternalEventBus for daemon domain events.
    const internalEventBus = createDaemonInternalEventBus();
    const logEvidenceService = earlyLogEvidenceService;
    const unsubscribeStructuredLogs = unsubscribeEarlyStructuredLogs;
    const restoreConsoleCapture = restoreEarlyConsoleCapture;

    // Initialize InternalCommandBus for daemon action dispatch.
    const commandBus = createInternalCommandBus<DaemonCommandMap>();

    // Initialize InternalQueryBus for point-in-time reads.
    // Handlers will be registered by domain services as they migrate.
    const queryBus = createInternalQueryBus<DaemonQueryMap>();

    // Initialize application-level MCP and Skills managers before SessionManager
    // so AgentSession can inject skills into SDK query options.
    const appMcpManager = new AppMcpLifecycleManager(db);
    seedDefaultMcpEntries(db);

    // Import `.mcp.json` entries into the registry (M2 of the MCP config
    // unification plan). Runs once on startup for every known workspace plus
    // the user-level `~/.claude/.mcp.json`. Safe to skip under NODE_ENV=test so
    // unit test DBs don't accidentally read the developer's home directory;
    // online/e2e suites set their own `TEST_USER_SETTINGS_DIR` or construct the
    // service explicitly.
    const mcpImportService = new McpImportService(db);
    startupPhase('mcp import sweep (.mcp.json)');
    if (process.env.NODE_ENV !== 'test') {
      try {
        const workspacePaths = db.workspaceHistory.list(100).map((row) => row.path);
        mcpImportService.refreshAll(workspacePaths);
      } catch (err) {
        // Non-fatal: a bad `.mcp.json` must never block daemon startup. The
        // service already logs per-file; this outer catch is defensive.
        logError('[Daemon] MCP import sweep failed (non-fatal):', err);
      }
    }

    const skillsManager = new SkillsManager(db.skills, db.appMcpServers, jobQueue);
    skillsManager.initializeBuiltins();

    // Materialise SDK-plugin wrappers for every builtin skill so the SDK
    // recognises them as plugins and exposes `/<commandName>` slash commands.
    // Without this, `plugins: [{ type: 'local', path: '~/.neokai/skills/playwright' }]`
    // is silently dropped because the directory has no `.claude-plugin/plugin.json`
    // (it follows the agent-skills layout, not the plugin layout). See
    // `lib/agent/builtin-skill-plugin-wrapper.ts` for the full rationale.
    //
    // Errors are non-fatal: if a wrapper can't be created the slash command
    // just won't appear, but the daemon must still come up.
    try {
      startupPhase('skill plugin wrappers');
      await skillsManager.ensureBuiltinPluginWrappers();
    } catch (err) {
      logError('[Daemon] Failed to ensure builtin skill plugin wrappers (non-fatal):', err);
    }

    // Initialize session manager (with InternalEventBus<DaemonInternalEventMap>, SettingsManager, no StateManager dependency!)
    // Use reactiveDb.db so sdk_messages writes emitted by AgentSession pipelines
    // trigger LiveQuery invalidation immediately.
    startupPhase('session manager');
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

    // Register session title generation handler before jobProcessor starts
    sessionManager.start();

    // Initialize StateProjectionService (read-model caches from InternalEventBus)
    startupPhase('state projection service');
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

    // Initialize ClientEventBridge — forwards selected InternalEventBus events to
    // WebSocket clients via ClientEventGateway. This extracts the repetitive
    // room/space forwarding out of StateProjectionService.
    const clientEventGateway = stateManager.getClientEventGateway();
    const clientEventBridge = createClientEventBridge(
      internalEventBus,
      clientEventGateway,
      stateManager
    );
    clientEventBridge.start();

    // Initial credential-store status (including Keychain-unavailable warning)
    // is delivered to clients via the GLOBAL_SNAPSHOT RPC, which
    // globalStore.initialize requests on connect and which calls
    // getSystemState() fresh — see StateProjectionService.getGlobalSnapshot.
    // A startup broadcast here would be dropped: MessageHub.event skips when
    // there are no connected subscribers, and Bun.serve hasn't accepted any
    // WebSocket clients yet at this point in startup.

    // Wire credential-store status transitions (keychain unavailable → UI
    // banner appears, keychain recovered → banner clears) to a system state
    // broadcast so connected clients update immediately. Without this, a
    // banner triggered by a provider save/login during a session would not
    // appear until the next reconnect or unrelated system refresh.
    credentialManager.registerStatusChangeCallback(() => {
      void stateManager.broadcastSystemChange();
      // On Keychain recovery, re-apply stored credentials to providers that
      // were registered without credentials at startup because the Keychain
      // was locked. applyStoredProviderCredentials is a no-op when the store
      // is still unavailable (reads return null), so this is safe to run on
      // both transitions.
      void applyStoredProviderCredentials(providerRegistry.getAll(), credentialManager, logError);
    });

    startupPhase('github service');
    // Initialize GitHub service if configured
    let gitHubService: GitHubService | null = null;
    const shouldEnableGitHub = config.githubWebhookSecret || getGitHubPollingIntervalSeconds() > 0;

    if (hasAnthropicAuth) {
      // Get API key for AI agents (security + routing).
      // Fall back to stored provider credentials so GitHub works when the sole
      // auth source is the credential store.
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
          githubToken: process.env.GITHUB_TOKEN, // Optional GitHub token for polling
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

    // Initialize workspace file index (non-blocking — init runs in the background)
    const fileIndex = new FileIndex(config.workspaceRoot);
    void fileIndex.init();

    const externalEventStore = new ExternalEventStore(db.getDatabase());
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

    startupPhase('external event extensions');
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

    // Setup RPC handlers (returns cleanup function + exposed services)
    startupPhase('rpc handlers + space runtime provision');
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

    // Start the readiness wait, but do not block HTTP/WS bind on the full
    // existing-session reattach/rehydrate sweep. Session query startup has
    // runtime MCP self-heal callbacks, so this avoids penalising health checks
    // and UI load on every historical active session.
    startupPhase('space runtime ready (background MCP re-attach)');
    const spaceRuntimeReadyPromise = spaceRuntimeService.ready();

    // Create WebSocket handlers
    const wsHandlers = createWebSocketHandlers(transport, sessionManager);

    // Create Bun server with native WebSocket support
    const server = Bun.serve({
      hostname: config.host,
      port: config.port,

      async fetch(req, server) {
        const url = new URL(req.url);

        // CORS preflight
        if (req.method === 'OPTIONS') {
          return new Response(null, {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            },
          });
        }

        // WebSocket upgrade at /ws
        if (url.pathname === '/ws') {
          const upgraded = server.upgrade(req, {
            data: {
              // Initial connection session is 'global'
              connectionSessionId: 'global',
            },
          });

          if (upgraded) {
            return; // WebSocket upgrade successful
          }

          return new Response('WebSocket upgrade failed', { status: 500 });
        }

        // Root info route (only in standalone mode)
        if (standalone && url.pathname === '/') {
          return Response.json(
            {
              name: 'NeoKai Daemon',
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

        // Space-level public-safe GitHub webhook endpoint.
        const extensionRoute = extensionManager
          .getRegisteredRoutes()
          .find((route) => route.path === url.pathname && route.method === req.method);
        if (extensionRoute) {
          return extensionRoute.handle(req);
        }

        // Hello world endpoint
        if (url.pathname === '/hello' && req.method === 'GET') {
          return new Response('Hello World', {
            status: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }

        // 404 for unknown routes
        return new Response('Not found', {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      },

      websocket: wsHandlers,

      error(error) {
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

    startupPhase('HTTP/WS server bound — createDaemonApp init complete');
    void spaceRuntimeReadyPromise.then(() => {
      logInfo('[Daemon] Space runtime startup provisioning complete');
    });
    // Start GitHub service after server is ready.
    // GitHubService.start() registers the github.poll handler and enqueues the
    // initial job when jobProcessor/jobQueue are provided.
    if (gitHubService && shouldEnableGitHub) {
      gitHubService.start();
      logInfo('[Daemon] GitHub service started');
    }

    // Register job handlers BEFORE starting the processor so no pending job
    // from a previous run is dequeued without a handler available.
    jobProcessor.register(
      SKILL_VALIDATE,
      createSkillValidateHandler(skillsManager, db.appMcpServers)
    );
    jobProcessor.register(JOB_QUEUE_CLEANUP, createCleanupHandler(jobQueue));
    jobProcessor.register(
      MEMORY_CONSOLIDATION,
      createMemoryConsolidationHandler(db.agentMemory, jobQueue)
    );

    // Register task-schedule.fire handler.
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

    // Startup resilience: re-seed active schedules whose pending jobs are missing.
    // This handles crash recovery in two cases:
    //   1) Schedule has a pendingJobId, but the underlying job is gone OR has reached
    //      a terminal state (completed/failed/dead) without `updateAfterFire` advancing
    //      the schedule. This can happen if the daemon crashed between job completion
    //      and the schedule update.
    //   2) Schedule has pendingJobId = null and is due — this happens when the daemon
    //      crashed between scheduleRepo.create() and jobQueue.enqueue(), leaving an
    //      orphaned schedule that listActiveWithPendingJob() would never see.
    if (process.env.NODE_ENV !== 'test') {
      const now = Date.now();

      // A job is considered "lost" for recovery purposes if it's missing OR in any
      // terminal state. `pending` and `processing` are still in flight and should
      // not be re-enqueued.
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
        // Pass 1: schedules with a pendingJobId pointing to a missing/terminal job.
        const activeSchedules = taskScheduleRepo.listActiveWithPendingJob();
        for (const schedule of activeSchedules) {
          if (!schedule.pendingJobId) continue;
          const job = jobQueue.getJob(schedule.pendingJobId);
          if (isJobLost(job?.status)) {
            reseedSchedule(schedule.id, schedule.nextRunAt);
          }
        }

        // Pass 2: due schedules with no pendingJobId at all (e.g. crashed mid-create).
        // `listActiveDue(now)` returns schedules whose nextRunAt <= now. The repo
        // applies a default page size, so loop until a page comes back smaller
        // than the limit — otherwise a backlog of >100 due schedules would only
        // be partially recovered until the next restart.
        const RECOVERY_PAGE_SIZE = 200;
        let totalReseeded = 0;
        while (true) {
          const dueSchedules = taskScheduleRepo.listActiveDue(now, RECOVERY_PAGE_SIZE);
          let pageReseeded = 0;
          for (const schedule of dueSchedules) {
            if (schedule.pendingJobId) continue; // handled by pass 1
            reseedSchedule(schedule.id, schedule.nextRunAt);
            pageReseeded++;
          }
          totalReseeded += pageReseeded;
          // Drained the queue when either the page is short or none of the
          // returned rows actually needed re-seeding (all already had a
          // pending job linked, e.g. set by pass 1).
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

    // Enqueue the initial cleanup job if none is already pending.
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

    // Start job queue processor last (after all handler registrations)
    jobProcessor.start();
    logInfo('[Daemon] Job queue processor started');
    if (process.env.NODE_ENV !== 'test') {
      processWatchdog.start();
      logInfo('[Daemon] Process watchdog started');
    }

    // On startup: clean up orphaned worktrees (directories missing from disk) and run the TTL reaper.
    // Both are non-blocking — errors are logged but never propagate to block server start.
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

      // Run TTL reaper periodically (every hour) for long-running daemon processes.
      const WORKTREE_REAPER_INTERVAL_MS = 60 * 60 * 1000;
      reaperTimer = setInterval(() => {
        spaceWorktreeManager.reapExpiredWorktrees().catch((err) => {
          logError('[Daemon] Periodic worktree TTL reaper failed:', err);
        });
      }, WORKTREE_REAPER_INTERVAL_MS);
      // Allow the process to exit even if this timer is still pending.
      reaperTimer.unref();
    }

    // Cleanup function for graceful shutdown
    let isCleanedUp = false;
    const cleanup = async () => {
      if (isCleanedUp) {
        return;
      }
      isCleanedUp = true;
      startupLogCaptureCleanup = null;

      // Abort any in-flight embedding-model prefetch so shutdown is not delayed
      // by a background download.
      abortAgentMemoryEmbeddingModelPrefetch();

      // Stop the hourly worktree TTL reaper before shutting down other resources.
      if (reaperTimer !== null) {
        clearInterval(reaperTimer);
        reaperTimer = null;
      }

      try {
        // Stop event bridge first so no new client events are forwarded
        // while we're tearing down sessions and transport.
        clientEventBridge.stop();

        try {
          server.stop();
        } catch {
          // Server already stopped
        }

        // Wait for pending RPC calls (with 3s timeout)
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
          // CRITICAL: Clear interval if timeout fired first (prevents hang on exit)
          if (checkInterval) {
            clearInterval(checkInterval);
          }
        }

        // Stop background processors before MessageHub cleanup
        processWatchdog.stop();
        logInfo('[Daemon] Process watchdog stopped');
        oauthRefreshScheduler.stop();
        logInfo('[Daemon] OAuth refresh scheduler stopped');
        await jobProcessor.stop();
        logInfo('[Daemon] Job queue processor stopped');

        // Cleanup MessageHub (rejects remaining calls)
        messageHub.cleanup();

        // Cleanup RPC handlers (disposes live query subscriptions) before
        // tearing down the engine so handles are disposed against a live engine.
        await rpcHandlerCleanup();

        // Dispose live query engine after all subscriptions are cleared
        liveQueries.dispose();

        // Stop GitHub service
        if (gitHubService) {
          gitHubService.stop();
          logInfo('[Daemon] GitHub service stopped');
        }
        for (const extension of extensionManager.getAll()) {
          await extensionManager.stopExtension(extension.sourceId);
        }
        logInfo('[Daemon] External event extensions stopped');

        // Stop all Task Agent sessions before sessionManager.cleanup() so that
        // Task Agent sessions are interrupted cleanly before the session pool drains.
        await taskAgentManager.cleanupAll();

        // Stop all agent sessions first — this closes any open SSE connections
        // that are held by providers (e.g. AnthropicToCopilotBridgeProvider's embedded
        // HTTP server). Provider shutdown must follow so server.close() is not
        // blocked waiting for those connections to drain.
        await sessionManager.cleanup();

        // Shut down providers that hold background resources (e.g. embedded
        // HTTP servers and CLI subprocesses). Runs after sessionManager.cleanup()
        // so all active connections are already closed.
        const providerRegistry = getProviderRegistry();
        await Promise.allSettled(
          providerRegistry.getAll().flatMap((p) => (p.shutdown ? [p.shutdown()] : []))
        );

        // Stop workspace file index polling
        fileIndex.dispose();

        logEvidenceService.flush();
        unsubscribeStructuredLogs();
        restoreConsoleCapture();

        // Close database
        db.close();

        logInfo('[Daemon] Graceful shutdown complete');
      } catch (error) {
        logError('Error during cleanup:', error);
        logEvidenceService.flush();
        unsubscribeStructuredLogs();
        restoreConsoleCapture();
        throw error;
      }
    };

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
      cleanup,
    };
  } catch (error) {
    startupLogCaptureCleanup?.();
    // A startup failure returns no cleanup function, so stop any in-flight
    // embedding-model prefetch here so it cannot outlive the failed process.
    abortAgentMemoryEmbeddingModelPrefetch();
    throw error;
  }
}
