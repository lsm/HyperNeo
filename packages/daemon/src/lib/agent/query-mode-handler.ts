import type { MessageContent, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
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
  }): Promise<{
    success: boolean;
    messageCount: number;
    error?: string;
  }> {
    const { session, db, internalEventBus, messageQueue, logger } = this.ctx;

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
        await this.clearContextAheadOfFlush(flushMessages, options);
        const v2Owned =
          db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ?? new Set<string>();
        await this.ctx.ensureQueryStarted();
        for (const msg of deferredMessages) {
          if (typeof msg.uuid !== 'string' || msg.uuid.length === 0) continue;
          if (v2Owned.has(msg.uuid)) continue;
          const replayContent = this.toReplayContent(msg.message.content);
          if (replayContent) {
            await messageQueue.enqueueWithId(msg.uuid, replayContent);
          }
        }
      }

      return deferredMessages.length;
    };

    try {
      const messageCount = options?.skipResetCoordination
        ? await runFlush()
        : await withSessionResetCoordination(session.id, runFlush);
      return { success: true, messageCount };
    } catch (error) {
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
          isUserMessage,
          isTaskInput: isTaskFlushInput(msg as { isSynthetic?: boolean; inputKind?: string }),
          flattenedText: isUserMessage ? flattenDeliveryText(msg.message.content ?? '') : null,
        };
      });
  }

  private planFlush(flushMessages: FlushMessage[]): TurnEndFlushPlan {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    return decideTurnEndFlush({
      messages: flushMessages,
      activeInJobQueue: jobQueue.activeDeliveryMessageUuids(this.ctx.session.id),
      pendingInMemoryUuids: new Set<string>(),
      activeTurnInJobQueue: jobQueue.hasActiveTurnDeliveryJob(this.ctx.session.id),
      slotResetsContext: this.ctx.slotResetsContext?.() ?? false,
      hasPriorContext: !!this.ctx.session.sdkSessionId,
    });
  }

  private async clearContextAheadOfFlush(
    flushMessages: FlushMessage[],
    options?: { skipContextReset?: boolean }
  ): Promise<void> {
    if (options?.skipContextReset) return;
    if (!this.ctx.clearConversationContext) return;
    const plan = this.planFlush(flushMessages);
    if (plan.action === 'noop') return;
    if (plan.contextReset.action !== 'clear_then_flush') return;
    try {
      await this.ctx.clearConversationContext();
    } catch (error) {
      if (error instanceof ClearConversationCancelledError) throw error;
      this.ctx.logger.warn(
        `turn-end flush clear failed for session ${this.ctx.session.id}: ` +
          `${error instanceof Error ? error.message : String(error)} — flushing without clear`
      );
    }
  }

  private async deliverFlushUnderV2(
    flushMessages: FlushMessage[],
    origin: MessageDeliveryOrigin,
    options?: { deliverIndividually?: boolean; skipContextReset?: boolean }
  ): Promise<void> {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    const plan = this.planFlush(flushMessages);
    if (plan.action === 'noop') return;
    if (plan.contextReset.action === 'clear_then_flush') {
      await this.clearContextAheadOfFlush(flushMessages, options);
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
      if (batched) return;
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
  }

  async sendEnqueuedMessagesOnTurnEnd(): Promise<boolean> {
    const { session, db, messageQueue, logger } = this.ctx;
    let replayedWork = false;

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
        await this.deliverFlushUnderV2(this.toFlushMessages(pendingMessages), 'recovery');
      } else {
        await this.clearContextAheadOfFlush(this.toFlushMessages(pendingMessages));
        const v2Owned =
          db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ?? new Set<string>();
        await this.ctx.ensureQueryStarted();
        for (const msg of pendingMessages) {
          if (v2Owned.has((msg.uuid ?? '') as string)) continue;
          const replayContent = this.toReplayContent(msg.message.content);
          if (replayContent) {
            await messageQueue.enqueueWithId(msg.uuid as string, replayContent);
          }
        }
      }
    };

    try {
      await withSessionResetCoordination(session.id, runReplay);
    } catch (error) {
      logger.error('Failed to send enqueued messages on turn end:', error);
    }
    return replayedWork;
  }

  async replayPendingMessagesForImmediateMode(): Promise<void> {
    const replayedWork = await this.sendEnqueuedMessagesOnTurnEnd();
    await this.handleQueryTrigger({ skipContextReset: replayedWork });
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
