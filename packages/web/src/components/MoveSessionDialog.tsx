import type { Session } from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { sessions } from '../lib/state.ts';
import { toast } from '../lib/toast.ts';
import { Modal } from './ui/Modal.tsx';

type MoveResult = { accepted: true } | { accepted: false; message: string };

export function movableSession(session: Session): boolean {
  return !session.id.startsWith('neo:') && !session.context?.spaceId;
}

export function parentCandidates(session: Session, all: readonly Session[]): Session[] {
  return all.filter(
    (item) =>
      item.id !== session.id &&
      !item.parentSessionId &&
      item.status !== 'archived' &&
      movableSession(item)
  );
}

export async function moveSession(sessionId: string, parentSessionId: string | null) {
  const hub = connectionManager.getHubIfConnected();
  if (!hub) {
    toast.error('Reconnect before moving this chat.');
    return false;
  }
  const result = await invokeOperation<MoveResult>(hub, 'session.parent.set', {
    sessionId,
    parentSessionId,
  });
  if (!result.accepted) toast.error(result.message);
  return result.accepted;
}

export function MoveSessionDialog({
  session,
  isOpen,
  onClose,
}: {
  session: Session;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const candidates = parentCandidates(session, sessions.value);
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Move under another chat" size="sm">
      {candidates.length === 0 ? (
        <p class="text-sm text-fg-muted">No top-level chats to move this under.</p>
      ) : (
        <ul class="max-h-80 space-y-1 overflow-y-auto">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                disabled={busy}
                class="w-full truncate rounded-lg px-3 py-2 text-left text-sm hover:bg-fill-soft disabled:opacity-50"
                onClick={async () => {
                  setBusy(true);
                  try {
                    if (await moveSession(session.id, candidate.id)) onClose();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {candidate.title || 'Untitled chat'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
