import { getWorkflowRunExecutionStatusLabel } from '@hyperneo/shared';
import type { SpaceTaskPriority, SpaceTaskStatus } from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useResolvedSpaceTask } from '../../hooks';
import { navigateToSpaceEvolve, navigateToSpaceGoals } from '../../lib/router';
import { currentSpaceGoalIdSignal, currentSpaceScopeIdSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { getTaskStatusConfig } from '../../lib/task-status';
import { getPriorityIndicatorTone } from '../../lib/priority-tokens';
import { cn } from '../../lib/utils';
import { Dropdown, type DropdownMenuItem } from '../ui/Dropdown';
import { InspectBadge, InspectPanel } from '../ui/InspectPanel';
import { SectionCard } from '../ui/SectionCard';
import { StatusBadge } from '../ui/StatusBadge';
import { TaskArtifactsPanel } from './TaskArtifactsPanel';
import { TaskTimelineFeed } from './TaskTimelineFeed';
import { getTransitionActions } from './TaskStatusActions';

interface TaskAuxiliaryPanelProps {
  spaceId: string;
  navigationSpaceId?: string;
  taskId: string;
  onClose?: () => void;
  focusSection?: string;
}

const STATUS_LABELS: Record<SpaceTaskStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  in_progress: 'In Progress',
  review: 'Awaiting Review',
  approved: 'Approved',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  archived: 'Archived',
  rate_limited: 'Rate Limited',
  usage_limited: 'Usage Limited',
  stopped: 'Stopped',
};

const PRIORITY_LABELS: Record<SpaceTaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="flex items-start justify-between gap-3 text-sm">
      <span class="text-gray-400">{label}</span>
      <span class="min-w-0 text-right text-gray-200">{children}</span>
    </div>
  );
}

function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}

function formatSchedule(schedule: {
  cronExpression?: string | null;
  timezone?: string;
  runAt?: number | null;
}) {
  if (schedule.cronExpression) return `${schedule.cronExpression} (${schedule.timezone})`;
  return formatTime(schedule.runAt);
}

export function TaskAuxiliaryPanel({
  spaceId,
  navigationSpaceId,
  taskId,
  onClose,
  focusSection,
}: TaskAuxiliaryPanelProps) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const task = spaceStore.tasks.value.find((item) => item.id === taskId) ?? null;
  const resolvedTask = useResolvedSpaceTask(task);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scopeName, setScopeName] = useState<string | null>(null);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [statusTransitioning, setStatusTransitioning] = useState(false);
  const [transitionError, setTransitionError] = useState<string | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState(resolvedTask?.description ?? '');
  const [savingDescription, setSavingDescription] = useState(false);

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [spaceId]);

  useEffect(() => {
    setDescriptionDraft(resolvedTask?.description ?? '');
  }, [resolvedTask?.id, resolvedTask?.description]);

  useEffect(() => {
    if (!task?.evolutionScopeId) {
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
  }, [task?.evolutionScopeId]);

  useEffect(() => {
    if (!focusSection) return;
    const testId =
      focusSection === 'timeline'
        ? 'task-timeline-section'
        : focusSection === 'artifacts'
          ? 'task-artifacts-section'
          : null;
    if (!testId) return;
    scrollRef.current
      ?.querySelector(`[data-testid="${testId}"]`)
      ?.scrollIntoView?.({ block: 'start' });
  }, [focusSection, taskId]);

  if (!task) {
    return (
      <InspectPanel
        emptyState={
          <div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
            Task not found
          </div>
        }
      />
    );
  }

  const handleStatusTransition = async (newStatus: SpaceTaskStatus) => {
    try {
      setStatusTransitioning(true);
      setTransitionError(null);
      if (task.status === 'draft' && newStatus === 'open') {
        await spaceStore.publishTask(task.id);
      } else if (newStatus === 'review') {
        await spaceStore.submitForReview(task.id);
      } else {
        await spaceStore.updateTask(task.id, { status: newStatus });
      }
    } catch (err) {
      setTransitionError(err instanceof Error ? err.message : 'Failed to update task status');
    } finally {
      setStatusTransitioning(false);
    }
  };

  const handleDescriptionBlur = async () => {
    const current = resolvedTask?.description ?? '';
    if (descriptionDraft === current) return;
    try {
      setSavingDescription(true);
      await spaceStore.updateTask(task.id, { description: descriptionDraft });
    } catch {
      setDescriptionDraft(current);
    } finally {
      setSavingDescription(false);
    }
  };

  const handleWorkflowChange = async (nextWorkflowId: string | null) => {
    try {
      setSavingWorkflow(true);
      await spaceStore.updateTask(task.id, { preferredWorkflowId: nextWorkflowId });
    } catch {
    } finally {
      setSavingWorkflow(false);
    }
  };

  const goal = task.goalId
    ? (spaceStore.goals.value.find((item) => item.id === task.goalId) ?? null)
    : null;
  const schedule = task.createdByTaskScheduleId
    ? (spaceStore.schedules.value.find((item) => item.id === task.createdByTaskScheduleId) ?? null)
    : null;
  const workflowRun = task.workflowRunId
    ? (spaceStore.workflowRuns.value.find((run) => run.id === task.workflowRunId) ?? null)
    : null;
  const executedWorkflow = workflowRun
    ? (spaceStore.workflows.value.find((wf) => wf.id === workflowRun.workflowId) ?? null)
    : null;

  const badges = (
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <InspectBadge class="min-w-16 justify-center border-dark-600 bg-dark-800/60 font-mono text-gray-300 tabular-nums">
        #{task.taskNumber}
      </InspectBadge>
      <StatusBadge
        tone={getTaskStatusConfig(task.status).tone}
        label={STATUS_LABELS[task.status]}
      />
      <InspectBadge tone={getPriorityIndicatorTone(task.priority)}>
        {PRIORITY_LABELS[task.priority]} Priority
      </InspectBadge>
    </div>
  );

  const transitionActions = getTransitionActions(task.status);
  const taskMenuItems: DropdownMenuItem[] = transitionActions.map(({ target, label }) => ({
    label,
    onClick: () => handleStatusTransition(target),
    disabled: statusTransitioning,
    danger: target === 'cancelled' || target === 'archived',
  }));

  const actionsMenu =
    taskMenuItems.length > 0 ? (
      <Dropdown
        items={taskMenuItems}
        position="right"
        trigger={
          <button
            type="button"
            class="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-dark-800 hover:text-gray-200"
            data-testid="task-actions-menu-trigger"
            aria-label="Task Actions"
            title="Task Actions"
          >
            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <circle cx="10" cy="4" r="1.75" />
              <circle cx="10" cy="10" r="1.75" />
              <circle cx="10" cy="16" r="1.75" />
            </svg>
          </button>
        }
      />
    ) : null;

  const descriptionPending = !!task?.descriptionTruncated && resolvedTask === task;
  const descriptionSection = (
    <SectionCard title="Description">
      <textarea
        value={descriptionDraft}
        onInput={(e) => setDescriptionDraft((e.target as HTMLTextAreaElement).value)}
        onBlur={handleDescriptionBlur}
        disabled={savingDescription || descriptionPending}
        rows={4}
        placeholder="Add a description…"
        class="w-full resize-none rounded border border-dark-600 bg-dark-900 px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
      />
      {descriptionPending && (
        <p class="mt-1 text-[11px] text-gray-400">Loading full description…</p>
      )}
      {savingDescription && <p class="mt-1 text-[11px] text-gray-400">Saving…</p>}
    </SectionCard>
  );

  const detailsSection = (
    <SectionCard title="Details">
      <DetailRow label="Status">{STATUS_LABELS[task.status]}</DetailRow>
      <DetailRow label="Priority">{PRIORITY_LABELS[task.priority]}</DetailRow>
      <DetailRow label="Created">{formatTime(task.createdAt)}</DetailRow>
      {goal && (
        <DetailRow label="Goal">
          <button
            type="button"
            onClick={() => {
              currentSpaceGoalIdSignal.value = goal.id;
              navigateToSpaceGoals(routeSpaceId);
            }}
            class="truncate text-blue-300 hover:text-blue-200"
          >
            {goal.title}
          </button>
        </DetailRow>
      )}
      {task.evolutionScopeId && (
        <DetailRow label="Evolution scope">
          <button
            type="button"
            onClick={() => {
              currentSpaceScopeIdSignal.value = task.evolutionScopeId!;
              navigateToSpaceEvolve(routeSpaceId);
            }}
            class="truncate text-blue-300 hover:text-blue-200"
          >
            {scopeName ?? task.evolutionScopeId}
          </button>
        </DetailRow>
      )}
      {schedule && <DetailRow label="Schedule">{formatSchedule(schedule)}</DetailRow>}
      {workflowRun && (
        <DetailRow label="Run status">
          {getWorkflowRunExecutionStatusLabel(workflowRun.status)}
        </DetailRow>
      )}
      {executedWorkflow && executedWorkflow.id !== task.preferredWorkflowId && (
        <DetailRow label="Executed workflow">{executedWorkflow.name}</DetailRow>
      )}
      <div>
        <label class="mb-1 block text-xs text-gray-400">Workflow</label>
        <select
          value={task.preferredWorkflowId ?? ''}
          disabled={savingWorkflow}
          onChange={(e) => handleWorkflowChange((e.target as HTMLSelectElement).value || null)}
          data-testid="task-workflow-select"
          class="w-full rounded border border-dark-600 bg-dark-900 px-2 py-1.5 text-xs text-gray-200 disabled:opacity-50"
        >
          <option value="">Auto-select</option>
          {spaceStore.workflows.value.map((wf) => (
            <option key={wf.id} value={wf.id}>
              {wf.name}
            </option>
          ))}
        </select>
        {savingWorkflow && <p class="mt-1 text-[11px] text-gray-400">Saving…</p>}
      </div>
      {task.dependsOn.length > 0 && (
        <div>
          <div class="mb-1 text-xs text-gray-400">Depends on</div>
          <div class="space-y-2">
            {task.dependsOn.map((depId) => {
              const dep = spaceStore.tasks.value.find((t) => t.id === depId);
              return (
                <div key={depId} class="flex items-center gap-2 text-sm">
                  <span class="flex-shrink-0 font-mono text-[11px] text-gray-400">
                    #{dep?.taskNumber ?? '—'}
                  </span>
                  <span class="min-w-0 truncate text-gray-300">{dep?.title ?? depId}</span>
                  {dep ? (
                    <StatusBadge
                      tone={getTaskStatusConfig(dep.status).tone}
                      label={STATUS_LABELS[dep.status]}
                    />
                  ) : (
                    <InspectBadge tone="neutral">—</InspectBadge>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </SectionCard>
  );

  const resultSection = resolvedTask?.result && (
    <SectionCard title="Result summary">
      <p class="whitespace-pre-wrap text-sm text-gray-300">{resolvedTask.result}</p>
    </SectionCard>
  );

  const panelHeader = (
    <div class="relative flex h-[88px] items-center bg-dark-900/30 px-4">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          class="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-dark-800 hover:text-gray-200"
          aria-label="Back"
          data-testid="task-back-button"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
      )}
      <div class={cn('min-w-0 flex-1', onClose ? 'pl-3' : 'pr-12')}>
        <div class="flex min-w-0 items-center gap-2">
          <h2 class="min-w-0 truncate text-base font-semibold leading-6 text-gray-100">
            {task.title}
          </h2>
          {actionsMenu}
        </div>
        {badges}
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
    </div>
  );

  return (
    <InspectPanel header={panelHeader}>
      <div ref={scrollRef} class="min-h-0 flex-1 overflow-y-auto">
        <div class="space-y-4 px-4 py-4">
          {transitionError && (
            <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
              {transitionError}
            </div>
          )}
          {descriptionSection}
          {detailsSection}
          {resultSection}
          <section
            class="overflow-hidden rounded-xl border border-white/10 bg-dark-900/50"
            data-testid="task-timeline-section"
          >
            <h3 class="px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Timeline
            </h3>
            <div class="h-96">
              <TaskTimelineFeed taskId={task.id} topInsetClass="" />
            </div>
          </section>
          {task.workflowRunId && (
            <section
              class="h-96 overflow-hidden rounded-xl border border-white/10 bg-dark-900/50"
              data-testid="task-artifacts-section"
            >
              <TaskArtifactsPanel
                key={task.workflowRunId}
                runId={task.workflowRunId}
                taskId={task.id}
                class="h-full"
              />
            </section>
          )}
        </div>
      </div>
    </InspectPanel>
  );
}
