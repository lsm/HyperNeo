/**
 * InterruptHandler - Handles query interruption
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Interrupt state management
 * - Abort controller signaling
 * - SDK interrupt() integration
 * - Queue cleanup
 * - State transitions during interrupt
 */

import type { Session, MessageHub } from '@hyperneo/shared';
import type { QueryLike } from './query-like';
import type { Logger } from '../logger';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import { withSessionLock } from './message-delivery';

/**
 * Context interface - what InterruptHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface InterruptHandlerContext {
  readonly session: Session;
  readonly messageHub: MessageHub;
  readonly messageQueue: MessageQueue;
  readonly stateManager: ProcessingStateManager;
  readonly logger: Logger;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  // Mutable query state
  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;
  queryAbortController: AbortController | null;
  processExitedPromise: Promise<void> | null;
}

/**
 * Handles interrupt operations for AgentSession
 */
export class InterruptHandler {
  // Interrupt completion tracking
  private interruptPromise: Promise<void> | null = null;
  private interruptResolve: (() => void) | null = null;
  // Replay suppression is shared across invocations: a teardown-bound
  // interrupt (skipDeferredReplay) arriving while a user interrupt is
  // already in flight early-returns on the shared 'interrupted' state, so
  // the in-flight interrupt's scheduled replay must observe the later
  // suppression at fire time.
  private deferredReplaySuppressed = false;

  constructor(private ctx: InterruptHandlerContext) {}

  /**
   * Get the current interrupt promise (for waiting in ensureQueryStarted)
   */
  getInterruptPromise(): Promise<void> | null {
    return this.interruptPromise;
  }

  /**
   * Handle interrupt request
   * Uses official SDK interrupt() method
   *
   * Pass `{ preserveDeliveryJobs: true }` on a stop path that is about to
   * RESTART (daemon graceful shutdown): the caller has already requeued in-flight
   * message_delivery rows for the next boot, so the default cancel-everything
   * behavior here would delete the very handoff that requeue preserved. The
   * query abort + SDK interrupt still run (the in-flight turn must unwind so
   * cleanup doesn't block); only the durable-job cancellation is skipped.
   * (Codex P1.)
   */
  async handleInterrupt(opts?: {
    preserveDeliveryJobs?: boolean;
    skipDeferredReplay?: boolean;
  }): Promise<void> {
    const { session, messageHub, messageQueue, stateManager, logger } = this.ctx;

    // Snapshot the process-exit promise BEFORE the first await: the durable
    // cancellation below yields, and the old query's finally may run in that
    // window — QueryRunner clears ctx.processExitedPromise once the query
    // settles (close() only initiates subprocess termination), so reading it
    // later would miss the still-pending exit. Mirrors
    // QueryLifecycleManager.stop's snapshot-before-await discipline.
    const processExitSnapshot = this.ctx.processExitedPromise ?? Promise.resolve();

    // Durable-delivery cancel FIRST (message-delivery v2): revoke EVERY active
    // message_delivery job for the session and terminalize each still-enqueued
    // SDK row. This must live here — the single chokepoint every interrupt path
    // reaches (client.interrupt RPC → agent.interruptRequest subscriber → this
    // handler, space paths via the AgentSession wrapper). Without it a pending
    // turn/steer job survives the user's interrupt and is claimed afterwards.
    // Legacy path: no message_delivery jobs exist → no-op. Consumed rows are
    // untouched (they WERE delivered). SKIPPED on a restart-bound shutdown stop
    // (see opts.preserveDeliveryJobs). See Codex (#3743968030, #3744105273).
    if (!opts?.preserveDeliveryJobs) {
      await withSessionLock(session.id, async () => {
        const messageUuids =
          this.ctx.db.getJobQueueRepo?.()?.cancelForSessionWithMessages(session.id) ?? [];
        const sdkRepo = this.ctx.db.getSDKMessageRepo?.();
        for (const messageUuid of messageUuids) {
          sdkRepo?.markDeliveryFailedByUuid(session.id, messageUuid);
        }
        // Also terminalize enqueued user ORPHANS — rows with no active durable
        // job (the #856 stranded-pending shape). cancelForSessionWithMessages
        // only returns UUIDs that HAD an active job, so an enqueued row that
        // never got one (or whose job already completed) isn't terminalized
        // above. Without this, the post-interrupt idle transition's
        // reconcileStrandedDeliveries would re-enqueue it, restarting a prompt
        // the user just stopped with the rest of the queued input. `deferred`
        // rows are left (the user intentionally queued them for next turn) and
        // `submitted` rows are settled by the ACP runner. (Codex review, #861.)
        const cancelled = new Set(messageUuids);
        const enqueued = this.ctx.db.getMessagesByStatus?.(session.id, 'enqueued') ?? [];
        for (const msg of enqueued) {
          const uuid = (msg as { uuid?: string }).uuid;
          if (uuid && !cancelled.has(uuid)) {
            sdkRepo?.markDeliveryFailedByUuid(session.id, uuid);
          }
        }
      });
      // Task #862 (review P1): both cancelForSessionWithMessages (raw DELETE on
      // job_queue) and markDeliveryFailedByUuid (raw UPDATE on sdk_messages) write
      // without a notify, so after interrupting a pending/enqueued message (or an
      // in-flight steer job) the queued/retrying badge would stay stuck until an
      // unrelated write or reconnect. Notify both tables (session-scoped) so the
      // widened delivery feeds re-evaluate immediately.
      this.ctx.db.notifyChange?.('sdk_messages', { sessionId: session.id });
      this.ctx.db.notifyChange?.('job_queue', { sessionId: session.id });
    }

    const currentState = stateManager.getState();

    // Edge case: already idle or interrupted
    if (currentState.status === 'idle' || currentState.status === 'interrupted') {
      // A teardown request arriving while another interrupt is in flight must
      // still suppress that interrupt's pending replay — only ever set here,
      // never cleared, so a concurrent user invocation cannot un-suppress.
      if (opts?.skipDeferredReplay) {
        this.deferredReplaySuppressed = true;
      }
      return;
    }
    // A proceeding invocation owns the flag: reset to its own intent. A
    // session reused across workflow activations must not inherit a stale
    // suppression from a previous quiesce.
    this.deferredReplaySuppressed = opts?.skipDeferredReplay === true;

    // Create interrupt completion promise
    const interruptCompletePromise = new Promise<void>((resolve) => {
      this.interruptResolve = resolve;
    });
    this.interruptPromise = interruptCompletePromise;

    try {
      // Set state to 'interrupted' immediately
      await stateManager.setInterrupted();

      // Clear pending messages in queue
      const queueSize = messageQueue.size();
      if (queueSize > 0) {
        messageQueue.clear();
      }

      // STEP 1: Abort the query to break the for-await loop
      if (this.ctx.queryAbortController) {
        this.ctx.queryAbortController.abort();
        this.ctx.queryAbortController = null;
      }

      // Capture snapshot before any await so interrupt() always targets the
      // right object even if ctx.queryObject changes during async operations.
      const queryObjectSnapshot = this.ctx.queryObject;

      // STEP 2: Call SDK interrupt(). The receipt (interrupt_receipt_v1) lists
      // uuid-stamped async commands the SDK already pulled from our queue that
      // will still run unless cancelled. The wrapper does not expose a follow-up
      // cancel, so the only way to stop them is to close the subprocess before
      // its drain loop starts the next queued turn.
      let hasInterruptSurvivors = false;
      if (queryObjectSnapshot && typeof queryObjectSnapshot.interrupt === 'function') {
        try {
          const receipt = await queryObjectSnapshot.interrupt();
          const survivors = receipt?.still_queued?.length ?? 0;
          if (survivors > 0) {
            hasInterruptSurvivors = true;
            logger.warn(
              `SDK interrupt left ${survivors} queued message(s) still running; closing immediately to stop them`
            );
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('SDK interrupt() failed (may be expected):', errorMessage);
        }
      }

      // STEP 3: Wait for old query to finish — but only when the interrupt did
      // not report survivors. A survivor means the SDK queue is about to drain a
      // queued turn despite the stop; skip the grace wait so STEP 4 closes the
      // subprocess before that turn can begin.
      if (this.ctx.queryPromise && !hasInterruptSurvivors) {
        try {
          await Promise.race([
            this.ctx.queryPromise,
            new Promise((resolve) => setTimeout(resolve, 200)),
          ]);
        } catch (error) {
          logger.warn('Error waiting for old query:', error);
        }
      }

      // STEP 4: Close query — use live reference to avoid double-close.
      // If runQuery()'s finally block ran during the STEP 3 await, it already
      // called close() and nulled ctx.queryObject; skip close() in that case.
      // Only close when the promise timed out and the subprocess is still alive.
      if (this.ctx.queryObject) {
        try {
          this.ctx.queryObject.close();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('SDK close() failed (may be expected):', errorMessage);
        }
      }

      // STEP 5: Clear queryObject
      this.ctx.queryObject = null;

      // STEP 6: Stop the message queue
      messageQueue.stop();

      // Publish interrupt event
      messageHub.event('session.interrupted', {}, { channel: `session:${session.id}` });

      // Set state back to idle
      await stateManager.setIdle();
      // Drive the deferred queue on interrupt completion, mirroring
      // SDKMessageHandler.finishTurn: without this, a row persisted as
      // 'deferred' while the session was processing (e.g. an external event
      // in 'defer' mode) is never replayed — the interrupt path reaches idle
      // without the query.trigger that finishTurn publishes on normal turn
      // end, so the row would sit unconsumed indefinitely. No-op when no
      // deferred rows exist. Skipped for teardown-bound interrupts (session
      // stop/shutdown) — replaying there would promote deferred rows to
      // enqueued and drive jobs for a session that is about to be cleaned
      // up. The replay is gated on BOTH the old query settling AND the SDK
      // subprocess exiting: query settlement is not an exit guarantee
      // (QueryLifecycleManager.stop separately awaits processExitedPromise),
      // so replaying earlier could launch a replacement query while the old
      // process still holds workspace resources.
      if (!opts?.skipDeferredReplay) {
        const oldQuerySettled =
          this.ctx.queryPromise?.then(undefined, () => {}) ?? Promise.resolve();
        void Promise.all([oldQuerySettled, processExitSnapshot]).then(() => {
          if (this.deferredReplaySuppressed) return;
          // A newer turn may have started while we waited for the old query
          // and subprocess to exit — the interrupt already exposed idle, so
          // nothing gated a concurrent kickoff. Publishing now would steer
          // the old deferred rows into that active turn; leave their replay
          // to the newer turn's own completion.
          if (this.ctx.stateManager.getState().status !== 'idle') return;
          this.publishDeferredQueueTrigger();
        });
      }
    } finally {
      // Always resolve the interrupt promise
      if (this.interruptResolve) {
        this.interruptResolve();
        this.interruptResolve = null;
      }
      this.interruptPromise = null;
    }
  }

  /**
   * Publish the deferred-queue trigger for this session. Fire-and-forget:
   * QueryModeHandler flips deferred rows to enqueued and the durable delivery
   * job drives the replacement turn. No-op when no deferred rows exist.
   */
  private publishDeferredQueueTrigger(): void {
    if (this.ctx.session.config.queryMode === 'manual') return;
    this.ctx.internalEventBus.publishAsync('query.trigger', {
      sessionId: this.ctx.session.id,
    });
  }
}
