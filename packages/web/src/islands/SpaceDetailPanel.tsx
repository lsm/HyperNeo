import type {
  AgentProcessingState,
  SessionStatus,
  SpaceTaskStatus,
  WorktreeCommitStatus,
} from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ArchiveConfirmDialog } from '../components/ArchiveConfirmDialog';
import { useSpaceWorkspaceChoice } from '../components/space/SpaceWorkspacePicker';
import { CollapsibleSection } from '../components/ui/CollapsibleSection';
import { StatusDot } from '../components/ui/StatusDot';
import { UnreadBadge } from '../components/ui/UnreadBadge';
import { archiveSession, createSession } from '../lib/api-helpers';
import { useSessionRename } from '../hooks/useSessionRename';
import {
  navigateToSpace,
  navigateToSpaceAgent,
  navigateToSpaceGoals,
  navigateToSpaceEvolve,
  navigateToSpaceMemories,
  navigateToSpaceSession,
  navigateToSpaceSessions,
  navigateToSpaceTask,
  navigateToSpaceTasks,
} from '../lib/router';
import {
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceViewModeSignal,
} from '../lib/signals';
import { spaceStore, type SpaceSessionRow } from '../lib/space-store';
import { isActionRequired, isActiveTask, isDraftTask } from '../lib/task-filters';
import { getAgentProcessingStateConfig } from '../lib/session-processing-phase';
import { SESSION_LIFECYCLE_STATUS_CONFIG } from '../lib/session-lifecycle-status';
import { getTaskStatusConfig } from '../lib/task-status';
import {
  getSpaceSessionUnreadCount,
  isSpaceTaskUnread,
  markSpaceSessionRead,
  markSpaceTaskRead,
  seedSpaceTasksSeen,
  spaceSessionLastSeen,
  syncSpaceSessionSeen,
} from '../lib/space-unread';
import { toast } from '../lib/toast';
import { cn } from '../lib/utils';

type TaskTab = 'active' | 'action' | 'draft';

type SessionIndicatorTone = ReturnType<typeof getAgentProcessingStateConfig>['tone'];

const SIDEBAR_PREVIEW_LIMIT = 10;

function parseAgentState(value?: string): AgentProcessingState {
  if (!value) return { status: 'idle' };
  try {
    return JSON.parse(value) as AgentProcessingState;
  } catch {
    return { status: 'idle' };
  }
}

function sessionIndicator(session: SpaceSessionRow): {
  tone: SessionIndicatorTone;
  pulse: boolean;
} {
  const agentState = parseAgentState(session.processingState);
  if (agentState.status !== 'idle') {
    const isActive = agentState.status === 'processing' || agentState.status === 'queued';
    return { tone: getAgentProcessingStateConfig(agentState).tone, pulse: isActive };
  }
  const lifecycle = SESSION_LIFECYCLE_STATUS_CONFIG[session.status as SessionStatus];
  return { tone: lifecycle?.tone ?? 'neutral', pulse: false };
}

function SpaceDetailSessionRow({
  session,
  isSelected,
  onClick,
  onArchive,
}: {
  session: SpaceSessionRow;
  isSelected: boolean;
  onClick: (sessionId: string) => void;
  onArchive: (sessionId: string) => void | Promise<void>;
}) {
  const { isEditing, startEditing, inputProps } = useSessionRename(session.id, session.title);
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const handleArchive = async () => {
    setArchiving(true);
    try {
      await onArchive(session.id);
    } finally {
      setArchiving(false);
      setConfirming(false);
    }
  };

  void spaceSessionLastSeen.value;
  const unread = isSelected ? 0 : getSpaceSessionUnreadCount(session.id, session.messageCount);
  const { tone, pulse } = sessionIndicator(session);

  if (isEditing) {
    return (
      <input
        type="text"
        data-testid="space-session-rename-input"
        {...inputProps}
        class="w-full mx-3 my-0.5 px-2 py-1 text-sm bg-fill rounded-md text-fg outline-none ring-1 ring-accent/60"
      />
    );
  }

  const openSession = () => onClick(session.id);
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.currentTarget === e.target && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openSession();
    }
  };

  return (
    <div
      class={cn(
        'group/row relative w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors cursor-pointer',
        isSelected ? 'bg-fill' : 'hover:bg-fill-soft'
      )}
      role="button"
      tabIndex={0}
      onClick={openSession}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => {
        if (!archiving) setConfirming(false);
      }}
    >
      <StatusDot tone={tone} pulse={pulse} />
      <span
        class="flex-1 min-w-0 text-sm text-fg-soft truncate"
        onDblClick={startEditing}
        title="Double-click to rename"
      >
        {session.title || 'Untitled'}
      </span>
      {unread > 0 && <UnreadBadge count={unread} />}
      {session.status !== 'archived' && (
        <div class="flex items-center">
          {confirming ? (
            <button
              type="button"
              data-testid="space-session-archive-confirm"
              onClick={(e) => {
                e.stopPropagation();
                void handleArchive();
              }}
              disabled={archiving}
              class="px-2 py-0.5 rounded text-xs font-medium bg-danger text-on-danger transition-colors hover:bg-danger disabled:opacity-60"
            >
              {archiving ? 'Archiving…' : 'Archive'}
            </button>
          ) : (
            <button
              type="button"
              data-testid="space-session-archive"
              onClick={(e) => {
                e.stopPropagation();
                setConfirming(true);
              }}
              title="Archive session"
              aria-label={`Archive ${session.title || 'session'}`}
              class="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 p-1 rounded text-fg-faint transition-colors hover:text-fg hover:bg-fill"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
      )}
    </div>
  );
}

function TaskStatusDot({ status, pulse }: { status: SpaceTaskStatus; pulse?: boolean }) {
  return <StatusDot tone={getTaskStatusConfig(status).tone} pulse={pulse} />;
}

interface SpaceDetailPanelProps {
  spaceId: string;
  navigationSpaceId?: string;
  onNavigate?: () => void;
}

function TaskTabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={cn(
        'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors',
        active ? 'bg-fill-soft text-fg-soft' : 'text-fg-muted hover:bg-fill-soft hover:text-fg-soft'
      )}
    >
      <span>{label}</span>
      <span class="text-[11px] text-fg-muted tabular-nums">{count}</span>
    </button>
  );
}

function SpaceNavItem({
  label,
  active,
  onClick,
  testId,
  icon,
  accentClass,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
  icon: ComponentChildren;
  accentClass: string;
  badge?: ComponentChildren;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      class={cn(
        'mx-2 w-auto rounded-lg px-2.5 py-2 flex items-center gap-2.5 text-left text-sm transition-colors',
        active ? 'bg-fill text-fg' : 'text-fg-muted hover:bg-fill-soft hover:text-fg-soft'
      )}
    >
      <span
        class={cn(
          'flex h-5 w-5 flex-shrink-0 items-center justify-center',
          active ? accentClass : 'text-fg-muted'
        )}
      >
        {icon}
      </span>
      <span class="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </button>
  );
}

export function SpaceDetailPanel({
  spaceId,
  navigationSpaceId,
  onNavigate,
}: SpaceDetailPanelProps) {
  const isLoading = spaceStore.loading.value;
  const loadedSpaceId = spaceStore.spaceId.value;
  const tasks = spaceStore.tasks.value;
  const goals = spaceStore.goals.value;
  const space = spaceStore.space.value;
  const routeSpaceId = navigationSpaceId ?? spaceId;

  const isReady = !isLoading && loadedSpaceId === spaceId;

  if (!isReady) {
    return (
      <div class="flex-1 flex items-center justify-center p-6">
        <span class="text-xs text-fg-muted">Loading…</span>
      </div>
    );
  }

  const selectedSessionId = currentSpaceSessionIdSignal.value;
  const selectedTaskId = currentSpaceTaskIdSignal.value;
  const [taskTab, setTaskTab] = useState<TaskTab>('action');
  const [archiveConfirm, setArchiveConfirm] = useState<{
    sessionId: string;
    commitStatus: WorktreeCommitStatus;
  } | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const spaceIdRef = useRef(spaceId);

  useEffect(() => {
    spaceIdRef.current = spaceId;
    setArchiveConfirm(null);
  }, [spaceId]);

  useEffect(() => {
    if (!selectedTaskId) return;
    const task = tasks.find((t) => t.id === selectedTaskId);
    if (!task) return;
    if (isActiveTask(task) && taskTab !== 'active') setTaskTab('active');
    else if (isActionRequired(task) && taskTab !== 'action') setTaskTab('action');
    else if (isDraftTask(task) && taskTab !== 'draft') setTaskTab('draft');
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const session = spaceStore.sessions.value.find((s) => s.id === selectedSessionId);
    if (session) markSpaceSessionRead(session.id, session.messageCount);
  }, [selectedSessionId, spaceStore.sessions.value]);

  useEffect(() => {
    syncSpaceSessionSeen(spaceStore.sessions.value);
  }, [spaceStore.sessions.value]);

  useEffect(() => {
    seedSpaceTasksSeen(tasks);
  }, [tasks]);

  useEffect(() => {
    if (!selectedTaskId) return;
    const task = tasks.find((t) => t.id === selectedTaskId);
    if (task) markSpaceTaskRead(task.id, task.updatedAt);
  }, [selectedTaskId, tasks]);

  const isOverviewSelected =
    selectedSessionId === null &&
    selectedTaskId === null &&
    currentSpaceViewModeSignal.value === 'overview';
  const isSpaceAgentSelected = currentSpaceViewModeSignal.value === 'agents';
  const isGoalsSelected = currentSpaceViewModeSignal.value === 'goals';
  const isMemoriesSelected = currentSpaceViewModeSignal.value === 'memories';
  const isForgeSelected = currentSpaceViewModeSignal.value === 'forge';
  const isTasksSelected = currentSpaceViewModeSignal.value === 'tasks';
  const isSessionsSelected = currentSpaceViewModeSignal.value === 'sessions';

  const { activeCount, actionCount, draftCount } = useMemo(() => {
    let active = 0;
    let action = 0;
    let draft = 0;
    for (const task of tasks) {
      if (isActiveTask(task)) active++;
      else if (isActionRequired(task)) action++;
      else if (isDraftTask(task)) draft++;
    }
    return { activeCount: active, actionCount: action, draftCount: draft };
  }, [tasks]);
  const taskListCount = activeCount + actionCount + draftCount;

  const tasksForTab = useMemo(() => {
    const predicate =
      taskTab === 'action' ? isActionRequired : taskTab === 'draft' ? isDraftTask : isActiveTask;
    const statusRank =
      taskTab === 'active'
        ? (s: SpaceTaskStatus) => (s === 'in_progress' ? 0 : s === 'approved' ? 1 : 2)
        : () => 0;
    return [...tasks]
      .sort((a, b) => {
        const rankDelta = statusRank(a.status) - statusRank(b.status);
        return rankDelta !== 0 ? rankDelta : b.updatedAt - a.updatedAt;
      })
      .filter(predicate);
  }, [tasks, taskTab, selectedTaskId]);

  const visibleTasks = useMemo(() => {
    const capped = tasksForTab.slice(0, SIDEBAR_PREVIEW_LIMIT);
    const selected = tasksForTab.find((t) => t.id === selectedTaskId);
    if (selected && !capped.some((t) => t.id === selected.id)) {
      return [...capped, selected];
    }
    return capped;
  }, [tasksForTab, selectedTaskId]);

  const sessions = useMemo(() => {
    const storeSessions = spaceStore.sessions.value;
    const isSystemSpaceSession = (sessionId: string): boolean =>
      sessionId.startsWith(`space:${spaceId}:task:`) ||
      sessionId.startsWith(`space:${spaceId}:workflow:`);

    return storeSessions
      .filter((s) => !isSystemSpaceSession(s.id))
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }, [spaceStore.sessions.value, spaceId]);

  const visibleSessions = useMemo(() => {
    const capped = sessions.slice(0, SIDEBAR_PREVIEW_LIMIT);
    const selected = sessions.find((s) => s.id === selectedSessionId);
    if (selected && !capped.some((s) => s.id === selected.id)) {
      return [...capped, selected];
    }
    return capped;
  }, [sessions, selectedSessionId]);

  const handleOverviewClick = useCallback(() => {
    navigateToSpace(routeSpaceId);
    onNavigate?.();
  }, [routeSpaceId, onNavigate]);

  const handleSpaceAgentClick = useCallback(() => {
    navigateToSpaceAgent(routeSpaceId);
    onNavigate?.();
  }, [routeSpaceId, onNavigate]);

  const handleGoalsClick = useCallback(() => {
    navigateToSpaceGoals(routeSpaceId);
    onNavigate?.();
  }, [routeSpaceId, onNavigate]);

  const handleMemoriesClick = useCallback(() => {
    navigateToSpaceMemories(routeSpaceId);
    onNavigate?.();
  }, [routeSpaceId, onNavigate]);

  const handleForgeClick = useCallback(() => {
    navigateToSpaceEvolve(routeSpaceId);
    onNavigate?.();
  }, [routeSpaceId, onNavigate]);

  const handleTasksClick = useCallback(
    (tab?: TaskTab) => {
      navigateToSpaceTasks(
        routeSpaceId,
        tab ?? (actionCount === 0 && activeCount > 0 ? 'active' : 'action')
      );
      onNavigate?.();
    },
    [routeSpaceId, actionCount, activeCount, onNavigate]
  );

  const handleSessionsClick = useCallback(() => {
    navigateToSpaceSessions(routeSpaceId);
    onNavigate?.();
  }, [routeSpaceId, onNavigate]);

  const handleTaskClick = useCallback(
    (taskId: string) => {
      navigateToSpaceTask(routeSpaceId, taskId);
      onNavigate?.();
    },
    [routeSpaceId, onNavigate]
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      navigateToSpaceSession(routeSpaceId, sessionId);
      onNavigate?.();
    },
    [routeSpaceId, onNavigate]
  );

  const handleArchive = useCallback(async (sessionId: string) => {
    const probeSpaceId = spaceIdRef.current;
    try {
      const result = await archiveSession(sessionId, false);
      if (probeSpaceId !== spaceIdRef.current) return;
      if (result.requiresConfirmation && result.commitStatus) {
        setArchiveConfirm({ sessionId, commitStatus: result.commitStatus });
      } else if (result.success) {
        toast.success('Session archived');
      }
    } catch (err) {
      if (probeSpaceId !== spaceIdRef.current) return;
      toast.error(err instanceof Error ? err.message : 'Failed to archive session');
    }
  }, []);

  const handleConfirmArchive = useCallback(async () => {
    if (!archiveConfirm) return;
    setArchiveBusy(true);
    try {
      const result = await archiveSession(archiveConfirm.sessionId, true);
      if (result.success) {
        toast.success('Session archived');
        setArchiveConfirm(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive session');
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveConfirm]);

  const workspaceChoice = useSpaceWorkspaceChoice(spaceId, space?.workspacePath);

  const handleCreateSession = (e: Event) => {
    e.stopPropagation();
    workspaceChoice.chooseWorkspace((workspacePath, worktreeMode) => {
      void (async () => {
        try {
          const response = await createSession({ spaceId, workspacePath, worktreeMode });
          navigateToSpaceSession(routeSpaceId, response.sessionId);
          onNavigate?.();
        } catch {}
      })();
    });
  };

  return (
    <div class="flex-1 flex flex-col overflow-hidden">
      <nav class="flex flex-col gap-1 px-1 pt-2 pb-2" aria-label="Space navigation">
        <SpaceNavItem
          label="Overview"
          active={isOverviewSelected}
          onClick={handleOverviewClick}
          testId="space-detail-dashboard"
          accentClass="text-accent"
          icon={
            <svg
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
              />
            </svg>
          }
        />
        <SpaceNavItem
          label="Agents"
          active={isSpaceAgentSelected}
          onClick={handleSpaceAgentClick}
          testId="space-detail-agent"
          accentClass="text-cat-purple"
          icon={
            <svg
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
              />
            </svg>
          }
        />

        <SpaceNavItem
          label="Goals"
          active={isGoalsSelected}
          onClick={handleGoalsClick}
          testId="space-detail-goals"
          accentClass="text-accent"
          icon={
            <svg
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z"
              />
            </svg>
          }
          badge={
            goals.length > 0 ? (
              <span class="flex-shrink-0 text-xs tabular-nums text-fg-muted">
                {goals.filter((goal) => goal.status !== 'archived').length}
              </span>
            ) : undefined
          }
        />
        <SpaceNavItem
          label="Memories"
          active={isMemoriesSelected}
          onClick={handleMemoriesClick}
          testId="space-detail-memories"
          accentClass="text-cat-pink"
          icon={
            <svg
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
              />
            </svg>
          }
        />
        <SpaceNavItem
          label="Evolve"
          active={isForgeSelected}
          onClick={handleForgeClick}
          testId="space-detail-forge"
          accentClass="text-cat-cyan"
          icon={
            <svg
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M11 4H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-4M16 3l5 5-9 9H7v-5l9-9z"
              />
            </svg>
          }
        />
        <SpaceNavItem
          label="Tasks"
          active={isTasksSelected}
          onClick={() => handleTasksClick()}
          testId="space-detail-tasks"
          accentClass="text-success"
          icon={
            <svg
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m0 0h-2"
              />
            </svg>
          }
          badge={
            actionCount > 0 ? (
              <span class="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-warning/15 px-1.5 text-xs font-medium tabular-nums text-warning-soft">
                {actionCount}
              </span>
            ) : undefined
          }
        />
        <SpaceNavItem
          label="Sessions"
          active={isSessionsSelected}
          onClick={handleSessionsClick}
          testId="space-detail-sessions"
          accentClass="text-warning"
          icon={
            <svg
              class="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
              />
            </svg>
          }
          badge={
            sessions.length > 0 ? (
              <span class="flex-shrink-0 text-xs tabular-nums text-fg-muted">
                {sessions.length}
              </span>
            ) : undefined
          }
        />
      </nav>

      <div class="border-t border-line mx-3 my-2" />

      <div class="flex-1 overflow-y-auto">
        <CollapsibleSection title="Tasks">
          {taskListCount > 0 && (
            <div class="flex items-center gap-1 px-2 py-1">
              <TaskTabButton
                label="Active"
                count={activeCount}
                active={taskTab === 'active'}
                onClick={() => setTaskTab('active')}
              />
              <TaskTabButton
                label="Action"
                count={actionCount}
                active={taskTab === 'action'}
                onClick={() => setTaskTab('action')}
              />
              {draftCount > 0 && (
                <TaskTabButton
                  label="Drafts"
                  count={draftCount}
                  active={taskTab === 'draft'}
                  onClick={() => setTaskTab('draft')}
                />
              )}
            </div>
          )}
          {visibleTasks.length === 0 ? (
            <div class="px-4 py-2 text-xs text-fg-muted">No tasks</div>
          ) : (
            visibleTasks.map((task) => {
              const taskUnread =
                selectedTaskId !== task.id && isSpaceTaskUnread(task.id, task.updatedAt);
              const taskRunning =
                task.status === 'in_progress' &&
                (!task.workflowRunId ||
                  spaceStore.activeRuns.value.some((r) => r.id === task.workflowRunId));
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => handleTaskClick(task.id)}
                  class={cn(
                    'w-full px-3 py-1.5 flex items-center gap-2 rounded-lg transition-colors text-left',
                    selectedTaskId === task.id ? 'bg-fill' : 'hover:bg-fill-soft'
                  )}
                >
                  <TaskStatusDot status={task.status} pulse={taskRunning} />
                  <div class="min-w-0 flex-1">
                    <span class="block text-sm text-fg-muted truncate">{task.title}</span>
                  </div>
                  {taskUnread && <StatusDot tone="info" size="xs" aria-label="Has updates" />}
                </button>
              );
            })
          )}
          {tasksForTab.length > SIDEBAR_PREVIEW_LIMIT && (
            <button
              type="button"
              data-testid="space-tasks-view-all"
              onClick={() => handleTasksClick(taskTab)}
              class="w-full px-3 py-1.5 text-left text-xs text-fg-muted transition-colors hover:text-fg-soft"
            >
              View all {tasksForTab.length}
            </button>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Sessions"
          count={sessions.length}
          defaultExpanded={true}
          headerRight={
            <button
              type="button"
              onClick={handleCreateSession}
              class="rounded-md p-0.5 text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg-soft"
              aria-label="Create session"
            >
              <svg
                class="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </button>
          }
        >
          {visibleSessions.length === 0 ? (
            <div class="px-4 py-2 text-xs text-fg-muted">No sessions</div>
          ) : (
            visibleSessions.map((session) => (
              <SpaceDetailSessionRow
                key={session.id}
                session={session}
                isSelected={selectedSessionId === session.id}
                onClick={handleSessionClick}
                onArchive={handleArchive}
              />
            ))
          )}
          {sessions.length > SIDEBAR_PREVIEW_LIMIT && (
            <button
              type="button"
              data-testid="space-sessions-view-all"
              onClick={() => handleSessionsClick()}
              class="w-full px-3 py-1.5 text-left text-xs text-fg-muted transition-colors hover:text-fg-soft"
            >
              View all {sessions.length}
            </button>
          )}
        </CollapsibleSection>
      </div>

      {archiveConfirm && (
        <ArchiveConfirmDialog
          commitStatus={archiveConfirm.commitStatus}
          archiving={archiveBusy}
          onConfirm={handleConfirmArchive}
          onCancel={() => setArchiveConfirm(null)}
        />
      )}
      {workspaceChoice.dialog}
    </div>
  );
}
