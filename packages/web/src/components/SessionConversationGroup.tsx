import type { Session } from '@hyperneo/shared';
import { useState } from 'preact/hooks';
import { currentSessionIdSignal } from '../lib/signals';
import { allSessionStatuses } from '../lib/session-status';
import { conversationTitle } from '../lib/session-sidebar-status';
import { ConversationDisclosure } from './ConversationDisclosure';
import SessionListItem from './SessionListItem';

interface SessionConversationGroupProps {
  session: Session;
  childSessions: Session[];
  onSessionClick: (sessionId: string) => void;
  onArchive: (sessionId: string) => void | Promise<void>;
}

export function SessionConversationGroup({
  session,
  childSessions,
  onSessionClick,
  onArchive,
}: SessionConversationGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const selectedId = currentSessionIdSignal.value;
  const visible = expanded
    ? childSessions
    : childSessions.filter((child) => child.id === selectedId);
  const hiddenUnread =
    !expanded &&
    childSessions.some(
      (child) =>
        child.id !== selectedId && (allSessionStatuses.value.get(child.id)?.unreadCount ?? 0) > 0
    );
  return (
    <div>
      <SessionListItem
        session={session}
        onSessionClick={onSessionClick}
        onArchive={onArchive}
        unread={hiddenUnread}
        disclosure={
          childSessions.length > 0 && (
            <ConversationDisclosure
              expanded={expanded}
              title={conversationTitle(session.title, !!session.parentSessionId)}
              onToggle={() => setExpanded((value) => !value)}
            />
          )
        }
      />
      {visible.map((child) => (
        <SessionListItem
          key={child.id}
          session={child}
          onSessionClick={onSessionClick}
          onArchive={onArchive}
          nested
        />
      ))}
    </div>
  );
}
