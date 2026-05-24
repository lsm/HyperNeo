/**
 * MessageRecoveryHandler - Marks orphaned messages as failed
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - Detecting messages stuck in 'consumed' status with no system:init response
 * - Marking those messages as 'failed' so they appear in the UI as undelivered
 */

import type { Session, ChatMessage } from '@neokai/shared';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import { isSDKUserMessage, isSDKSystemMessage } from '@neokai/shared/sdk/type-guards';
import { Database } from '../../storage/database';
import { Logger } from '../logger';

/**
 * Recovers orphaned messages for a session
 */
export class MessageRecoveryHandler {
  private session: Session;
  private db: Database;
  private logger: Logger;

  constructor(session: Session, db: Database, logger: Logger) {
    this.session = session;
    this.db = db;
    this.logger = logger;
  }

  /**
   * Mark orphaned consumed messages as failed
   *
   * For consumed messages with no system:init boundary after them (i.e. the server
   * crashed before Claude responded), mark them as 'failed' so they appear in
   * the UI as undelivered. The user can see what was lost without silent re-dispatch.
   *
   * Synthetic messages and tool_result-only messages are skipped — they are
   * SDK-internal and should not be surfaced as user-facing failures.
   */
  recoverOrphanedConsumedMessages(): void {
    const { session, db, logger } = this;

    try {
      // Consumed messages may need recovery if they never got a corresponding
      // system:init/response boundary after being marked consumed.
      const consumedMessages = db.getMessagesByStatus(session.id, 'consumed');
      const allStuckMessages = [...consumedMessages];

      if (allStuckMessages.length === 0) {
        return;
      }

      // Get all SDK messages to check for responses
      const { messages: allMessages } = db.getSDKMessages(session.id, 10000);

      // Find the latest system:init message timestamp
      let latestInitTimestamp = 0;
      for (const msg of allMessages as Array<ChatMessage & { timestamp?: number }>) {
        // Skip NeoKai-native action messages — they are not SDK messages.
        if ((msg as ChatMessage).type === 'neokai_action') continue;
        if (
          isSDKSystemMessage(msg as SDKMessage) &&
          (msg as SDKMessage & { subtype?: string }).subtype === 'init'
        ) {
          const msgWithTimestamp = msg as SDKMessage & { timestamp?: number };
          if (msgWithTimestamp.timestamp && msgWithTimestamp.timestamp > latestInitTimestamp) {
            latestInitTimestamp = msgWithTimestamp.timestamp;
          }
        }
      }

      // Find orphaned user messages
      const orphanedMessages: Array<{
        dbId: string;
        uuid: string;
        timestamp: number;
      }> = [];

      for (const consumedMsg of allStuckMessages) {
        if (!isSDKUserMessage(consumedMsg)) {
          continue;
        }

        // Skip synthetic messages (SDK-generated tool results, not human-typed).
        // These are saved by saveSDKMessage with isSynthetic=true and should not
        // be recovered — they are internal SDK messages, not user input.
        const userMsg = consumedMsg as SDKUserMessage & { isSynthetic?: boolean };
        if (userMsg.isSynthetic) {
          continue;
        }

        // Also skip messages whose content is entirely tool_result blocks.
        // Even without the isSynthetic flag (e.g. older messages), tool_result
        // content is never human-typed input.
        if (isToolResultOnlyContent(userMsg.message.content)) {
          continue;
        }

        const msgWithTimestamp = consumedMsg as SDKMessage & { timestamp?: number };
        const msgTimestamp = msgWithTimestamp.timestamp || 0;

        // If no system:init after this message, it's orphaned
        if (msgTimestamp > latestInitTimestamp) {
          orphanedMessages.push({
            dbId: consumedMsg.dbId,
            uuid: consumedMsg.uuid || 'unknown',
            timestamp: msgTimestamp,
          });
        }
      }

      if (orphanedMessages.length === 0) {
        return;
      }

      // Mark orphaned messages as 'failed' so they surface in the UI as undelivered
      const dbIds = orphanedMessages.map((m) => m.dbId);
      db.updateMessageStatus(dbIds, 'failed');
    } catch (error) {
      logger.warn('Failed to mark orphaned consumed messages as failed:', error);
      // Don't throw - recovery failure shouldn't prevent session from loading
    }
  }
}

/**
 * Check if message content consists entirely of tool_result blocks
 * (no human-typed text content).
 */
function isToolResultOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every(
    (block) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool_result'
  );
}
