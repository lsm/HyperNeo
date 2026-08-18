import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { navigateToSpaceSession } from '../../lib/router';
import type { SpaceSessionRow } from '../../lib/space-store';
import { spaceStore } from '../../lib/space-store';
import {
  getSpaceSessionUnreadCount,
  spaceSessionLastSeen,
  syncSpaceSessionSeen,
} from '../../lib/space-unread';
import { getRelativeTime } from '../../lib/utils';
import {
  FLAT_SURFACE,
  GLASS_CONTENT_CONTAINER_CLASS,
  GLASS_PRIMARY_BUTTON_CLASS,
} from './glass-workspace';

const SESSION_PAGE_SIZE = 10;

type RuntimeGroupKey =
  | 'waiting'
  | 'idle-unread'
  | 'error'
  | 'running'
  | 'rate-limited'
  | 'idle-read';
type RuntimeKind = 'idle' | 'error' | 'running' | 'waiting' | 'rate-limited';

interface ClassifiedSession {
  session: SpaceSessionRow;
  runtimeKind: RuntimeKind;
  runtimeLabel: string;
  unreadCount: number;
}

interface RuntimeGroupDef {
  key: RuntimeGroupKey;
  title: string;
  accent: string;
}

const RUNTIME_GROUPS: RuntimeGroupDef[] = [
  { key: 'waiting', title: 'Waiting for input', accent: 'bg-amber-300/80' },
  { key: 'idle-unread', title: 'Unread', accent: 'bg-sky-300/80' },
  { key: 'error', title: 'Error', accent: 'bg-red-300/80' },
  { key: 'running', title: 'Running', accent: 'bg-emerald-300/80' },
  { key: 'rate-limited', title: 'Rate Limited', accent: 'bg-orange-300/80' },
  { key: 'idle-read', title: 'Idle', accent: 'bg-gray-400/80' },
];

const RUNNING_LABELS: Record<string, string> = {
  queued: 'Queued',
  processing: 'Processing',
};

function classifySession(
  status: string,
  processingStateValue: unknown
): { kind: RuntimeKind; label: string } {
  if (status === 'pending_worktree_choice') {
    return { kind: 'waiting', label: 'Needs worktree choice' };
  }

  let parsed: unknown = processingStateValue;
  if (typeof processingStateValue === 'string') {
    try {
      parsed = JSON.parse(processingStateValue);
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === 'object') {
    const phase = (parsed as { status?: unknown }).status;
    if (phase === 'interrupted') return { kind: 'error', label: 'Interrupted' };
    if (phase === 'waiting_for_input') return { kind: 'waiting', label: 'Waiting for input' };
    if (phase === 'rate_limit_cooldown') {
      return { kind: 'rate-limited', label: 'Rate limit cooldown' };
    }
    if (typeof phase === 'string' && phase in RUNNING_LABELS) {
      return { kind: 'running', label: RUNNING_LABELS[phase] };
    }
  }

  if (status === 'paused') return { kind: 'idle', label: 'Paused' };
  if (status === 'ended') return { kind: 'idle', label: 'Ended' };
  return { kind: 'idle', label: 'Idle' };
}

function groupKeyFor(session: ClassifiedSession): RuntimeGroupKey {
  if (session.runtimeKind === 'waiting') return 'waiting';
  if (session.runtimeKind === 'rate-limited') return 'rate-limited';
  if (session.runtimeKind === 'error') return 'error';
  if (session.runtimeKind === 'running') return 'running';
  return session.unreadCount > 0 ? 'idle-unread' : 'idle-read';
}

function GroupShell({
  title,
  count,
  accent,
  children,
}: {
  title: string;
  count: number;
  accent: string;
  children: ComponentChildren;
}) {
  const headingId = `session-group-${title.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <section class="space-y-2" aria-labelledby={headingId} data-testid="session-group">
      <div class="flex items-center gap-2 px-1">
        <span class={`h-1.5 w-1.5 rounded-full ${accent}`} aria-hidden="true" />
        <h3 id={headingId} class="text-xs font-semibold uppercase tracking-[0.14em] text-gray-300">
          {title} ({count})
        </h3>
      </div>
      <div class={`overflow-hidden rounded-2xl border ${FLAT_SURFACE}`}>{children}</div>
    </section>
  );
}

function PaginatedSessionGroup({
  group,
  sessions,
  spaceId,
}: {
  group: RuntimeGroupDef;
  sessions: ClassifiedSession[];
  spaceId: string;
}) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(sessions.length / SESSION_PAGE_SIZE));

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  const start = page * SESSION_PAGE_SIZE;
  const displayed = sessions.slice(start, start + SESSION_PAGE_SIZE);
  const end = start + displayed.length;
  const buttonClass =
    'rounded-lg px-2.5 py-1 text-xs text-gray-300 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/50 disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <GroupShell title={group.title} count={sessions.length} accent={group.accent}>
      <div class="divide-y divide-white/10">
        {displayed.map((session) => (
          <SessionItem key={session.session.id} classified={session} spaceId={spaceId} />
        ))}
      </div>
      {totalPages > 1 && (
        <div class="flex items-center justify-between border-t border-white/10 bg-black/10 px-4 py-2">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={page === 0}
            class={buttonClass}
            aria-label={`Previous ${group.title.toLowerCase()} sessions`}
          >
            ← Prev
          </button>
          <span class="text-xs text-gray-400" aria-live="polite">
            Showing {start + 1}–{end} of {sessions.length}
          </span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
            disabled={page === totalPages - 1}
            class={buttonClass}
            aria-label={`Next ${group.title.toLowerCase()} sessions`}
          >
            Next →
          </button>
        </div>
      )}
    </GroupShell>
  );
}

function SessionItem({ classified, spaceId }: { classified: ClassifiedSession; spaceId: string }) {
  const { session, runtimeKind, runtimeLabel, unreadCount } = classified;
  const title = session.title || session.id;
  const runtimeTone =
    runtimeKind === 'waiting'
      ? 'text-amber-200'
      : runtimeKind === 'error'
        ? 'text-red-300'
        : runtimeKind === 'running'
          ? 'text-emerald-200'
          : runtimeKind === 'rate-limited'
            ? 'text-orange-200'
            : unreadCount > 0
              ? 'text-sky-200'
              : 'text-gray-400';

  return (
    <button
      type="button"
      class="group/open flex w-full items-start justify-between gap-3 px-5 py-4 text-left transition hover:bg-white/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-200/55"
      onClick={() => navigateToSpaceSession(spaceId, session.id)}
      aria-label={`Open session ${title}, ${runtimeLabel}${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
      data-testid="space-session-item"
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h4 class="truncate text-[15px] font-semibold text-gray-50">{title}</h4>
          {unreadCount > 0 && (
            <span
              class="inline-flex min-w-5 shrink-0 items-center justify-center rounded-md bg-sky-400/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-sky-200"
              aria-label={`${unreadCount} unread messages`}
            >
              {unreadCount}
            </span>
          )}
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span class={runtimeTone}>{runtimeLabel}</span>
          {session.lastActiveAt > 0 && (
            <span class="text-gray-500">Updated {getRelativeTime(session.lastActiveAt)}</span>
          )}
        </div>
      </div>
      <svg
        class="mt-1 h-4 w-4 shrink-0 text-gray-600 transition group-hover/open:translate-x-0.5 group-hover/open:text-gray-300"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fill-rule="evenodd"
          d="M7.21 14.77a.75.75 0 010-1.06L10.94 10 7.21 6.29a.75.75 0 111.06-1.06l4.25 4.24a.75.75 0 010 1.06l-4.25 4.24a.75.75 0 01-1.06 0z"
          clip-rule="evenodd"
        />
      </svg>
    </button>
  );
}

interface SpaceSessionsPageProps {
  spaceId: string;
  navigationSpaceId?: string;
  onCreateSession?: (event: Event) => void;
  creatingSession?: boolean;
}

export function SpaceSessionsPage({
  spaceId,
  navigationSpaceId,
  onCreateSession,
  creatingSession = false,
}: SpaceSessionsPageProps) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const storeSessions = spaceStore.sessions.value;
  void spaceSessionLastSeen.value;

  const sessions = useMemo(() => {
    const isSystemSpaceSession = (sessionId: string): boolean =>
      sessionId.startsWith(`space:${spaceId}:task:`) ||
      sessionId.startsWith(`space:${spaceId}:workflow:`);

    return [...storeSessions]
      .filter((session) => !isSystemSpaceSession(session.id))
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }, [storeSessions, spaceId]);

  useEffect(() => {
    syncSpaceSessionSeen(sessions);
  }, [sessions]);

  const classifiedSessions = sessions.map((session) => {
    const runtime = classifySession(session.status, session.processingState);
    return {
      session,
      runtimeKind: runtime.kind,
      runtimeLabel: runtime.label,
      unreadCount: getSpaceSessionUnreadCount(session.id, session.messageCount),
    };
  });

  return (
    <div class="flex-1 min-h-0 w-full overflow-y-auto">
      <div class={`${GLASS_CONTENT_CONTAINER_CLASS} min-h-[calc(100%+1px)] space-y-4`}>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200/80">
              Working conversations
            </p>
            <p class="mt-1 text-sm text-gray-400">
              Resume running work, review unread output, or return to an idle session.
            </p>
          </div>
          <p class="text-xs tabular-nums text-gray-500">
            {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} tracked
          </p>
        </div>

        {sessions.length === 0 ? (
          <div
            class={`flex min-h-52 flex-col items-center justify-center rounded-2xl border px-6 py-10 text-center ${FLAT_SURFACE}`}
            role="status"
          >
            <span
              class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-gray-400"
              aria-hidden="true"
            >
              ◇
            </span>
            <p class="text-sm font-semibold text-gray-100">No sessions yet</p>
            <p class="mt-1 text-xs leading-5 text-gray-400">
              Create a session to begin a focused conversation in this space.
            </p>
            {onCreateSession && (
              <button
                type="button"
                class={`${GLASS_PRIMARY_BUTTON_CLASS} mt-5`}
                onClick={onCreateSession}
                disabled={creatingSession}
              >
                Create session
              </button>
            )}
          </div>
        ) : (
          <div class="space-y-4">
            {RUNTIME_GROUPS.map((group) => {
              const groupSessions = classifiedSessions.filter(
                (session) => groupKeyFor(session) === group.key
              );
              if (groupSessions.length === 0) return null;
              return (
                <PaginatedSessionGroup
                  key={group.key}
                  group={group}
                  sessions={groupSessions}
                  spaceId={routeSpaceId}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
