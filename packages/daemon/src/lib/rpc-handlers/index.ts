import { createNeoFrontHandler } from '../neo/front-job.ts';
import { readCodingTodoWorker } from '../neo/packs/coding/worker-read.ts';
import { codingProjectIdentity } from '../neo/packs/coding/project-cleanup.ts';
import { createPeerMessageRoute } from '../../routes/neo-peer-message.ts';
import { createSessionToolActivationOperation } from '../tools/session-tool-activation.ts';
import {
  createSessionToolPreferenceWriter,
  type SessionToolPreferenceWriter,
} from '../tools/write-session-tool-preferences.ts';
import { createNeoHomeOperations } from '../neo/home/operations.ts';
import { createNeoHomeGithubOperation } from '../neo/packs/coding/home/github.ts';
import { NeoHomeRepository } from '../neo/packs/coding/home/repository.ts';
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
import { collectFamilyOperations, type FamilyOperationContext } from './family-operations/index.ts';
import type { SpaceRpc, SpaceRpcFactory } from './space-rpc.ts';
import { createDatabaseOperationCatalog } from '../operations/database-catalog.ts';
import { neoUserFolder } from '../neo/folder.ts';
import { createNeoService, neoPacksExtension } from '../neo/packs/runtime.ts';
import type { OperationRegistry } from '../operations/registry.ts';
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
import { setupOperationHandlers } from './operation-handlers.ts';
import type { UpgradeIdentity } from '../pairing/upgrade-auth.ts';
import type { MessageHub } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { DaemonCommandMap, InternalCommandBus } from '../internal-command-bus.ts';
import type { SessionManager } from '../session-manager.ts';
import type { AuthManager } from '../auth-manager.ts';
import type { SettingsManager } from '../settings-manager.ts';
import type { Config } from '../../config.ts';
import type { Database } from '../../storage/database.ts';
import type { ReactiveDatabase, TableChangeEvent } from '../../storage/reactive-database.ts';

import { createCloneLifecycleEffects, setupSessionHandlers } from './session-handlers.ts';
import { createResolveClones } from '../session/clone-cascade.ts';
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
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { JobQueueProcessor } from '../../storage/job-queue-processor.ts';
import { setupLiveQueryHandlers } from './live-query-handlers.ts';
import { readLiveSessionList } from '../../storage/repositories/session-list-live-read.ts';
import { setupReferenceHandlers } from './reference-handlers.ts';
import { FileIndex } from '../file-index.ts';
import { LiveQueryEngine } from '../../storage/live-query.ts';
import type { McpImportService } from '../mcp/index.ts';
import { registerAppMcpHandlers, setupAppMcpHandlers } from './app-mcp-handlers.ts';
import { registerSkillHandlers } from './skill-handlers.ts';
import type { SkillsManager } from '../skills-manager.ts';
import { setupWorkspaceHandlers } from './workspace-handlers.ts';
import { setupGitHandlers } from './git-handlers.ts';
import { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository.ts';
import { ExternalEventExtensionConfigStore } from '../external-events/extension-config-store.ts';
import {
  isHttpExtension,
  isRpcExtension,
  type ExternalEventExtensionManager,
} from '../external-events/extension-manager.ts';
import type { ExternalEventExtensionContext } from '../external-events/types.ts';

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
  externalEventExtensionManager: ExternalEventExtensionManager;
  externalEventExtensionConfigStore: ExternalEventExtensionConfigStore;
  externalEventExtensionContext: ExternalEventExtensionContext;
  db: Database;
  gitHubService?: GitHubService;
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

export interface RPCHandlerSetupResult<SpaceServices> {
  cleanup: RPCHandlerCleanup;
  space?: SpaceServices;
  sessionScheduler: SessionScheduler;
  handlePeerMessage: (req: Request) => Promise<Response>;
  frontInference: ReturnType<typeof createNeoFrontHandler>;
  prepareNeoInput: ReturnType<typeof createNeoService>['speech']['prepareInput'];
  wakePollingConcern: (key: string, text: string) => Promise<boolean>;
}

export async function setupRPCHandlers<SpaceServices = never>(
  deps: RPCHandlerDependencies,
  spaceRpc?: SpaceRpcFactory<SpaceServices>
): Promise<RPCHandlerSetupResult<SpaceServices>> {
  let space: SpaceRpc<SpaceServices> | undefined;
  const persistToolPreferences: SessionToolPreferenceWriter = (id, request, tools) =>
    createSessionToolPreferenceWriter(deps.db, async () => {
      const stored = deps.db.getSession(id);
      if (!stored) return;
      const live = new Set([
        space?.sessionSpace.liveSession(id),
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
          space?.sessionSpace.liveSession(id) ?? deps.sessionManager.getCachedSession(id)
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

  space = await spaceRpc?.(deps, {
    readGithubPr: (url, workspacePath) => neoService.readConnectorPr(url, workspacePath),
    readGithubReviewThreads: (url, workspacePath) =>
      neoService.readReviewThreads(url, workspacePath),
  });
  setupSessionHandlers(
    deps.messageHub,
    deps.sessionManager,
    deps.internalEventBus,
    space?.membership,
    undefined,
    {
      writeToolPreferences,
      ensureSession: async (target) => {
        if (space) return space.ensureSession(target);
        const sessionId = target.kind === 'session' ? target.sessionId : null;
        return sessionId && (await deps.sessionManager.getSessionAsync(sessionId))
          ? { kind: 'resolved', sessionId, created: false }
          : { kind: 'unresolved', reason: 'Session not found' };
      },
      resolveClones:
        space?.resolveClones ??
        createResolveClones({
          listChildren: (parentId) => deps.db.listChildSessions(parentId),
          detach: (sessionId) => deps.db.detachSessionFromParent(sessionId),
          ...createCloneLifecycleEffects(
            deps.sessionManager,
            undefined,
            deps.internalEventBus,
            (id) => deps.db.getSession(id)
          ),
        }),
      listClones: (parentId) => deps.db.listChildSessions(parentId),
      primaryAgentFor: (sessionId) => space?.primaryAgentFor(sessionId) ?? null,
    }
  );

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
    sessionSpace: space?.sessionSpace,
  };
  const neoService = createNeoService(
    deps.db,
    deps.sessionManager,
    deps.messageHub,
    deps.internalEventBus,
    (settings) => publishGlobalSettings(deps.internalEventBus, settings, deps.credentialManager),
    neoUserFolder(deps.config.workspaceRoot)
  );
  deps.extensions.register(neoPacksExtension(neoService));
  deps.reactiveDb.on('change:neo_session_messages', () => neoService.notifyChanged());
  deps.reactiveDb.on('change:pack_coding_todos', () => neoService.notifyChanged());
  neoService.filePacks = adoptNeoFilePacks(
    loadNeoFilePacks({
      root: join(getDataDir(), 'neo-packs'),
      warn: (id, error) => log.warn(`Neo file pack ${id} was not loaded`, error),
    })
  );
  const neoHome = new NeoHomeRepository(neoFolderPath(), neoService.repo);
  const boundFamilyContext: FamilyOperationContext = {
    ...familyContext,
    workerNameSource: (read) => {
      neoService.workerNames = read;
    },
    driverHealthNotice: async (id, text) => {
      const root = neoService.repo.defaultBinding()?.sessionId;
      if (!root) return false;
      await neoService.deliverForward(root, id, text, root, 'event');
      return true;
    },
    goalMandateChange: (ref, revision) => neoHome.changedRevision(ref, revision),
    executionPreparations: () => neoService.packs(),
  };
  const familyOperations = [
    createSessionToolActivationOperation({
      write: persistToolPreferences,
      exclusive: exclusiveToolPreferences,
      getLiveSession: (id) =>
        space?.sessionSpace.liveSession(id) ?? deps.sessionManager.getCachedSession(id),
    }),
    ...collectFamilyOperations(boundFamilyContext),
    ...(space?.familyOperations(boundFamilyContext) ?? []),
    ...deps.extensions.operations(),
    createDaemonExtensionsOperation(deps.extensions),
    ...createNeoOperations(neoService, codingProjectIdentity, readCodingTodoWorker),
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

  if (space)
    space.complete(familyOperations, neoService.handleWorkerQuestion, (prUrl) =>
      neoService.readPrState(prUrl)
    );
  else {
    let registry: OperationRegistry | undefined;
    deps.sessionManager.setDefaultOperationRegistryProvider(
      () =>
        (registry ??= createDatabaseOperationCatalog(
          deps.db,
          deps.jobQueue,
          { workerReport: neoService.handleWorkerQuestion },
          familyOperations
        ))
    );
  }

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
  const reorganizeTopics = createNeoProjectsReorganizer(
    neoReorganizeRuntime(neoService, codingProjectIdentity)
  );
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
        await space?.stop();
        unsubLiveQuery();
        fileIndex.dispose();
      }
    },
    space: space?.services,
    sessionScheduler,
    wakePollingConcern: (key: string, text: string) => neoService.wakeNeo(key, text),
    handlePeerMessage: createPeerMessageRoute(neoService),
    frontInference: createNeoFrontHandler(neoService),
    prepareNeoInput: neoService.speech.prepareInput.bind(neoService.speech),
  };
}
