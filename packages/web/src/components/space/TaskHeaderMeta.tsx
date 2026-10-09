import type { SpaceTask, SpaceTaskPriority } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { navigateToSpaceEvolve, navigateToSpaceGoals } from '../../lib/router';
import { currentSpaceGoalIdSignal, currentSpaceScopeIdSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';

const PRIORITY_TEXT: Record<SpaceTaskPriority, { label: string; class: string }> = {
  low: { label: 'Low priority', class: 'text-fg-muted' },
  normal: { label: 'Normal priority', class: 'text-fg-muted' },
  high: { label: 'High priority', class: 'text-warning' },
  urgent: { label: 'Urgent', class: 'text-danger' },
};

export function TaskHeaderMeta({
  task,
  workspaceLabel,
  routeSpaceId,
}: {
  task: SpaceTask;
  workspaceLabel?: string | null;
  routeSpaceId: string;
}) {
  const [scopeName, setScopeName] = useState<string | null>(null);

  useEffect(() => {
    if (!task.evolutionScopeId) {
      setScopeName(null);
      return;
    }
    let cancelled = false;
    spaceStore
      .fetchEvolutionScope(task.evolutionScopeId)
      .then((scope) => {
        if (!cancelled) setScopeName(scope?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setScopeName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [task.evolutionScopeId]);

  const scheduleId = task.createdByTaskScheduleId ?? null;
  const schedule = scheduleId
    ? (spaceStore.schedules.value.find((item) => item.id === scheduleId) ?? null)
    : null;
  useEffect(() => {
    if (!scheduleId || schedule) return;
    spaceStore.listSchedules().catch(() => {});
  }, [scheduleId, !!schedule]);

  const goal = task.goalId
    ? (spaceStore.goals.value.find((item) => item.id === task.goalId) ?? null)
    : null;
  const priority = PRIORITY_TEXT[task.priority];

  return (
    <div
      class="flex min-w-0 items-center gap-x-3 overflow-hidden whitespace-nowrap text-xs text-fg-muted"
      data-testid="task-header-meta"
    >
      <span class={priority.class} data-testid="task-header-priority">
        {priority.label}
      </span>
      {goal && (
        <button
          type="button"
          class="min-w-0 truncate text-accent-soft hover:underline"
          onClick={() => {
            currentSpaceGoalIdSignal.value = goal.id;
            navigateToSpaceGoals(routeSpaceId);
          }}
        >
          Goal: {goal.title}
        </button>
      )}
      {task.evolutionScopeId && (
        <button
          type="button"
          class="min-w-0 truncate text-accent-soft hover:underline"
          onClick={() => {
            currentSpaceScopeIdSignal.value = task.evolutionScopeId!;
            navigateToSpaceEvolve(routeSpaceId);
          }}
        >
          Scope: {scopeName ?? task.evolutionScopeId}
        </button>
      )}
      {schedule && <span class="min-w-0 truncate">From schedule: {schedule.title}</span>}
      {workspaceLabel && (
        <span class="min-w-0 truncate" data-testid="task-workspace-badge">
          {workspaceLabel}
        </span>
      )}
    </div>
  );
}
