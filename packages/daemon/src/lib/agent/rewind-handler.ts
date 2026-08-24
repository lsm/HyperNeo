import type {
  RewindMode,
  RewindPreview,
  RewindResult,
  SelectiveRewindPreview,
  SelectiveRewindResult,
  Session,
} from '@hyperneo/shared';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Database } from '../../storage/database.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Logger } from '../logger.ts';
import {
  messageUuidExistsInSessionFile,
  truncateSessionFileAtMessage,
} from '../sdk-session-file-manager.ts';
import type { QueryLifecycleManager } from './query-lifecycle-manager.ts';
import type { QueryLike } from './query-like.ts';

export interface RewindPoint {
  uuid: string;
  timestamp: number;
  content: string;
  turnNumber: number;
}

export type RewindCase = 'sdk-native' | 'diff-based' | 'hybrid';

export interface FileOperation {
  type: 'edit' | 'write' | 'multiEdit';
  filePath: string;
  oldString?: string;
  newString?: string;
  content?: string;
}

export interface RewindCaseAnalysis {
  rewindCase: RewindCase;
  oldestUserMessage?: { uuid: string; timestamp: number };
  messagesBeforeUser: Array<Record<string, unknown>>;
}

export interface RewindHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly lifecycleManager: QueryLifecycleManager;
  readonly logger: Logger;
  readonly queryObject: QueryLike | null;
  readonly firstMessageReceived: boolean;
  setPendingResumeSessionAt(messageUuid: string): void;
  clearPendingResumeSessionAt(): void;
}

export class RewindHandler {
  constructor(private ctx: RewindHandlerContext) {}

  getRewindPoints(): RewindPoint[] {
    const { session, db } = this.ctx;
    const userMessages = db.getUserMessages(session.id);

    return userMessages
      .map((msg, idx) => ({
        uuid: msg.uuid,
        timestamp: msg.timestamp,
        content: msg.content,
        turnNumber: idx + 1,
      }))
      .reverse();
  }

  getRewindPoint(uuid: string): RewindPoint | undefined {
    const { session, db } = this.ctx;
    const userMessage = db.getUserMessageByUuid(session.id, uuid);
    if (!userMessage) return undefined;

    const allMessages = db.getUserMessages(session.id);
    const turnNumber = allMessages.findIndex((m) => m.uuid === uuid) + 1;

    return {
      uuid: userMessage.uuid,
      timestamp: userMessage.timestamp,
      content: userMessage.content,
      turnNumber,
    };
  }

  async previewRewind(checkpointId: string): Promise<RewindPreview> {
    const { db, queryObject, firstMessageReceived, logger, session } = this.ctx;

    const rewindPoint = this.getRewindPoint(checkpointId);
    if (!rewindPoint) {
      return { canRewind: false, error: `Rewind point ${checkpointId} not found` };
    }

    if (!queryObject) {
      return { canRewind: false, error: 'SDK query not active. Start a conversation first.' };
    }

    if (!firstMessageReceived) {
      return {
        canRewind: false,
        error: 'SDK not ready. Please wait for the session to initialize.',
      };
    }

    try {
      const sdkResult = await queryObject.rewindFiles(checkpointId, { dryRun: true });

      const messagesAffected = db.countMessagesAfter(session.id, rewindPoint.timestamp);

      return {
        canRewind: sdkResult.canRewind,
        error: sdkResult.error,
        filesChanged: sdkResult.filesChanged,
        insertions: sdkResult.insertions,
        deletions: sdkResult.deletions,
        messagesAffected,
      };
    } catch (error) {
      logger.error('Rewind preview failed:', error);
      return { canRewind: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async executeRewind(checkpointId: string, mode: RewindMode): Promise<RewindResult> {
    const { session, internalEventBus, queryObject, firstMessageReceived, logger } = this.ctx;

    const rewindPoint = this.getRewindPoint(checkpointId);
    if (!rewindPoint) {
      return { success: false, error: `Rewind point ${checkpointId} not found` };
    }

    if (!queryObject) {
      return { success: false, error: 'SDK query not active. Start a conversation first.' };
    }

    if (!firstMessageReceived) {
      return { success: false, error: 'SDK not ready. Please wait for the session to initialize.' };
    }

    await internalEventBus.publish('rewind.started', { sessionId: session.id, checkpointId, mode });

    try {
      if (mode === 'files') {
        const sdkResult = await queryObject.rewindFiles(checkpointId);

        if (!sdkResult.canRewind) {
          await internalEventBus.publish('rewind.failed', {
            sessionId: session.id,
            checkpointId,
            mode,
            error: sdkResult.error || 'Rewind failed',
          });
          return { success: false, error: sdkResult.error };
        }

        await internalEventBus.publish('rewind.completed', {
          sessionId: session.id,
          checkpointId,
          mode,
          result: {
            success: true,
            filesChanged: sdkResult.filesChanged,
            insertions: sdkResult.insertions,
            deletions: sdkResult.deletions,
          },
        });

        return {
          success: true,
          filesChanged: sdkResult.filesChanged,
          insertions: sdkResult.insertions,
          deletions: sdkResult.deletions,
        };
      }

      if (mode === 'conversation') {
        return await this.executeConversationRewind(checkpointId, rewindPoint);
      }

      let fileResult: { filesChanged?: string[]; insertions?: number; deletions?: number } = {};
      try {
        const sdkResult = await queryObject.rewindFiles(checkpointId);
        if (sdkResult.canRewind) {
          fileResult = {
            filesChanged: sdkResult.filesChanged,
            insertions: sdkResult.insertions,
            deletions: sdkResult.deletions,
          };
        }
      } catch (fileError) {
        logger.error('File rewind failed (proceeding with conversation rewind):', fileError);
      }

      const conversationResult = await this.executeConversationRewind(checkpointId, rewindPoint);

      await internalEventBus.publish('rewind.completed', {
        sessionId: session.id,
        checkpointId,
        mode,
        result: {
          success: conversationResult.success,
          filesChanged: fileResult.filesChanged,
          messagesDeleted: conversationResult.messagesDeleted,
        },
      });

      return {
        success: conversationResult.success,
        error: conversationResult.error,
        filesChanged: fileResult.filesChanged,
        insertions: fileResult.insertions,
        deletions: fileResult.deletions,
        conversationRewound: conversationResult.conversationRewound,
        messagesDeleted: conversationResult.messagesDeleted,
      };
    } catch (error) {
      logger.error('Rewind execution failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      await internalEventBus.publish('rewind.failed', {
        sessionId: session.id,
        checkpointId,
        mode,
        error: errorMessage,
      });

      return { success: false, error: errorMessage };
    }
  }

  private async executeConversationRewind(
    checkpointId: string,
    rewindPoint: RewindPoint
  ): Promise<RewindResult> {
    const { session, db, lifecycleManager } = this.ctx;

    const messagesDeleted = db.deleteMessagesAtAndAfter(session.id, rewindPoint.timestamp);

    const sdkWorkspacePath = session.worktree
      ? session.worktree.worktreePath
      : session.workspacePath;
    if (!sdkWorkspacePath) {
      throw new Error('Cannot rewind unbound session without a workspace path');
    }
    const _jsonlResult = truncateSessionFileAtMessage(
      sdkWorkspacePath,
      session.sdkSessionId,
      session.id,
      checkpointId
    );

    const remainingUserMessages = db.getUserMessages(session.id);
    const previousUserMessage =
      remainingUserMessages.length > 0
        ? remainingUserMessages[remainingUserMessages.length - 1]
        : null;

    if (
      previousUserMessage &&
      messageUuidExistsInSessionFile(
        sdkWorkspacePath,
        session.sdkSessionId,
        session.id,
        previousUserMessage.uuid
      )
    ) {
      this.ctx.setPendingResumeSessionAt(previousUserMessage.uuid);
    } else {
      this.ctx.clearPendingResumeSessionAt();
    }

    await lifecycleManager.restart();

    return { success: true, conversationRewound: true, messagesDeleted };
  }

  analyzeRewindCase(
    earliestMessage: Record<string, unknown>,
    messagesInRange: Array<Record<string, unknown>>,
    userMessagesInRange: Array<{ uuid: string; timestamp: number }>
  ): RewindCaseAnalysis {
    const earliestType = earliestMessage.type as string;

    if (earliestType === 'user') {
      return {
        rewindCase: 'sdk-native',
        messagesBeforeUser: [],
      };
    }

    if (userMessagesInRange.length === 0) {
      return {
        rewindCase: 'diff-based',
        messagesBeforeUser: messagesInRange.filter((m) => m.type === 'assistant'),
      };
    }

    const sortedUserMessages = [...userMessagesInRange].sort((a, b) => a.timestamp - b.timestamp);
    const oldestUserMessage = sortedUserMessages[0];

    const messagesBeforeUser = messagesInRange.filter((m) => {
      const msgTimestamp = m.timestamp as number;
      return m.type === 'assistant' && msgTimestamp < oldestUserMessage.timestamp;
    });

    return {
      rewindCase: 'hybrid',
      oldestUserMessage,
      messagesBeforeUser,
    };
  }

  extractFileOperations(messages: Array<Record<string, unknown>>): FileOperation[] {
    const operations: FileOperation[] = [];

    const assistantMessages = messages.filter((m) => m.type === 'assistant');

    for (const message of assistantMessages) {
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type !== 'tool_use') continue;

        const name = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        if (!input) continue;

        if (name === 'Edit') {
          operations.push({
            type: 'edit',
            filePath: input.file_path as string,
            oldString: input.old_string as string,
            newString: input.new_string as string,
          });
        } else if (name === 'Write') {
          operations.push({
            type: 'write',
            filePath: input.file_path as string,
            content: input.content as string,
          });
        } else if (name === 'MultiEdit') {
          const edits = Array.isArray(input.edits) ? input.edits : [];
          for (const edit of edits) {
            if (!edit || typeof edit !== 'object') continue;
            const item = edit as Record<string, unknown>;
            operations.push({
              type: 'multiEdit',
              filePath: input.file_path as string,
              oldString: item.old_string as string,
              newString: item.new_string as string,
            });
          }
        }
      }
    }

    return operations;
  }

  async revertFileOperations(
    operations: FileOperation[]
  ): Promise<{ reverted: string[]; failed: string[]; skipped: string[] }> {
    const { logger } = this.ctx;
    const reverted: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];

    const reversedOps = [...operations].reverse();

    for (const op of reversedOps) {
      if (op.type === 'write') {
        skipped.push(op.filePath);
        continue;
      }

      try {
        if (!existsSync(op.filePath)) {
          failed.push(op.filePath);
          logger.warn(`Diff revert failed: file not found: ${op.filePath}`);
          continue;
        }

        const fileContent = readFileSync(op.filePath, 'utf-8');

        if (!op.newString || !op.oldString) {
          failed.push(op.filePath);
          logger.warn(`Diff revert failed: missing old/new strings for ${op.filePath}`);
          continue;
        }

        if (!fileContent.includes(op.newString)) {
          failed.push(op.filePath);
          logger.warn(`Diff revert failed: newString not found in ${op.filePath}`);
          continue;
        }

        const revertedContent = fileContent.replace(op.newString, op.oldString);
        writeFileSync(op.filePath, revertedContent, 'utf-8');

        if (!reverted.includes(op.filePath)) {
          reverted.push(op.filePath);
        }
      } catch (error) {
        failed.push(op.filePath);
        logger.error(`Diff revert error for ${op.filePath}:`, error);
      }
    }

    return { reverted, failed, skipped };
  }

  async previewSelectiveRewind(messageIds: string[]): Promise<SelectiveRewindPreview> {
    const { session, db, queryObject, firstMessageReceived, logger } = this.ctx;

    if (!queryObject) {
      return {
        canRewind: false,
        error: 'SDK query not active. Start a conversation first.',
        messagesToDelete: 0,
        filesToRevert: [],
      };
    }

    if (!firstMessageReceived) {
      return {
        canRewind: false,
        error: 'SDK not ready. Please wait for the session to initialize.',
        messagesToDelete: 0,
        filesToRevert: [],
      };
    }

    const { messages: allMessages } = db.getSDKMessages(session.id, 10000);
    const selectedMessages = allMessages.filter((m) => m.uuid && messageIds.includes(m.uuid));

    if (selectedMessages.length === 0) {
      return {
        canRewind: false,
        error: 'No valid messages found',
        messagesToDelete: 0,
        filesToRevert: [],
      };
    }

    const earliestMessage = selectedMessages.reduce((earliest, current) => {
      const currentTimestamp = (current as Record<string, unknown>).timestamp as number;
      const earliestTimestamp = (earliest as Record<string, unknown>).timestamp as number;
      return currentTimestamp < earliestTimestamp ? current : earliest;
    });

    const earliestTimestamp = (earliestMessage as Record<string, unknown>).timestamp as number;

    const messagesToDelete = allMessages.filter((m) => {
      const msgTimestamp = (m as Record<string, unknown>).timestamp as number;
      return msgTimestamp > earliestTimestamp;
    }).length;

    const checkpointId = messageIds[0];

    try {
      const sdkResult = await queryObject.rewindFiles(checkpointId, { dryRun: true });

      const filesToRevert = (sdkResult.filesChanged || []).map((path) => ({
        path,
        hasCheckpoint: true,
        hasEditDiff: false,
      }));

      return {
        canRewind: sdkResult.canRewind,
        error: sdkResult.error,
        messagesToDelete,
        filesToRevert,
      };
    } catch (error) {
      logger.error('Selective rewind preview failed:', error);
      return {
        canRewind: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        messagesToDelete,
        filesToRevert: [],
      };
    }
  }

  async executeSelectiveRewind(
    messageIds: string[],
    mode: RewindMode = 'both'
  ): Promise<SelectiveRewindResult> {
    const { session, db, lifecycleManager, queryObject, firstMessageReceived, logger } = this.ctx;

    if (!queryObject) {
      return {
        success: false,
        error: 'SDK query not active. Start a conversation first.',
        messagesDeleted: 0,
        filesReverted: [],
      };
    }

    if (!firstMessageReceived) {
      return {
        success: false,
        error: 'SDK not ready. Please wait for the session to initialize.',
        messagesDeleted: 0,
        filesReverted: [],
      };
    }

    const { messages: allMessages } = db.getSDKMessages(session.id, 10000);
    const selectedMessages = allMessages.filter((m) => m.uuid && messageIds.includes(m.uuid));

    if (selectedMessages.length === 0) {
      return {
        success: false,
        error: 'No valid messages found',
        messagesDeleted: 0,
        filesReverted: [],
      };
    }

    const earliestMessage = selectedMessages.reduce((earliest, current) => {
      const currentTimestamp = (current as Record<string, unknown>).timestamp as number;
      const earliestTimestamp = (earliest as Record<string, unknown>).timestamp as number;
      return currentTimestamp < earliestTimestamp ? current : earliest;
    });

    const earliestTimestamp = (earliestMessage as Record<string, unknown>).timestamp as number;

    try {
      const messagesInRange = allMessages.filter((m) => {
        const ts = (m as Record<string, unknown>).timestamp as number;
        return ts >= earliestTimestamp;
      });

      const userMessages = db.getUserMessages(session.id);
      const userMessagesInRange = userMessages.filter((um) => um.timestamp >= earliestTimestamp);

      const analysis = this.analyzeRewindCase(
        earliestMessage as Record<string, unknown>,
        messagesInRange,
        userMessagesInRange
      );

      let filesReverted: string[] = [];
      let diffRevertedFiles: string[] = [];

      if (mode === 'files' || mode === 'both') {
        switch (analysis.rewindCase) {
          case 'sdk-native': {
            const checkpointUuid = (earliestMessage as { uuid?: string }).uuid;
            if (checkpointUuid) {
              try {
                const sdkResult = await queryObject.rewindFiles(checkpointUuid);
                if (sdkResult.canRewind) {
                  filesReverted = sdkResult.filesChanged || [];
                }
              } catch (e) {
                logger.error('SDK file rewind failed:', e);
              }
            }
            break;
          }
          case 'diff-based': {
            const ops = this.extractFileOperations(messagesInRange);
            if (ops.length > 0) {
              const result = await this.revertFileOperations(ops);
              diffRevertedFiles = result.reverted;
              if (result.failed.length > 0) {
                logger.warn('Diff revert failed for:', result.failed);
              }
            }
            break;
          }
          case 'hybrid': {
            if (analysis.oldestUserMessage) {
              try {
                const sdkResult = await queryObject.rewindFiles(analysis.oldestUserMessage.uuid);
                if (sdkResult.canRewind) {
                  filesReverted = sdkResult.filesChanged || [];
                }
              } catch (e) {
                logger.error('SDK file rewind failed:', e);
              }
            }
            if (analysis.messagesBeforeUser.length > 0) {
              const ops = this.extractFileOperations(analysis.messagesBeforeUser);
              if (ops.length > 0) {
                const result = await this.revertFileOperations(ops);
                diffRevertedFiles = result.reverted;
                if (result.failed.length > 0) {
                  logger.warn('Diff revert failed for:', result.failed);
                }
              }
            }
            break;
          }
        }
      }

      let messagesDeleted = 0;
      if (mode === 'conversation' || mode === 'both') {
        messagesDeleted = db.deleteMessagesAtAndAfter(session.id, earliestTimestamp);

        const rewindSdkPath = session.worktree
          ? session.worktree.worktreePath
          : session.workspacePath;
        if (!rewindSdkPath) {
          throw new Error('Cannot rewind unbound session without a workspace path');
        }

        const jsonlUuid = (earliestMessage as { uuid?: string }).uuid;
        if (jsonlUuid) {
          const _jsonlResult = truncateSessionFileAtMessage(
            rewindSdkPath,
            session.sdkSessionId,
            session.id,
            jsonlUuid
          );
        }

        const remainingUserMessages = db.getUserMessages(session.id);
        const previousUserMessage =
          remainingUserMessages.length > 0
            ? remainingUserMessages[remainingUserMessages.length - 1]
            : null;

        if (
          previousUserMessage &&
          messageUuidExistsInSessionFile(
            rewindSdkPath,
            session.sdkSessionId,
            session.id,
            previousUserMessage.uuid
          )
        ) {
          this.ctx.setPendingResumeSessionAt(previousUserMessage.uuid);
        } else {
          this.ctx.clearPendingResumeSessionAt();
        }

        await lifecycleManager.restart();
      }

      return {
        success: true,
        messagesDeleted,
        filesReverted: [...filesReverted, ...diffRevertedFiles],
        rewindCase: analysis.rewindCase,
        diffRevertedFiles: diffRevertedFiles.length > 0 ? diffRevertedFiles : undefined,
      };
    } catch (error) {
      logger.error('Selective rewind execution failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,
        error: errorMessage,
        messagesDeleted: 0,
        filesReverted: [],
      };
    }
  }
}
