import type { SpaceGoal, SpaceGoalStatus, SpaceTaskPriority } from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { navigateToSpaceTask } from '../../lib/router';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import { SpaceGoalDialog } from './SpaceGoalDialog';
import {
  formatGoalMetricSnapshot,
  getGoalLastActivityAt,
  getRecurringGoalActivityStatus,
} from './goal-display-utils';

interface GoalDetailPanelProps {
  spaceId: string;
  navigationSpaceId?: string;
  goalId: string;
}

const STATUS_CLASSES: Record<SpaceGoalStatus, string> = {
  active: 'border-green-500/30 bg-green-500/10 text-green-300',
  paused: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  completed: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  archived: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
};

const PRIORITY_CLASSES: Record<SpaceTaskPriority, string> = {
  low: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
  normal: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
  high: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  urgent: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const TYPE_LABELS: Record<SpaceGoal['type'], string> = {
  one_shot: 'One-shot',
  measurable: 'Measurable',
  recurring: 'Recurring',
};

function GoalPanelBadge({
  children,
  class: className,
}: {
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <span
      class={cn(
        'inline-flex h-6 max-w-[11rem] items-center rounded-md border px-2 text-[11px] font-medium leading-none whitespace-nowrap',
        className
      )}
    >
      <span class="truncate">{children}</span>
    </span>
  );
}

function formatDate(ts: number | null): string {
  if (!ts) return 'None';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function GoalDetailPanel({ spaceId, navigationSpaceId, goalId }: GoalDetailPanelProps) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const [editing, setEditing] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const goal =
    spaceStore.spaceId.value === spaceId
      ? (spaceStore.goals.value.find((item) => item.id === goalId) ?? null)
      : null;
  const tasks = spaceStore.spaceId.value === spaceId ? spaceStore.tasks.value : [];

  if (!goal) {
    return (
      <div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
        Goal not found
      </div>
    );
  }

  const linkedTasks = tasks
    .filter(
      (task) =>
        task.goalId === goal.id || task.id === goal.activeTaskId || task.id === goal.lastTaskId
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activityTask = linkedTasks[0] ?? null;
  const lastActivityAt = getGoalLastActivityAt(goal, activityTask);

  const runAction = async (action: 'pause' | 'resume' | 'archive' | 'trigger') => {
    setActionLoading(true);
    try {
      if (action === 'pause') await spaceStore.pauseGoal(goal.id);
      else if (action === 'resume') await spaceStore.resumeGoal(goal.id);
      else if (action === 'archive') await spaceStore.archiveGoal(goal.id);
      else {
        const result = await spaceStore.createImmediateGoalTask(goal.id);
        if (result.queued) toast.success('Next goal task queued');
        else toast.success('Goal task created');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Goal action failed');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div class="flex h-full min-w-0 flex-col overflow-hidden">
      <div class="relative flex h-[88px] flex-col justify-center bg-dark-900/30 px-5">
        <div class="pr-12">
          <div class="flex items-start justify-between gap-3">
            <h2 class="min-w-0 flex-1 truncate text-base font-semibold leading-6 text-gray-100">
              {goal.title}
            </h2>
            <button
              type="button"
              onClick={() => setEditing(true)}
              class="rounded-lg border border-dark-600 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-dark-800"
            >
              Edit
            </button>
          </div>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <GoalPanelBadge class={STATUS_CLASSES[goal.status]}>
              {goal.status.replace(/_/g, ' ')}
            </GoalPanelBadge>
            <GoalPanelBadge class="border-dark-600 bg-dark-800/60 text-gray-300">
              {TYPE_LABELS[goal.type]}
            </GoalPanelBadge>
            <GoalPanelBadge class={PRIORITY_CLASSES[goal.priority]}>
              {goal.priority} Priority
            </GoalPanelBadge>
          </div>
        </div>
        <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div class="space-y-5">
          <section class="flex flex-wrap gap-2">
            {goal.status === 'active' && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => void runAction('pause')}
                class="rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-1.5 text-xs font-medium text-amber-300 disabled:opacity-50"
              >
                Pause
              </button>
            )}
            {goal.status === 'paused' && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => void runAction('resume')}
                class="rounded-lg border border-green-800/40 bg-green-950/20 px-3 py-1.5 text-xs font-medium text-green-300 disabled:opacity-50"
              >
                Resume
              </button>
            )}
            <button
              type="button"
              disabled={actionLoading || goal.status !== 'active'}
              onClick={() => void runAction('trigger')}
              class="rounded-lg border border-blue-800/40 bg-blue-950/20 px-3 py-1.5 text-xs font-medium text-blue-300 disabled:opacity-50"
            >
              Create task now
            </button>
            {goal.status !== 'archived' && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => void runAction('archive')}
                class="rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-300 disabled:opacity-50"
              >
                Archive
              </button>
            )}
          </section>

          <section>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">Summary</h3>
            <p class="mt-2 text-sm leading-6 text-gray-300">
              {goal.summary || goal.description || 'No summary yet.'}
            </p>
          </section>

          {goal.type === 'recurring' ? (
            <section>
              <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">Activity</h3>
              <div class="mt-2 space-y-2 rounded-lg border border-dark-700 bg-dark-900/40 px-3 py-2 text-xs">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-gray-400">Status</span>
                  <span class="capitalize text-gray-300">
                    {getRecurringGoalActivityStatus(goal, activityTask)}
                  </span>
                </div>
                <div class="flex items-center justify-between gap-2">
                  <span class="text-gray-400">Last activity</span>
                  <span class="text-gray-300">{formatDate(lastActivityAt)}</span>
                </div>
                <div>
                  <div class="text-gray-400">Metric trajectory</div>
                  <div class="mt-1 text-gray-300">{formatGoalMetricSnapshot(goal, 4)}</div>
                </div>
              </div>
            </section>
          ) : (
            <section>
              <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">Progress</h3>
              <div class="mt-2 h-2 rounded-full bg-dark-700">
                <div
                  class="h-2 rounded-full bg-green-500"
                  style={{ width: `${Math.max(0, Math.min(100, goal.progress ?? 0))}%` }}
                />
              </div>
              <p class="mt-2 text-xs text-gray-400">{goal.progress ?? 0}% complete</p>
            </section>
          )}

          <section class="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div class="text-gray-400">Last check-in</div>
              <div class="mt-1 text-gray-300">{formatDate(goal.lastCheckInAt)}</div>
            </div>
            <div>
              <div class="text-gray-400">Next check-in</div>
              <div class="mt-1 text-gray-300">{formatDate(goal.nextCheckInAt)}</div>
            </div>
          </section>

          {goal.nextSteps.length > 0 && (
            <section>
              <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Next Steps
              </h3>
              <ul class="mt-2 space-y-2 text-sm text-gray-300">
                {goal.nextSteps.map((step) => (
                  <li key={step} class="rounded-md border border-dark-700 bg-dark-900/40 px-3 py-2">
                    {step}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">
              Linked Tasks
            </h3>
            <div class="mt-2 space-y-2">
              {linkedTasks.length === 0 ? (
                <p class="text-sm text-gray-400">No linked tasks yet.</p>
              ) : (
                linkedTasks.slice(0, 8).map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => navigateToSpaceTask(routeSpaceId, task.id)}
                    class="w-full rounded-md border border-dark-700 bg-dark-900/40 px-3 py-2 text-left hover:border-dark-600 hover:bg-dark-800/60"
                  >
                    <div class="truncate text-sm text-gray-200">{task.title}</div>
                    <div class="mt-1 font-mono text-[11px] text-gray-400">#{task.taskNumber}</div>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
        <SpaceGoalDialog
          isOpen={editing}
          goal={goal}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            spaceStore.upsertGoal(saved);
          }}
        />
      </div>
    </div>
  );
}
