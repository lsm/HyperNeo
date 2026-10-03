import type { Session } from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { useSessionRename } from '../hooks/useSessionRename';
import { conversationTitle, getSessionSidebarStatus } from '../lib/session-sidebar-status.ts';
import { allSessionStatuses } from '../lib/session-status.ts';
import { currentSessionIdSignal } from '../lib/signals.ts';
import { ConversationRow } from './ConversationRow.tsx';

interface SessionListItemProps {
  session: Session;
  onSessionClick: (sessionId: string) => void;
  onArchive: (sessionId: string) => void | Promise<void>;
  disclosure?: ComponentChildren;
  unread?: boolean;
  displayTitle?: string;
  nested?: boolean;
}

export default function SessionListItem({
  session,
  onSessionClick,
  onArchive,
  disclosure,
  unread,
  displayTitle,
  nested = false,
}: SessionListItemProps) {
  const returnedAt = session.metadata?.clone?.returnedAt;
  const isClone = !!session.parentSessionId && !session.id.startsWith('neo:');
  const liveStatus = allSessionStatuses.value.get(session.id);
  const status = getSessionSidebarStatus({
    status: session.status,
    processingState: liveStatus?.processingState ?? session.processingState,
  });
  const isActive = currentSessionIdSignal.value === session.id;
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const { isEditing, startEditing, inputProps } = useSessionRename(session.id, session.title);

  const handleArchive = async () => {
    setArchiving(true);
    try {
      await onArchive(session.id);
    } finally {
      setArchiving(false);
      setConfirming(false);
    }
  };

  return (
    <ConversationRow
      title={displayTitle ?? conversationTitle(session.title, isClone)}
      selected={isActive}
      nested={nested}
      status={status}
      unreadCount={liveStatus?.unreadCount}
      unread={unread}
      disclosure={disclosure}
      onClick={() => onSessionClick(session.id)}
      onTitleDoubleClick={startEditing}
      titleHint="Double-click or press F2 to rename"
      rowTestId="session-row"
      testId="session-card"
      sessionId={session.id}
      onMouseLeave={() => {
        if (!archiving) setConfirming(false);
      }}
      editor={
        isEditing && (
          <input
            type="text"
            data-testid="session-rename-input"
            {...inputProps}
            class="flex-1 min-w-0 mx-2.5 my-0.5 px-1.5 py-1 text-sm bg-fill rounded-md text-fg outline-none ring-1 ring-accent/60"
          />
        )
      }
      actions={
        session.status !== 'archived' && (
          <div class="flex items-center">
            {confirming ? (
              <button
                type="button"
                data-testid="session-archive-confirm"
                onClick={handleArchive}
                disabled={archiving}
                class="h-[26px] rounded-md bg-danger px-2 text-[11px] font-semibold text-on-danger transition-colors hover:bg-danger disabled:opacity-60"
              >
                {archiving ? 'Archiving…' : 'Archive'}
              </button>
            ) : (
              <button
                type="button"
                data-testid="session-archive"
                onClick={() => setConfirming(true)}
                title="Archive chat"
                aria-label={`Archive ${session.title || 'chat'}`}
                class="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={1.75}
                    d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"
                  />
                </svg>
              </button>
            )}
          </div>
        )
      }
    >
      {isClone && returnedAt && (
        <span
          class="flex-shrink-0 text-xs text-fg-faint"
          data-testid="session-clone-returned"
          title={`Returned ${returnedAt}`}
        >
          ✓
        </span>
      )}
    </ConversationRow>
  );
}
