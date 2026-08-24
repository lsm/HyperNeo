import type { Session, MessageHub } from '@hyperneo/shared';
import type { QueryLike } from './query-like.ts';
import type { Logger } from '../logger.ts';
import type { MessageQueue } from './message-queue.ts';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Database } from '../../storage/database.ts';
import { withSessionLock } from './message-delivery.ts';

const DEFAULT_INTERRUPT_CONTROL_TIMEOUT_MS = 2000;
const INTERRUPT_CONTROL_TIMED_OUT = 'interrupt-control-timed-out';

function getInterruptControlTimeoutMs(): number {
  const raw = process.env.HYPERNEO_INTERRUPT_CONTROL_TIMEOUT_MS;
  if (!raw) return DEFAULT_INTERRUPT_CONTROL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERRUPT_CONTROL_TIMEOUT_MS;
}

export interface InterruptHandlerContext {
  readonly session: Session;
  readonly messageHub: MessageHub;
  readonly messageQueue: MessageQueue;
  readonly stateManager: ProcessingStateManager;
  readonly logger: Logger;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  queryObject: QueryLike | null;
  queryPromise: Promise<void> | null;
  queryAbortController: AbortController | null;
  processExitedPromise: Promise<void> | null;

  getSdkCapabilities?(): ReadonlySet<string>;

  onInterruptRequested?(): void;
}

export class InterruptHandler {
  private interruptPromise: Promise<void> | null = null;
  private interruptResolve: (() => void) | null = null;
  private deferredReplaySuppressed = false;

  constructor(private ctx: InterruptHandlerContext) {}

  getInterruptPromise(): Promise<void> | null {
    return this.interruptPromise;
  }

  async handleInterrupt(opts?: {
    preserveDeliveryJobs?: boolean;
    skipDeferredReplay?: boolean;
  }): Promise<void> {
    const { session, messageHub, messageQueue, stateManager, logger } = this.ctx;

    this.ctx.onInterruptRequested?.();

    const processExitSnapshot = this.ctx.processExitedPromise ?? Promise.resolve();

    if (!opts?.preserveDeliveryJobs) {
      const failedDbIds: string[] = [];
      await withSessionLock(session.id, async () => {
        const messageUuids =
          this.ctx.db.getJobQueueRepo?.()?.cancelForSessionWithMessages(session.id) ?? [];
        const sdkRepo = this.ctx.db.getSDKMessageRepo?.();
        for (const messageUuid of messageUuids) {
          const failedDbId = sdkRepo?.markDeliveryFailedByUuid(session.id, messageUuid) ?? null;
          if (failedDbId) failedDbIds.push(failedDbId);
        }
        const cancelled = new Set(messageUuids);
        const enqueued = this.ctx.db.getUserMessageIdsByStatus?.(session.id, 'enqueued') ?? [];
        for (const msg of enqueued) {
          const uuid = msg.uuid;
          if (uuid && !cancelled.has(uuid)) {
            const failedDbId = sdkRepo?.markDeliveryFailedByUuid(session.id, uuid) ?? null;
            if (failedDbId) failedDbIds.push(failedDbId);
          }
        }
      });
      if (failedDbIds.length > 0) {
        await this.ctx.internalEventBus
          .publish('messages.statusChanged', {
            sessionId: session.id,
            messageIds: failedDbIds,
            status: 'failed',
          })
          .catch(() => {});
      }
      this.ctx.db.notifyChange?.('sdk_messages', { sessionId: session.id });
      this.ctx.db.notifyChange?.('job_queue', { sessionId: session.id });
    }

    const currentState = stateManager.getState();

    if (currentState.status === 'idle' || currentState.status === 'interrupted') {
      if (opts?.skipDeferredReplay) {
        this.deferredReplaySuppressed = true;
      }
      return;
    }
    this.deferredReplaySuppressed = opts?.skipDeferredReplay === true;

    const interruptCompletePromise = new Promise<void>((resolve) => {
      this.interruptResolve = resolve;
    });
    this.interruptPromise = interruptCompletePromise;

    try {
      await stateManager.setInterrupted();

      const queueSize = messageQueue.size();
      if (queueSize > 0) {
        messageQueue.clear();
      }

      const queryObjectSnapshot = this.ctx.queryObject;

      let hasInterruptSurvivors = false;
      if (queryObjectSnapshot && typeof queryObjectSnapshot.interrupt === 'function') {
        try {
          const receipt = await this.withInterruptControlDeadline(queryObjectSnapshot.interrupt());
          if (receipt === INTERRUPT_CONTROL_TIMED_OUT) {
            hasInterruptSurvivors = true;
            logger.warn(
              `SDK interrupt() did not answer within ${getInterruptControlTimeoutMs()}ms; closing immediately`
            );
          } else {
            const survivors = receipt?.still_queued ?? [];
            if (survivors.length > 0) {
              const cancelled = await this.withInterruptControlDeadline(
                this.cancelQueuedSurvivors(queryObjectSnapshot, survivors)
              );
              if (cancelled === INTERRUPT_CONTROL_TIMED_OUT) {
                hasInterruptSurvivors = true;
                logger.warn(
                  `SDK cancel_async_message did not settle within ${getInterruptControlTimeoutMs()}ms; closing immediately`
                );
              } else if (cancelled) {
                logger.info(
                  `SDK interrupt: cancelled ${survivors.length} queued message(s) via cancel_async_message`
                );
              } else {
                hasInterruptSurvivors = true;
                logger.warn(
                  `SDK interrupt left ${survivors.length} queued message(s) still running; closing immediately to stop them`
                );
              }
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('SDK interrupt() failed (may be expected):', errorMessage);
        }
      }

      if (this.ctx.queryAbortController) {
        this.ctx.queryAbortController.abort();
        this.ctx.queryAbortController = null;
      }

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

      if (this.ctx.queryObject) {
        try {
          this.ctx.queryObject.close();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn('SDK close() failed (may be expected):', errorMessage);
        }
      }

      this.ctx.queryObject = null;

      messageQueue.stop();

      messageHub.event('session.interrupted', {}, { channel: `session:${session.id}` });

      await stateManager.setIdle();
      if (!opts?.skipDeferredReplay) {
        const oldQuerySettled =
          this.ctx.queryPromise?.then(undefined, () => {}) ?? Promise.resolve();
        void Promise.all([oldQuerySettled, processExitSnapshot]).then(() => {
          if (this.deferredReplaySuppressed) return;
          if (this.ctx.stateManager.getState().status !== 'idle') return;
          this.publishDeferredQueueTrigger();
        });
      }
    } finally {
      if (this.interruptResolve) {
        this.interruptResolve();
        this.interruptResolve = null;
      }
      this.interruptPromise = null;
    }
  }

  private async withInterruptControlDeadline<T>(
    promise: Promise<T>
  ): Promise<T | typeof INTERRUPT_CONTROL_TIMED_OUT> {
    void promise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof INTERRUPT_CONTROL_TIMED_OUT>((resolve) => {
      timer = setTimeout(
        () => resolve(INTERRUPT_CONTROL_TIMED_OUT),
        getInterruptControlTimeoutMs()
      );
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async cancelQueuedSurvivors(
    queryObject: QueryLike,
    survivors: string[]
  ): Promise<boolean> {
    if (!this.ctx.getSdkCapabilities?.().has('interrupt_cancel_queued_v1')) return false;
    if (typeof queryObject.cancelAsyncMessage !== 'function') return false;
    try {
      for (const messageUuid of survivors) {
        const cancelled = await queryObject.cancelAsyncMessage(messageUuid);
        if (!cancelled) {
          this.ctx.logger.warn(
            `SDK cancel_async_message did not confirm cancellation of ${messageUuid}; falling back to subprocess close`
          );
          return false;
        }
      }
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.ctx.logger.warn(
        `SDK cancel_async_message failed (${errorMessage}); falling back to subprocess close`
      );
      return false;
    }
  }

  private publishDeferredQueueTrigger(): void {
    if (this.ctx.session.config.queryMode === 'manual') return;
    this.ctx.internalEventBus.publishAsync('query.trigger', {
      sessionId: this.ctx.session.id,
    });
  }
}
