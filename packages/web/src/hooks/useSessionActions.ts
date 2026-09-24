import { useState, useCallback } from 'preact/hooks';
import type {
  ArchiveSessionResponse,
  CloneChildrenChoice,
  CloneSummary,
  Session,
} from '@hyperneo/shared';
import { connectionManager } from '../lib/connection-manager';
import { deleteSession, listSessions, archiveSession, resetSessionQuery } from '../lib/api-helpers';
import { toast } from '../lib/toast';
import { currentSessionIdSignal, sessionsSignal } from '../lib/signals';
import { connectionState } from '../lib/state';

export interface ArchiveConfirmState {
  show: boolean;
  commitStatus?: ArchiveSessionResponse['commitStatus'];
}

export interface CloneChoiceState {
  action: 'archive' | 'delete';
  clones: CloneSummary[];
}

export interface UseSessionActionsOptions {
  sessionId: string;
  session: Session | null;
  onDeleteModalClose: () => void;
  onStateReset: () => void;
}

export interface UseSessionActionsResult {
  archiving: boolean;
  deleting: boolean;
  resettingAgent: boolean;
  archiveConfirmDialog: ArchiveConfirmState | null;
  cloneChoiceDialog: CloneChoiceState | null;

  handleDeleteSession: () => Promise<void>;
  handleCloneChoice: (choice: CloneChildrenChoice) => Promise<void>;
  handleCancelCloneChoice: () => void;
  handleArchiveClick: () => Promise<void>;
  handleConfirmArchive: () => Promise<void>;
  handleCancelArchive: () => void;
  handleResetAgent: () => Promise<void>;
  handleExportChat: () => Promise<void>;
}

export function useSessionActions({
  sessionId,
  session,
  onDeleteModalClose,
  onStateReset,
}: UseSessionActionsOptions): UseSessionActionsResult {
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resettingAgent, setResettingAgent] = useState(false);
  const [archiveConfirmDialog, setArchiveConfirmDialog] = useState<ArchiveConfirmState | null>(
    null
  );
  const [cloneChoiceDialog, setCloneChoiceDialog] = useState<CloneChoiceState | null>(null);

  const isConnected = connectionState.value === 'connected';

  const handleDeleteSession = useCallback(
    async (children?: CloneChildrenChoice) => {
      try {
        setDeleting(true);
        const result = await deleteSession(sessionId, children);
        if (result.reason === 'has_clones' && result.clones) {
          setCloneChoiceDialog({ action: 'delete', clones: result.clones });
          return;
        }
        setCloneChoiceDialog(null);
        onDeleteModalClose();
        const response = await listSessions();
        sessionsSignal.value = response.sessions;
        setTimeout(() => {
          currentSessionIdSignal.value = null;
        }, 0);
        toast.success('Session deleted');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete session');
      } finally {
        setDeleting(false);
      }
    },
    [sessionId, onDeleteModalClose]
  );

  const handleArchiveClick = useCallback(
    async (children?: CloneChildrenChoice) => {
      try {
        setArchiving(true);
        const result = await archiveSession(sessionId, false, children);
        if (result.reason === 'has_clones' && result.clones) {
          setCloneChoiceDialog({ action: 'archive', clones: result.clones });
        } else if (result.requiresConfirmation && result.commitStatus) {
          setCloneChoiceDialog(null);
          setArchiveConfirmDialog({
            show: true,
            commitStatus: result.commitStatus,
          });
        } else if (result.success) {
          setCloneChoiceDialog(null);
          toast.success('Session archived successfully');
          const response = await listSessions();
          sessionsSignal.value = response.sessions;
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to archive session');
      } finally {
        setArchiving(false);
      }
    },
    [sessionId]
  );

  const handleCloneChoice = useCallback(
    async (choice: CloneChildrenChoice) => {
      if (!cloneChoiceDialog) return;
      await (cloneChoiceDialog.action === 'delete'
        ? handleDeleteSession(choice)
        : handleArchiveClick(choice));
    },
    [cloneChoiceDialog, handleDeleteSession, handleArchiveClick]
  );

  const handleCancelCloneChoice = useCallback(() => {
    setCloneChoiceDialog(null);
  }, []);

  const handleConfirmArchive = useCallback(async () => {
    try {
      setArchiving(true);
      const result = await archiveSession(sessionId, true);
      if (result.success) {
        toast.success(`Session archived (${result.commitsRemoved} commits removed)`);
        setArchiveConfirmDialog(null);
        const response = await listSessions();
        sessionsSignal.value = response.sessions;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to archive session');
    } finally {
      setArchiving(false);
    }
  }, [sessionId]);

  const handleCancelArchive = useCallback(() => {
    setArchiveConfirmDialog(null);
  }, []);

  const handleResetAgent = useCallback(async () => {
    if (!isConnected) {
      toast.error('Not connected to server');
      return;
    }

    try {
      setResettingAgent(true);
      const result = await resetSessionQuery(sessionId);

      if (result.success) {
        toast.success('Agent reset successfully.');
        onStateReset();
      } else {
        toast.error(result.error || 'Failed to reset agent');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset agent');
    } finally {
      setResettingAgent(false);
    }
  }, [sessionId, isConnected, onStateReset]);

  const handleExportChat = useCallback(async () => {
    if (!isConnected) {
      toast.error('Not connected to server');
      return;
    }
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        toast.error('Not connected to server');
        return;
      }
      const result = await hub.request<{ markdown: string }>('session.export', {
        sessionId,
        format: 'markdown',
      });
      const blob = new Blob([result.markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${session?.title || 'chat'}-export.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Chat exported!');
    } catch {
      toast.error('Failed to export chat');
    }
  }, [sessionId, session?.title, isConnected]);

  return {
    archiving,
    deleting,
    resettingAgent,
    archiveConfirmDialog,
    cloneChoiceDialog,
    handleDeleteSession,
    handleCloneChoice,
    handleCancelCloneChoice,
    handleArchiveClick,
    handleConfirmArchive,
    handleCancelArchive,
    handleResetAgent,
    handleExportChat,
  };
}
