import type { Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Logger } from '../logger.ts';
import {
  DETERMINISTIC_DIGEST_UUID_PREFIX,
  type RenderPendingDigestOutcome,
} from '../space/runtime/render-pending-digest-pipeline.ts';
import { ClearConversationCancelledError } from './agent-session.ts';
import {
  acquireContextClearBoundary,
  type ContextClearBoundaryOwner,
  flattenDeliveryText,
  type MessageDeliveryOrigin,
  SessionCoordinationStallError,
  withSessionOperationLock,
} from './message-delivery.ts';
import { activatePrompts } from './message-delivery-outbox.ts';
import { decideTurnEndFlush, type TurnEndFlushPlan } from './message-delivery-pipeline.ts';
import { type FlushMessage, isTaskFlushInput } from './message-ownership-gates.ts';
import type { MessageQueue } from './message-queue.ts';

export interface QueryModeHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly messageQueue: MessageQueue;
  readonly logger: Logger;
  readonly stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
    getState(): { status: string };
  };
  slotResetsContext?(): boolean;
  clearConversationContext?(boundaryOwner?: ContextClearBoundaryOwner): Promise<void>;
  renderPendingDigest?(
    sessionId: string,
    taskId?: string
  ): Promise<RenderPendingDigestOutcome | null>;

  ensureQueryStarted(): Promise<void>;
}

export class QueryModeHandler {
  constructor(private ctx: QueryModeHandlerContext) {}

  async handleQueryTrigger(options?: {
    deliverIndividually?: boolean;
    excludeMessageUuid?: string;
    skipContextReset?: boolean;
    skipResetCoordination?: boolean;
    pendingTaskInput?: boolean;
  }): Promise<{
    success: boolean;
    messageCount: number;
    error?: string;
  }> {
    const { session, db, logger } = this.ctx;

    const runFlush = async (): Promise<number> => {
      type DigestRowFilter = ((row: { uuid: string; taskId?: string }) => boolean) | null;
      let digestRowFilter: DigestRowFilter = null;
      const admittedTaskId = session.context?.taskId;
      const taskScoped = (row: { uuid: string; taskId?: string }): boolean =>
        admittedTaskId === undefined || (row.taskId !== undefined && row.taskId === admittedTaskId);
      try {
        const renderDigest = this.ctx.renderPendingDigest;
        const outcome = renderDigest
          ? await renderDigest(session.id, session.context?.taskId)
          : null;
        if (outcome == null) {
          if (renderDigest) {
            logger.warn(
              `turn-end digest pull for session ${session.id} was unavailable ` +
                `(runtime stopped or digest pipeline missing) — flushing without the digest`
            );
          }
        } else if (outcome.action === 'delivered') {
          digestRowFilter = (row) => row.uuid === outcome.uuid;
        } else if (outcome.action === 'skip') {
          if (outcome.heldDigestInFlight) {
            logger.warn(
              `turn-end digest pull for session ${session.id} held a digest already in ` +
                `flight — flushing without the digest`
            );
          } else if (
            outcome.reason === 'session_interrupted' ||
            outcome.reason === 'session_not_current' ||
            outcome.reason === 'task_not_admissible' ||
            outcome.reason === 'space_paused' ||
            outcome.reason === 'no_execution'
          ) {
            logger.warn(
              `turn-end digest pull for session ${session.id} skipped ` +
                `(reason=${outcome.reason}) — flushing without the digest`
            );
          } else {
            digestRowFilter = taskScoped;
          }
        } else {
          logger.warn(
            `turn-end digest pull for session ${session.id} did not deliver ` +
              `(action=${outcome.action}${
                outcome.action === 'failed'
                  ? `, stage=${outcome.stage}`
                  : `, reason=${outcome.reason}`
              }) — flushing without the digest`
          );
        }
      } catch (error) {
        logger.warn(
          `turn-end digest pull failed for session ${session.id}: ` +
            `${error instanceof Error ? error.message : String(error)} — flushing without the digest`
        );
      }
      const { messages: allDeferred } = db.getUserMessagesByStatus(session.id, 'deferred');
      const backlogBase = options?.excludeMessageUuid
        ? allDeferred.filter((m) => m.uuid !== options.excludeMessageUuid)
        : allDeferred;
      const backlog = backlogBase.filter((m) => {
        const uuid = String(m.uuid);
        if (!uuid.startsWith(DETERMINISTIC_DIGEST_UUID_PREFIX)) return true;
        const rowTaskId = (m as { externalEventTaskId?: unknown }).externalEventTaskId;
        return (
          digestRowFilter !== null &&
          digestRowFilter({ uuid, taskId: typeof rowTaskId === 'string' ? rowTaskId : undefined })
        );
      });

      if (backlog.length === 0) {
        return 0;
      }

      await this.deliverFlushUnderV2(this.toFlushMessages(backlog), 'recovery', options);

      return backlog.length;
    };

    try {
      const messageCount = options?.skipResetCoordination
        ? await runFlush()
        : await withSessionOperationLock(session.id, runFlush);
      return { success: true, messageCount };
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to trigger query:', error);
      return { success: false, messageCount: 0, error: errorMessage };
    }
  }

  private toFlushMessages(
    messages: Array<SDKMessage & { dbId: string; timestamp: number }>
  ): FlushMessage[] {
    return messages
      .filter((msg) => typeof msg.uuid === 'string' && msg.uuid.length > 0)
      .map((msg) => {
        const isUserMessage = isSDKUserMessage(msg);
        return {
          uuid: msg.uuid as string,
          dbId: msg.dbId,
          isUserMessage,
          isTaskInput: isTaskFlushInput(msg as { isSynthetic?: boolean; inputKind?: string }),
          flattenedText: isUserMessage ? flattenDeliveryText(msg.message.content ?? '') : null,
        };
      });
  }

  private planFlush(
    flushMessages: FlushMessage[],
    options?: { pendingTaskInput?: boolean }
  ): TurnEndFlushPlan {
    const jobQueue = this.ctx.db.getJobQueueRepo?.();
    return decideTurnEndFlush({
      messages: flushMessages,
      activeInJobQueue:
        jobQueue?.activeDeliveryMessageUuids?.(this.ctx.session.id) ?? new Set<string>(),
      slotResetsContext: this.ctx.slotResetsContext?.() ?? false,
      hasPriorContext: !!(this.ctx.session.sdkSessionId || this.ctx.session.acpSessionId),
      pendingTaskInput: options?.pendingTaskInput === true,
    });
  }

  private async clearContextAheadOfFlush(
    flushMessages: FlushMessage[],
    options?: { skipContextReset?: boolean; pendingTaskInput?: boolean },
    boundaryOwner?: ContextClearBoundaryOwner
  ): Promise<boolean> {
    if (options?.skipContextReset) return false;
    if (!this.ctx.clearConversationContext) return false;
    const plan = this.planFlush(flushMessages, options);
    if (plan.action === 'noop') return false;
    if (plan.contextReset.action !== 'clear_then_flush') return false;
    try {
      await this.ctx.clearConversationContext(boundaryOwner);
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      this.ctx.logger.warn(
        `turn-end flush clear failed for session ${this.ctx.session.id}: ` +
          `${error instanceof Error ? error.message : String(error)} — flushing without clear`
      );
      return false;
    }
    return true;
  }

  private async deferTaskDeliverables(
    flushMessages: FlushMessage[],
    deliverables: string[]
  ): Promise<string[]> {
    const deliverableSet = new Set(deliverables);
    const repo = this.ctx.db.getSDKMessageRepo();
    const flipped: string[] = [];
    for (const message of flushMessages) {
      if (!message.isTaskInput || !deliverableSet.has(message.uuid)) continue;
      if (repo.transitionMessageSendStatus(message.dbId, 'enqueued', 'deferred')) {
        flipped.push(message.dbId);
      }
    }
    if (flipped.length > 0) {
      await this.ctx.internalEventBus.publish('messages.statusChanged', {
        sessionId: this.ctx.session.id,
        messageIds: flipped,
        status: 'deferred',
      });
    }
    return deliverables.filter((uuid) => {
      const message = flushMessages.find((entry) => entry.uuid === uuid);
      return message !== undefined && !message.isTaskInput;
    });
  }

  private async activateFlushDeliverables(
    deliverables: string[],
    flushMessages: FlushMessage[],
    origin: MessageDeliveryOrigin
  ): Promise<void> {
    if (deliverables.length === 0) return;
    const db = this.ctx.db;
    const dbIdByUuid = new Map<string, string>();
    for (const message of flushMessages) {
      if (!dbIdByUuid.has(message.uuid)) dbIdByUuid.set(message.uuid, message.dbId);
    }
    const { activated } = await activatePrompts({
      db: db.getDatabase(),
      jobQueue: db.getJobQueueRepo(),
      sessionId: this.ctx.session.id,
      messageUuids: deliverables,
      dbIds: deliverables.map((uuid) => dbIdByUuid.get(uuid)),
      origin,
      publishStatusChanged: (messageIds) =>
        this.ctx.internalEventBus.publish('messages.statusChanged', {
          sessionId: this.ctx.session.id,
          messageIds,
          status: 'enqueued',
        }),
    });
    if (!this.ctx.stateManager) return;
    for (const entry of activated) {
      try {
        await this.ctx.stateManager.setQueuedIfIdle(entry.messageUuid);
      } catch {}
    }
  }

  private async deliverFlushUnderV2(
    flushMessages: FlushMessage[],
    origin: MessageDeliveryOrigin,
    options?: {
      skipContextReset?: boolean;
      pendingTaskInput?: boolean;
    }
  ): Promise<{ clearedContext: boolean }> {
    const plan = this.planFlush(flushMessages, options);
    if (plan.action === 'noop') return { clearedContext: false };
    let clearedContext = false;
    let deliverables = plan.deliver;
    let clearBoundaryOwner: ContextClearBoundaryOwner | null = null;
    try {
      if (plan.contextReset.action === 'clear_then_flush' && !options?.skipContextReset) {
        clearBoundaryOwner = await this.acquireClearBoundaryAheadOfFlush();
        if (clearBoundaryOwner === null) {
          const refreshed = this.planFlush(flushMessages, options);
          if (refreshed.action === 'noop') {
            return { clearedContext: false };
          }
          deliverables = refreshed.deliver;
          deliverables = await this.deferTaskDeliverables(flushMessages, deliverables);
          if (deliverables.length === 0) return { clearedContext: false };
        } else {
          clearedContext = await this.clearContextAheadOfFlush(
            flushMessages,
            options,
            clearBoundaryOwner
          );
          if (!clearedContext) {
            const refreshed = this.planFlush(flushMessages, options);
            if (refreshed.action === 'noop') {
              return { clearedContext };
            }
            deliverables = refreshed.deliver;
            if (
              refreshed.contextReset.action === 'flush_without_clear' &&
              refreshed.contextReset.reason === 'active_delivery_job'
            ) {
              deliverables = await this.deferTaskDeliverables(flushMessages, deliverables);
              if (deliverables.length === 0) return { clearedContext };
            }
          }
        }
      } else if (
        plan.contextReset.action === 'flush_without_clear' &&
        plan.contextReset.reason === 'active_delivery_job'
      ) {
        deliverables = await this.deferTaskDeliverables(flushMessages, deliverables);
        if (deliverables.length === 0) return { clearedContext: false };
      }
      await this.activateFlushDeliverables(deliverables, flushMessages, origin);
      return { clearedContext };
    } finally {
      clearBoundaryOwner?.release();
    }
  }

  private async acquireClearBoundaryAheadOfFlush(): Promise<ContextClearBoundaryOwner | null> {
    try {
      return await acquireContextClearBoundary(this.ctx.session.id);
    } catch (error) {
      if (error instanceof SessionCoordinationStallError) {
        this.ctx.logger.warn(
          `turn-end flush context-clear boundary busy for session ${this.ctx.session.id}: ` +
            `${error.message} — deferring the flush instead of clearing unprotected`
        );
        return null;
      }
      throw error;
    }
  }

  async sendEnqueuedMessagesOnTurnEnd(options?: {
    pendingTaskInput?: boolean;
    skipResetCoordination?: boolean;
  }): Promise<{
    replayedWork: boolean;
    clearedContext: boolean;
    replayFailed: boolean;
  }> {
    const { session, db, messageQueue, logger } = this.ctx;
    let replayedWork = false;
    let clearedContext = false;
    let replayFailed = false;

    const runReplay = async (): Promise<void> => {
      const { messages: queuedMessages } = db.getUserMessagesByStatus(session.id, 'enqueued');
      const pendingMessages = queuedMessages.filter(
        (msg) => typeof msg.uuid === 'string' && !messageQueue.hasPendingOrInFlight(msg.uuid)
      );

      if (pendingMessages.length === 0) {
        return;
      }
      replayedWork = true;

      const v2 = await this.deliverFlushUnderV2(this.toFlushMessages(pendingMessages), 'recovery', {
        pendingTaskInput: options?.pendingTaskInput,
      });
      clearedContext = v2.clearedContext;
    };

    try {
      await (options?.skipResetCoordination
        ? runReplay()
        : withSessionOperationLock(this.ctx.session.id, runReplay));
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      replayFailed = true;
      logger.error('Failed to send enqueued messages on turn end:', error);
    }
    return { replayedWork, clearedContext, replayFailed };
  }

  async replayPendingMessagesForAutomaticTurnEnd(): Promise<boolean> {
    if (this.ctx.session.config.queryMode === 'manual') return true;
    if (this.ctx.stateManager?.getState().status === 'waiting_for_input') return true;
    return this.replayPendingMessagesForImmediateMode();
  }

  async replayPendingMessagesForImmediateMode(): Promise<boolean> {
    const { clearedContext, replayFailed } = await this.sendEnqueuedMessagesOnTurnEnd();
    if (replayFailed) return false;
    if (!clearedContext) {
      const jobQueue = this.ctx.db.getJobQueueRepo?.();
      if (jobQueue?.activeDeliveryMessageUuids?.(this.ctx.session.id).size) {
        this.schedulePostSettlementFlush();
        return true;
      }
    }
    const replay = await this.handleQueryTrigger({ skipContextReset: clearedContext });
    return replay.success;
  }

  private postSettlementFlushScheduled = false;

  private schedulePostSettlementFlush(): void {
    if (this.postSettlementFlushScheduled) return;
    this.postSettlementFlushScheduled = true;
    void (async () => {
      try {
        const jobQueue = this.ctx.db.getJobQueueRepo?.();
        for (let i = 0; i < 240; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (!jobQueue?.activeDeliveryMessageUuids?.(this.ctx.session.id).size) break;
        }
        await this.handleQueryTrigger();
      } catch (error) {
        this.ctx.logger.warn(
          `post-settlement deferred flush failed for session ${this.ctx.session.id}:`,
          error
        );
      } finally {
        this.postSettlementFlushScheduled = false;
      }
    })();
  }
}
