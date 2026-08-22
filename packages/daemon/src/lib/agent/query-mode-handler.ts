import type { MessageContent, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Logger } from '../logger';
import { ClearConversationCancelledError } from './agent-session';
import {
  deliverAndMarkQueued,
  deliverBatchAndMarkQueued,
  flattenDeliveryText,
  isMessageDeliveryV2Enabled,
  type MessageDeliveryOrigin,
  withSessionResetCoordination,
} from './message-delivery';
import { decideTurnEndFlush, type TurnEndFlushPlan } from './message-delivery-pipeline';
import { type FlushMessage, isTaskFlushInput } from './message-ownership-gates';
import type { MessageQueue } from './message-queue';

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
  clearConversationContext?(): Promise<void>;

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
    const { session, db, internalEventBus, logger } = this.ctx;

    const runFlush = async (): Promise<number> => {
      const { messages: allDeferred } = db.getUserMessagesByStatus(session.id, 'deferred');
      const deferredMessages = options?.excludeMessageUuid
        ? allDeferred.filter((m) => m.uuid !== options.excludeMessageUuid)
        : allDeferred;

      if (deferredMessages.length === 0) {
        return 0;
      }

      const dbIds = deferredMessages.map((m) => m.dbId);
      db.updateMessageStatus(dbIds, 'enqueued');
      const flushMessages = this.toFlushMessages(deferredMessages);

      if (isMessageDeliveryV2Enabled()) {
        try {
          await this.deliverFlushUnderV2(flushMessages, 'recovery', options);
        } catch (error) {
          await internalEventBus.publish('messages.statusChanged', {
            sessionId: session.id,
            messageIds: dbIds,
            status: 'enqueued',
          });
          throw error;
        }
      }

      await internalEventBus.publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: dbIds,
        status: 'enqueued',
      });

      if (!isMessageDeliveryV2Enabled()) {
        await this.deliverRowsViaMemoryQueue(deferredMessages, flushMessages, options);
      }

      return deferredMessages.length;
    };

    try {
      const messageCount = options?.skipResetCoordination
        ? await runFlush()
        : await withSessionResetCoordination(session.id, runFlush);
      return { success: true, messageCount };
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to trigger query:', error);
      return { success: false, messageCount: 0, error: errorMessage };
    }
  }

  private flushClearBlockedByLiveWork(): boolean {
    if (this.ctx.messageQueue.size() > 0) return true;
    const status = this.ctx.stateManager?.getState().status;
    return status !== undefined && status !== 'idle';
  }

  private async deliverRowsViaMemoryQueue(
    messages: Array<SDKUserMessage & { dbId: string; timestamp: number }>,
    flushMessages: FlushMessage[],
    options?: { skipContextReset?: boolean; pendingTaskInput?: boolean }
  ): Promise<boolean> {
    const session = this.ctx.session;
    const v2Owned =
      this.ctx.db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ??
      new Set<string>();
    const taskUuids = new Set(
      flushMessages.filter((message) => message.isTaskInput).map((message) => message.uuid)
    );
    await this.ctx.ensureQueryStarted();
    let clearAttempted = false;
    let clearedContext = false;
    const clearAheadOfTask = async (): Promise<void> => {
      clearAttempted = true;
      clearedContext = await this.clearContextAheadOfFlush(flushMessages, options);
    };
    for (const msg of messages) {
      if (typeof msg.uuid !== 'string' || msg.uuid.length === 0) continue;
      if (v2Owned.has(msg.uuid)) continue;
      const replayContent = this.toReplayContent(msg.message.content);
      if (!replayContent) continue;
      if (!clearAttempted && taskUuids.has(msg.uuid)) {
        if (this.flushClearBlockedByLiveWork()) {
          await this.deferRemainingRows(messages, v2Owned, msg.uuid);
          return clearedContext;
        }
        await clearAheadOfTask();
      }
      await this.ctx.messageQueue.enqueueWithId(msg.uuid, replayContent);
    }
    if (
      !clearAttempted &&
      options?.pendingTaskInput === true &&
      !this.flushClearBlockedByLiveWork()
    ) {
      await clearAheadOfTask();
    }
    return clearedContext;
  }

  private async deferRemainingRows(
    messages: Array<SDKUserMessage & { dbId: string; timestamp: number }>,
    v2Owned: ReadonlySet<string>,
    fromUuid: string
  ): Promise<void> {
    const dbIds: string[] = [];
    let delaying = false;
    for (const msg of messages) {
      if (!delaying && msg.uuid !== fromUuid) continue;
      delaying = true;
      if (typeof msg.uuid !== 'string' || msg.uuid.length === 0) continue;
      if (v2Owned.has(msg.uuid)) continue;
      dbIds.push(msg.dbId);
    }
    if (dbIds.length === 0) return;
    this.ctx.db.updateMessageStatus(dbIds, 'deferred');
    await this.ctx.internalEventBus.publish('messages.statusChanged', {
      sessionId: this.ctx.session.id,
      messageIds: dbIds,
      status: 'deferred',
    });
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
        jobQueue?.activeDeliveryMessageUuids(this.ctx.session.id) ?? new Set<string>(),
      pendingInMemoryUuids: new Set<string>(),
      activeTurnInJobQueue: jobQueue?.hasActiveTurnDeliveryJob(this.ctx.session.id) ?? false,
      slotResetsContext: this.ctx.slotResetsContext?.() ?? false,
      hasPriorContext: !!this.ctx.session.sdkSessionId,
      pendingTaskInput: options?.pendingTaskInput === true,
    });
  }

  private async clearContextAheadOfFlush(
    flushMessages: FlushMessage[],
    options?: { skipContextReset?: boolean; pendingTaskInput?: boolean }
  ): Promise<boolean> {
    if (options?.skipContextReset) return false;
    if (!this.ctx.clearConversationContext) return false;
    const plan = this.planFlush(flushMessages, options);
    if (plan.action === 'noop') return false;
    if (plan.contextReset.action !== 'clear_then_flush') return false;
    try {
      await this.ctx.clearConversationContext();
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

  private async deliverFlushUnderV2(
    flushMessages: FlushMessage[],
    origin: MessageDeliveryOrigin,
    options?: {
      deliverIndividually?: boolean;
      skipContextReset?: boolean;
      pendingTaskInput?: boolean;
    }
  ): Promise<boolean> {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    const plan = this.planFlush(flushMessages, options);
    if (plan.action === 'noop') return false;
    let clearedContext = false;
    if (plan.contextReset.action === 'clear_then_flush') {
      clearedContext = await this.clearContextAheadOfFlush(flushMessages, options);
    }
    const deliverables = plan.action === 'batch' ? plan.uuids : plan.deliver;
    if (plan.action === 'batch' && !options?.deliverIndividually) {
      const batched = await deliverBatchAndMarkQueued({
        jobQueue,
        stateManager: this.ctx.stateManager,
        sessionId: this.ctx.session.id,
        messageUuids: deliverables,
        origin,
      });
      if (batched) return clearedContext;
    }
    for (const uuid of deliverables) {
      await deliverAndMarkQueued({
        jobQueue,
        stateManager: this.ctx.stateManager,
        sessionId: this.ctx.session.id,
        messageUuid: uuid,
        origin,
      });
    }
    return clearedContext;
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

      if (isMessageDeliveryV2Enabled()) {
        clearedContext = await this.deliverFlushUnderV2(
          this.toFlushMessages(pendingMessages),
          'recovery',
          { pendingTaskInput: options?.pendingTaskInput }
        );
      } else {
        clearedContext = await this.deliverRowsViaMemoryQueue(
          pendingMessages,
          this.toFlushMessages(pendingMessages),
          { pendingTaskInput: options?.pendingTaskInput }
        );
      }
    };

    try {
      if (options?.skipResetCoordination) {
        await runReplay();
      } else {
        await withSessionResetCoordination(session.id, runReplay);
      }
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      replayFailed = true;
      logger.error('Failed to send enqueued messages on turn end:', error);
    }
    return { replayedWork, clearedContext, replayFailed };
  }

  async replayPendingMessagesForImmediateMode(): Promise<void> {
    const { clearedContext } = await this.sendEnqueuedMessagesOnTurnEnd();
    if (!clearedContext) {
      const jobQueue = this.ctx.db.getJobQueueRepo?.();
      if (jobQueue?.activeDeliveryMessageUuids(this.ctx.session.id).size) {
        return;
      }
    }
    await this.handleQueryTrigger({ skipContextReset: clearedContext });
  }

  private toReplayContent(
    content: string | Array<{ type: string; text?: string }>
  ): string | MessageContent[] | null {
    if (typeof content === 'string') {
      return content || null;
    }

    if (Array.isArray(content)) {
      if (content.some((block) => block.type !== 'text')) {
        return content as MessageContent[];
      }

      const textContent = content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && !!c.text)
        .map((c) => c.text)
        .join('\n');
      return textContent || null;
    }

    return null;
  }
}
