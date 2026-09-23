import type { SpaceTaskStatus } from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { CollapsibleSection } from '../components/ui/CollapsibleSection';
import { StatusDot } from '../components/ui/StatusDot';
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
import { spaceStore } from '../lib/space-store';
import { isActionRequired, isActiveTask, isDraftTask } from '../lib/task-filters';
import { getTaskStatusConfig } from '../lib/task-status';
import {
  isSpaceTaskUnread,
  markSpaceSessionRead,
  markSpaceTaskRead,
  seedSpaceTasksSeen,
  syncSpaceSessionSeen,
} from '../lib/space-unread';
import { cn } from '../lib/utils';

type TaskTab = 'active' | 'action' | 'draft';

const SIDEBAR_PREVIEW_LIMIT = 10;

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

  const agents = spaceStore.agents.value.filter((agent) => agent.status !== 'archived');

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

  const handleAgentClick = useCallback(
    (agent: { handle: string; sessionId: string | null }) => {
      if (agent.sessionId) navigateToSpaceSession(routeSpaceId, agent.sessionId);
      else navigateToSpaceAgent(routeSpaceId, agent.handle);
      onNavigate?.();
    },
    [routeSpaceId, onNavigate]
  );

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

        <CollapsibleSection title="Agents" count={agents.length} defaultExpanded={true}>
          {agents.length === 0 ? (
            <div class="px-4 py-2 text-xs text-fg-muted">No agents</div>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                data-testid="space-detail-agent-row"
                onClick={() => handleAgentClick(agent)}
                class={`w-full flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                  agent.sessionId !== null && agent.sessionId === selectedSessionId
                    ? 'bg-fill-soft text-fg'
                    : 'text-fg-soft hover:bg-fill-soft hover:text-fg'
                }`}
              >
                <span class="min-w-0 flex-1 truncate">{agent.displayName}</span>
                {agent.status !== 'active' && (
                  <span class="text-[11px] text-fg-faint">{agent.status}</span>
                )}
              </button>
            ))
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
}
