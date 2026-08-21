import type { Session, MessageHub } from '@hyperneo/shared';
import type { QueryLike } from './query-like';
import type { Logger } from '../logger';
import type { MessageQueue } from './message-queue';
import type { ProcessingStateManager } from './processing-state-manager';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import { withSessionLock } from './message-delivery';

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

      if (this.ctx.queryAbortController) {
        this.ctx.queryAbortController.abort();
        this.ctx.queryAbortController = null;
      }

      const queryObjectSnapshot = this.ctx.queryObject;

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

  private publishDeferredQueueTrigger(): void {
    if (this.ctx.session.config.queryMode === 'manual') return;
    this.ctx.internalEventBus.publishAsync('query.trigger', {
      sessionId: this.ctx.session.id,
    });
  }
}
