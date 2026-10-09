import type { SpaceTask } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { getTaskStatusConfig } from '../../lib/task-status';
import { StatusBadge } from '../ui/StatusBadge';

function readiness(
  task: SpaceTask,
  workflowCount: number,
  waitingOn: SpaceTask[],
  workflowName: string | null
): { title: string; detail: string } {
  if (task.status === 'draft') {
    return { title: 'Draft', detail: 'Publish it when it is ready to start.' };
  }
  if (task.status !== 'open') {
    return {
      title: getTaskStatusConfig(task.status).label,
      detail: 'No agent has worked on this task yet.',
    };
  }
  if (workflowCount === 0) {
    return { title: 'Ready to run', detail: 'Run starts an agent on this task.' };
  }
  const using = workflowName ?? 'the best-matching workflow';
  if (waitingOn.length > 0) {
    return {
      title: 'Waiting',
      detail: `Starts with ${using} once the tasks it waits on are done.`,
    };
  }
  return { title: 'Starting soon', detail: `Starts with ${using} when a task slot is free.` };
}

export function TaskReadyPanel({
  task,
  workspaceLabel,
  description,
  canRunDirectly,
  busy,
  onRun,
  onPublish,
  onEdit,
}: {
  task: SpaceTask;
  workspaceLabel?: string | null;
  description: string;
  canRunDirectly: boolean;
  busy: boolean;
  onRun: () => void;
  onPublish: () => void;
  onEdit: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskIdRef = useRef(task.id);

  useEffect(() => {
    taskIdRef.current = task.id;
    setSaving(false);
    setError(null);
  }, [task.id]);

  const workflows = spaceStore.workflows.value.filter((workflow) => !workflow.disabled);
  const tasks = spaceStore.tasks.value;
  const dependencies = task.dependsOn.map((id) => ({
    id,
    task: tasks.find((candidate) => candidate.id === id) ?? null,
  }));
  const waitingOn = dependencies
    .map((dependency) => dependency.task)
    .filter((dependency): dependency is SpaceTask => !!dependency && dependency.status !== 'done');
  const workflowName = task.preferredWorkflowId
    ? (workflows.find((workflow) => workflow.id === task.preferredWorkflowId)?.name ?? null)
    : null;
  const state = readiness(task, workflows.length, waitingOn, workflowName);
  const runIsPrimary = canRunDirectly && workflows.length === 0;

  const changeWorkflow = async (workflowId: string | null) => {
    const requestedTaskId = task.id;
    try {
      setSaving(true);
      setError(null);
      await spaceStore.setPreferredWorkflow(requestedTaskId, workflowId);
    } catch (err) {
      if (taskIdRef.current !== requestedTaskId) return;
      setError(err instanceof Error ? err.message : 'Failed to change the workflow');
    } finally {
      if (taskIdRef.current === requestedTaskId) setSaving(false);
    }
  };

  return (
    <section
      class="flex flex-col gap-4 rounded-xl border border-dashed border-line-strong px-5 py-5"
      data-testid="task-ready-panel"
    >
      <div class="flex flex-col gap-1">
        <h3 class="text-base font-semibold text-fg" data-testid="task-ready-title">
          {state.title}
        </h3>
        <p class="text-sm text-fg-muted">{state.detail}</p>
      </div>

      {description && (
        <p
          class="whitespace-pre-wrap break-words text-sm text-fg-soft"
          data-testid="task-ready-description"
        >
          {description}
        </p>
      )}

      <dl class="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-sm">
        <dt class="text-xs text-fg-muted">Workflow</dt>
        <dd>
          <select
            value={task.preferredWorkflowId ?? ''}
            disabled={saving}
            onChange={(event) => changeWorkflow((event.target as HTMLSelectElement).value || null)}
            data-testid="task-workflow-select"
            class="w-full max-w-xs rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg-soft disabled:opacity-50"
          >
            <option value="">Auto-select</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
          {error && (
            <p class="mt-1 text-xs text-danger" data-testid="task-workflow-error">
              {error}
            </p>
          )}
        </dd>
        <dt class="text-xs text-fg-muted">Workspace</dt>
        <dd class="truncate text-fg-soft">{workspaceLabel ?? 'Space workspace'}</dd>
        {dependencies.length > 0 && (
          <>
            <dt class="self-start pt-0.5 text-xs text-fg-muted">Waits on</dt>
            <dd class="flex min-w-0 flex-col gap-1.5" data-testid="task-dependencies">
              {dependencies.map(({ id, task: dependency }) => (
                <div key={id} class="flex min-w-0 items-center gap-2">
                  <span class="flex-shrink-0 font-mono text-[11px] text-fg-faint">
                    #{dependency?.taskNumber ?? '—'}
                  </span>
                  <span class="min-w-0 truncate text-fg-soft">{dependency?.title ?? id}</span>
                  {dependency && (
                    <StatusBadge
                      tone={getTaskStatusConfig(dependency.status).tone}
                      label={getTaskStatusConfig(dependency.status).label}
                    />
                  )}
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>

      <div class="flex flex-wrap gap-2">
        {task.status === 'draft' && (
          <button
            type="button"
            disabled={busy}
            onClick={onPublish}
            class="h-8 rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg disabled:opacity-50"
            data-testid="task-publish-button"
          >
            Publish
          </button>
        )}
        {canRunDirectly && (
          <button
            type="button"
            disabled={busy}
            onClick={onRun}
            class={
              runIsPrimary
                ? 'h-8 rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg disabled:opacity-50'
                : 'h-8 rounded-lg border border-line-strong px-3 text-sm text-fg-soft hover:text-fg disabled:opacity-50'
            }
            data-testid="task-run-button"
          >
            {runIsPrimary ? 'Run' : 'Run without a workflow'}
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          class="h-8 rounded-lg border border-line-strong px-3 text-sm text-fg-soft hover:text-fg"
          data-testid="task-ready-edit"
        >
          Edit task
        </button>
      </div>
    </section>
  );
}
