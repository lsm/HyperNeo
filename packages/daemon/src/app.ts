import type { Server } from 'bun';
import { homedir } from 'os';
import type { Config } from './config';
import type { WebSocketData } from './types/websocket';
import { Database } from './storage/database';
import { SessionManager } from './lib/session-manager';
import { AuthManager } from './lib/auth-manager';
import { SettingsManager } from './lib/settings-manager';
import { StateProjectionService } from './lib/state-projection-service';
import { createClientEventBridge } from './lib/client-event-bridge';
import { MessageHub, MessageHubRouter } from '@neokai/shared';
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
import { getProviderRegistry } from './lib/providers/registry.js';
import { createReactiveDatabase } from './storage/reactive-database';
import { LiveQueryEngine } from './storage/live-query';
import { SpaceAgentRepository } from './storage/repositories/space-agent-repository';
import { SpaceAgentManager } from './lib/space/managers/space-agent-manager';
import { SpaceManager } from './lib/space/managers/space-manager';
import type { SpaceRuntimeService } from './lib/space/runtime/space-runtime-service';
import type { TaskAgentManager } from './lib/space/runtime/task-agent-manager';
import type { SpaceWorktreeManager } from './lib/space/managers/space-worktree-manager';
import { JobQueueRepository } from './storage/repositories/job-queue-repository';
import { JobQueueProcessor } from './storage/job-queue-processor';
import { createCleanupHandler } from './lib/job-handlers/cleanup.handler';
import { createSkillValidateHandler } from './lib/job-handlers/skill-validate.handler';
import { JOB_QUEUE_CLEANUP, SKILL_VALIDATE, TASK_SCHEDULE_FIRE } from './lib/job-queue-constants';
import { handleTaskScheduleFire } from './lib/job-handlers/task-schedule-fire.handler';
import { TaskScheduleRepository } from './storage/repositories/task-schedule-repository';
import { SpaceRepository } from './storage/repositories/space-repository';
import { SpaceTaskRepository } from './storage/repositories/space-task-repository';
import { AppMcpLifecycleManager, McpImportService, seedDefaultMcpEntries } from './lib/mcp';
import { FileIndex } from './lib/file-index';
import { SkillsManager } from './lib/skills-manager';
import {
	cleanupSuspiciousProcesses,
	ProcessWatchdog,
	type ProcessSnapshot,
} from './lib/process-watchdog';

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
	const logInfo = verbose ? console.log : () => {};
	const logError = verbose ? console.error : () => {};

	// Clear CLAUDECODE env var so SDK subprocesses don't refuse to start.
	// The daemon may run inside a Claude Code session (e.g., during development),
	// but its spawned agent sessions are independent and must not be blocked.
	delete process.env.CLAUDECODE;

	// Initialize database
	const db = new Database(config.dbPath);
	// Create reactiveDb before initialize() so GoalRepository can receive it
	const reactiveDb = createReactiveDatabase(db);
	await db.initialize(reactiveDb);
	const liveQueries = new LiveQueryEngine(db.getDatabase(), reactiveDb);

	// Initialize job queue
	const jobQueue = new JobQueueRepository(db.getDatabase());
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
	const spaceAgentManager = new SpaceAgentManager(new SpaceAgentRepository(db.getDatabase()));

	// Initialize Space manager
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
	applyProviderModelAllowlistsToEnv(settingsManager.getGlobalSettings().providerModelAllowlists);

	// Register user-defined OpenAI-compatible endpoints (LM Studio, vLLM, LiteLLM, etc.)
	// stored under `settings.customEndpoints`. Synchronous failure is non-fatal — bad
	// endpoint configs are logged and skipped rather than blocking daemon startup.
	{
		const { syncCustomEndpointProviders } = await import('./lib/providers/factory.js');
		await syncCustomEndpointProviders(settingsManager.getGlobalSettings().customEndpoints);
	}

	// Check authentication status
	const authStatus = await authManager.getAuthStatus();

	// Initialize dynamic models on app startup (global cache fallback)
	if (authStatus.isAuthenticated) {
		const { initializeModels } = await import('./lib/model-service');
		await initializeModels();
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
		await skillsManager.ensureBuiltinPluginWrappers();
	} catch (err) {
		logError('[Daemon] Failed to ensure builtin skill plugin wrappers (non-fatal):', err);
	}

	// Initialize session manager (with InternalEventBus<DaemonInternalEventMap>, SettingsManager, no StateManager dependency!)
	// Use reactiveDb.db so sdk_messages writes emitted by AgentSession pipelines
	// trigger LiveQuery invalidation immediately.
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
	const stateManager = new StateProjectionService(
		messageHub,
		sessionManager,
		authManager,
		settingsManager,
		config,
		db,
		internalEventBus
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

	// Initialize GitHub service if configured
	let gitHubService: GitHubService | null = null;
	const shouldEnableGitHub =
		config.githubWebhookSecret ||
		(config.githubPollingInterval && config.githubPollingInterval > 0);

	if (shouldEnableGitHub && authStatus.isAuthenticated) {
		// Get API key for AI agents (security + routing)
		const apiKey =
			config.anthropicApiKey || config.claudeCodeOAuthToken || config.anthropicAuthToken;

		if (apiKey) {
			gitHubService = createGitHubService({
				db,
				internalEventBus,
				config,
				apiKey,
				githubToken: process.env.GITHUB_TOKEN, // Optional GitHub token for polling
				jobQueue,
				jobProcessor,
			});

			logInfo('[Daemon] GitHub integration enabled', {
				webhook: !!config.githubWebhookSecret,
				polling: !!(config.githubPollingInterval && config.githubPollingInterval > 0),
			});
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
	const githubPollingEnabled = !!(config.githubPollingInterval && config.githubPollingInterval > 0);
	if (githubPollingEnabled) {
		const githubGlobalConfig = await extensionConfigStore.getGlobalConfig('github');
		await extensionConfigStore.setGlobalConfig('github', {
			...githubGlobalConfig,
			capabilities: {
				...githubGlobalConfig.capabilities,
				polling: true,
			},
		});
	}
	extensionManager.register(
		new GitHubEventExtension(
			db.getDatabase(),
			process.env.GITHUB_TOKEN,
			githubPollingEnabled ? { pollIntervalMs: config.githubPollingInterval! * 1000 } : undefined
		)
	);

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
	const rpcHandlers = setupRPCHandlers({
		messageHub,
		sessionManager,
		authManager,
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
	} = rpcHandlers;
	taskAgentManager = rpcHandlers.taskAgentManager;

	// Wait for SpaceRuntimeService startup provisioning to complete before we
	// bind the WebSocket/HTTP server. `start()` inside `setupRPCHandlers` kicks
	// off MCP re-attachment for every existing space_chat / space member session
	// as an async task; if we begin accepting queries before it settles, any
	// session-bound RPC can run with `mcpServers: undefined` (strictMcpConfig is
	// on globally) and fail to reach `space-agent-tools`. That was the root
	// cause of task #83. `ready()` never rejects — errors are already logged by
	// the provisioning path.
	await spaceRuntimeService.ready();

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

	// Start GitHub service after server is ready.
	// GitHubService.start() registers the github.poll handler and enqueues the
	// initial job when jobProcessor/jobQueue are provided.
	if (gitHubService) {
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
			const runAt = scheduleNextRunAt !== null && scheduleNextRunAt > now ? scheduleNextRunAt : now;
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

			// Close database
			db.close();

			logInfo('[Daemon] Graceful shutdown complete');
		} catch (error) {
			logError('Error during cleanup:', error);
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
		jobQueue,
		jobProcessor,
		appMcpManager,
		skillsManager,
		fileIndex,
		cleanup,
	};
}
