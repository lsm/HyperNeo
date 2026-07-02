/**
 * Rewind RPC Handlers
 *
 * RPC handlers for the rewind feature, which allows restoring workspace files
 * and/or conversation to a previous checkpoint.
 *
 * Follows the 3-layer communication pattern:
 * - RPC handlers do minimal work and return fast (<100ms)
 * - Heavy operations are deferred to InternalEventBus<DaemonInternalEventMap> subscribers
 * - State updates are broadcast via State Channels
 */

import type { MessageHub } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SessionManager } from '../session-manager';
import type { RewindMode, SelectiveRewindRequest } from '@hyperneo/shared';

export function setupRewindHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  _internalEventBus: InternalEventBus<DaemonInternalEventMap>
): void {
  /**
   * Get all rewind points for a session
   *
   * Request: { sessionId: string }
   * Response: { rewindPoints: RewindPoint[]; error?: string }
   */
  messageHub.onRequest('rewind.checkpoints', async (data) => {
    const { sessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      return {
        rewindPoints: [],
        error: 'Session not found',
      };
    }

    const rewindPoints = agentSession.getRewindPoints();
    return { rewindPoints };
  });

  /**
   * Preview a rewind operation (dry run)
   *
   * Request: { sessionId: string; checkpointId: string }
   * Response: { preview: RewindPreview }
   */
  messageHub.onRequest('rewind.preview', async (data) => {
    const { sessionId, checkpointId } = data as { sessionId: string; checkpointId: string };

    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      return {
        preview: {
          canRewind: false,
          error: 'Session not found',
        },
      };
    }

    const preview = await agentSession.previewRewind(checkpointId);
    return { preview };
  });

  /**
   * Execute a rewind operation
   *
   * Request: { sessionId: string; checkpointId: string; mode?: RewindMode }
   * Response: { result: RewindResult }
   *
   * Modes:
   * - 'files': Restore file changes only (default, non-destructive)
   * - 'conversation': Resume conversation from checkpoint (deletes messages after checkpoint)
   * - 'both': Full rewind of both files and conversation
   */
  messageHub.onRequest('rewind.execute', async (data) => {
    const {
      sessionId,
      checkpointId,
      mode = 'files',
    } = data as {
      sessionId: string;
      checkpointId: string;
      mode?: RewindMode;
    };

    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      return {
        result: {
          success: false,
          error: 'Session not found',
        },
      };
    }

    const result = await agentSession.executeRewind(checkpointId, mode);
    return { result };
  });

  /**
   * Preview a selective rewind operation (dry run)
   *
   * Selective rewind allows choosing specific messages to rewind,
   * deleting all messages from the first selected message onward.
   *
   * Request: SelectiveRewindRequest
   * Response: { preview: SelectiveRewindPreview }
   */
  messageHub.onRequest('rewind.previewSelective', async (data) => {
    const { sessionId, messageIds } = data as SelectiveRewindRequest;

    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      return {
        preview: {
          canRewind: false,
          error: 'Session not found',
          messagesToDelete: 0,
          filesToRevert: [],
        },
      };
    }

    if (messageIds.length === 0) {
      return {
        preview: {
          canRewind: false,
          error: 'No messages selected',
          messagesToDelete: 0,
          filesToRevert: [],
        },
      };
    }

    // Get the first selected message (earliest timestamp)
    // All messages from this point onward will be deleted
    const preview = await agentSession.previewSelectiveRewind(messageIds);
    return { preview };
  });

  /**
   * Execute a selective rewind operation
   *
   * Request: SelectiveRewindRequest
   * Response: { result: SelectiveRewindResult }
   */
  messageHub.onRequest('rewind.executeSelective', async (data) => {
    const {
      sessionId,
      messageIds,
      mode = 'both',
    } = data as SelectiveRewindRequest & { mode?: RewindMode };

    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) {
      return {
        result: {
          success: false,
          error: 'Session not found',
          messagesDeleted: 0,
          filesReverted: [],
        },
      };
    }

    if (messageIds.length === 0) {
      return {
        result: {
          success: false,
          error: 'No messages selected',
          messagesDeleted: 0,
          filesReverted: [],
        },
      };
    }

    const result = await agentSession.executeSelectiveRewind(messageIds, mode);
    return { result };
  });
}
