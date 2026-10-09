import type { SpaceTask, SpaceTaskPriority } from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { navigateToSpaceEvolve, navigateToSpaceGoals } from '../../lib/router';
import { currentSpaceGoalIdSignal, currentSpaceScopeIdSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { getTaskStatusConfig } from '../../lib/task-status';
import { StatusBadge } from '../ui/StatusBadge';

const PRIORITY_TEXT: Record<SpaceTaskPriority, { label: string; class: string }> = {
  low: { label: 'Low priority', class: 'text-fg-muted' },
  normal: { label: 'Normal priority', class: 'text-fg-muted' },
  high: { label: 'High priority', class: 'text-warning' },
  urgent: { label: 'Urgent', class: 'text-danger' },
};

export function TaskHeaderMeta({
  task,
  statusLabel,
  workspaceLabel,
  routeSpaceId,
}: {
  task: SpaceTask;
  statusLabel?: string | null;
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

  const items: ComponentChildren[] = [];
  if (goal) {
    items.push(
      <button
        key="goal"
        type="button"
        class="min-w-0 max-w-[12rem] truncate text-accent-soft hover:underline"
        onClick={() => {
          currentSpaceGoalIdSignal.value = goal.id;
          navigateToSpaceGoals(routeSpaceId);
        }}
      >
        Goal: {goal.title}
      </button>
    );
  }
  if (task.evolutionScopeId) {
    const scopeId = task.evolutionScopeId;
    items.push(
      <button
        key="scope"
        type="button"
        class="min-w-0 max-w-[10rem] truncate text-accent-soft hover:underline"
        onClick={() => {
          currentSpaceScopeIdSignal.value = scopeId;
          navigateToSpaceEvolve(routeSpaceId);
        }}
      >
        Scope: {scopeName ?? scopeId}
      </button>
    );
  }
  if (schedule) {
    items.push(
      <span key="schedule" class="min-w-0 max-w-[10rem] truncate">
        From schedule: {schedule.title}
      </span>
    );
  }
  if (workspaceLabel) {
    items.push(
      <span
        key="workspace"
        class="min-w-0 max-w-[10rem] truncate"
        data-testid="task-workspace-badge"
      >
        {workspaceLabel}
      </span>
    );
  }
  items.push(
    <span
      key="priority"
      class={`flex-shrink-0 ${priority.class}`}
      data-testid="task-header-priority"
    >
      {priority.label}
    </span>
  );
  if (statusLabel) {
    items.push(
      <span key="status" class="flex-shrink-0" data-testid="task-status-label">
        <StatusBadge tone={getTaskStatusConfig(task.status).tone} label={statusLabel} />
      </span>
    );
  }

  return (
    <div
      class="flex min-w-0 flex-shrink items-center justify-end gap-x-1.5 overflow-hidden whitespace-nowrap text-xs text-fg-muted"
      data-testid="task-header-meta"
    >
      {items.flatMap((item, index) =>
        index === 0
          ? [item]
          : [
              <span key={`sep-${index}`} aria-hidden="true" class="text-fg-faint">
                ·
              </span>,
              item,
            ]
      )}
    </div>
  );
}
