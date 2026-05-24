/**
 * SpaceDetailPanel
 *
 * Space-specific context panel for the three-column layout.
 * Prioritizes fast access to overview, review work, and sessions.
 */

import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { CollapsibleSection } from '../components/ui/CollapsibleSection';
import { createSession } from '../lib/api-helpers';
import {
  navigateToSpace,
  navigateToSpaceAgent,
  navigateToSpaceGoals,
  navigateToSpaceForge,
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
import { cn } from '../lib/utils';

type TaskTab = 'active' | 'action' | 'draft';

const sessionStatusColors: Record<string, string> = {
  active: 'bg-green-500',
  pending_worktree_choice: 'bg-amber-500',
  paused: 'bg-amber-500',
  ended: 'bg-gray-500',
};

const taskStatusColors: Record<string, string> = {
  open: 'bg-gray-500',
  in_progress: 'bg-blue-500',
  blocked: 'bg-amber-500',
  review: 'bg-purple-500',
  // `approved` tasks now appear in the sidebar Active tab — match the
  // emerald accent used by `SpaceTasks.tsx` (`STATUS_BORDER`) so the dot
  // colour reads consistently across both surfaces.
  approved: 'bg-emerald-500',
  done: 'bg-green-500',
  cancelled: 'bg-gray-600',
  archived: 'bg-gray-700',
};

function TaskStatusDot({ status }: { status: string }) {
  return (
    <div
      class={cn('w-2 h-2 rounded-full flex-shrink-0', taskStatusColors[status] ?? 'bg-gray-500')}
    />
  );
}

interface SpaceDetailPanelProps {
  spaceId: string;
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
        active ? 'bg-white/5 text-gray-200' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'
      )}
    >
      <span>{label}</span>
      <span class="text-[11px] text-gray-500 tabular-nums">{count}</span>
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
        active ? 'bg-white/10 text-gray-100' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
      )}
    >
      <span
        class={cn(
          'flex h-5 w-5 flex-shrink-0 items-center justify-center',
          active ? accentClass : 'text-gray-500'
        )}
      >
        {icon}
      </span>
      <span class="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </button>
  );
}

export function SpaceDetailPanel({ spaceId, onNavigate }: SpaceDetailPanelProps) {
  const isLoading = spaceStore.loading.value;
  const loadedSpaceId = spaceStore.spaceId.value;
  const tasks = spaceStore.tasks.value;
  const goals = spaceStore.goals.value;
  const space = spaceStore.space.value;

  const isReady = !isLoading && loadedSpaceId === spaceId;

  if (!isReady) {
    return (
      <div class="flex-1 flex items-center justify-center p-6">
        <span class="text-xs text-gray-600">Loading…</span>
      </div>
    );
  }

  const selectedSessionId = currentSpaceSessionIdSignal.value;
  const selectedTaskId = currentSpaceTaskIdSignal.value;
  const spaceAgentSessionId = `space:chat:${spaceId}`;

  const [taskTab, setTaskTab] = useState<TaskTab>('action');

  // Auto-switch tab when the selected task changes (not on every task update)
  useEffect(() => {
    if (!selectedTaskId) return;
    const task = tasks.find((t) => t.id === selectedTaskId);
    if (!task) return;
    if (isActiveTask(task) && taskTab !== 'active') setTaskTab('active');
    else if (isActionRequired(task) && taskTab !== 'action') setTaskTab('action');
    else if (isDraftTask(task) && taskTab !== 'draft') setTaskTab('draft');
    // Only re-run when the selected task changes, not on every task list update.
  }, [selectedTaskId]);

  const isOverviewSelected =
    selectedSessionId === null &&
    selectedTaskId === null &&
    currentSpaceViewModeSignal.value === 'overview';
  const isSpaceAgentSelected = selectedSessionId === spaceAgentSessionId;
  const isGoalsSelected = currentSpaceViewModeSignal.value === 'goals';
  const isForgeSelected = currentSpaceViewModeSignal.value === 'forge';
  const isTasksSelected = currentSpaceViewModeSignal.value === 'tasks';
  const isSessionsSelected = currentSpaceViewModeSignal.value === 'sessions';

  // Action tab + Tasks-nav badge share the same predicate (`isActionRequired`)
  // so the badge count cannot drift from what's visible under the Action tab.
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
    const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
    const predicate =
      taskTab === 'action' ? isActionRequired : taskTab === 'draft' ? isDraftTask : isActiveTask;
    return sorted.filter(predicate);
  }, [tasks, taskTab, selectedTaskId]);

  const sessions = useMemo(() => {
    const storeSessions = spaceStore.sessions.value;
    const isSystemSpaceSession = (sessionId: string): boolean =>
      sessionId.startsWith(`space:${spaceId}:task:`) ||
      sessionId.startsWith(`space:${spaceId}:workflow:`);

    return storeSessions.filter((s) => !isSystemSpaceSession(s.id));
  }, [spaceStore.sessions.value, spaceId]);

  const handleOverviewClick = useCallback(() => {
    navigateToSpace(spaceId);
    onNavigate?.();
  }, [spaceId, onNavigate]);

  const handleSpaceAgentClick = useCallback(() => {
    navigateToSpaceAgent(spaceId);
    onNavigate?.();
  }, [spaceId, onNavigate]);

  const handleGoalsClick = useCallback(() => {
    navigateToSpaceGoals(spaceId);
    onNavigate?.();
  }, [spaceId, onNavigate]);

  const handleForgeClick = useCallback(() => {
    navigateToSpaceForge(spaceId);
    onNavigate?.();
  }, [spaceId, onNavigate]);

  const handleTasksClick = useCallback(() => {
    navigateToSpaceTasks(spaceId);
    onNavigate?.();
  }, [spaceId, onNavigate]);

  const handleSessionsClick = useCallback(() => {
    navigateToSpaceSessions(spaceId);
    onNavigate?.();
  }, [spaceId, onNavigate]);

  const handleTaskClick = useCallback(
    (taskId: string) => {
      navigateToSpaceTask(spaceId, taskId);
      onNavigate?.();
    },
    [spaceId, onNavigate]
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      navigateToSpaceSession(spaceId, sessionId);
      onNavigate?.();
    },
    [spaceId, onNavigate]
  );

  const handleCreateSession = useCallback(
    async (e: Event) => {
      e.stopPropagation();
      try {
        const response = await createSession({
          spaceId,
          workspacePath: space?.workspacePath,
        });
        navigateToSpaceSession(spaceId, response.sessionId);
        onNavigate?.();
      } catch {
        // Session creation failed silently
      }
    },
    [spaceId, space?.workspacePath, onNavigate]
  );

  return (
    <div class="flex-1 flex flex-col overflow-hidden">
      <nav class="flex flex-col gap-1 px-1 pt-2 pb-2" aria-label="Space navigation">
        <SpaceNavItem
          label="Overview"
          active={isOverviewSelected}
          onClick={handleOverviewClick}
          testId="space-detail-dashboard"
          accentClass="text-blue-400"
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
          accentClass="text-purple-400"
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
          accentClass="text-blue-400"
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
              <span class="flex-shrink-0 text-xs tabular-nums text-gray-500">
                {goals.filter((goal) => goal.status !== 'archived').length}
              </span>
            ) : undefined
          }
        />
        <SpaceNavItem
          label="Forge"
          active={isForgeSelected}
          onClick={handleForgeClick}
          testId="space-detail-forge"
          accentClass="text-cyan-400"
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
          onClick={handleTasksClick}
          testId="space-detail-tasks"
          accentClass="text-green-400"
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
              <span class="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-xs font-medium tabular-nums text-amber-300">
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
          accentClass="text-amber-400"
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
              <span class="flex-shrink-0 text-xs tabular-nums text-gray-500">
                {sessions.length}
              </span>
            ) : undefined
          }
        />
      </nav>

      <div class="border-t border-white/10 mx-3 my-2" />

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
          {tasksForTab.length === 0 ? (
            <div class="px-4 py-2 text-xs text-gray-600">No tasks</div>
          ) : (
            tasksForTab.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => handleTaskClick(task.id)}
                class={cn(
                  'w-full px-3 py-1.5 flex items-center gap-2 rounded-lg transition-colors text-left',
                  selectedTaskId === task.id ? 'bg-white/10' : 'hover:bg-white/5'
                )}
              >
                <TaskStatusDot status={task.status} />
                <div class="min-w-0 flex-1">
                  <span class="block text-sm text-gray-400 truncate">{task.title}</span>
                </div>
              </button>
            ))
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
              class="rounded-md p-0.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-300"
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
          {sessions.length === 0 ? (
            <div class="px-4 py-2 text-xs text-gray-600">No sessions</div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => handleSessionClick(session.id)}
                class={cn(
                  'w-full px-3 py-2 flex items-center gap-2.5 rounded-lg transition-colors',
                  selectedSessionId === session.id ? 'bg-white/10' : 'hover:bg-white/5'
                )}
              >
                <div
                  class={cn(
                    'w-2 h-2 rounded-full flex-shrink-0',
                    sessionStatusColors[session.status] ?? 'bg-gray-500'
                  )}
                />
                <span class="flex-1 text-sm text-gray-300 truncate text-left">{session.title}</span>
              </button>
            ))
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
}
