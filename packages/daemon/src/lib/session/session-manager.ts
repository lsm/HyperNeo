import type {
  Session,
  ImageContent,
  MessageHub,
  MessageDeliveryMode,
  MessageOrigin,
  MessageImage,
} from '@hyperneo/shared';
import { generateUUID, matchesDraftOrComposition } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import {
  AgentSession,
  type AgentSessionRuntimeOptions,
  RECENTLY_EXITED_ROOT_PID_RETENTION_MS,
} from '../agent/agent-session';
import type { AuthManager } from '../auth-manager';
import type { SettingsManager } from '../settings-manager';
import { WorktreeManager } from '../worktree-manager';
import { Logger } from '../logger';
import { listProcesses, type ProcessSnapshot } from '../process-watchdog';
import type { SkillsManager } from '../skills-manager';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import type { JobQueueProcessor } from '../../storage/job-queue-processor';
import { SESSION_TITLE_GENERATION } from '../job-queue-constants';
import { handleSessionTitleGeneration } from '../job-handlers/session-title.handler';

import { SessionCache } from './session-cache';
import {
  SessionLifecycle,
  type SessionLifecycleConfig,
  type CreateSessionParams,
  type ArchiveResourcesTrigger,
  type DeleteResourcesTrigger,
} from './session-lifecycle';
import { ToolsConfigManager } from './tools-config';
import { MessagePersistence } from './message-persistence';
import { ReferenceResolver } from './reference-resolver';

export interface SpaceRuntimeMcpProvider {
  reattachMemberSpaceTools(sessionId: string): Promise<void>;
}

export enum CleanupState {
  IDLE = 'idle',
  CLEANING = 'cleaning',
  CLEANED = 'cleaned',
}

export class SessionManager {
  private logger: Logger;
  private worktreeManager: WorktreeManager;
  private internalEventBusUnsubscribers: Array<() => void> = [];
  private sessionResetSubscribers: Array<
    (event: { sessionId: string; session: Session; restartQuery: boolean }) => Promise<void> | void
  > = [];
  private started = false;

  private cleanupState: CleanupState = CleanupState.IDLE;
  private hardResetInFlight = new Map<string, Promise<{ success: boolean; error?: string }>>();

  private evictedLiveRootPids = new Map<number, { evictedAt: number; startTime: number }>();
  private evictedExitedRootPids = new Map<number, number>();

  private sessionCache: SessionCache;
  private sessionLifecycle: SessionLifecycle;
  private toolsConfigManager: ToolsConfigManager;
  private messagePersistence: MessagePersistence;
  private spaceRuntimeMcpProvider?: SpaceRuntimeMcpProvider;

  constructor(
    private db: Database,
    private messageHub: MessageHub,
    private authManager: AuthManager,
    private settingsManager: SettingsManager,
    private internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private config: SessionLifecycleConfig,
    private jobQueue: JobQueueRepository,
    private jobProcessor: JobQueueProcessor,
    private skillsManager?: SkillsManager,
    private appMcpServerRepo?: AppMcpServerRepository
  ) {
    this.logger = new Logger('SessionManager');
    this.worktreeManager = new WorktreeManager();

    this.toolsConfigManager = new ToolsConfigManager(db);

    const createAgentSession = (session: Session): AgentSession =>
      this.createAgentSessionFromSession(session);

    this.sessionCache = new SessionCache(createAgentSession, (sessionId: string) =>
      this.db.getSession(sessionId)
    );

    this.sessionLifecycle = new SessionLifecycle(
      db,
      this.worktreeManager,
      this.sessionCache,
      internalEventBus,
      messageHub,
      config,
      this.toolsConfigManager,
      createAgentSession
    );

    const referenceResolver = new ReferenceResolver({
      taskRepo: db.getTaskRepo(),
      goalRepo: db.getGoalRepo(),
    });
    this.messagePersistence = new MessagePersistence(
      this.sessionCache,
      db,
      messageHub,
      internalEventBus,
      referenceResolver
    );

    this.setupEventSubscriptions();
  }

  private needsSpaceRuntimeProvisioning(session: Session): boolean {
    if (session.type === 'space_chat') return true;
    if (session.type === 'space_task_agent') return true;
    return typeof session.context?.spaceId === 'string';
  }

  private createAgentSessionFromSession(
    session: Session,
    runtimeOptions: AgentSessionRuntimeOptions = {}
  ): AgentSession {
    const agentSession = new AgentSession(
      session,
      this.db,
      this.messageHub,
      this.internalEventBus,
      () => this.authManager.getCurrentApiKey(),
      this.skillsManager,
      this.appMcpServerRepo,
      undefined,
      session.config.toolGuards,
      {
        autoReplayPendingMessages: !this.needsSpaceRuntimeProvisioning(session),
        ...runtimeOptions,
        hardReset: (agentSession, options) => this.hardResetAgentSession(agentSession, options),
      }
    );
    if (this.spaceRuntimeMcpProvider) {
      const provider = this.spaceRuntimeMcpProvider;
      agentSession.onMissingMemberSpaceMcpServers = () =>
        provider.reattachMemberSpaceTools(session.id);
    }
    return agentSession;
  }

  private preserveResetCostBaseline(
    agentSession: AgentSession,
    persistedSession: Session
  ): Session {
    const currentSession = agentSession.getSessionData();
    const currentMetadata = currentSession.metadata ?? {};
    const lastSdkCost = currentMetadata.lastSdkCost || 0;
    if (lastSdkCost <= 0) return persistedSession;

    const costBaseline = currentMetadata.costBaseline || 0;
    const metadata = {
      ...currentMetadata,
      costBaseline: costBaseline + lastSdkCost,
      lastSdkCost: 0,
    };
    this.db.updateSession(currentSession.id, { metadata });
    return { ...persistedSession, metadata };
  }

  private hardResetAgentSession(
    agentSession: AgentSession,
    options: { restartQuery: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    const sessionId = agentSession.getSessionData().id;
    const existingReset = this.hardResetInFlight.get(sessionId);
    if (existingReset) {
      return existingReset;
    }

    const resetPromise = this.performHardResetAgentSession(agentSession, options).finally(() => {
      if (this.hardResetInFlight.get(sessionId) === resetPromise) {
        this.hardResetInFlight.delete(sessionId);
      }
    });
    this.hardResetInFlight.set(sessionId, resetPromise);

    return resetPromise;
  }

  registerSessionResetSubscriber(
    subscriber: (event: {
      sessionId: string;
      session: Session;
      restartQuery: boolean;
    }) => Promise<void> | void
  ): () => void {
    this.sessionResetSubscribers.push(subscriber);
    return () => {
      const index = this.sessionResetSubscribers.indexOf(subscriber);
      if (index !== -1) {
        this.sessionResetSubscribers.splice(index, 1);
      }
    };
  }

  private async emitSessionReset(event: {
    sessionId: string;
    session: Session;
    restartQuery: boolean;
  }): Promise<void> {
    await this.internalEventBus.publish('session.reset', event);
    for (const subscriber of this.sessionResetSubscribers) {
      await subscriber(event);
    }
  }

  private async performHardResetAgentSession(
    agentSession: AgentSession,
    options: { restartQuery: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    const sessionId = agentSession.getSessionData().id;
    try {
      const persistedSession = this.db.getSession(sessionId);
      if (!persistedSession) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const sessionForFreshInstance = this.preserveResetCostBaseline(
        agentSession,
        persistedSession
      );

      if (!options.restartQuery) {
        const messageUuids =
          this.db.getJobQueueRepo?.()?.cancelForSessionWithMessages(sessionId) ?? [];
        const sdkRepo = this.db.getSDKMessageRepo?.();
        for (const messageUuid of messageUuids) {
          sdkRepo?.markDeliveryFailedByUuid(sessionId, messageUuid);
        }
      }

      await this.internalEventBus.publish('session.errorClear', { sessionId });

      const freshSession = this.createAgentSessionFromSession(sessionForFreshInstance, {
        autoReplayPendingMessages: false,
      });
      this.sessionCache.set(sessionId, freshSession);

      await this.emitSessionReset({
        sessionId,
        session: sessionForFreshInstance,
        restartQuery: options.restartQuery,
      });

      try {
        await agentSession.cleanup();
      } catch (error) {
        this.logger.error(
          `[SessionManager] hardResetAgentSession: cleanup failed for ${sessionId}:`,
          error
        );
      }

      if (options.restartQuery) {
        await freshSession.replayPendingMessagesForImmediateMode();
      }

      this.messageHub.event(
        'session.reset',
        { message: 'Agent has been reset and is ready for new messages' },
        { channel: `session:${sessionId}` }
      );

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`[SessionManager] hardResetAgentSession failed for ${sessionId}:`, error);
      return { success: false, error: errorMessage };
    }
  }

  start(): void {
    if (this.started) {
      throw new Error('SessionManager.start() called more than once');
    }
    this.started = true;
    this.jobProcessor.register(SESSION_TITLE_GENERATION, (job) =>
      handleSessionTitleGeneration(job, this.sessionLifecycle)
    );
  }

  private setupEventSubscriptions(): void {
    const unsubMessagePersisted = this.internalEventBus.subscribe(
      'message.persisted',
      async (data) => {
        const {
          sessionId,
          userMessageText,
          needsWorkspaceInit,
          hasDraftToClear,
          voicePendingSent,
        } = data;

        try {
          if (needsWorkspaceInit) {
            this.jobQueue.enqueue({
              queue: SESSION_TITLE_GENERATION,
              payload: { sessionId, userMessageText },
              maxRetries: 2,
            });
          }

          if (hasDraftToClear) {
            const beforeClear = this.getSessionFromDB(sessionId);
            const draft = beforeClear?.metadata?.inputDraft ?? '';
            const pending = beforeClear?.metadata?.inputDraftVoicePending ?? '';
            const match = matchesDraftOrComposition(draft, pending, userMessageText ?? '');
            if (match) {
              await this.sessionLifecycle.update(sessionId, {
                metadata: {
                  inputDraft: null,
                  ...(match === 'composition' ? { inputDraftVoicePending: null } : {}),
                },
              } as Partial<Session>);
            } else if (
              voicePendingSent !== undefined &&
              pending.trim() !== '' &&
              pending.trim() === voicePendingSent.trim()
            ) {
              await this.sessionLifecycle.update(sessionId, {
                metadata: { inputDraftVoicePending: null },
              } as Partial<Session>);
            }
          }
        } catch (error) {
          this.logger.error(
            `[SessionManager] Error in post-persistence processing for session ${sessionId}:`,
            error
          );
        }
      },
      { subscriberName: 'SessionManager.messagePersisted' }
    );
    this.internalEventBusUnsubscribers.push(unsubMessagePersisted);

    const unsubMcpRegistry = this.internalEventBus.subscribe(
      'mcp.registry.changed',
      () => {
        this.reconcileActiveSessionsMcp();
      },
      { subscriberName: 'SessionManager.mcpRegistryChanged' }
    );
    this.internalEventBusUnsubscribers.push(unsubMcpRegistry);

    const unsubSkills = this.internalEventBus.subscribe(
      'skills.changed',
      () => {
        this.reconcileActiveSessionsMcp();
      },
      { subscriberName: 'SessionManager.skillsChanged' }
    );
    this.internalEventBusUnsubscribers.push(unsubSkills);
  }

  private reconcileActiveSessionsMcp(): void {
    for (const [, agentSession] of this.sessionCache.entries()) {
      try {
        agentSession.reconcileEffectiveMcpServers();
      } catch (error) {
        this.logger.error(
          `[SessionManager] MCP reconcile failed for session ${agentSession.getSessionData().id}:`,
          error
        );
      }
    }
  }

  async createSession(params: CreateSessionParams): Promise<string> {
    return this.sessionLifecycle.create(params);
  }

  async generateTitleAndRenameBranch(
    sessionId: string,
    userMessageText: string
  ): Promise<{ title: string; isFallback: boolean }> {
    return this.sessionLifecycle.generateTitleAndRenameBranch(sessionId, userMessageText);
  }

  async initializeSessionWorkspace(
    sessionId: string,
    userMessageText: string
  ): Promise<{ title: string; isFallback: boolean }> {
    return this.generateTitleAndRenameBranch(sessionId, userMessageText);
  }

  getSession(sessionId: string): AgentSession | null {
    return this.sessionCache.get(sessionId);
  }

  getCachedSession(sessionId: string): AgentSession | null {
    return this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
  }

  setSpaceRuntimeMcpProvider(provider: SpaceRuntimeMcpProvider): void {
    this.spaceRuntimeMcpProvider = provider;
  }

  getSessionLifecycle(): SessionLifecycle {
    return this.sessionLifecycle;
  }

  getWorktreeManager(): WorktreeManager {
    return this.worktreeManager;
  }

  async getSessionAsync(sessionId: string): Promise<AgentSession | null> {
    return this.sessionCache.getAsync(sessionId);
  }

  registerSession(agentSession: AgentSession): void {
    this.sessionCache.set(agentSession.getSessionData().id, agentSession);
  }

  *getTrackedAgentRootPids(): Iterable<number> {
    for (const [, agentSession] of this.sessionCache.entries()) {
      yield* agentSession.getTrackedAgentRootPids();
    }
  }

  getTrackedAgentRootPidsSplit(snapshot?: ProcessSnapshot[]): { live: number[]; exited: number[] } {
    this.expireEvictedRoots(snapshot);
    const live: number[] = [];
    const exited: number[] = [];
    for (const [, agentSession] of this.sessionCache.entries()) {
      const split = agentSession.getTrackedAgentRootPidsSplit();
      live.push(...split.live);
      exited.push(...split.exited);
    }
    for (const pid of this.evictedLiveRootPids.keys()) {
      if (!live.includes(pid)) {
        live.push(pid);
      }
    }
    for (const pid of this.evictedExitedRootPids.keys()) {
      if (!exited.includes(pid)) {
        exited.push(pid);
      }
    }
    return { live, exited };
  }

  async unregisterSession(sessionId: string): Promise<void> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    if (agentSession) {
      await this.preserveRootPids(agentSession);
    }
    this.sessionCache.remove(sessionId);
  }

  async injectMessage(
    sessionId: string,
    message: string,
    opts?: { deliveryMode?: MessageDeliveryMode; origin?: MessageOrigin }
  ): Promise<void> {
    await this.messagePersistence.persist({
      sessionId,
      messageId: generateUUID(),
      content: message,
      deliveryMode: opts?.deliveryMode,
      origin: opts?.origin,
    });
  }

  async sendUserMessage(data: {
    sessionId: string;
    messageId: string;
    content: string;
    images?: Array<MessageImage | ImageContent>;
    deliveryMode?: MessageDeliveryMode;
  }): Promise<void> {
    await this.messagePersistence.persist(data);
  }

  listSessions(options?: {
    status?: string;
    includeArchived?: boolean;
    includeSpaceSessions?: boolean;
  }): Session[] {
    return this.db.listSessions(options);
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    return this.sessionLifecycle.update(sessionId, updates);
  }

  getSessionFromDB(sessionId: string): Session | null {
    return this.sessionLifecycle.getFromDB(sessionId);
  }

  async markOutputRemoved(sessionId: string, messageUuid: string): Promise<void> {
    return this.sessionLifecycle.markOutputRemoved(sessionId, messageUuid);
  }

  async archiveSessionResources(
    sessionId: string,
    trigger: ArchiveResourcesTrigger
  ): Promise<void> {
    return this.sessionLifecycle.archiveResources(sessionId, trigger);
  }

  async deleteSessionResources(sessionId: string, trigger: DeleteResourcesTrigger): Promise<void> {
    return this.sessionLifecycle.deleteResources(sessionId, trigger);
  }

  async interruptInMemorySession(sessionId: string): Promise<void> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    if (agentSession) {
      try {
        await agentSession.cleanup();
      } catch (error) {
        this.logger.error(
          `[SessionManager] interruptInMemorySession: cleanup failed for ${sessionId}:`,
          error
        );
      }
      await this.preserveRootPids(agentSession);
    }
    this.sessionCache.remove(sessionId);
  }

  getActiveSessions(): number {
    return this.sessionCache.getActiveCount();
  }

  getTotalSessions(): number {
    return this.db.listSessions({ includeArchived: true }).length;
  }

  private async preserveRootPids(agentSession: AgentSession): Promise<void> {
    const split = agentSession.getTrackedAgentRootPidsSplit();

    let startTimeByPid = new Map<number, number>();
    let now = Date.now();
    if (split.live.length > 0) {
      try {
        const snapshot = await listProcesses();
        now = Date.now();
        for (const snap of snapshot) {
          if (split.live.includes(snap.pid)) {
            startTimeByPid.set(snap.pid, now - snap.elapsedSeconds * 1000);
          }
        }
      } catch {
        // Process listing failed â start times remain unknown.
      }
    }

    for (const pid of split.live) {
      const newStartTime = startTimeByPid.get(pid) ?? 0;
      const existing = this.evictedLiveRootPids.get(pid);
      if (existing) {
        existing.evictedAt = now;
        if (newStartTime !== 0) {
          existing.startTime = newStartTime;
        }
      } else if (newStartTime !== 0) {
        this.evictedLiveRootPids.set(pid, {
          evictedAt: now,
          startTime: newStartTime,
        });
      }
    }
    const exitTimestamps = agentSession.getExitedRootPidTimestamps();
    for (const [pid, exitedAt] of exitTimestamps) {
      this.evictedExitedRootPids.set(pid, exitedAt);
    }
  }

  private expireEvictedRoots(snapshot: ProcessSnapshot[] = [], now = Date.now()): void {
    const snapshotByPid = new Map<number, ProcessSnapshot>();
    for (const snap of snapshot) snapshotByPid.set(snap.pid, snap);

    for (const [pid, meta] of this.evictedLiveRootPids) {
      if (now - meta.evictedAt > RECENTLY_EXITED_ROOT_PID_RETENTION_MS) {
        this.evictedLiveRootPids.delete(pid);
        continue;
      }

      if (snapshot.length === 0) continue;

      const snap = snapshotByPid.get(pid);
      if (!snap) {
        this.evictedLiveRootPids.delete(pid);
        this.evictedExitedRootPids.set(pid, now);
        continue;
      }

      const currentStartTime = now - snap.elapsedSeconds * 1000;
      if (Math.abs(currentStartTime - meta.startTime) > 1000) {
        this.evictedLiveRootPids.delete(pid);
        continue;
      }
    }

    for (const [pid, exitedAt] of this.evictedExitedRootPids) {
      if (now - exitedAt > RECENTLY_EXITED_ROOT_PID_RETENTION_MS) {
        this.evictedExitedRootPids.delete(pid);
      }
    }
  }

  getGlobalToolsConfig() {
    return this.toolsConfigManager.getGlobal();
  }

  saveGlobalToolsConfig(config: ReturnType<typeof this.toolsConfigManager.getGlobal>) {
    this.toolsConfigManager.saveGlobal(config);
  }

  async cleanup(): Promise<void> {
    if (this.cleanupState !== CleanupState.IDLE) {
      return;
    }

    this.cleanupState = CleanupState.CLEANING;

    try {
      for (const unsubscribe of this.internalEventBusUnsubscribers) {
        try {
          unsubscribe();
        } catch (error) {
          this.logger.error(
            `[SessionManager] Error during InternalEventBus<DaemonInternalEventMap> unsubscribe:`,
            error
          );
        }
      }
      this.internalEventBusUnsubscribers = [];
      this.sessionResetSubscribers = [];

      const cleanupPromises: Promise<void>[] = [];
      for (const [sessionId, agentSession] of this.sessionCache.entries()) {
        cleanupPromises.push(
          agentSession.cleanup().catch((error) => {
            this.logger.error(`[SessionManager] Error cleaning up session ${sessionId}:`, error);
          })
        );
      }

      await Promise.all(cleanupPromises);

      this.sessionCache.clear();
      this.hardResetInFlight.clear();

      this.cleanupState = CleanupState.CLEANED;
    } catch (error) {
      this.cleanupState = CleanupState.IDLE;
      this.logger.error(`[SessionManager] Cleanup failed, state rolled back to IDLE:`, error);
      throw error;
    }
  }

  getCleanupState(): CleanupState {
    return this.cleanupState;
  }

  async cleanupOrphanedWorktrees(workspacePath: string): Promise<string[]> {
    return await this.worktreeManager.cleanupOrphanedWorktrees(workspacePath);
  }

  getDatabase(): Database {
    return this.db;
  }
}
