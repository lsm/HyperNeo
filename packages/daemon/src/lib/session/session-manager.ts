/**
 * Session Manager - Orchestrator
 *
 * Main entry point for session operations. Orchestrates:
 * - SessionCache: In-memory session storage
 * - SessionLifecycle: CRUD operations and title generation
 * - ToolsConfigManager: Global tools configuration
 * - MessagePersistence: User message handling
 *
 * Also manages:
 * - InternalEventBus<DaemonInternalEventMap> subscriptions for async message processing
 */

import type {
  Session,
  ImageContent,
  MessageHub,
  MessageDeliveryMode,
  MessageOrigin,
  MessageImage,
} from '@hyperneo/shared';
import { appendDraftText, generateUUID } from '@hyperneo/shared';
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

// Import extracted modules
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

/**
 * Narrow handle onto SpaceRuntimeService for re-attaching a session's required
 * in-process Space MCP servers. Kept as a structural interface so SessionManager
 * (a generic layer) does not import from `lib/space` — SpaceRuntimeService
 * satisfies it structurally.
 */
export interface SpaceRuntimeMcpProvider {
  reattachMemberSpaceTools(sessionId: string): Promise<void>;
}

/**
 * Cleanup state machine for SessionManager
 *
 * Prevents concurrent or redundant cleanup calls.
 *
 * States:
 * - IDLE: Normal operation, cleanup not started
 * - CLEANING: Cleanup in progress
 * - CLEANED: Cleanup complete, no further operations allowed
 */
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

  // Cleanup state machine - prevents race conditions during shutdown
  private cleanupState: CleanupState = CleanupState.IDLE;
  private hardResetInFlight = new Map<string, Promise<{ success: boolean; error?: string }>>();

  /**
   * Agent root PIDs that survived session cache eviction, split by liveness.
   *
   * When `interruptInMemorySession()` or `unregisterSession()` removes an
   * AgentSession from the cache, its tracked PIDs are no longer visible to
   * `getTrackedAgentRootPidsSplit()`. We snapshot them here so the process
   * watchdog retains ownership attribution.
   *
   * Live PIDs are tracked separately with their eviction timestamp so:
   * 1. `collectDescendantPids()` treats them as live roots while the
   *    process is still running (avoids false PID-reuse skips).
   * 2. When the process exits, they are promoted to exited for the
   *    PGID-based orphan discovery window.
   * 3. If a live root outlives the retention window it is removed,
   *    preventing PID-reuse misattribution for long-lived reused PIDs.
   */
  private evictedLiveRootPids = new Map<number, { evictedAt: number; startTime: number }>();
  private evictedExitedRootPids = new Map<number, number>();

  // Extracted modules
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

    // Initialize tools config manager
    this.toolsConfigManager = new ToolsConfigManager(db);

    // Factory function for creating AgentSession instances
    const createAgentSession = (session: Session): AgentSession =>
      this.createAgentSessionFromSession(session);

    // Initialize session cache with factory and loader
    this.sessionCache = new SessionCache(createAgentSession, (sessionId: string) =>
      this.db.getSession(sessionId)
    );

    // Initialize session lifecycle
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

    // Initialize message persistence with @ reference resolver
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

    // Setup InternalEventBus<DaemonInternalEventMap> subscribers for async message processing
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
    // Wire Space member/long-term self-heal at construction so it survives any
    // hydration path. `space-agent-tools` is an in-process MCP server (not
    // persisted); after a daemon restart it is gone, and the background reattach
    // sweep may not have reached this session before its first turn. Without
    // this, QueryRunner.ensureMemberSpaceMcpInvariant finds the server missing
    // AND no heal callback (the callback was previously wired only as a
    // side-effect of the attach it is meant to trigger) and hard-fails the turn.
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
        // A no-restart reset is an explicit stop boundary. Cancel every durable
        // turn/steer before replacing the cached AgentSession; otherwise the
        // processor resolves the fresh session and starts a new query for a
        // prompt the caller asked to keep stopped.
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

  /**
   * Register job handlers and start background processing.
   * Must be called after construction but before jobProcessor.start().
   * Throws if called more than once to catch accidental double-registration.
   */
  start(): void {
    if (this.started) {
      throw new Error('SessionManager.start() called more than once');
    }
    this.started = true;
    this.jobProcessor.register(SESSION_TITLE_GENERATION, (job) =>
      handleSessionTitleGeneration(job, this.sessionLifecycle)
    );
  }

  /**
   * Setup InternalEventBus<DaemonInternalEventMap> subscriptions for async message processing
   */
  private setupEventSubscriptions(): void {
    // Subscribe to message persisted events (for title generation + draft clearing)
    // AgentSession also subscribes to this event for query feeding
    const unsubMessagePersisted = this.internalEventBus.subscribe(
      'message.persisted',
      async (data) => {
        const { sessionId, userMessageText, needsWorkspaceInit, hasDraftToClear } = data;

        try {
          // STEP 1: Enqueue title generation job (if needed)
          // Only run if workspace initialization is needed (first message)
          if (needsWorkspaceInit) {
            this.jobQueue.enqueue({
              queue: SESSION_TITLE_GENERATION,
              payload: { sessionId, userMessageText },
              maxRetries: 2,
            });
          }

          // STEP 2: Clear the draft when the sent message consumed it. The
          // match is re-decided here from a FRESH read (the persistence-time
          // flag was computed from a pre-send snapshot): direct match clears
          // the typing only, while a composition match — the sent text equals
          // draft + staged voice joined whole — means the sender read the
          // composed draft and the voice went out in the message, so the
          // staging is consumed too. A typing-only sender never saw the
          // staged transcript and must not wipe it: it stays for the next
          // draft. No match → write nothing (a newer draft intervened).
          if (hasDraftToClear) {
            const beforeClear = this.getSessionFromDB(sessionId);
            const draft = beforeClear?.metadata?.inputDraft ?? '';
            const pending = beforeClear?.metadata?.inputDraftVoicePending ?? '';
            const directMatch = draft.trim() === (userMessageText ?? '').trim();
            let compositionMatch = false;
            if (!directMatch && pending.trim() !== '') {
              const composed = appendDraftText(draft, pending);
              const fitsWhole =
                composed === `${draft}${pending}` || composed === `${draft} ${pending}`;
              compositionMatch = fitsWhole && composed.trim() === (userMessageText ?? '').trim();
            }
            if (directMatch || compositionMatch) {
              await this.sessionLifecycle.update(sessionId, {
                metadata: {
                  inputDraft: null,
                  ...(compositionMatch ? { inputDraftVoicePending: null } : {}),
                },
              } as Partial<Session>);
            }
          }
        } catch (error) {
          this.logger.error(
            `[SessionManager] Error in post-persistence processing for session ${sessionId}:`,
            error
          );
          // Errors are non-fatal - the user message is already persisted and visible
        }
      },
      { subscriberName: 'SessionManager.messagePersisted' }
    );
    this.internalEventBusUnsubscribers.push(unsubMessagePersisted);

    // Recompute the effective MCP set for every active session when the
    // app-level MCP registry or skills change. The effective set (registry +
    // mcp_enablement overrides + skills) is recomputed inside each
    // AgentSession and pushed to its live query via setMcpServers, so an
    // enable/disable/update/remove applies to running sessions instead of only
    // taking effect on the next spawned session. Idle sessions (no live query)
    // pick the change up on their next turn's option rebuild.
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

  /**
   * Recompute and push the effective MCP-server set to every active session's
   * live query. Best-effort: a failure reconciling one session is logged and
   * does not abort the rest. Runtime-injected servers are preserved (they win
   * the merge inside `AgentSession.reconcileEffectiveMcpServers`).
   */
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

  // ==================== Session CRUD Operations ====================

  async createSession(params: CreateSessionParams): Promise<string> {
    return this.sessionLifecycle.create(params);
  }

  /**
   * Generate title and rename branch for a session
   * @deprecated Use sessionLifecycle.generateTitleAndRenameBranch directly
   */
  async generateTitleAndRenameBranch(
    sessionId: string,
    userMessageText: string
  ): Promise<{ title: string; isFallback: boolean }> {
    return this.sessionLifecycle.generateTitleAndRenameBranch(sessionId, userMessageText);
  }

  /**
   * @deprecated Use generateTitleAndRenameBranch instead
   * Kept for backward compatibility - now just calls generateTitleAndRenameBranch
   */
  async initializeSessionWorkspace(
    sessionId: string,
    userMessageText: string
  ): Promise<{ title: string; isFallback: boolean }> {
    return this.generateTitleAndRenameBranch(sessionId, userMessageText);
  }

  /**
   * Get session (with lazy-loading race condition fix)
   *
   * FIX: Prevents multiple simultaneous loads of the same session
   * which would create duplicate Claude API connections
   */
  getSession(sessionId: string): AgentSession | null {
    return this.sessionCache.get(sessionId);
  }

  getCachedSession(sessionId: string): AgentSession | null {
    return this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
  }

  /**
   * Late-bind the Space runtime MCP provider (breaks the construction-order
   * cycle: SpaceRuntimeService is built after SessionManager and itself takes
   * SessionManager). Mirrors `spaceRuntimeService.setTaskAgentManager(...)`.
   *
   * Once set, every AgentSession produced by this manager wires a self-heal
   * callback so it can recover its in-process `space-agent-tools` server on any
   * hydration path — notably right after a daemon restart, before the background
   * reattach sweep reaches it.
   */
  setSpaceRuntimeMcpProvider(provider: SpaceRuntimeMcpProvider): void {
    this.spaceRuntimeMcpProvider = provider;
  }

  /**
   * Get the session lifecycle manager.
   */
  getSessionLifecycle(): SessionLifecycle {
    return this.sessionLifecycle;
  }

  /**
   * Get the worktree manager (git detection, branch listing, worktree ops).
   */
  getWorktreeManager(): WorktreeManager {
    return this.worktreeManager;
  }

  /**
   * Get session asynchronously (preferred for concurrent access)
   *
   * FIX: Handles concurrent requests properly with locking
   */
  async getSessionAsync(sessionId: string): Promise<AgentSession | null> {
    return this.sessionCache.getAsync(sessionId);
  }

  /**
   * Register an externally-created AgentSession in the session cache.
   *
   * Used by TaskAgentManager to register Task Agent sessions created via
   * AgentSession.fromInit() so that getSessionAsync() returns the original
   * live instance (with MCP tools and active query) instead of creating a
   * duplicate from DB that would set up competing event subscriptions.
   */
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
    // Collect from sessions still in the cache.
    for (const [, agentSession] of this.sessionCache.entries()) {
      const split = agentSession.getTrackedAgentRootPidsSplit();
      live.push(...split.live);
      exited.push(...split.exited);
    }
    // Merge session-manager-level live PIDs that survived cache eviction.
    for (const pid of this.evictedLiveRootPids.keys()) {
      if (!live.includes(pid)) {
        live.push(pid);
      }
    }
    // Merge session-manager-level exited PIDs that survived cache eviction.
    for (const pid of this.evictedExitedRootPids.keys()) {
      if (!exited.includes(pid)) {
        exited.push(pid);
      }
    }
    return { live, exited };
  }

  /**
   * Remove an AgentSession from the session cache.
   *
   * Called when a session ends (e.g. room task completion) so that subsequent
   * getSessionAsync() calls fall through to DB loading rather than returning
   * a stale, already-cleaned-up instance.
   *
   * Also clears any in-flight load lock via SessionCache.remove(), preventing
   * a concurrent getAsync() from re-inserting the stale session after removal.
   *
   * Currently called by TaskAgentManager when a task agent session is torn down.
   * Space runtime callers will be added as that subsystem is wired up.
   */
  async unregisterSession(sessionId: string): Promise<void> {
    const agentSession = this.sessionCache.has(sessionId) ? this.sessionCache.get(sessionId) : null;
    if (agentSession) {
      await this.preserveRootPids(agentSession);
    }
    this.sessionCache.remove(sessionId);
  }

  /**
   * Inject a message into a session bypassing the RPC/UI message flow.
   *
   * Used for internal daemon-to-session communication (e.g. SpaceRuntime → global agent).
   * Delegates to MessagePersistence so the message is persisted to DB and the session
   * query is started/notified exactly like a user-sent message.
   */
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

  /**
   * Get session metadata directly from database without loading SDK
   * Used for operations that don't require SDK initialization (e.g., removing tool outputs)
   */
  getSessionFromDB(sessionId: string): Session | null {
    return this.sessionLifecycle.getFromDB(sessionId);
  }

  /**
   * Mark a message's tool output as removed from SDK session file
   * This updates the session metadata to track which outputs were deleted
   */
  async markOutputRemoved(sessionId: string, messageUuid: string): Promise<void> {
    return this.sessionLifecycle.markOutputRemoved(sessionId, messageUuid);
  }

  /**
   * Archive a session's external resources (worktree + SDK `.jsonl`) while
   * keeping the DB row and all `sdk_messages` intact.
   *
   * **UI-only invariant (Task #85):** every non-UI lifecycle event (task
   * done/cancelled, spawn rollback, workflow end, daemon shutdown, session
   * recovery, etc.) must preserve session data and must only interrupt the
   * in-memory SDK subprocess via {@link interruptInMemorySession}. This
   * method is callable exclusively from the two UI archive RPC paths —
   * `session.archive` and `task.archive`.
   */
  async archiveSessionResources(
    sessionId: string,
    trigger: ArchiveResourcesTrigger
  ): Promise<void> {
    return this.sessionLifecycle.archiveResources(sessionId, trigger);
  }

  /**
   * Fully delete a session's external resources AND its DB row
   * (cascades to `sdk_messages` via FK).
   *
   * **UI-only invariant (Task #85):** callable exclusively from the two UI
   * delete RPC paths — `session.delete` and `room.delete` (cascade). Any
   * other caller must use {@link interruptInMemorySession} instead.
   */
  async deleteSessionResources(sessionId: string, trigger: DeleteResourcesTrigger): Promise<void> {
    return this.sessionLifecycle.deleteResources(sessionId, trigger);
  }

  /**
   * Stop the in-memory SDK subprocess for a session and drop the cache
   * entry — WITHOUT touching the worktree, SDK `.jsonl` files, or the
   * `sessions` DB row.
   *
   * This is the primitive non-UI callers (TaskAgentManager cleanup,
   * spawn-rollback, space-runtime reconciliation, session recovery, ...) must
   * use instead of the old `deleteSession`. The next `getSessionAsync()`
   * will hydrate a fresh `AgentSession` from the DB row.
   */
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
      // Snapshot root PIDs AFTER cleanup so the retention window for
      // exited PIDs starts from the actual process exit time.
      // cleanup() awaits process exit, so live PIDs will have
      // transitioned to exited with real exit timestamps. Any
      // stubborn live roots that survive cleanup are preserved as
      // live so the watchdog tracks them correctly.
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

  /**
   * Snapshot live and exited root PIDs from an AgentSession before/after
   * it is removed from the session cache.
   *
   * Live PIDs are preserved as live so the watchdog tracks them correctly
   * (exited roots are skipped if the PID appears in the process snapshot).
   * Exited PIDs are preserved with their actual exit timestamp for the
   * 15-minute retention window.
   */
  private async preserveRootPids(agentSession: AgentSession): Promise<void> {
    const split = agentSession.getTrackedAgentRootPidsSplit();

    // Capture process start times from a contemporaneous snapshot so
    // the PID+startTime identity guard is effective from eviction time.
    // Without this, a PID reused before the first watchdog poll would
    // establish the wrong baseline identity.
    // Note: `now` is captured AFTER listProcesses() returns to avoid
    // skewing the startTime calculation when ps collection is slow.
    let startTimeByPid = new Map<number, number>();
    let now = Date.now();
    if (split.live.length > 0) {
      try {
        const snapshot = await listProcesses();
        now = Date.now(); // Re-capture after ps to avoid skew
        for (const snap of snapshot) {
          if (split.live.includes(snap.pid)) {
            startTimeByPid.set(snap.pid, now - snap.elapsedSeconds * 1000);
          }
        }
      } catch {
        // Process listing failed â start times remain unknown.
      }
    }

    // Preserve live PIDs as live so the watchdog can track them
    // as live roots (not exited) while the process is still running.
    // Only preserve when we have a valid identity baseline (startTime
    // from the process snapshot). Without it, expireEvictedRoots cannot
    // distinguish the real root from a reused PID, risking cross-process
    // attribution and kills.
    for (const pid of split.live) {
      const newStartTime = startTimeByPid.get(pid) ?? 0;
      const existing = this.evictedLiveRootPids.get(pid);
      if (existing) {
        // Refresh retention window on re-eviction. Only update startTime
        // when we have a valid baseline — a stale prior-generation
        // startTime is better than 0 (unknown), which would disable
        // identity verification until the next watchdog poll.
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
    // Preserve exited PIDs with their actual exit timestamp from the
    // AgentSession, not Date.now(), so the retention window reflects
    // real process exit time rather than eviction time.
    const exitTimestamps = agentSession.getExitedRootPidTimestamps();
    // Always update the exit timestamp so reused PIDs that exit
    // again get the latest exit time (Fix P2: stale timestamp on re-preservation).
    for (const [pid, exitedAt] of exitTimestamps) {
      this.evictedExitedRootPids.set(pid, exitedAt);
    }
  }

  private expireEvictedRoots(snapshot: ProcessSnapshot[] = [], now = Date.now()): void {
    // Build PID → snapshot lookup for identity verification.
    const snapshotByPid = new Map<number, ProcessSnapshot>();
    for (const snap of snapshot) snapshotByPid.set(snap.pid, snap);

    for (const [pid, meta] of this.evictedLiveRootPids) {
      // Expire entries past the retention window regardless.
      if (now - meta.evictedAt > RECENTLY_EXITED_ROOT_PID_RETENTION_MS) {
        this.evictedLiveRootPids.delete(pid);
        continue;
      }

      // Without a real snapshot we cannot reliably determine whether
      // the process is still running or the PID was reused, so we skip
      // live-root promotion to avoid false attribution.
      if (snapshot.length === 0) continue;

      const snap = snapshotByPid.get(pid);
      if (!snap) {
        // PID absent from snapshot → process exited.
        // Promote to exited for PGID-based orphan discovery.
        this.evictedLiveRootPids.delete(pid);
        // Always overwrite with latest exit time so reused PIDs
        // that exit again get the full retention window.
        this.evictedExitedRootPids.set(pid, now);
        continue;
      }

      // PID exists in snapshot — verify identity via start time.
      // (startTime is always > 0 because preserveRootPids skips
      // entries without a valid identity baseline.)
      const currentStartTime = now - snap.elapsedSeconds * 1000;
      if (Math.abs(currentStartTime - meta.startTime) > 1000) {
        // Start time changed by >1s → PID was reused by a different process.
        // Remove to prevent cross-process attribution.
        this.evictedLiveRootPids.delete(pid);
        continue;
      }
      // Identity verified — keep as live.
    }

    // Expire old exited roots past the retention window.
    for (const [pid, exitedAt] of this.evictedExitedRootPids) {
      if (now - exitedAt > RECENTLY_EXITED_ROOT_PID_RETENTION_MS) {
        this.evictedExitedRootPids.delete(pid);
      }
    }
  }

  // ==================== Tools Configuration ====================

  /**
   * Get the global tools configuration
   */
  getGlobalToolsConfig() {
    return this.toolsConfigManager.getGlobal();
  }

  /**
   * Save the global tools configuration
   */
  saveGlobalToolsConfig(config: ReturnType<typeof this.toolsConfigManager.getGlobal>) {
    this.toolsConfigManager.saveGlobal(config);
  }

  // ==================== Cleanup ====================

  /**
   * Cleanup all sessions (called during shutdown)
   *
   * Uses a state machine to prevent race conditions:
   * - IDLE → CLEANING: Sets barrier
   * - CLEANING: Executes cleanup in phases
   * - CLEANING → CLEANED: Final state, no more operations allowed
   *
   * If cleanup fails, state returns to IDLE to allow retry.
   *
   * Title generation jobs are drained by the job processor (stopped in app.ts
   * before sessionManager.cleanup() is called), not here.
   */
  async cleanup(): Promise<void> {
    // State check: prevent concurrent cleanup
    if (this.cleanupState !== CleanupState.IDLE) {
      return;
    }

    // Transition to CLEANING state
    this.cleanupState = CleanupState.CLEANING;

    try {
      // PHASE 1: Unsubscribe from InternalEventBus<DaemonInternalEventMap> FIRST
      // This prevents new events from being processed during cleanup
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

      // PHASE 2: Cleanup all in-memory sessions in parallel
      // CRITICAL: Each AgentSession.cleanup() now properly stops SDK queries
      // with lifecycle manager, ensuring subprocesses exit before we continue
      const cleanupPromises: Promise<void>[] = [];
      for (const [sessionId, agentSession] of this.sessionCache.entries()) {
        cleanupPromises.push(
          agentSession.cleanup().catch((error) => {
            this.logger.error(`[SessionManager] Error cleaning up session ${sessionId}:`, error);
          })
        );
      }

      // Wait for all cleanups to complete
      await Promise.all(cleanupPromises);

      // Clear session cache
      this.sessionCache.clear();
      this.hardResetInFlight.clear();

      // Transition to CLEANED state
      this.cleanupState = CleanupState.CLEANED;
    } catch (error) {
      // On failure, rollback to IDLE to allow retry
      this.cleanupState = CleanupState.IDLE;
      this.logger.error(`[SessionManager] Cleanup failed, state rolled back to IDLE:`, error);
      throw error;
    }
  }

  /**
   * Get the current cleanup state (useful for testing/diagnostics)
   */
  getCleanupState(): CleanupState {
    return this.cleanupState;
  }

  /**
   * Manually cleanup orphaned worktrees in a workspace.
   * Callers must supply an explicit path — no global fallback here.
   * Returns array of cleaned up worktree paths.
   */
  async cleanupOrphanedWorktrees(workspacePath: string): Promise<string[]> {
    return await this.worktreeManager.cleanupOrphanedWorktrees(workspacePath);
  }

  /**
   * Get the database instance
   * Used by RPC handlers that need direct DB access for query mode operations
   */
  getDatabase(): Database {
    return this.db;
  }
}
