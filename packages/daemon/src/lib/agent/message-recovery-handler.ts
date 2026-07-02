/**
 * MessageRecoveryHandler - Marks orphaned messages as failed
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - Detecting messages stuck in 'consumed' status with no system:init response
 * - Marking those messages as 'failed' so they appear in the UI as undelivered
 */

import type { Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { isSDKUserMessage } from '@hyperneo/shared/sdk/type-guards';
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
      // Only consumed user messages after the latest system:init can be orphaned.
      // Do the status/type/timestamp filtering in SQL so cold-opening an old,
      // large session does not parse the whole transcript.
      const candidateMessages = db.getConsumedUserMessagesAfterLatestInit(session.id);

      if (candidateMessages.length === 0) {
        return;
      }

      // Find orphaned user messages
      const orphanedMessages: Array<{
        dbId: string;
        uuid: string;
        timestamp: number;
      }> = [];

      for (const consumedMsg of candidateMessages) {
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

        const msgTimestamp = (consumedMsg as SDKMessage & { timestamp?: number }).timestamp || 0;
        orphanedMessages.push({
          dbId: consumedMsg.dbId,
          uuid: consumedMsg.uuid || 'unknown',
          timestamp: msgTimestamp,
        });
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
