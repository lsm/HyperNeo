import type { SpaceTask, SpaceTaskPriority } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { navigateToSpaceEvolve, navigateToSpaceGoals } from '../../lib/router';
import { currentSpaceGoalIdSignal, currentSpaceScopeIdSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';

const PRIORITY_TEXT: Record<SpaceTaskPriority, { label: string; class: string }> = {
  low: { label: 'Low priority', class: 'text-fg-muted' },
  normal: { label: 'Normal priority', class: 'text-fg-muted' },
  high: { label: 'High priority', class: 'text-warning' },
  urgent: { label: 'Urgent', class: 'text-danger' },
};

const COLLAPSE_AFTER_CHARS = 180;

function formatCreated(timestamp: number | null | undefined): string | null {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TaskBrief({
  task,
  description,
  workspaceLabel,
  routeSpaceId,
  collapsible = false,
}: {
  task: SpaceTask;
  description: string;
  workspaceLabel?: string | null;
  routeSpaceId: string;
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [scopeName, setScopeName] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(false);
  }, [task.id]);

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

  const goal = task.goalId
    ? (spaceStore.goals.value.find((item) => item.id === task.goalId) ?? null)
    : null;
  const schedule = task.createdByTaskScheduleId
    ? (spaceStore.schedules.value.find((item) => item.id === task.createdByTaskScheduleId) ?? null)
    : null;
  const created = formatCreated(task.createdAt);
  const priority = PRIORITY_TEXT[task.priority];
  const long = description.length > COLLAPSE_AFTER_CHARS || description.includes('\n');
  const clamped = collapsible && long && !expanded;

  return (
    <section
      class="rounded-xl border border-line bg-surface-raised/40 px-4 py-3"
      data-testid="task-brief"
    >
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Brief</span>
        {created && <span class="text-[11px] text-fg-faint">{created}</span>}
      </div>
      <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted">
        <span class={priority.class} data-testid="task-brief-priority">
          {priority.label}
        </span>
        {goal && (
          <button
            type="button"
            class="truncate text-accent-soft hover:underline"
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
            class="truncate text-accent-soft hover:underline"
            onClick={() => {
              currentSpaceScopeIdSignal.value = task.evolutionScopeId!;
              navigateToSpaceEvolve(routeSpaceId);
            }}
          >
            Scope: {scopeName ?? task.evolutionScopeId}
          </button>
        )}
        {schedule && <span>From schedule: {schedule.title}</span>}
        {workspaceLabel && (
          <span class="truncate" data-testid="task-workspace-badge">
            {workspaceLabel}
          </span>
        )}
      </div>
      {description ? (
        <p
          class={cn(
            'mt-2 whitespace-pre-wrap break-words text-sm text-fg-soft',
            clamped && 'line-clamp-2'
          )}
          data-testid="task-brief-text"
        >
          {description}
        </p>
      ) : (
        <p class="mt-2 text-sm text-fg-faint">No description yet.</p>
      )}
      {collapsible && long && (
        <button
          type="button"
          class="mt-1 text-xs text-accent-soft hover:underline"
          onClick={() => setExpanded((value) => !value)}
          data-testid="task-brief-toggle"
        >
          {expanded ? 'Show less' : 'Show full brief'}
        </button>
      )}
    </section>
  );
}
