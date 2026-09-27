import type { ComponentChildren } from 'preact';
import type { SidebarSessionStatus } from '../lib/session-sidebar-status.ts';
import { cn } from '../lib/utils.ts';
import { SessionActivityIndicator } from './SessionActivityIndicator.tsx';

interface ConversationRowProps {
  title: string;
  selected?: boolean;
  nested?: boolean;
  status: SidebarSessionStatus;
  unreadCount?: number;
  unread?: boolean;
  onClick: () => void;
  onTitleDoubleClick?: () => void;
  titleHint?: string;
  actions?: ComponentChildren;
  disclosure?: ComponentChildren;
  children?: ComponentChildren;
  editor?: ComponentChildren;
  rowTestId?: string;
  testId?: string;
  sessionId?: string;
  onMouseLeave?: () => void;
}

export function ConversationRow({
  title,
  selected = false,
  nested = false,
  status,
  unreadCount = 0,
  unread = false,
  onClick,
  onTitleDoubleClick,
  titleHint,
  actions,
  disclosure,
  children,
  editor,
  rowTestId,
  testId,
  sessionId,
  onMouseLeave,
}: ConversationRowProps) {
  const hasUnread = unreadCount > 0 || unread;
  const showUnreadDot = hasUnread && ['idle', 'not_started', 'open'].includes(status.kind ?? '');
  return (
    <div
      data-testid={rowTestId}
      class={cn(
        'conversation-row group/row relative flex min-h-9 items-stretch rounded-[9px] transition-colors',
        nested && 'ml-[22px]',
        selected && 'is-selected'
      )}
      onMouseLeave={onMouseLeave}
    >
      {editor || (
        <>
          <button
            type="button"
            data-testid={testId}
            data-session-id={sessionId}
            aria-current={selected ? 'page' : undefined}
            onClick={onClick}
            onKeyDown={(event) => {
              if (event.key === 'F2' && onTitleDoubleClick) {
                event.preventDefault();
                onTitleDoubleClick();
              }
            }}
            title={[title, status.label, titleHint].filter(Boolean).join(' · ')}
            class={cn(
              'conversation-row__button flex flex-1 min-w-0 items-center gap-2.5 rounded-[9px] px-[9px] text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60'
            )}
          >
            <SessionActivityIndicator status={status} unreadCount={unreadCount} unread={unread} />
            <h3
              class={cn(
                'min-w-0 flex-1 truncate text-[13px]',
                hasUnread && 'conversation-row__title--unread font-semibold'
              )}
              onDblClick={onTitleDoubleClick}
              title={[title, status.label, titleHint].filter(Boolean).join(' · ')}
            >
              {title}
            </h3>
            {children}
            {hasUnread && !showUnreadDot && (
              <span
                class="sr-only"
                role="img"
                aria-label={
                  unreadCount > 0
                    ? `${unreadCount} unread ${unreadCount === 1 ? 'message' : 'messages'}`
                    : 'Has updates'
                }
              />
            )}
          </button>
          {actions && (
            <div class="hidden shrink-0 items-center pr-[9px] group-hover/row:flex group-focus-within/row:flex max-sm:flex [@media(hover:none)]:flex">
              {actions}
            </div>
          )}
          {disclosure && <div class="flex shrink-0 items-center pr-[5px]">{disclosure}</div>}
        </>
      )}
    </div>
  );
}
