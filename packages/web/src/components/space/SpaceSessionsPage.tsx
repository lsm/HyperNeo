/**
 * SpaceSessionsPage — lists all user-created sessions for a space.
 *
 * Sessions are grouped by status in cards matching the SpaceTasks style.
 * Excludes system sessions (task worker sessions, workflow sessions).
 *
 * Navigation: clicking a session calls navigateToSpaceSession() which uses
 * pushState, so the browser back button naturally returns to /space/:id/sessions
 * where handlePopState restores spaceViewMode = 'sessions'.
 */

import { useMemo, useRef, useState } from 'preact/hooks';
import type { SpaceWorkerAgentPromotionDraft } from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';
import { navigateToSpaceSession } from '../../lib/router';
import { getRelativeTime } from '../../lib/utils';
import { toast } from '../../lib/toast';
import { useSessionRename } from '../../hooks/useSessionRename';
import { RenameIcon } from '../icons/RenameIcon';
import { SpaceAgentEditor } from './SpaceAgentEditor';

type Session = { id: string; title: string; status: string; lastActiveAt: number; type?: string };

// Left-border accent per lifecycle status. Tones mirror the unified indicator
// palette: active=success(green), paused=warning(amber), pending=warning(amber),
// ended/archived=neutral(gray). `paused` is warning, not success — a paused
// session needs attention, it isn't healthy.
const STATUS_BORDER: Record<string, string> = {
  active: 'border-l-green-500',
  paused: 'border-l-amber-500',
  pending_worktree_choice: 'border-l-amber-500',
  ended: 'border-l-gray-600',
  archived: 'border-l-gray-600',
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  pending_worktree_choice: 'Pending',
  ended: 'Ended',
  archived: 'Archived',
};

const ACTIVE_PAGE_SIZE = 10;
const ARCHIVED_LIMIT = 5;

interface StatusGroupDef {
  statuses: string[];
  title: string;
  variant: 'green' | 'yellow' | 'gray';
  /** Hard cap with "+N more" footer — used for Archived */
  hardLimit?: number;
  /** Paginated with prev/next controls — used for Active */
  paginated?: boolean;
}

const SESSION_GROUPS: StatusGroupDef[] = [
  { statuses: ['pending_worktree_choice'], title: 'Pending', variant: 'yellow' },
  { statuses: ['active', 'paused'], title: 'Active', variant: 'green', paginated: true },
  { statuses: ['ended'], title: 'Archived', variant: 'gray', hardLimit: ARCHIVED_LIMIT },
];

function PaginatedSessionGroup({
  title,
  count,
  variant,
  sessions,
  spaceId,
  onPromote,
}: {
  title: string;
  count: number;
  variant: 'green' | 'yellow' | 'gray';
  sessions: Session[];
  spaceId: string;
  onPromote: (session: Session) => void;
}) {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(sessions.length / ACTIVE_PAGE_SIZE);
  const displayed = sessions.slice(page * ACTIVE_PAGE_SIZE, (page + 1) * ACTIVE_PAGE_SIZE);

  const headerStyles: Record<string, string> = {
    green: 'bg-green-900/20',
    yellow: 'bg-yellow-900/20',
    gray: 'bg-dark-800',
  };
  const titleStyles: Record<string, string> = {
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    gray: 'text-gray-400',
  };

  return (
    <div class="bg-dark-850 border border-dark-700 rounded-xl overflow-hidden">
      <div
        class={`px-4 py-3 border-b border-dark-700 ${headerStyles[variant]} flex items-center gap-1`}
      >
        <h3 class={`font-semibold ${titleStyles[variant]}`}>
          {title} ({count})
        </h3>
      </div>
      <div class="divide-y divide-dark-700">
        {displayed.map((session) => (
          <SessionItem key={session.id} session={session} spaceId={spaceId} onPromote={onPromote} />
        ))}
      </div>
      {totalPages > 1 && (
        <div class="px-4 py-2 border-t border-dark-700 flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            class="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            ← Prev
          </button>
          <span class="text-xs text-gray-400">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page === totalPages - 1}
            class="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

function SessionGroup({
  title,
  count,
  variant,
  sessions,
  spaceId,
  hardLimit,
  onPromote,
}: {
  title: string;
  count: number;
  variant: 'green' | 'yellow' | 'gray';
  sessions: Session[];
  spaceId: string;
  hardLimit?: number;
  onPromote: (session: Session) => void;
}) {
  const displayed = hardLimit ? sessions.slice(0, hardLimit) : sessions;
  const hidden = hardLimit ? Math.max(0, sessions.length - hardLimit) : 0;

  const headerStyles: Record<string, string> = {
    green: 'bg-green-900/20',
    yellow: 'bg-yellow-900/20',
    gray: 'bg-dark-800',
  };
  const titleStyles: Record<string, string> = {
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    gray: 'text-gray-400',
  };

  return (
    <div class="bg-dark-850 border border-dark-700 rounded-xl overflow-hidden">
      <div
        class={`px-4 py-3 border-b border-dark-700 ${headerStyles[variant]} flex items-center gap-1`}
      >
        <h3 class={`font-semibold ${titleStyles[variant]}`}>
          {title} ({count})
        </h3>
      </div>
      <div class="divide-y divide-dark-700">
        {displayed.map((session) => (
          <SessionItem key={session.id} session={session} spaceId={spaceId} onPromote={onPromote} />
        ))}
        {hidden > 0 && (
          <div class="px-4 py-2 text-xs text-gray-400 text-center">+{hidden} more not shown</div>
        )}
      </div>
    </div>
  );
}

function SessionItem({
  session,
  spaceId,
  onPromote,
}: {
  session: Session;
  spaceId: string;
  onPromote: (session: Session) => void;
}) {
  const borderColor = STATUS_BORDER[session.status] ?? 'border-l-transparent';
  const canPromote = session.type !== 'space_task_agent';
  const { isEditing, startEditing, inputProps } = useSessionRename(session.id, session.title);

  if (isEditing) {
    return (
      <div class={`px-4 py-3 border-l-2 ${borderColor}`}>
        <input
          type="text"
          data-testid="space-session-rename-input"
          {...inputProps}
          class="w-full px-2 py-1 text-sm bg-white/10 rounded-md text-gray-100 outline-none ring-1 ring-blue-500/60"
        />
      </div>
    );
  }

  return (
    <div
      class={`group/row relative px-4 py-3 border-l-2 ${borderColor} cursor-pointer hover:bg-dark-800/50 transition-colors`}
      onClick={() => navigateToSpaceSession(spaceId, session.id)}
    >
      <div class="flex items-start justify-between">
        <div class="flex-1 min-w-0">
          <h4 class="text-sm font-medium text-gray-100 truncate">{session.title || session.id}</h4>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-xs text-gray-400">
              {STATUS_LABEL[session.status] ?? session.status}
            </span>
            {session.lastActiveAt > 0 && (
              <span class="text-xs text-gray-400">{getRelativeTime(session.lastActiveAt)}</span>
            )}
          </div>
        </div>
        <div class="ml-4 flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            data-testid="space-session-rename"
            onClick={(event) => {
              event.stopPropagation();
              startEditing();
            }}
            title="Rename session"
            aria-label={`Rename ${session.title || 'session'}`}
            class="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 rounded-md p-1 text-gray-500 transition-colors hover:text-gray-100 hover:bg-white/10"
          >
            <RenameIcon className="w-3.5 h-3.5" />
          </button>
          {canPromote && (
            <>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onPromote(session);
                }}
                class="rounded-md border border-blue-500/30 px-2 py-1 text-xs text-blue-300 transition-colors hover:bg-blue-500/10 hover:text-blue-200"
              >
                Promote
              </button>
              <span class="text-xs text-gray-400">&rarr;</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface SpaceSessionsPageProps {
  spaceId: string;
  navigationSpaceId?: string;
}

export function SpaceSessionsPage({ spaceId, navigationSpaceId }: SpaceSessionsPageProps) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const storeSessions = spaceStore.sessions.value;
  const agents = spaceStore.agents.value;
  const [promotionDraft, setPromotionDraft] = useState<SpaceWorkerAgentPromotionDraft | null>(null);
  const promotionRequestId = useRef(0);

  const sessions = useMemo(() => {
    const isSystemSpaceSession = (sessionId: string): boolean =>
      sessionId.startsWith(`space:${spaceId}:task:`) ||
      sessionId.startsWith(`space:${spaceId}:workflow:`);

    return [...storeSessions]
      .filter((s) => !isSystemSpaceSession(s.id))
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }, [storeSessions, spaceId]);

  const existingAgentNames = agents.map((agent) => agent.name);

  const handlePromote = async (session: Session) => {
    const requestId = promotionRequestId.current + 1;
    promotionRequestId.current = requestId;
    try {
      const draft = await spaceStore.getAgentPromotionDraft(session.id);
      if (promotionRequestId.current !== requestId) return;
      setPromotionDraft(draft);
    } catch (err) {
      if (promotionRequestId.current !== requestId) return;
      toast.error(
        `Failed to generate promotion draft: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  if (sessions.length === 0) {
    return (
      <div class="w-full px-8 flex flex-col items-center justify-center py-16 text-center">
        <svg
          class="w-10 h-10 text-gray-400 mb-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={1.5}
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
          />
        </svg>
        <p class="text-sm text-gray-400 font-medium">No sessions yet</p>
        <p class="text-xs text-gray-400 mt-1">Sessions will appear here when created</p>
      </div>
    );
  }

  return (
    <>
      <div class="flex-1 min-h-0 w-full px-4 py-4 sm:px-8 sm:py-6 overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] space-y-4">
          {SESSION_GROUPS.map((group) => {
            const groupSessions = sessions.filter((s) => group.statuses.includes(s.status));
            if (groupSessions.length === 0) return null;
            if (group.paginated) {
              return (
                <PaginatedSessionGroup
                  key={group.title}
                  title={group.title}
                  count={groupSessions.length}
                  variant={group.variant}
                  sessions={groupSessions}
                  spaceId={routeSpaceId}
                  onPromote={handlePromote}
                />
              );
            }
            return (
              <SessionGroup
                key={group.title}
                title={group.title}
                count={groupSessions.length}
                variant={group.variant}
                sessions={groupSessions}
                spaceId={routeSpaceId}
                hardLimit={group.hardLimit}
                onPromote={handlePromote}
              />
            );
          })}
        </div>
      </div>
      {promotionDraft && (
        <SpaceAgentEditor
          key={promotionDraft.sourceSessionId}
          agent={null}
          promotionDraft={promotionDraft}
          existingAgentNames={existingAgentNames}
          onSave={() => setPromotionDraft(null)}
          onCancel={() => setPromotionDraft(null)}
        />
      )}
    </>
  );
}
