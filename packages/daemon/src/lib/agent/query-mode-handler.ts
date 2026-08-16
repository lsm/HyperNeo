/**
 * QueryModeHandler - Handles query mode operations (Manual/Auto-queue)
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - handleQueryTrigger - manual mode: send all deferred messages
 * - sendEnqueuedMessagesOnTurnEnd - auto-defer mode: send enqueued messages after turn
 */

import type { MessageContent, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
import type { Database } from '../../storage/database';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Logger } from '../logger';
import {
  deliverAndMarkQueued,
  deliverBatchAndMarkQueued,
  flattenDeliveryText,
  isMessageDeliveryV2Enabled,
  type MessageDeliveryOrigin,
} from './message-delivery';
import type { MessageQueue } from './message-queue';

/**
 * Context interface - what QueryModeHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface QueryModeHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly messageQueue: MessageQueue;
  readonly logger: Logger;
  /**
   * State manager — a replayed/enqueued TURN sets the queued marker
   * (setQueuedIfIdle) so a concurrent `deliveryMode:'defer'` send isn't
   * mis-converted to immediate while the replayed job waits to be claimed.
   * Optional for unit-test contexts that don't exercise the marker. (Codex review.)
   */
  readonly stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
    getState(): { status: string };
  };

  // Method to ensure query is started
  ensureQueryStarted(): Promise<void>;
}

/**
 * Handles query mode operations
 */
export class QueryModeHandler {
  constructor(private ctx: QueryModeHandlerContext) {}

  /**
   * Handle manual query trigger (Manual mode)
   *
   * Retrieves all 'deferred' messages from the database and sends them to Claude.
   * Under durable delivery (default), each message is flipped to 'enqueued' and
   * routed through the `deliverMessage` chokepoint — the message_delivery
   * handler owns ensureQueryStarted + feeding the transport (turn/steer), with
   * the same atomic single-owner / reclaimStale / synchronous-consumed-flip
   * guarantees as an immediate kickoff. The first message becomes the turn;
   * the rest steer into it (the active-turn index arbitrates). Legacy opt-out
   * (HYPERNEO_MESSAGE_DELIVERY_V2=0) keeps the inline ensureQueryStarted +
   * enqueueWithId path.
   */
  async handleQueryTrigger(): Promise<{
    success: boolean;
    messageCount: number;
    error?: string;
  }> {
    const { session, db, internalEventBus, messageQueue, logger } = this.ctx;

    try {
      const deferredMessages = db.getMessagesByStatus(session.id, 'deferred');

      if (deferredMessages.length === 0) {
        return { success: true, messageCount: 0 };
      }

      // Update status to 'enqueued' so the durable handler drives (not skips)
      // the message. The handler reloads content by UUID.
      const dbIds = deferredMessages.map((m) => m.dbId);
      db.updateMessageStatus(dbIds, 'enqueued');

      // Emit status change event
      await internalEventBus.publish('messages.statusChanged', {
        sessionId: session.id,
        messageIds: dbIds,
        status: 'enqueued',
      });

      if (isMessageDeliveryV2Enabled()) {
        // Durable: enqueue a delivery job per message (idempotent via
        // getActiveDeliveryRole). The handler drives the turn / feeds steers.
        // Multiple messages flushing together on an idle session coalesce into
        // ONE batched turn (see deliverFlushUnderV2).
        await this.deliverFlushUnderV2(deferredMessages, 'recovery');
      } else {
        // Legacy inline path (HYPERNEO_MESSAGE_DELIVERY_V2=0 opt-out). Exclude
        // UUIDs still owned by a durable job — a rollback to v2=0 after a v2 run
        // leaves surviving message_delivery jobs (the processor is registered
        // unconditionally), and replaying them here through MessageQueue would
        // duplicate the feed. (Codex review, P1.)
        const v2Owned =
          db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ?? new Set<string>();
        await this.ctx.ensureQueryStarted();
        for (const msg of deferredMessages) {
          if (!isSDKUserMessage(msg)) continue;
          if (v2Owned.has((msg.uuid ?? '') as string)) continue;
          const replayContent = this.toReplayContent(msg.message.content);
          if (replayContent) {
            await messageQueue.enqueueWithId(msg.uuid as string, replayContent);
          }
        }
      }

      return { success: true, messageCount: deferredMessages.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to trigger query:', error);
      return { success: false, messageCount: 0, error: errorMessage };
    }
  }

  /**
   * Deliver a queue flush under durable delivery (v2). When the flush is
   * entirely foldable plain-text messages (≥2) AND no turn is active, they are
   * coalesced into ONE batched turn (payload.batchUuids — the handler combines
   * the contents with numbered delimiters) so the model reads the whole queue
   * before acting, instead of answering N steers one at a time. ANY
   * non-foldable message in the flush (non-text content like images, or an SDK
   * slash command that must reach the SDK standalone) disables batching for
   * the whole flush — batching only the foldable subset would reorder the
   * queue (a later text arriving before an earlier image/command). A turn
   * active at enqueue time, or any member already owning a job, also falls
   * back to per-message delivery — the pre-batch first-turn/rest-steer
   * behavior.
   */
  private async deliverFlushUnderV2(
    messages: Array<SDKMessage & { dbId: string; timestamp: number }>,
    origin: MessageDeliveryOrigin
  ): Promise<void> {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    const pending = messages.filter(
      (msg) => isSDKUserMessage(msg) && typeof msg.uuid === 'string' && msg.uuid.length > 0
    );
    const allBatchable = pending.every((msg) => {
      if (!isSDKUserMessage(msg)) return false;
      const text = flattenDeliveryText(msg.message.content ?? '');
      // SDK slash commands (e.g. a deferred /compact) must reach the SDK as a
      // standalone command — a batch delimiter prefix would turn the command
      // into literal prompt text.
      return text !== null && !text.startsWith('/');
    });

    if (allBatchable && pending.length >= 2) {
      const batched = await deliverBatchAndMarkQueued({
        jobQueue,
        stateManager: this.ctx.stateManager,
        sessionId: this.ctx.session.id,
        messageUuids: pending.map((m) => m.uuid as string),
        origin,
      });
      if (batched) return;
    }
    await this.deliverEachUnderV2(pending, origin);
  }

  /**
   * Per-message durable delivery (the pre-batch flush behavior): first
   * message wins the turn role via the atomic index, the rest steer. Uses the
   * queued-marker wrapper so the first (turn) message marks the session busy
   * — a concurrent deliveryMode:'defer' send then stays deferred instead of
   * being mis-converted to immediate. (Codex review.)
   *
   * Batch-aware: messages owned by an ACTIVE batched turn (members have no
   * job row of their own, so deliverMessage's per-UUID idempotency check
   * cannot see them) are skipped — a startup/replay flush racing a pending
   * batch would otherwise give every member its own steer job on top of the
   * combined prompt, executing it twice.
   */
  private async deliverEachUnderV2(
    messages: Array<SDKMessage & { dbId: string; timestamp: number }>,
    origin: MessageDeliveryOrigin
  ): Promise<void> {
    const jobQueue = this.ctx.db.getJobQueueRepo();
    const active = jobQueue.activeDeliveryMessageUuids(this.ctx.session.id);
    for (const msg of messages) {
      const uuid = msg.uuid as string;
      if (active.has(uuid)) continue; // owned by an active job (incl. batch member)
      await deliverAndMarkQueued({
        jobQueue,
        stateManager: this.ctx.stateManager,
        sessionId: this.ctx.session.id,
        messageUuid: uuid,
        origin,
      });
    }
  }

  /**
   * Send enqueued messages when the agent turn ends / on (re)hydration
   * (auto-defer mode + startup replay). Under durable delivery, each enqueued
   * message is routed through `deliverMessage` — the handler drives it as a
   * turn (if idle) or steer (if a turn is active), with the durable owner's
   * full guarantees. Legacy opt-out keeps the inline path.
   */
  async sendEnqueuedMessagesOnTurnEnd(): Promise<void> {
    const { session, db, messageQueue, logger } = this.ctx;

    try {
      const queuedMessages = db.getMessagesByStatus(session.id, 'enqueued');

      if (queuedMessages.length === 0) {
        return;
      }

      if (isMessageDeliveryV2Enabled()) {
        // Durable: enqueue a delivery job per message via the queued-marker
        // wrapper (see handleQueryTrigger). Already-enqueued rows need no
        // status flip; deliverAndMarkQueued is idempotent via getActiveDeliveryRole.
        // Multiple messages flushing together on an idle session coalesce into
        // ONE batched turn (see deliverFlushUnderV2).
        await this.deliverFlushUnderV2(queuedMessages, 'recovery');
      } else {
        // Legacy inline path (HYPERNEO_MESSAGE_DELIVERY_V2=0 opt-out). Exclude
        // UUIDs still owned by a durable job (see handleQueryTrigger). (Codex P1.)
        const v2Owned =
          db.getJobQueueRepo?.()?.activeDeliveryMessageUuids?.(session.id) ?? new Set<string>();
        await this.ctx.ensureQueryStarted();
        for (const msg of queuedMessages) {
          if (!isSDKUserMessage(msg)) continue;
          if (v2Owned.has((msg.uuid ?? '') as string)) continue;
          const replayContent = this.toReplayContent(msg.message.content);
          if (replayContent) {
            await messageQueue.enqueueWithId(msg.uuid as string, replayContent);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to send enqueued messages on turn end:', error);
    }
  }

  /**
   * Replay persisted pending messages for immediate mode startup/recovery.
   * Priority: current-turn queued messages first, then next-turn deferred messages.
   */
  async replayPendingMessagesForImmediateMode(): Promise<void> {
    await this.sendEnqueuedMessagesOnTurnEnd();
    await this.handleQueryTrigger();
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
