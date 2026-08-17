/**
 * QueryLifecycleManager - Manages SDK query lifecycle operations
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Stopping message queue
 * - Interrupting current query
 * - Waiting for query termination
 * - Clearing query state
 * - Starting fresh query
 * - Full reset with cost tracking, state management, and client notification
 */

import type { MessageContent, Session, MessageHub, HyperNeoActionMessage } from '@hyperneo/shared';
import type { QueryLike } from './query-like';
import { generateUUID } from '@hyperneo/shared';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { SDKMessageHandler } from './sdk-message-handler';
import type { InterruptHandler } from './interrupt-handler';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { ErrorManager } from '../error-manager';
import { ErrorCategory } from '../error-manager';
import { Logger } from '../logger';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { throwIfDeliveryAborted, waitForDeliveryAbort } from './message-delivery';
import {
  validateAndRepairSDKSession,
  findSDKSessionFileGlobally,
  migrateSDKSessionFile,
  getSDKSessionFilePath,
} from '../sdk-session-file-manager';

const DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
const RESET_TERMINATION_TIMEOUT_MS = 3000;
const FORCE_PROCESS_KILL_DELAY_MS = 2000;
const MAX_TIMEOUT_DELIVERY_RETRIES = 1;

export type EnsureQueryStartedResult = 'started' | 'already-running' | 'blocked';

/**
 * Context interface - what QueryLifecycleManager needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface QueryLifecycleManagerContext {
  readonly session: Session;
  readonly messageQueue: MessageQueue;
  readonly db: Database;
  readonly messageHub: MessageHub;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly stateManager: ProcessingStateManager;
  readonly messageHandler: SDKMessageHandler;
  readonly interruptHandler: InterruptHandler;
  readonly errorManager: ErrorManager;

  // Mutable query state
  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;
  firstMessageReceived: boolean;
  /** Resolves when the SDK subprocess exits. Used by stop() to wait deterministically. */
  processExitedPromise: Promise<void> | null;
  /** Clear processExitedPromise and any stale no-PID exit promises. */
  resetProcessExitedPromise(): void;
  /** SDK startup timeout timer — must be cleared during stop() to prevent stale timers. */
  startupTimeoutTimer: ReturnType<typeof setTimeout> | null;
  /** Abort controller for the current query — must be cleared during stop(). */
  queryAbortController: AbortController | null;
  terminateTrackedAgentProcesses(options?: {
    forceDelayMs?: number;
    processes?: Array<[number, import('./query-runner').TrackedAgentProcess]>;
    noPidProcesses?: unknown[];
  }): void;
  snapshotTrackedAgentProcesses(): Array<[number, import('./query-runner').TrackedAgentProcess]>;
  /** Snapshot the durable no-PID tracked handles (VM/container/remote spawns). */
  snapshotNoPidTrackedProcesses?(): unknown[];
  /**
   * Re-derive the aggregated exit-wait promise from the current tracked
   * handles. A prior resetProcessExitedPromise() may have nulled the
   * aggregate while a retained (still-live) orphan handle exists; without a
   * refresh, a reader would see null and skip waiting on that orphan.
   */
  refreshProcessExitedPromise?(): void;

  // Mutable session state
  pendingRestartReason: 'settings.local.json' | null;

  // Method to start the streaming query
  startStreamingQuery(): Promise<void>;

  // Cleanup support
  setCleaningUp(value: boolean): void;
  cleanupEventSubscriptions(): void;
  clearModelsCache(): Promise<void>;
  /**
   * True when a rate-limit recovery episode that captured `generation` has since
   * been superseded by cancel()/reset(). The lifecycle re-checks this inside
   * startQueryAndEnqueue (after its internal awaits) so a cancel during query
   * startup can't let a recovery re-enqueue commit the stale message. Optional:
   * undefined on the genuine-new-user-input path (no recovery episode to guard).
   */
  isRateLimitEpisodeSuperseded?(generation: number): boolean;
}

export class QueryLifecycleManager {
  private logger: Logger;
  private timeoutDeliveryRetryCounts = new Map<string, number>();

  constructor(private ctx: QueryLifecycleManagerContext) {
    this.logger = new Logger(`QueryLifecycleManager ${ctx.session.id}`);
  }

  private clearAcpSessionStateForReset(): void {
    const { session, db } = this.ctx;
    if (session.config.provider !== 'acp') return;

    const updates: Partial<Session> = {};
    if (session.acpSessionId) {
      session.acpSessionId = undefined;
      updates.acpSessionId = undefined;
    }
    if (session.metadata?.acpInstructionsSent) {
      session.metadata = {
        ...session.metadata,
        acpInstructionsSent: undefined,
      };
      updates.metadata = session.metadata;
    }

    if (Object.keys(updates).length > 0) {
      db.updateSession(session.id, updates);
    }
  }

  /**
   * Get the effective workspace path for SDK session file lookups.
   *
   * The SDK subprocess uses its CWD to determine the project directory
   * for session files. For worktree sessions, the CWD is the worktree path,
   * not session.workspacePath (which is the main repo path).
   * Must match QueryOptionsBuilder.getCwd() to find the correct files.
   */
  private getSDKWorkspacePath(): string {
    const { session } = this.ctx;
    return session.worktree
      ? session.worktree.worktreePath
      : (session.workspacePath ?? process.cwd());
  }

  /**
   * Ensure the SDK session file is accessible at the current workspace path.
   *
   * When the effective CWD changes between daemon restarts (e.g. a worktree is
   * added or removed), the SDK session file may still live under the OLD project
   * directory. This method:
   *
   * 1. Checks whether the file already exists at the CURRENT workspace path → done.
   * 2. Tries sdkOriginPath (persisted CWD at session-init time) if it differs.
   * 3. Falls back to a global scan of ~/.claude/projects/ to locate the file.
   * 4. When found elsewhere, copies the file to the current workspace's project dir
   *    so the SDK subprocess (which starts with cwd=current) can find it, then
   *    updates sdkOriginPath in the DB to reflect the new canonical location.
   *
   * Non-destructive: the original file is never deleted.
   *
   * @returns true if the file is now present at the current workspace path, false
   *          if it cannot be located and the session must start fresh.
   */
  private ensureSDKSessionFileMigrated(): boolean {
    const { session, db } = this.ctx;
    if (!session.sdkSessionId) return false;

    const currentWorkspacePath = this.getSDKWorkspacePath();

    // Fast path: file already at the correct location
    const currentFilePath = getSDKSessionFilePath(currentWorkspacePath, session.sdkSessionId);
    if (existsSync(currentFilePath)) {
      // If sdkOriginPath was never recorded (sessions predating this fix), set it now.
      if (!session.sdkOriginPath) {
        session.sdkOriginPath = currentWorkspacePath;
        db.updateSession(session.id, { sdkOriginPath: currentWorkspacePath });
      }
      return true;
    }

    // Try the persisted origin path first (common case after worktree assignment)
    if (session.sdkOriginPath && session.sdkOriginPath !== currentWorkspacePath) {
      const migrated = migrateSDKSessionFile(
        session.sdkOriginPath,
        currentWorkspacePath,
        session.sdkSessionId
      );
      if (migrated) {
        this.logger.info(
          `SDK session file migrated from ${session.sdkOriginPath} → ${currentWorkspacePath} ` +
            `(sdkSessionId: ${session.sdkSessionId})`
        );
        // Update origin to reflect new canonical location
        session.sdkOriginPath = currentWorkspacePath;
        db.updateSession(session.id, { sdkOriginPath: currentWorkspacePath });
        return true;
      }
    }

    // Global fallback: scan all ~/.claude/projects/ directories
    const foundFilePath = findSDKSessionFileGlobally(session.sdkSessionId);
    if (foundFilePath) {
      // Copy from wherever it was found to the current workspace's project dir
      try {
        const targetDir = dirname(currentFilePath);
        mkdirSync(targetDir, { recursive: true });
        copyFileSync(foundFilePath, currentFilePath);
        this.logger.info(
          `SDK session file recovered via global scan: ${foundFilePath} → ${currentFilePath} ` +
            `(sdkSessionId: ${session.sdkSessionId})`
        );
        session.sdkOriginPath = currentWorkspacePath;
        db.updateSession(session.id, { sdkOriginPath: currentWorkspacePath });
        return true;
      } catch (err) {
        this.logger.warn(`Failed to copy SDK session file from global scan result: ${err}`);
      }
    }

    // File not found anywhere
    return false;
  }

  /**
   * Validate and repair the SDK session file, with cross-path migration as a
   * pre-step when the effective CWD has changed since the session was created.
   *
   * Returns true when the session is ready to resume.
   */
  private validateAndRepairWithMigration(): boolean {
    const { session, db } = this.ctx;
    if (!session.sdkSessionId) return false;

    // Migrate the file to current workspace if needed
    const fileFound = this.ensureSDKSessionFileMigrated();

    if (!fileFound) {
      this.logger.warn(
        `SDK session file not found anywhere for sdkSessionId=${session.sdkSessionId}. ` +
          'Will attempt resume anyway — the SDK may produce a "No conversation found" error ' +
          'and start fresh automatically.'
      );
      return false;
    }

    // File is now at the current workspace — validate/repair as usual
    return validateAndRepairSDKSession(
      this.getSDKWorkspacePath(),
      session.sdkSessionId,
      session.id,
      db
    );
  }

  /**
   * Stop the current query
   *
   * Shared logic for restart and reset operations:
   * 1. Stop message queue
   * 2. Interrupt current query
   * 3. Wait for termination (with timeout)
   * 4. Clear query references
   */
  async stop(options?: { timeoutMs?: number; catchQueryErrors?: boolean }): Promise<void> {
    const { timeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS, catchQueryErrors = false } = options ?? {};
    const { messageQueue } = this.ctx;

    // Snapshot BEFORE awaiting — runQuery()'s finally block clears ctx.processExitedPromise
    // during queryPromise settlement, so capture it here while it's still set.
    const processExitedPromise = this.ctx.processExitedPromise;
    // Snapshot tracked processes before awaiting so that terminateTrackedAgentProcesses
    // only signals processes belonging to THIS query, not a concurrently started new one.
    // Includes the durable no-PID handles (VM/container/remote spawns).
    const trackedProcessSnapshot = this.ctx.snapshotTrackedAgentProcesses();
    const noPidProcessSnapshot = this.ctx.snapshotNoPidTrackedProcesses?.() ?? [];

    // 1. Stop the message queue (no new messages processed)
    messageQueue.stop();

    // 2. Interrupt current query (only if transport is ready)
    // ProcessTransport must be ready before calling interrupt() - otherwise we get
    // "ProcessTransport is not ready for writing" error that corrupts session state
    const queryObject = this.ctx.queryObject;
    if (queryObject && typeof queryObject.interrupt === 'function') {
      if (this.ctx.firstMessageReceived) {
        try {
          await queryObject.interrupt();
        } catch {
          // Continue - query might already be stopped
        }
      }
      // Else: Transport not ready - skip interrupt, just clear references
    }

    // 3. Wait for termination
    const queryPromise = this.ctx.queryPromise;
    if (queryPromise) {
      try {
        const promiseToAwait = catchQueryErrors
          ? queryPromise.catch(() => {
              // Ignore errors during cleanup
            })
          : queryPromise;

        await Promise.race([
          promiseToAwait,
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch {
        // Ignore errors during termination
      }
    }

    // 4. Ask the tracked SDK process group to terminate. queryObject.close()
    // kills the direct SDK child, but detached process-group cleanup also reaches
    // tool grandchildren (bun test, make dev, etc.) that would otherwise survive.
    this.ctx.terminateTrackedAgentProcesses({
      forceDelayMs: FORCE_PROCESS_KILL_DELAY_MS,
      processes: trackedProcessSnapshot,
      noPidProcesses: noPidProcessSnapshot,
    });

    // 5. Close query only if runQuery()'s finally block has not already done so.
    // When queryPromise resolves normally, the finally block ran during the await
    // above: it called close() and nulled ctx.queryObject. Check the live reference
    // against our local snapshot — if they differ (null or new query), skip close()
    // to avoid a redundant double-call. Only close when the promise timed out
    // (finally block has not run yet, subprocess is still alive).
    if (queryObject && this.ctx.queryObject === queryObject) {
      try {
        queryObject.close();
      } catch {
        // Ignore close errors — subprocess may already be terminated
      }
    }

    // 6. Wait for the SDK subprocess to fully exit after close().
    // close() sends SIGTERM but the process may take time to clean up.
    // Without this, starting a new subprocess immediately can fail because
    // the old process still holds workspace locks (.claude/ files).
    // Uses the local snapshot captured at the top — ctx.processExitedPromise may
    // have already been cleared by runQuery()'s finally block during queryPromise
    // settlement above (the race condition this snapshot was introduced to fix).
    if (processExitedPromise) {
      await Promise.race([
        processExitedPromise,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      this.ctx.resetProcessExitedPromise();
    }

    // 7. Clear stale startup timer and abort controller.
    // The old runQuery()'s finally block normally clears these, but if stop()
    // timed out waiting for queryPromise, finally hasn't run yet. Leaving them
    // alive is dangerous: the old timer's closure reads this.ctx.firstMessageReceived
    // and this.ctx.queryAbortController at fire time. When restart() starts a new
    // query that resets firstMessageReceived=false and creates a new abort controller,
    // the stale timer fires, sees firstMessageReceived=false, and ABORTS THE NEW
    // QUERY'S controller — causing immediate startup-timeout errors after model switch.
    const staleTimer = this.ctx.startupTimeoutTimer;
    if (staleTimer) {
      clearTimeout(staleTimer);
      this.ctx.startupTimeoutTimer = null;
    }
    const staleAbort = this.ctx.queryAbortController;
    if (staleAbort) {
      this.ctx.queryAbortController = null;
    }

    // 8. Clear references
    this.ctx.queryObject = null;
    this.ctx.queryPromise = null;
  }

  /**
   * Restart the query (stop + start)
   *
   * Used when model switching or MCP settings change.
   * Clears error state and resets circuit breaker to ensure the new query
   * starts cleanly without stale error artifacts from the interrupted query.
   */
  async restart(): Promise<void> {
    const { session, internalEventBus, messageHandler } = this.ctx;
    // True once the old query is stopped AND the suppressed idle is reached. A
    // failure before this point leaves the original SDK query still running, so
    // releasing the waiter would free the active-turn slot mid-turn; only
    // release if we suppressed the drain (old query stopped) but then failed to
    // establish a replacement. (Codex P1.)
    let reachedSuppressedIdle = false;

    try {
      // Clear error state and circuit breaker before stopping.
      // The interrupt during stop() may produce transient errors that should
      // not persist into the new query's lifecycle.
      messageHandler.resetCircuitBreaker();
      await internalEventBus.publish('session.errorClear', { sessionId: session.id });

      // stop() now awaits processExitedPromise, so the old SDK subprocess is
      // guaranteed to have exited before we proceed. No arbitrary delay needed.
      await this.stop();

      // Explicitly reset to idle after stop(). If stop() timed out waiting for
      // the old queryPromise, the old query's finally block may run AFTER the
      // new query increments the generation — triggering the stale-query guard
      // and skipping setIdle(). This explicit call guarantees clean state.
      await this.ctx.stateManager.setIdle({ suppressDeliveryWaiters: true });
      reachedSuppressedIdle = true;

      // Validate and repair SDK session file before restarting.
      // Includes cross-path migration when effective CWD changed since session init.
      // The interrupted query may have left the session file in an inconsistent state
      // (e.g., orphaned tool_results from interrupted SDK context compaction).
      // Also detects stale sdkSessionId when the session file no longer exists.
      if (session.config.provider !== 'acp' && session.sdkSessionId) {
        const isValid = this.validateAndRepairWithMigration();
        if (!isValid) {
          // Do NOT silently clear sdkSessionId — the user may be able to recover
          // the session (e.g., transient FS issue, or future DB-restore feature).
          // Emit the sdkResumeChoice prompt so the user can choose to start fresh.
          // Unlike ensureQueryStarted() (which blocks until the user responds),
          // restart() must always call startStreamingQuery() because:
          //   1. The model switch/settings change needs to take effect.
          //   2. If the user later picks "leave_as_is", the RPC handler calls
          //      restart() again — blocking here would create an infinite loop.
          // The SDK handles the missing session file gracefully (errors with
          // "No conversation found", caught by query-runner's error handling).
          this.logger.warn(
            `SDK session file missing/invalid for ${session.sdkSessionId}. ` +
              'Emitting sdk_resume_choice for user, but starting query anyway.'
          );
          await this.emitSdkResumeChoiceMessage();
        }
      }

      // Clear models cache to ensure the new model is fetched fresh from DB
      // This is critical for model switch to pick up the correct model
      await this.ctx.clearModelsCache();

      await this.ctx.startStreamingQuery();
    } catch (error) {
      // restart failed BEFORE a replacement query was established (validation,
      // cache clear, or startStreamingQuery threw). Only release the suppressed
      // waiter if the old query was already stopped (reachedSuppressedIdle) — a
      // failure before stop() (e.g. a session.errorClear subscriber rejecting at
      // the publish above) leaves the original SDK query running, and releasing
      // would complete the delivery job + free the active-turn slot mid-turn.
      // (Codex P1.)
      if (reachedSuppressedIdle) {
        this.ctx.stateManager.releaseIdleWaiters();
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Query restart failed: ${errorMessage}`);
    }
  }

  /**
   * Full reset with additional cleanup
   *
   * Used for user-initiated "Reset Agent" that needs to:
   * - Clear pending messages
   * - Reset circuit breaker
   * - Preserve cost tracking
   * - Notify clients
   *
   * @returns Result indicating success or failure
   */
  async reset(options?: { restartAfter?: boolean }): Promise<{ success: boolean; error?: string }> {
    const { restartAfter = true } = options ?? {};
    const {
      session,
      db,
      messageQueue,
      messageHub,
      internalEventBus,
      stateManager,
      messageHandler,
    } = this.ctx;

    // Early return if no query is running
    if (!this.ctx.queryObject && !this.ctx.queryPromise) {
      messageQueue.clear();
      this.ctx.pendingRestartReason = null;
      messageHandler.resetCircuitBreaker();
      this.clearAcpSessionStateForReset();
      await stateManager.setIdle();
      // Clear models cache to ensure fresh model info is fetched from DB
      await this.ctx.clearModelsCache();
      return { success: true };
    }

    // True once the old query is stopped AND the suppressed idle is reached (a
    // restartAfter reset). A failure after this leaves the durable turn waiter
    // pending (the suppress deferred its drain to the restart) — release it in
    // the catch so it doesn't hang `processing`. (Codex P1.)
    let reachedSuppressedIdle = false;

    try {
      // Pre-stop: Preserve cost tracking
      const lastSdkCost = session.metadata?.lastSdkCost || 0;
      const costBaseline = session.metadata?.costBaseline || 0;
      if (lastSdkCost > 0) {
        session.metadata = {
          ...session.metadata,
          costBaseline: costBaseline + lastSdkCost,
          lastSdkCost: 0,
        };
        db.updateSession(session.id, { metadata: session.metadata });
      }

      // Pre-stop: Clear pending messages and reset flags
      messageQueue.clear();
      this.ctx.pendingRestartReason = null;
      messageHandler.resetCircuitBreaker();
      this.clearAcpSessionStateForReset();
      await internalEventBus.publish('session.errorClear', { sessionId: session.id });

      // Stop the query with shorter timeout and catch errors
      await this.stop({
        timeoutMs: RESET_TERMINATION_TIMEOUT_MS,
        catchQueryErrors: true,
      });

      // Post-stop: Reset state. Suppress the delivery-waiter drain ONLY when a
      // restart follows (this is a retry mid-point — the query is re-started
      // below). When restartAfter is false the reset is TERMINAL (no
      // startStreamingQuery): the turn that was driving a durable job is
      // abandoned, so its turn-end waiter MUST drain here or driveDeliveryTurn
      // hangs forever (the job keeps heartbeating `processing`, blocking the
      // active-turn slot). (Codex P1.)
      this.ctx.firstMessageReceived = false;
      await stateManager.setIdle({ suppressDeliveryWaiters: restartAfter });
      reachedSuppressedIdle = true;

      // Clear models cache to ensure fresh model info is fetched from DB
      // This is critical for model switch to pick up the new model
      await this.ctx.clearModelsCache();

      // Optionally restart
      if (restartAfter) {
        // No delay needed — stop() snapshots processExitedPromise before awaiting
        // queryPromise, so the old SDK subprocess is guaranteed to have exited
        // before we proceed (even if runQuery()'s finally block already cleared
        // ctx.processExitedPromise during queryPromise settlement).

        // Validate and repair SDK session file before restarting.
        // Includes cross-path migration when effective CWD changed since session init.
        if (session.config.provider !== 'acp' && session.sdkSessionId) {
          const isValid = this.validateAndRepairWithMigration();
          if (!isValid) {
            // Do NOT silently clear sdkSessionId — surface to user for manual
            // recovery choice (start fresh vs keep session). See restart()
            // for the same pattern. Always call startStreamingQuery() — blocking
            // here would break the leave_as_is path (infinite re-prompt loop).
            this.logger.warn(
              `SDK session file missing/invalid for ${session.sdkSessionId}. ` +
                'Emitting sdk_resume_choice for user, but starting query anyway.'
            );
            await this.emitSdkResumeChoiceMessage();
          }
        }

        await this.ctx.startStreamingQuery();
      }

      // Post-restart: Notify clients
      messageHub.event(
        'session.reset',
        { message: 'Agent has been reset and is ready for new messages' },
        { channel: `session:${session.id}` }
      );

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Query reset failed:', error);
      // A restartAfter reset suppressed the waiter drain (the restart owns it);
      // if the replacement startup then failed, release the waiter so the
      // durable turn doesn't hang `processing` and block the active-turn slot.
      // (Mirrors restart()'s failure path. Codex P1.)
      if (restartAfter && reachedSuppressedIdle) {
        this.ctx.stateManager.releaseIdleWaiters();
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Emit a HyperNeo action message asking the user what to do when the SDK
   * transcript file cannot be found.
   *
   * The action message is persisted to the DB and broadcast via the
   * state.sdkMessages.delta event so it appears in the chat timeline.
   * The query stays blocked; startStreamingQuery() is NOT called here.
   */
  private async emitSdkResumeChoiceMessage(): Promise<boolean> {
    const { session, db, messageHub } = this.ctx;

    // Dedupe: under message-delivery v2 a blocked turn job is parked + re-claimed
    // every few seconds, re-running ensureQueryStarted → here. Skip emitting a
    // FRESH card when an unresolved sdk_resume_choice already exists (otherwise
    // ~12 duplicate cards/min). Falls through (emit) when the repo isn't wired
    // (partial-mock contexts). See message-delivery-v2.md §8 + review P2.
    const messageRepo = db.getSDKMessageRepo?.();
    if (messageRepo?.hasUnresolvedHyperNeoAction?.(session.id, 'sdk_resume_choice')) {
      return true;
    }

    const actionMessage: HyperNeoActionMessage = {
      type: 'hyperneo_action',
      uuid: generateUUID(),
      session_id: session.id,
      action: 'sdk_resume_choice',
      resolved: false,
      timestamp: Date.now(),
    };

    db.saveHyperNeoActionMessage(session.id, actionMessage);

    if (
      messageRepo?.hasUnresolvedHyperNeoAction &&
      !messageRepo.hasUnresolvedHyperNeoAction(session.id, 'sdk_resume_choice')
    ) {
      return false;
    }

    messageHub.event(
      'state.sdkMessages.delta',
      { added: [actionMessage], timestamp: Date.now() },
      { channel: `session:${session.id}` }
    );
    return true;
  }

  /**
   * Ensure query is started
   *
   * Waits for any pending interrupt, validates SDK session file,
   * and starts the streaming query if not already running.
   *
   * Detects stale running state: if messageQueue.isRunning() is true but
   * queryPromise is null, the queue was not properly stopped after the previous
   * query ended (race between SDK query completion and finally block cleanup).
   * In this case, force-stop the queue and restart.
   */
  async ensureQueryStarted(signal?: AbortSignal): Promise<EnsureQueryStartedResult> {
    const { session, messageQueue, interruptHandler } = this.ctx;
    throwIfDeliveryAborted(signal);

    // Wait for any pending interrupt
    const interruptPromise = interruptHandler.getInterruptPromise();
    if (interruptPromise) {
      const aborted = waitForDeliveryAbort(signal);
      try {
        await Promise.race([
          interruptPromise.catch(() => {}),
          new Promise((r) => setTimeout(r, 5000)),
          aborted.promise,
        ]);
      } finally {
        aborted.cancel();
      }
    }

    if (messageQueue.isRunning()) {
      // Defensive stale state detection: if the queue thinks it's running but
      // there's no active query promise, the session is in an inconsistent state
      // (e.g., restored session with stale queue flag, or cleanup was interrupted).
      // The primary race (between for-await loop ending and finally block cleanup)
      // is handled by the early messageQueue.stop() in QueryRunner.runQuery().
      // This check catches residual edge cases where queryPromise has already
      // been nulled but the queue wasn't stopped.
      if (!this.ctx.queryPromise) {
        // Delivery observability: include the tracked-PID set in the stale-state
        // warning — a non-empty set here means an orphaned SDK subprocess was
        // alive while the queue had no consumer, the collision that produces
        // 0-message startup timeouts.
        const stalePids = this.ctx
          .snapshotTrackedAgentProcesses()
          .map(([pid]) => pid)
          .join(',');
        this.logger.warn(
          `Stale running state detected for session ${session.id}: ` +
            `messageQueue.isRunning()=true but queryPromise=null ` +
            `(trackedPids=[${stalePids}] queueSize=${messageQueue.size()}). ` +
            'Force-stopping and restarting.'
        );
        messageQueue.stop();
        // Clear stale query reference to prevent concurrent callers from
        // seeing a dead query object during the restart window.
        this.ctx.queryObject = null;

        // Clean-slate guard: the stale-running state usually means the SDK
        // subprocess died without the queue being stopped — but the process may
        // also be an orphan (spawned, never fed) still holding the workspace
        // lock. Force-terminate the tracked set so the fresh query spawned below
        // does not collide with a surviving subprocess, and wait (bounded) for it
        // to exit before starting the replacement. Mirrors stop()'s ordering.
        const orphanedProcesses = this.ctx.snapshotTrackedAgentProcesses();
        const orphanedNoPidProcesses = this.ctx.snapshotNoPidTrackedProcesses?.() ?? [];
        this.ctx.terminateTrackedAgentProcesses({
          forceDelayMs: FORCE_PROCESS_KILL_DELAY_MS,
          processes: orphanedProcesses,
          noPidProcesses: orphanedNoPidProcesses,
        });
        // Refresh the aggregate before reading it: a prior
        // resetProcessExitedPromise() may have nulled it while a retained
        // no-PID orphan (signaled above) is still alive — without the refresh
        // the bounded wait below reads null and skips waiting on that orphan.
        // (Codex P2, PR #2491.)
        this.ctx.refreshProcessExitedPromise?.();
        const orphanExit = this.ctx.processExitedPromise;
        if (orphanExit) {
          const aborted = waitForDeliveryAbort(signal);
          try {
            await Promise.race([
              orphanExit,
              new Promise((resolve) => setTimeout(resolve, DEFAULT_TERMINATION_TIMEOUT_MS)),
              aborted.promise,
            ]);
          } finally {
            aborted.cancel();
          }
          // Clear the exit tracking ONLY if it still belongs to the orphan. A
          // concurrent ensureQueryStarted() that saw the queue stopped during
          // our await may have already started the replacement query, whose
          // trackAgentProcess() installed a NEW processExitedPromise — clearing
          // that would drop the replacement's exit tracking and re-open the
          // workspace-lock collision this guard exists to close. (Codex P1.)
          if (this.ctx.processExitedPromise === orphanExit) {
            this.ctx.resetProcessExitedPromise();
          }
        }
        // Fall through to start a fresh query below
      } else {
        this.logger.debug(
          `ensureQueryStarted: session ${session.id} already running, skipping start`
        );
        return 'already-running';
      }
    } else {
      this.logger.debug(`ensureQueryStarted: session ${session.id} not running, starting query`);
    }

    throwIfDeliveryAborted(signal);

    // Validate SDK session file, migrating it to the current workspace path if needed.
    if (session.config.provider !== 'acp' && session.sdkSessionId) {
      const isValid = this.validateAndRepairWithMigration();
      if (!isValid) {
        // Transcript file not found — ask the user before proceeding.
        // Do NOT call startStreamingQuery() here; the query stays blocked until
        // the user responds via the session.sdkResumeChoice RPC handler.
        this.logger.warn(
          `SDK session file missing for sdkSessionId=${session.sdkSessionId}. ` +
            'Emitting sdk_resume_choice action message for user.'
        );
        const recoveryPromptAvailable = await this.emitSdkResumeChoiceMessage();
        if (!recoveryPromptAvailable) {
          throw new Error(
            `Unable to start session: SDK transcript ${session.sdkSessionId} is missing ` +
              'and the recovery prompt could not be persisted.'
          );
        }
        return 'blocked';
      }
    }

    // Clear models cache to ensure fresh model info is fetched from DB
    // This handles the edge case where model was changed in DB directly
    await this.ctx.clearModelsCache();
    throwIfDeliveryAborted(signal);

    await this.ctx.startStreamingQuery();
    throwIfDeliveryAborted(signal);
    return 'started';
  }

  /**
   * Start query and enqueue message
   *
   * Ensures query is started, sets queued state, and enqueues the message.
   * Handles async delivery errors with automatic retry for timeout errors.
   */
  async startQueryAndEnqueue(
    messageId: string,
    messageContent: string | MessageContent[],
    episodeGeneration?: number
  ): Promise<void> {
    const { session, messageQueue, stateManager, internalEventBus } = this.ctx;

    const queryStartResult = await this.ensureQueryStarted();
    // A rate-limit recovery episode may have been superseded (cancel/reset) during
    // ensureQueryStarted's awaits (or the switch teardown before it). Re-check
    // before setting queued / enqueuing so the stale message can't commit into
    // the replacement query. Opt-in: only recovery passes episodeGeneration;
    // genuine new user input (undefined) is unaffected.
    if (
      episodeGeneration !== undefined &&
      this.ctx.isRateLimitEpisodeSuperseded?.(episodeGeneration)
    ) {
      this.logger.info(
        `startQueryAndEnqueue: aborting enqueue of ${messageId} ` +
          `(rate-limit episode superseded during query startup).`
      );
      return;
    }
    if (queryStartResult === 'blocked') {
      await stateManager.setQueued(messageId);
      this.logger.debug(
        `startQueryAndEnqueue: session ${session.id} is blocked on sdk_resume_choice; ` +
          `leaving message ${messageId} persisted as enqueued for replay after the choice.`
      );
      return;
    }
    if (!messageQueue.isRunning() || !this.ctx.queryPromise) {
      throw new Error('Agent query did not start; message remains queued for retry.');
    }
    await stateManager.setQueued(messageId);

    try {
      void messageQueue
        .enqueueWithId(messageId, messageContent)
        .catch((error) => this.handleQueuedMessageFailure(messageId, messageContent, error))
        .catch((handlerError) => {
          this.logger.warn('Failed to handle queued message delivery error', handlerError);
        });
    } catch (error) {
      await this.handleQueuedMessageFailure(messageId, messageContent, error);
      throw error;
    }

    internalEventBus.publish('message.sent', { sessionId: session.id }).catch((error) => {
      this.logger.warn('Failed to emit message.sent event', error);
    });
  }

  private async handleQueuedMessageFailure(
    messageId: string,
    messageContent: string | MessageContent[],
    error: unknown
  ): Promise<void> {
    const { session, messageQueue, stateManager, errorManager } = this.ctx;

    if (error instanceof Error && error.message === 'Interrupted by user') {
      return;
    }

    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const isTimeoutError = normalizedError.name === 'MessageQueueTimeoutError';
    await errorManager.handleError(
      session.id,
      normalizedError,
      isTimeoutError ? ErrorCategory.TIMEOUT : ErrorCategory.MESSAGE,
      isTimeoutError
        ? 'The SDK is not responding. Click "Reset Agent" to recover.'
        : 'Failed to process message. Please try again.',
      stateManager.getState(),
      { messageId }
    );

    if (!isTimeoutError) {
      this.timeoutDeliveryRetryCounts.delete(messageId);
      await stateManager.setIdle();
      return;
    }

    const retryCount = this.timeoutDeliveryRetryCounts.get(messageId) ?? 0;
    if (retryCount >= MAX_TIMEOUT_DELIVERY_RETRIES) {
      this.timeoutDeliveryRetryCounts.delete(messageId);
      await this.markEnqueuedMessageFailed(messageId);
      await stateManager.setIdle();
      this.logger.warn(
        `Message ${messageId} timed out after ${MAX_TIMEOUT_DELIVERY_RETRIES} delivery retry.`
      );
      return;
    }
    this.timeoutDeliveryRetryCounts.set(messageId, retryCount + 1);

    try {
      const resetResult = await this.reset({ restartAfter: true });
      if (!resetResult.success) {
        throw new Error(resetResult.error || 'Agent query reset failed.');
      }
      await stateManager.setQueued(messageId);
      if (!messageQueue.isRunning() || !this.ctx.queryPromise) {
        throw new Error('Agent query did not restart; message remains queued for retry.');
      }
      await messageQueue.enqueueWithId(messageId, messageContent);
      this.timeoutDeliveryRetryCounts.delete(messageId);
    } catch (retryError) {
      this.timeoutDeliveryRetryCounts.delete(messageId);
      await this.markEnqueuedMessageFailed(messageId);
      await stateManager.setIdle();
      this.logger.warn('Failed to recover queued message delivery', retryError);
    }
  }

  private async markEnqueuedMessageFailed(messageId: string): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;
    const enqueuedMessage = db
      .getMessagesByStatus(session.id, 'enqueued')
      .find((message) => message.uuid === messageId);
    if (!enqueuedMessage) {
      return;
    }

    db.updateMessageStatus([enqueuedMessage.dbId], 'failed');
    try {
      await internalEventBus.publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: [enqueuedMessage.dbId],
        status: 'failed',
      });
    } catch (error) {
      this.logger.warn('Failed to emit failed message status update', error);
    }
  }

  /**
   * Restart query if not currently processing
   *
   * If currently processing, defers the restart until idle.
   * Used when settings change and SDK needs to reload.
   */
  async restartQuery(): Promise<void> {
    const { messageQueue, stateManager } = this.ctx;

    if (!messageQueue.isRunning() || !this.ctx.queryObject) {
      // Stopped queue / no query object. For an IDLE session this stays a no-op
      // (callers rely on that — the next start() builds fresh options anyway;
      // see task-agent-manager's MCP refresh). But a 'processing' session with
      // a stopped queue is a recovery window, not an idle one — most commonly
      // the startup-timeout retry's 15–240 s backoff (the session stays
      // 'processing' with queryPromise set while the queue is stopped).
      // Restarting here is impossible (nothing to stop, and a start would race
      // the sleeping chain), but DROPPING the request silently loses the
      // settings change for the whole window. Record the deferred reason so
      // executeDeferredRestartIfPending completes the restart when the chain
      // resolves and the session goes idle.
      if (stateManager.getState().status === 'processing') {
        this.ctx.pendingRestartReason = 'settings.local.json';
      }
      return;
    }

    const currentState = stateManager.getState();
    if (currentState.status === 'processing') {
      this.ctx.pendingRestartReason = 'settings.local.json';
      return;
    }

    await this.restart();
  }

  /**
   * Execute deferred restart if one is pending
   *
   * Called when agent becomes idle to complete deferred restarts.
   */
  async executeDeferredRestartIfPending(): Promise<void> {
    if (!this.ctx.pendingRestartReason) {
      return;
    }

    const _reason = this.ctx.pendingRestartReason;
    this.ctx.pendingRestartReason = null;

    try {
      await this.restart();
    } catch {
      // Log but don't throw - deferred restart is best-effort
    }
  }

  /**
   * Full cleanup of the query lifecycle
   *
   * Stops event subscriptions, clears caches, and stops the query.
   * Called when session is being destroyed.
   */
  async cleanup(): Promise<void> {
    this.ctx.setCleaningUp(true);

    // Phase 1: Unsubscribe from events
    this.ctx.cleanupEventSubscriptions();

    // Phase 2: Clear models cache
    try {
      await this.ctx.clearModelsCache();
    } catch {}

    // Phase 3: Stop query
    try {
      await this.stop({ timeoutMs: 15000, catchQueryErrors: true });
      await new Promise((r) => setTimeout(r, 1000));
    } catch {
      // Ignore cleanup errors
    }
  }
}
