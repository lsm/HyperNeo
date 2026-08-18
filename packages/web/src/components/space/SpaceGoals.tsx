import type { SpaceGoal, SpaceGoalEvent, SpaceGoalStatus, SpaceTask } from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { getGoalStatusClasses, getGoalStatusConfig } from '../../lib/goal-status';
import { navigateToSpaceTask } from '../../lib/router';
import { currentSpaceGoalIdSignal, rightPanelTargetSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { cn, getRelativeTime } from '../../lib/utils';
import {
  FLAT_SURFACE,
  GLASS_CONTENT_CONTAINER_CLASS,
  GLASS_PRIMARY_BUTTON_CLASS,
  GLASS_SURFACE,
} from './glass-workspace';
import {
  formatGoalMetricSnapshot,
  getGoalActivityTask,
  getGoalLastActivityAt,
  getRecurringGoalActivityStatus,
} from './goal-display-utils';
import { SpaceGoalDialog } from './SpaceGoalDialog';

interface SpaceGoalsProps {
  spaceId: string;
  navigationSpaceId?: string;
}

const TYPE_LABELS: Record<SpaceGoal['type'], string> = {
  one_shot: 'One-shot',
  measurable: 'Measurable',
  recurring: 'Recurring',
};

function formatDate(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatGoalCount(count: number): string {
  return `${count} ${count === 1 ? 'objective' : 'objectives'}`;
}

function goalTask(tasks: SpaceTask[], taskId: string | null): SpaceTask | null {
  if (!taskId) return null;
  return tasks.find((task) => task.id === taskId) ?? null;
}

function goalDisplayTask(goal: SpaceGoal, tasks: SpaceTask[]): SpaceTask | null {
  return getGoalActivityTask(goal, tasks) ?? goalTask(tasks, goal.lastTaskId);
}

function eventLabel(event: SpaceGoalEvent): string {
  return event.eventType.replace(/_/g, ' ');
}

function lastActivityLabel(goal: SpaceGoal, lastTask: SpaceTask | null): string {
  const lastActivityAt = getGoalLastActivityAt(goal, lastTask);
  return lastActivityAt ? formatDate(lastActivityAt) : '—';
}

function GoalStatusBadge({ status }: { status: SpaceGoalStatus }) {
  return (
    <span
      class={cn(
        'rounded-full border px-2 py-0.5 text-xs font-medium',
        getGoalStatusClasses(status).soft
      )}
    >
      {getGoalStatusConfig(status).label}
    </span>
  );
}

const GOAL_ACTION_BUTTON_CLASS =
  'h-8 rounded-md border px-3 text-xs font-medium transition-colors disabled:opacity-50';

function ProgressBar({ value }: { value: number }) {
  const safeValue = Math.max(0, Math.min(100, value));
  return (
    <div class="h-1.5 rounded-full bg-dark-800/80">
      <div
        class="h-1.5 rounded-full bg-blue-500 transition-[width]"
        style={{ width: `${safeValue}%` }}
      />
    </div>
  );
}

function GoalCard({
  goal,
  selected,
  lastTask,
  onSelect,
}: {
  goal: SpaceGoal;
  selected: boolean;
  lastTask: SpaceTask | null;
  onSelect: () => void;
}) {
  const recurringActivityStatus = getRecurringGoalActivityStatus(goal, lastTask);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      class={cn(
        'group relative flex min-h-[12rem] w-full flex-col overflow-hidden rounded-2xl border border-white/[0.14] p-5 text-left transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70',
        FLAT_SURFACE,
        selected
          ? '!border-[rgba(111,177,255,0.72)] bg-[linear-gradient(145deg,rgba(35,82,137,0.44),rgba(13,20,32,0.96)_62%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_20px_48px_rgba(0,0,0,0.3)]'
          : 'hover:-translate-y-0.5 hover:bg-dark-850/95'
      )}
    >
      <div class="min-w-0">
        <div class="flex items-start justify-between gap-4">
          <h3 class="line-clamp-2 text-base font-semibold leading-6 tracking-tight text-gray-50">
            {goal.title}
          </h3>
          <span class="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">
            {goal.priority}
          </span>
        </div>
        <div class="mt-2.5 flex flex-wrap items-center gap-2">
          <GoalStatusBadge status={goal.status} />
          <span class="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-gray-300">
            {TYPE_LABELS[goal.type]}
          </span>
          {goal.pendingNextRun && (
            <span class="rounded-full border border-amber-300/20 bg-amber-300/[0.08] px-2 py-0.5 text-xs text-amber-200">
              Pending next
            </span>
          )}
        </div>
        <p class="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-gray-300">
          {goal.summary || goal.description || 'No summary recorded yet'}
        </p>
      </div>

      {goal.type === 'recurring' ? (
        <div class="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3.5 py-3 text-xs">
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-gray-400">Activity</span>
            <span class="flex items-center gap-1.5 capitalize text-gray-200">
              <span
                class={`h-1.5 w-1.5 rounded-full ${
                  recurringActivityStatus === 'active'
                    ? 'bg-emerald-300/80'
                    : recurringActivityStatus === 'paused'
                      ? 'bg-amber-300/80'
                      : 'bg-gray-400/80'
                }`}
                aria-hidden="true"
              />
              {recurringActivityStatus}
            </span>
          </div>
          <div class="mt-2 text-gray-400">Last activity: {lastActivityLabel(goal, lastTask)}</div>
          <div class="mt-1 line-clamp-2 text-gray-300">
            Metrics: {formatGoalMetricSnapshot(goal)}
          </div>
        </div>
      ) : (
        <div class="mt-4 space-y-2.5 rounded-xl border border-white/[0.08] bg-white/[0.035] px-3.5 py-3">
          <div class="flex items-center justify-between text-xs">
            <span class="font-medium text-gray-400">Progress</span>
            <span class="text-gray-200">{goal.progress ?? 0}% complete</span>
          </div>
          <ProgressBar value={goal.progress ?? 0} />
        </div>
      )}

      <div class="mt-auto grid grid-cols-3 gap-3 border-t border-white/[0.08] pt-3 text-xs">
        <div class="min-w-0">
          <span class="block text-gray-500">Next check-in</span>
          <span class="mt-0.5 block truncate text-gray-300">{formatDate(goal.nextCheckInAt)}</span>
        </div>
        <div class="min-w-0">
          <span class="block text-gray-500">Last task</span>
          <span class="mt-0.5 block truncate text-gray-300">
            {lastTask?.title ?? goal.lastTaskId ?? '—'}
          </span>
        </div>
        <div class="min-w-0">
          <span class="block text-gray-500">Priority</span>
          <span class="mt-0.5 block capitalize text-gray-300">{goal.priority}</span>
        </div>
      </div>
    </button>
  );
}

function DetailSection({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="rounded-lg bg-dark-900/65 p-4">
      <h3 class="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{title}</h3>
      {children}
    </section>
  );
}

export function GoalDetail({
  goal,
  tasks,
  events,
  onEdit,
  onRunAction,
  actionLoading,
  spaceId,
  navigationSpaceId,
}: {
  goal: SpaceGoal;
  tasks: SpaceTask[];
  events: SpaceGoalEvent[];
  onEdit: () => void;
  onRunAction: (action: 'pause' | 'resume' | 'archive' | 'trigger') => void;
  actionLoading: boolean;
  spaceId: string;
  navigationSpaceId?: string;
}) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const linkedTasks = tasks
    .filter(
      (task) =>
        task.goalId === goal.id || task.id === goal.activeTaskId || task.id === goal.lastTaskId
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activeTask = goalTask(tasks, goal.activeTaskId);
  const lastTask = goalTask(tasks, goal.lastTaskId);
  const activityTask = getGoalActivityTask(goal, tasks);

  return (
    <div class="flex h-full flex-col overflow-hidden">
      <div class="relative flex h-[88px] flex-col justify-center bg-dark-900/30 px-5">
        <div class="pr-12">
          <h2 class="truncate text-base font-semibold leading-6 text-gray-100">{goal.title}</h2>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <GoalStatusBadge status={goal.status} />
            <span class="rounded-full border border-dark-600 px-2 py-0.5 text-xs text-gray-400">
              {TYPE_LABELS[goal.type]}
            </span>
            <span class="rounded-full border border-dark-600 px-2 py-0.5 text-xs capitalize text-gray-400">
              {goal.priority}
            </span>
          </div>
        </div>
        <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
      </div>

      <div class="flex flex-wrap gap-2 px-4 pt-4">
        <button
          type="button"
          onClick={onEdit}
          class={cn(
            GOAL_ACTION_BUTTON_CLASS,
            'border-dark-600 bg-dark-800 text-gray-200 hover:bg-dark-700'
          )}
        >
          Edit details
        </button>
        {goal.status === 'active' && (
          <button
            type="button"
            disabled={actionLoading}
            onClick={() => onRunAction('pause')}
            class={cn(
              GOAL_ACTION_BUTTON_CLASS,
              'border-dark-600 bg-dark-800 text-amber-200 hover:bg-dark-700'
            )}
          >
            Pause
          </button>
        )}
        {goal.status === 'paused' && (
          <button
            type="button"
            disabled={actionLoading}
            onClick={() => onRunAction('resume')}
            class={cn(
              GOAL_ACTION_BUTTON_CLASS,
              'border-dark-600 bg-dark-800 text-green-200 hover:bg-dark-700'
            )}
          >
            Resume
          </button>
        )}
        <button
          type="button"
          disabled={actionLoading || goal.status !== 'active'}
          onClick={() => onRunAction('trigger')}
          class={cn(
            GOAL_ACTION_BUTTON_CLASS,
            'border-blue-700 bg-blue-600 text-white hover:bg-blue-500'
          )}
        >
          Create task now
        </button>
        {goal.status !== 'archived' && (
          <button
            type="button"
            disabled={actionLoading}
            onClick={() => onRunAction('archive')}
            class={cn(
              GOAL_ACTION_BUTTON_CLASS,
              'border-dark-600 bg-dark-800 text-red-200 hover:bg-dark-700'
            )}
          >
            Archive
          </button>
        )}
      </div>

      <div class="flex-1 space-y-4 overflow-y-auto p-4">
        <DetailSection title="Rolling state">
          <div class="space-y-3">
            <p class="text-sm text-gray-300">{goal.summary || 'No summary yet'}</p>
            {goal.type === 'recurring' ? (
              <div class="rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2 text-xs">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-gray-400">Activity status</span>
                  <span class="capitalize text-gray-300">
                    {getRecurringGoalActivityStatus(goal, activityTask)}
                  </span>
                </div>
                <div class="mt-2 text-gray-400">
                  Last activity: {lastActivityLabel(goal, activityTask)}
                </div>
                <div class="mt-2 text-gray-400">
                  Metric trajectory: {formatGoalMetricSnapshot(goal)}
                </div>
              </div>
            ) : (
              <div>
                <div class="mb-1 flex justify-between text-xs text-gray-400">
                  <span>Progress</span>
                  <span>{goal.progress ?? 0}%</span>
                </div>
                <ProgressBar value={goal.progress ?? 0} />
              </div>
            )}
            <div class="grid grid-cols-2 gap-3 text-xs text-gray-400">
              <div>
                <span class="block text-gray-400">Last check-in</span>
                <span class="text-gray-300">{formatDate(goal.lastCheckInAt)}</span>
              </div>
              <div>
                <span class="block text-gray-400">Next check-in</span>
                <span class="text-gray-300">{formatDate(goal.nextCheckInAt)}</span>
              </div>
              <div>
                <span class="block text-gray-400">Auto trigger next</span>
                <span class="text-gray-300">{goal.autoTriggerNext ? 'Enabled' : 'Off'}</span>
              </div>
              <div>
                <span class="block text-gray-400">Concurrency state</span>
                <span class="text-gray-300">
                  {activeTask
                    ? 'Active task running'
                    : goal.pendingNextRun
                      ? 'Pending next run'
                      : 'Idle'}
                </span>
              </div>
            </div>
          </div>
        </DetailSection>

        <DetailSection title="Metrics">
          {Object.keys(goal.metrics).length === 0 ? (
            <p class="text-sm text-gray-400">No metrics recorded</p>
          ) : (
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {Object.entries(goal.metrics).map(([key, value]) => (
                <div key={key} class="rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2">
                  <span class="block text-xs text-gray-400">{key}</span>
                  <span class="text-sm text-gray-200">{String(value ?? '—')}</span>
                </div>
              ))}
            </div>
          )}
        </DetailSection>

        <DetailSection title="Next steps">
          {goal.nextSteps.length === 0 ? (
            <p class="text-sm text-gray-400">No next steps recorded</p>
          ) : (
            <ul class="space-y-2 text-sm text-gray-300">
              {goal.nextSteps.map((step) => (
                <li key={step} class="flex gap-2">
                  <span class="text-gray-400">•</span>
                  <span>{step}</span>
                </li>
              ))}
            </ul>
          )}
        </DetailSection>

        <DetailSection title="Linked tasks">
          {linkedTasks.length === 0 ? (
            <p class="text-sm text-gray-400">No linked tasks yet</p>
          ) : (
            <div class="space-y-2">
              {linkedTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => navigateToSpaceTask(routeSpaceId, task.id)}
                  class="w-full rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2 text-left hover:border-dark-600"
                >
                  <div class="flex items-center justify-between gap-2">
                    <span class="truncate text-sm text-gray-200">{task.title}</span>
                    <span class="text-xs text-gray-400">#{task.taskNumber}</span>
                  </div>
                  <div class="mt-1 flex items-center gap-2 text-xs text-gray-400">
                    <span>{task.status}</span>
                    {task.result && <span class="truncate">{task.result}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
          {lastTask && !linkedTasks.some((task) => task.id === lastTask.id) && (
            <p class="mt-2 text-xs text-gray-400">Last task: {lastTask.title}</p>
          )}
        </DetailSection>

        <DetailSection title="Recent goal events">
          {events.length === 0 ? (
            <p class="text-sm text-gray-400">No events loaded</p>
          ) : (
            <div class="space-y-2">
              {events.slice(0, 6).map((event) => (
                <div
                  key={event.id}
                  class="rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2"
                >
                  <div class="flex items-center justify-between gap-2 text-xs">
                    <span class="capitalize text-gray-300">{eventLabel(event)}</span>
                    <span class="text-gray-400">{getRelativeTime(event.createdAt)}</span>
                  </div>
                  {event.note && <p class="mt-1 text-xs text-gray-400">{event.note}</p>}
                </div>
              ))}
            </div>
          )}
        </DetailSection>
      </div>
    </div>
  );
}

export function SpaceGoals({ spaceId, navigationSpaceId: _navigationSpaceId }: SpaceGoalsProps) {
  const goals = spaceStore.goals.value;
  const tasks = spaceStore.tasks.value;
  const selectedGoalId = currentSpaceGoalIdSignal.value;
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      spaceStore.listGoals({ includeArchived: showArchived }),
      spaceStore.ensureConfigData(),
    ])
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load goals');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, showArchived]);

  useEffect(() => {
    return () => {
      currentSpaceGoalIdSignal.value = null;
      if (rightPanelTargetSignal.value?.type === 'goal') rightPanelTargetSignal.value = null;
    };
  }, [spaceId]);

  const visibleGoals = useMemo(() => {
    const filtered = showArchived ? goals : goals.filter((goal) => goal.status !== 'archived');
    return [...filtered].sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [goals, showArchived]);

  useEffect(() => {
    if (selectedGoalId && visibleGoals.some((goal) => goal.id === selectedGoalId)) return;
    currentSpaceGoalIdSignal.value = visibleGoals[0]?.id ?? null;
  }, [visibleGoals, selectedGoalId]);

  const openGoal = (goalId: string) => {
    currentSpaceGoalIdSignal.value = goalId;
    rightPanelTargetSignal.value = { type: 'goal', spaceId, goalId };
  };

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex-1 overflow-y-auto">
        <div class={GLASS_CONTENT_CONTAINER_CLASS}>
          <section
            class={cn(
              'mb-5 flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6',
              GLASS_SURFACE
            )}
            data-testid="space-goals-introduction"
            aria-label="Goals workspace summary"
          >
            <div class="max-w-2xl">
              <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-200/80">
                <span class="h-1.5 w-1.5 rounded-full bg-amber-300" />
                Tracked objectives
              </div>
              <h2 class="mt-2 text-lg font-semibold tracking-tight text-gray-50">
                Active objectives ·{' '}
                <span data-testid="space-goal-count">{visibleGoals.length}</span>
              </h2>
              <p class="mt-1 text-sm leading-5 text-gray-300">
                {formatGoalCount(visibleGoals.length)} connecting recurring work, measurable
                progress, and the next operational move.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              class={GLASS_PRIMARY_BUTTON_CLASS}
            >
              Create goal
            </button>
          </section>

          <div class="mb-4 flex items-center justify-between gap-3">
            <p class="text-xs text-gray-400">
              {showArchived ? 'All objectives' : 'Current objectives'}
            </p>
            <label
              class={cn(
                'flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs text-gray-300 transition hover:border-white/25 hover:bg-white/[0.1]',
                GLASS_SURFACE
              )}
            >
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived((e.target as HTMLInputElement).checked)}
                class="h-3.5 w-3.5 rounded border-white/20 bg-dark-800 accent-amber-300"
              />
              Show archived
            </label>
          </div>

          {loading && (
            <div class={cn('rounded-2xl border p-6 text-sm text-gray-300', FLAT_SURFACE)}>
              Loading goals...
            </div>
          )}
          {error && (
            <div
              class={cn(
                'rounded-2xl border border-red-300/20 p-6 text-sm text-red-200',
                FLAT_SURFACE
              )}
            >
              {error}
            </div>
          )}
          {!loading && visibleGoals.length === 0 && (
            <div class={cn('rounded-2xl border border-dashed p-10 text-center', FLAT_SURFACE)}>
              <p class="text-sm font-medium text-gray-200">No goals yet</p>
              <p class="mt-1 text-xs text-gray-400">Create a goal to track long-horizon work.</p>
            </div>
          )}
          {visibleGoals.length > 0 && (
            <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(21rem,100%),1fr))]">
              {visibleGoals.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  selected={selectedGoalId === goal.id}
                  lastTask={goalDisplayTask(goal, tasks)}
                  onSelect={() => openGoal(goal.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <SpaceGoalDialog
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={(goal) => openGoal(goal.id)}
      />
    </div>
  );
}
