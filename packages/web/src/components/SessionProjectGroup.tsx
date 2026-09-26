import type { Session } from '@hyperneo/shared';
import SessionListItem from './SessionListItem.tsx';

interface SessionProjectGroupProps {
  name: string;
  path: string;
  sessions: Session[];
  collapsed: boolean;
  onToggle: () => void;
  onSessionClick: (sessionId: string) => void;
  onArchive: (sessionId: string) => void | Promise<void>;
  onSpawn?: (sessionId: string) => void | Promise<void>;
  childrenOf?: (sessionId: string) => Session[];
  onRemove?: () => void;
}

export function SessionProjectGroup({
  name,
  path,
  sessions,
  collapsed,
  onToggle,
  onSessionClick,
  onArchive,
  onSpawn,
  childrenOf,
  onRemove,
}: SessionProjectGroupProps) {
  const isEmpty = sessions.length === 0;

  return (
    <div>
      <div class="group/project flex items-center rounded-lg transition-colors hover:bg-fill-soft">
        <button
          type="button"
          data-testid="project-group-header"
          onClick={onToggle}
          title={path}
          aria-expanded={!collapsed}
          class="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-fg-soft transition-colors group-hover/project:text-fg"
        >
          <svg
            class={`w-3 h-3 flex-shrink-0 text-fg-faint transition-transform ${
              collapsed ? '' : 'rotate-90'
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2.5}
              d="M8.25 4.5l7.5 7.5-7.5 7.5"
            />
          </svg>
          <span class="flex h-5 w-5 flex-shrink-0 items-center justify-center text-fg-faint">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={1.9}
                d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"
              />
            </svg>
          </span>
          <span class="flex-1 min-w-0 truncate text-left font-medium">{name}</span>
        </button>
        {onRemove && (
          <button
            type="button"
            data-testid="project-remove"
            onClick={onRemove}
            title="Remove project"
            aria-label={`Remove project ${name}`}
            class="opacity-100 sm:opacity-0 sm:group-hover/project:opacity-100 group-focus-within/project:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 mr-1 p-1 rounded text-fg-faint hover:text-danger hover:bg-fill transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>
      {!collapsed && (
        <div class="ml-3 mt-0.5 flex flex-col gap-0.5">
          {isEmpty ? (
            <div class="px-2.5 py-1.5 text-xs text-fg-faint">No chats</div>
          ) : (
            sessions.flatMap((session) => [
              <SessionListItem
                key={session.id}
                session={session}
                onSessionClick={onSessionClick}
                onArchive={onArchive}
                onSpawn={onSpawn}
              />,
              ...(childrenOf?.(session.id) ?? []).map((child) => (
                <SessionListItem
                  key={child.id}
                  session={child}
                  onSessionClick={onSessionClick}
                  onArchive={onArchive}
                  nested
                />
              )),
            ])
          )}
        </div>
      )}
    </div>
  );
}
