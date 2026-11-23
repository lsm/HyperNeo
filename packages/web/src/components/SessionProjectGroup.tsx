import { Menu, MenuButton, MenuItem, MenuItems } from '@hyperneo/ui';
import type { Session } from '@hyperneo/shared';
import { SessionConversationGroup } from './SessionConversationGroup.tsx';

const ROW_ICON_BUTTON =
  'inline-flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-md text-fg-faint transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';

const PROJECT_MENU_ITEM =
  'flex w-full items-center gap-3 px-4 py-2 text-left text-sm data-[focus]:bg-surface-raised';

interface SessionProjectGroupProps {
  name: string;
  path: string;
  folders?: string[];
  onNewSession?: () => void;
  sessions: Session[];
  collapsed: boolean;
  onToggle: () => void;
  onSessionClick: (sessionId: string) => void;
  onArchive: (sessionId: string) => void | Promise<void>;
  childrenOf?: (sessionId: string) => Session[];
  onRemove: () => void;
  removeDisabledReason?: string;
  showArchived: boolean;
  onToggleArchived: () => void;
}

export function SessionProjectGroup({
  name,
  path,
  folders,
  onNewSession,
  sessions,
  collapsed,
  onToggle,
  onSessionClick,
  onArchive,
  childrenOf,
  onRemove,
  removeDisabledReason,
  showArchived,
  onToggleArchived,
}: SessionProjectGroupProps) {
  const isEmpty = sessions.length === 0;

  return (
    <div>
      <div class="group/project relative flex items-center gap-0.5 rounded-lg pr-1 transition-colors hover:bg-fill-soft">
        <button
          type="button"
          data-testid="project-group-header"
          onClick={onToggle}
          title={folders?.join('\n') ?? path}
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
        {onNewSession && (
          <button
            type="button"
            onClick={onNewSession}
            aria-label={`New session in ${name}`}
            title="New session"
            class={`${ROW_ICON_BUTTON} [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/project:opacity-100 [@media(hover:hover)]:group-focus-within/project:opacity-100`}
          >
            <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        )}
        <Menu>
          <MenuButton aria-label={`Project actions for ${name}`} class={ROW_ICON_BUTTON}>
            <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5" cy="12" r="1.7" />
              <circle cx="12" cy="12" r="1.7" />
              <circle cx="19" cy="12" r="1.7" />
            </svg>
          </MenuButton>
          <MenuItems
            anchor={{ to: 'top end', gap: 4 }}
            modal={false}
            class="z-[9999] min-w-[200px] rounded-lg border border-line bg-surface-overlay py-1 shadow-xl"
          >
            <MenuItem checked={showArchived} onClick={onToggleArchived}>
              <button type="button" class={PROJECT_MENU_ITEM}>
                <span class="w-4 text-center" aria-hidden="true">
                  {showArchived ? '✓' : ''}
                </span>
                Show archived chats
              </button>
            </MenuItem>
            <MenuItem disabled={!!removeDisabledReason} onClick={onRemove}>
              <button
                type="button"
                disabled={!!removeDisabledReason}
                title={removeDisabledReason}
                class={`${PROJECT_MENU_ITEM} text-danger disabled:cursor-not-allowed disabled:text-fg-faint`}
              >
                Delete this project
              </button>
            </MenuItem>
          </MenuItems>
        </Menu>
        {removeDisabledReason && (
          <span
            role="tooltip"
            class="pointer-events-none absolute right-1 top-full z-50 hidden max-w-60 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg group-hover/project:block group-focus-within/project:block"
          >
            {removeDisabledReason}
          </span>
        )}
      </div>
      {!collapsed && (
        <div class="ml-3 mt-0.5 flex flex-col gap-0.5">
          {folders &&
            folders.length > 1 &&
            folders.map((folder) => (
              <div key={folder} title={folder} class="truncate px-2.5 text-xs text-fg-faint">
                {folder}
              </div>
            ))}
          {isEmpty ? (
            <div class="px-2.5 py-1.5 text-xs text-fg-faint">No chats</div>
          ) : (
            sessions.map((session) => (
              <SessionConversationGroup
                key={session.id}
                session={session}
                childSessions={childrenOf?.(session.id) ?? []}
                onSessionClick={onSessionClick}
                onArchive={onArchive}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
