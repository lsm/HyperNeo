import type { ComponentChildren } from 'preact';
import type { SidebarSessionStatus } from '../lib/session-sidebar-status.ts';
import { cn } from '../lib/utils.ts';
import { CloneIcon } from './icons/CloneIcon.tsx';
import { SessionActivityIndicator } from './SessionActivityIndicator.tsx';
import { StatusDot } from './ui/StatusDot.tsx';
import { UnreadBadge } from './ui/UnreadBadge.tsx';

interface ConversationRowProps {
  title: string;
  selected?: boolean;
  nested?: boolean;
  clone?: boolean;
  status: SidebarSessionStatus;
  secondaryStatus?: SidebarSessionStatus;
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
  clone = false,
  status,
  secondaryStatus,
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
  return (
    <div
      data-testid={rowTestId}
      class={cn(
        'group/row relative flex min-h-8 items-stretch rounded-lg transition-colors',
        nested && 'ml-6',
        selected ? 'bg-fill' : 'hover:bg-fill-soft'
      )}
      onMouseLeave={onMouseLeave}
    >
      {editor || (
        <>
          {disclosure}
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
            title={[title, status.label, secondaryStatus?.label, titleHint]
              .filter(Boolean)
              .join(' · ')}
            class={cn(
              'flex flex-1 min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
              selected ? 'text-fg' : 'text-fg-muted group-hover/row:text-fg-soft'
            )}
          >
            <SessionActivityIndicator status={status} />
            {secondaryStatus && <SessionActivityIndicator status={secondaryStatus} />}
            {clone && (
              <span
                role="img"
                aria-label="Clone conversation"
                title="Clone conversation"
                data-testid="session-clone-glyph"
                class="shrink-0 text-fg-faint"
              >
                <CloneIcon />
              </span>
            )}
            <h3
              class={cn(
                'min-w-0 flex-1 truncate text-sm',
                (selected || unreadCount > 0 || unread) && 'font-medium text-fg'
              )}
              onDblClick={onTitleDoubleClick}
              title={[title, status.label, secondaryStatus?.label, titleHint]
                .filter(Boolean)
                .join(' · ')}
            >
              {title}
            </h3>
            {children}
            {unreadCount > 0 ? (
              <UnreadBadge count={unreadCount} />
            ) : (
              unread && <StatusDot tone="info" size="xs" aria-label="Has updates" />
            )}
          </button>
          {actions && (
            <div class="hidden shrink-0 items-center pr-1 group-hover/row:flex group-focus-within/row:flex max-sm:flex [@media(hover:none)]:flex">
              {actions}
            </div>
          )}
        </>
      )}
    </div>
  );
}
