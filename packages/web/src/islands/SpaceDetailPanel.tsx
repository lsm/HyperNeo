import type { SpaceTaskStatus } from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { ConversationDisclosure } from '../components/ConversationDisclosure';
import { ConversationRow } from '../components/ConversationRow';
import { CollapsibleSection } from '../components/ui/CollapsibleSection';
import {
  navigateToSpace,
  navigateToSpaceAgent,
  navigateToSpaceEvolve,
  navigateToSpaceGoals,
  navigateToSpaceMemories,
  navigateToSpaceSession,
  navigateToSpaceTask,
  navigateToSpaceTasks,
} from '../lib/router';
import {
  cloneConversationTitles,
  conversationTitle,
  getSessionSidebarStatus,
  getTaskSidebarStatus,
} from '../lib/session-sidebar-status';
import {
  currentSpaceAgentHandleSignal,
  currentSpaceSessionIdSignal,
  currentSpaceTaskIdSignal,
  currentSpaceTaskViewTabSignal,
  currentSpaceViewModeSignal,
  spaceOverlayPendingTaskIdSignal,
  spaceOverlaySessionIdSignal,
} from '../lib/signals';
import { type SpaceSessionRow, spaceStore } from '../lib/space-store';
import {
  getSpaceSessionUnreadCount,
  isSpaceTaskUnread,
  markSpaceSessionRead,
  markSpaceTaskRead,
  seedSpaceTasksSeen,
  syncSpaceSessionSeen,
} from '../lib/space-unread';
import { isActionRequired, isActiveTask, isDraftTask } from '../lib/task-filters';
import { getTaskStatusConfig } from '../lib/task-status';
import { cn } from '../lib/utils';

type TaskTab = 'active' | 'action' | 'draft';

const SIDEBAR_PREVIEW_LIMIT = 10;

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
      aria-pressed={active}
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
      aria-current={active ? 'page' : undefined}
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

  const selectedSessionId = currentSpaceSessionIdSignal.value;
  const selectedAgentHandle = currentSpaceAgentHandleSignal.value;
  const selectedTaskId = currentSpaceTaskIdSignal.value;
  const sessions = spaceStore.sessions.value;
  const agents = spaceStore.agents.value.filter((agent) => agent.status !== 'archived');
  const viewedSessionId = spaceOverlayPendingTaskIdSignal.value
    ? null
    : (spaceOverlaySessionIdSignal.value ??
      selectedSessionId ??
      agents.find((agent) => agent.handle === selectedAgentHandle)?.sessionId);
  const viewedTaskId =
    !spaceOverlaySessionIdSignal.value &&
    !spaceOverlayPendingTaskIdSignal.value &&
    currentSpaceTaskViewTabSignal.value !== 'canvas'
      ? selectedTaskId
      : null;
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [taskTab, setTaskTab] = useState<TaskTab>('action');

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
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
    for (const session of sessions) {
      if (session.id === viewedSessionId || (viewedTaskId && session.taskId === viewedTaskId)) {
        markSpaceSessionRead(session.id, session.messageCount);
      }
    }
  }, [viewedSessionId, viewedTaskId, sessions]);

  useEffect(() => {
    syncSpaceSessionSeen(sessions);
  }, [sessions]);

  useEffect(() => {
    seedSpaceTasksSeen(tasks);
  }, [tasks]);

  useEffect(() => {
    if (!viewedTaskId) return;
    const task = tasks.find((t) => t.id === viewedTaskId);
    if (task) markSpaceTaskRead(task.id, task.updatedAt);
  }, [viewedTaskId, tasks]);

  const isOverviewSelected =
    selectedSessionId === null &&
    selectedTaskId === null &&
    currentSpaceViewModeSignal.value === 'overview';
  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const isSpaceAgentSelected =
    currentSpaceViewModeSignal.value === 'agents' ||
    agents.some(
      (agent) =>
        agent.sessionId &&
        (agent.sessionId === selectedSessionId ||
          agent.sessionId === selectedSession?.parentSessionId)
    );
  const isGoalsSelected = currentSpaceViewModeSignal.value === 'goals';
  const isMemoriesSelected = currentSpaceViewModeSignal.value === 'memories';
  const isForgeSelected = currentSpaceViewModeSignal.value === 'forge';
  const isTasksSelected = currentSpaceViewModeSignal.value === 'tasks';

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

  const clonesByParent = useMemo(() => {
    const groups = new Map<string, SpaceSessionRow[]>();
    for (const row of sessions) {
      if (!row.parentSessionId) continue;
      const group = groups.get(row.parentSessionId) ?? [];
      group.push(row);
      groups.set(row.parentSessionId, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
    }
    return groups;
  }, [sessions]);

  const visibleClones = useCallback(
    (parentSessionId: string | null, expanded: boolean): SpaceSessionRow[] => {
      const all = parentSessionId ? (clonesByParent.get(parentSessionId) ?? []) : [];
      if (expanded) return all;
      return all.filter((row) => row.id === selectedSessionId || row.id === viewedSessionId);
    },
    [clonesByParent, selectedSessionId, viewedSessionId]
  );

  const handleCloneClick = useCallback(
    (sessionId: string) => {
      navigateToSpaceSession(routeSpaceId, sessionId);
      onNavigate?.();
    },
    [routeSpaceId, onNavigate]
  );

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

  const handleTaskClick = useCallback(
    (taskId: string) => {
      navigateToSpaceTask(routeSpaceId, taskId);
      onNavigate?.();
    },
    [routeSpaceId, onNavigate]
  );

  const handleAgentClick = useCallback(
    (agent: { handle: string }) => {
      navigateToSpaceAgent(routeSpaceId, agent.handle);
      onNavigate?.();
    },
    [routeSpaceId, onNavigate]
  );

  if (!isReady) {
    return (
      <div class="flex-1 flex items-center justify-center p-6">
        <span class="text-xs text-fg-muted">Loading…</span>
      </div>
    );
  }

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
                viewedTaskId !== task.id && isSpaceTaskUnread(task.id, task.updatedAt);
              const taskSessions = sessions.filter((session) => session.taskId === task.id);
              const taskActivity = getTaskSidebarStatus(task, taskSessions);
              const lifecycleLabel = getTaskStatusConfig(task.status).label;
              return (
                <ConversationRow
                  key={task.id}
                  title={task.title}
                  selected={selectedTaskId === task.id}
                  status={taskActivity}
                  secondaryStatus={
                    taskActivity.label !== lifecycleLabel
                      ? { ...getTaskStatusConfig(task.status), kind: task.status, pulse: false }
                      : undefined
                  }
                  unread={taskUnread}
                  unreadCount={taskSessions.reduce(
                    (count, session) =>
                      count +
                      (session.id === viewedSessionId || task.id === viewedTaskId
                        ? 0
                        : getSpaceSessionUnreadCount(session.id, session.messageCount)),
                    0
                  )}
                  onClick={() => handleTaskClick(task.id)}
                />
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
            agents.map((agent) => {
              const session = sessions.find((row) => row.id === agent.sessionId);
              const expanded = expandedAgents.has(agent.id);
              const clones = visibleClones(agent.sessionId, expanded);
              const cloneCount = agent.sessionId
                ? (clonesByParent.get(agent.sessionId)?.length ?? 0)
                : 0;
              const cloneTitles = cloneConversationTitles(
                agent.displayName,
                agent.sessionId ? (clonesByParent.get(agent.sessionId) ?? []) : []
              );
              return (
                <div key={agent.id} class="group/agent">
                  <ConversationRow
                    title={agent.displayName}
                    testId="space-detail-agent-row"
                    sessionId={agent.sessionId ?? undefined}
                    selected={
                      (agent.sessionId !== null && agent.sessionId === selectedSessionId) ||
                      agent.handle === selectedAgentHandle
                    }
                    status={getSessionSidebarStatus(session ?? null)}
                    unreadCount={
                      session && session.id !== viewedSessionId
                        ? getSpaceSessionUnreadCount(session.id, session.messageCount)
                        : 0
                    }
                    onClick={() => handleAgentClick(agent)}
                    unread={
                      !expanded &&
                      (agent.sessionId ? (clonesByParent.get(agent.sessionId) ?? []) : []).some(
                        (clone) =>
                          clone.id !== viewedSessionId &&
                          getSpaceSessionUnreadCount(clone.id, clone.messageCount) > 0
                      )
                    }
                    disclosure={
                      cloneCount > 0 && (
                        <ConversationDisclosure
                          expanded={expanded}
                          title={agent.displayName}
                          onToggle={() =>
                            setExpandedAgents((previous) => {
                              const next = new Set(previous);
                              if (expanded) next.delete(agent.id);
                              else next.add(agent.id);
                              return next;
                            })
                          }
                        />
                      )
                    }
                  >
                    {agent.status !== 'active' && (
                      <span class="text-[11px] text-fg-faint">{agent.status}</span>
                    )}
                  </ConversationRow>
                  {clones.map((clone) => (
                    <ConversationRow
                      key={clone.id}
                      title={cloneTitles.get(clone.id) ?? conversationTitle(clone.title, true)}
                      testId="space-detail-clone-row"
                      sessionId={clone.id}
                      nested
                      selected={clone.id === selectedSessionId}
                      status={getSessionSidebarStatus(clone)}
                      unreadCount={
                        clone.id === viewedSessionId
                          ? 0
                          : getSpaceSessionUnreadCount(clone.id, clone.messageCount)
                      }
                      onClick={() => handleCloneClick(clone.id)}
                    >
                      {clone.returnedAt && (
                        <span
                          class="text-fg-faint"
                          title={`Returned ${clone.returnedAt}`}
                          aria-label="Returned"
                        >
                          ✓
                        </span>
                      )}
                    </ConversationRow>
                  ))}
                </div>
              );
            })
          )}
        </CollapsibleSection>
      </div>
    </div>
  );
}
