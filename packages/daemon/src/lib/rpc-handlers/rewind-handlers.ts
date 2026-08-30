import type { MessageHub } from '@hyperneo/shared';
import { withSessionOperationLock } from '../agent/message-delivery.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { SessionManager } from '../session-manager.ts';
import type { RewindMode, SelectiveRewindRequest } from '@hyperneo/shared';

export function setupRewindHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  _internalEventBus: InternalEventBus<DaemonInternalEventMap>
): void {
  messageHub.onRequest('rewind.checkpoints', async (data) => {
    const { sessionId } = data as { sessionId: string };

    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) {
      return {
        rewindPoints: [],
        error: 'Session not found',
      };
    }

    const rewindPoints = agentSession.getRewindPoints();
    return { rewindPoints };
  });

  messageHub.onRequest('rewind.preview', async (data) => {
    const { sessionId, checkpointId } = data as { sessionId: string; checkpointId: string };

    const agentSession = await sessionManager.getSessionAsync(sessionId, {
      replayPendingMessages: false,
    });
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

    const agentSession = await sessionManager.getSessionAsync(sessionId, {
      replayPendingMessages: false,
    });
    if (!agentSession) {
      return {
        result: {
          success: false,
          error: 'Session not found',
        },
      };
    }

    const result = await withSessionOperationLock(sessionId, () =>
      agentSession.executeRewind(checkpointId, mode)
    );
    if (agentSession.getSessionData().config.queryMode !== 'manual') {
      await agentSession.replayPendingMessagesForImmediateMode();
    }
    return { result };
  });

  messageHub.onRequest('rewind.previewSelective', async (data) => {
    const { sessionId, messageIds } = data as SelectiveRewindRequest;

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

    const agentSession = await sessionManager.getSessionAsync(sessionId, {
      replayPendingMessages: false,
    });
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

    const preview = await agentSession.previewSelectiveRewind(messageIds);
    return { preview };
  });

  messageHub.onRequest('rewind.executeSelective', async (data) => {
    const {
      sessionId,
      messageIds,
      mode = 'both',
    } = data as SelectiveRewindRequest & { mode?: RewindMode };

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

    const agentSession = await sessionManager.getSessionAsync(sessionId, {
      replayPendingMessages: false,
    });
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

    const result = await withSessionOperationLock(sessionId, () =>
      agentSession.executeSelectiveRewind(messageIds, mode)
    );
    if (agentSession.getSessionData().config.queryMode !== 'manual') {
      await agentSession.replayPendingMessagesForImmediateMode();
    }
    return { result };
  });
}
