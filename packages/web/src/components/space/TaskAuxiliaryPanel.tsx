import { getWorkflowRunExecutionStatusLabel } from '@hyperneo/shared';
import type {
  NodeExecution,
  SpaceTask,
  SpaceTaskPriority,
  SpaceTaskStatus,
  SpaceWorkflow,
  WorkflowNode,
  WorkflowNodeAgent,
} from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { navigateToSpaceForge, navigateToSpaceGoals } from '../../lib/router';
import {
  currentSpaceGoalIdSignal,
  currentSpaceScopeIdSignal,
  rightPanelTargetSignal,
  type TaskRightPanelTab,
} from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { getTaskStatusConfig } from '../../lib/task-status';
import { cn } from '../../lib/utils';
import { Dropdown, type DropdownMenuItem } from '../ui/Dropdown';
import { StatusBadge } from '../ui/StatusBadge';
import { TaskArtifactsPanel } from './TaskArtifactsPanel';
import { TaskTimelineFeed } from './TaskTimelineFeed';
import { getTransitionActions } from './TaskStatusActions';
import { WorkflowExecutionLogFeed } from './WorkflowExecutionLogFeed';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect';

interface TaskAuxiliaryPanelProps {
  spaceId: string;
  navigationSpaceId?: string;
  taskId: string;
  tab?: TaskRightPanelTab;
  onClose?: () => void;
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
};

const PRIORITY_LABELS: Record<SpaceTaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const PRIORITY_BADGE_CLASSES: Record<SpaceTaskPriority, string> = {
  low: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
  normal: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
  high: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  urgent: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const TASK_PANEL_TABS: Array<{ id: TaskRightPanelTab; label: string; needsRun?: boolean }> = [
  { id: 'details', label: 'Details' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'agents', label: 'Agents' },
  { id: 'gates', label: 'Gates' },
  { id: 'artifacts', label: 'Artifacts', needsRun: true },
  { id: 'timeline', label: 'Timeline' },
  { id: 'log', label: 'Log', needsRun: true },
];

function TaskPanelBadge({
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

// ── Flat-view helpers (middle column only) ────────────────────────────────────

function PanelSection({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="rounded-xl border border-white/10 bg-dark-900/50 p-4">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
      <div class="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="flex items-start justify-between gap-3 text-sm">
      <span class="text-gray-400">{label}</span>
      <span class="min-w-0 text-right text-gray-200">{children}</span>
    </div>
  );
}

function overrideKey(nodeId: string, agentName: string): string {
  return `${nodeId}:${agentName}`;
}

function findExecution(
  executions: NodeExecution[],
  runId: string | null | undefined,
  nodeId: string,
  agentName: string
): NodeExecution | null {
  if (!runId) return null;
  return (
    executions.find(
      (execution) =>
        execution.workflowRunId === runId &&
        execution.workflowNodeId === nodeId &&
        execution.agentName === agentName
    ) ?? null
  );
}

function resolvedAgentModel(
  task: SpaceTask,
  node: WorkflowNode,
  agent: WorkflowNodeAgent,
  spaceDefaultModel?: string
): string {
  return (
    task.workflowModelOverrides?.[overrideKey(node.id, agent.name)] ??
    agent.model ??
    spaceDefaultModel ??
    'Default model'
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

function AgentConfigCard({
  task,
  node,
  agent,
  execution,
  canEditModels,
  spaceDefaultModel,
  savingOverrideKey,
  onModelChange,
}: {
  task: SpaceTask;
  node: WorkflowNode;
  agent: WorkflowNodeAgent;
  execution: NodeExecution | null;
  canEditModels: boolean;
  spaceDefaultModel?: string;
  savingOverrideKey: string | null;
  onModelChange: (nodeId: string, agentName: string, model: string | undefined) => void;
}) {
  const key = overrideKey(node.id, agent.name);
  const locked = !!execution || !canEditModels;
  const effectiveModel = resolvedAgentModel(task, node, agent, spaceDefaultModel);

  return (
    <div class="space-y-3 rounded-lg border border-white/10 bg-dark-800/60 p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="truncate text-sm font-medium text-gray-100">{agent.name}</div>
          <div class="truncate text-xs text-gray-400">{node.name}</div>
        </div>
        <span class="inline-flex h-6 max-w-[11rem] items-center rounded-md border border-white/10 bg-dark-900/70 px-2 text-[11px] font-medium leading-none text-gray-300 whitespace-nowrap">
          <span class="truncate">{execution?.status ?? 'Not started'}</span>
        </span>
      </div>
      {locked ? (
        <DetailRow label="Model">
          <span class="font-mono text-xs">{effectiveModel}</span>
        </DetailRow>
      ) : (
        <div>
          <label class="mb-1 block text-xs text-gray-400">Model override</label>
          <WorkflowModelSelect
            value={task.workflowModelOverrides?.[key]}
            onChange={(value) => onModelChange(node.id, agent.name, value)}
            testId={`task-agent-model-${node.id}-${agent.name}`}
            className="w-full rounded border border-dark-600 bg-dark-900 px-2 py-1.5 text-xs text-gray-200 disabled:opacity-50"
          />
          <div class="mt-1 text-[11px] text-gray-400">
            Default: {agent.model ?? spaceDefaultModel ?? 'Space default'}
            {savingOverrideKey === key ? ' · Saving…' : ''}
          </div>
        </div>
      )}
      {agent.customPrompt?.value && (
        <p class="line-clamp-3 text-xs text-gray-400">{agent.customPrompt.value}</p>
      )}
    </div>
  );
}

function GateCard({ gate }: { gate: NonNullable<SpaceWorkflow['gates']>[number] }) {
  return (
    <div class="rounded-lg border border-white/10 bg-dark-800/60 p-3">
      <div class="text-sm font-medium text-gray-200">{gate.label ?? gate.id}</div>
      {gate.description && <div class="mt-1 text-xs text-gray-400">{gate.description}</div>}
      <div class="mt-2 text-xs text-gray-400">
        Required autonomy: {gate.requiredLevel ?? 'validation only'}
      </div>
    </div>
  );
}

// ── Right-panel tab helpers ───────────────────────────────────────────────────

function availableTabs(task: SpaceTask): TaskRightPanelTab[] {
  return TASK_PANEL_TABS.filter((item) => !item.needsRun || task.workflowRunId).map(
    (item) => item.id
  );
}

function normalizeTab(task: SpaceTask, tab: TaskRightPanelTab | undefined): TaskRightPanelTab {
  const tabs = availableTabs(task);
  if (tab && tabs.includes(tab)) return tab;
  return 'details';
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TaskAuxiliaryPanel({
  spaceId,
  navigationSpaceId,
  taskId,
  tab,
  onClose,
}: TaskAuxiliaryPanelProps) {
  const routeSpaceId = navigationSpaceId ?? spaceId;
  const task = spaceStore.tasks.value.find((item) => item.id === taskId) ?? null;

  // Right-panel tab state
  const tabs = task ? availableTabs(task) : [];
  const activeTab = task ? normalizeTab(task, tab) : 'timeline';

  // Flat-view state (middle column only)
  const space = spaceStore.space.value;
  const workflowRun = task?.workflowRunId
    ? (spaceStore.workflowRuns.value.find((run) => run.id === task.workflowRunId) ?? null)
    : null;
  const workflowId = workflowRun?.workflowId ?? task?.preferredWorkflowId ?? null;
  const workflowVersion = spaceStore.workflowVersions.value.get(workflowId ?? '') ?? 0;
  const [workflow, setWorkflow] = useState<SpaceWorkflow | null>(null);
  const [scopeName, setScopeName] = useState<string | null>(null);
  const [savingOverrideKey, setSavingOverrideKey] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [statusTransitioning, setStatusTransitioning] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(task?.description ?? '');
  const [savingDescription, setSavingDescription] = useState(false);
  const pendingOverridesRef = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    if (!task) return;
    if (tab === activeTab) return;
    rightPanelTargetSignal.value = { type: 'task', spaceId, taskId, tab: activeTab };
  }, [activeTab, spaceId, tab, task, taskId]);

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [spaceId]);

  useEffect(() => {
    if (!task?.workflowRunId) return;
    spaceStore.ensureNodeExecutions().catch(() => {});
  }, [task?.workflowRunId]);

  useEffect(() => {
    if (!workflowId) {
      setWorkflow(null);
      return;
    }
    let cancelled = false;
    setWorkflow(null);
    spaceStore.fetchWorkflowDetail(workflowId).then((nextWorkflow) => {
      if (!cancelled) setWorkflow(nextWorkflow);
    });
    return () => {
      cancelled = true;
    };
  }, [workflowId, workflowVersion]);

  useEffect(() => {
    pendingOverridesRef.current = task?.workflowModelOverrides ?? null;
  }, [task?.id, task?.workflowModelOverrides]);

  useEffect(() => {
    setDescriptionDraft(task?.description ?? '');
  }, [task?.id, task?.description]);

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

  if (!task) {
    return (
      <div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-400">
        Task not found
      </div>
    );
  }

  const selectTab = (nextTab: TaskRightPanelTab) => {
    rightPanelTargetSignal.value = { type: 'task', spaceId, taskId, tab: nextTab };
  };

  // Flat-view data
  const goal = task.goalId
    ? (spaceStore.goals.value.find((item) => item.id === task.goalId) ?? null)
    : null;
  const schedule = task.createdByTaskScheduleId
    ? (spaceStore.schedules.value.find((item) => item.id === task.createdByTaskScheduleId) ?? null)
    : null;
  const nodeExecutions = spaceStore.nodeExecutions.value;
  const canEditModels =
    !task.workflowRunId && !task.startedAt && (task.status === 'open' || task.status === 'draft');

  const updateModelOverride = async (
    nodeId: string,
    agentName: string,
    model: string | undefined
  ) => {
    const key = overrideKey(nodeId, agentName);
    const nextOverrides = { ...(pendingOverridesRef.current ?? task.workflowModelOverrides) };
    if (model) nextOverrides[key] = model;
    else delete nextOverrides[key];
    pendingOverridesRef.current = nextOverrides;
    try {
      setSavingOverrideKey(key);
      setOverrideError(null);
      await spaceStore.updateTask(task.id, {
        workflowModelOverrides: Object.keys(nextOverrides).length > 0 ? nextOverrides : null,
      });
    } catch (err) {
      pendingOverridesRef.current = task.workflowModelOverrides ?? null;
      setOverrideError(err instanceof Error ? err.message : 'Failed to save model override');
    } finally {
      setSavingOverrideKey(null);
    }
  };

  const handleStatusTransition = async (newStatus: SpaceTaskStatus) => {
    try {
      setStatusTransitioning(true);
      if (task.status === 'draft' && newStatus === 'open') {
        await spaceStore.publishTask(task.id);
      } else if (newStatus === 'review') {
        await spaceStore.submitForReview(task.id);
      } else {
        await spaceStore.updateTask(task.id, { status: newStatus });
      }
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Failed to update task status');
    } finally {
      setStatusTransitioning(false);
    }
  };

  const handleDescriptionBlur = async () => {
    const current = task.description ?? '';
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
      // best-effort
    } finally {
      setSavingWorkflow(false);
    }
  };

  // ── Shared header badges ────────────────────────────────────────────────

  const badges = (
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <TaskPanelBadge class="min-w-16 justify-center border-dark-600 bg-dark-800/60 font-mono text-gray-300 tabular-nums">
        #{task.taskNumber}
      </TaskPanelBadge>
      <StatusBadge
        tone={getTaskStatusConfig(task.status).tone}
        label={STATUS_LABELS[task.status]}
      />
      <TaskPanelBadge class={PRIORITY_BADGE_CLASSES[task.priority]}>
        {PRIORITY_LABELS[task.priority]} Priority
      </TaskPanelBadge>
    </div>
  );

  const transitionActions = getTransitionActions(task.status);
  const taskMenuItems: DropdownMenuItem[] = transitionActions.map(({ target, label }) => ({
    label,
    onClick: () => handleStatusTransition(target),
    disabled: statusTransitioning,
    danger: target === 'cancelled' || target === 'archived',
  }));

  const descriptionSection = (
    <PanelSection title="Description">
      <textarea
        value={descriptionDraft}
        onInput={(e) => setDescriptionDraft((e.target as HTMLTextAreaElement).value)}
        onBlur={handleDescriptionBlur}
        disabled={savingDescription}
        rows={4}
        placeholder="Add a description…"
        class="w-full resize-none rounded border border-dark-600 bg-dark-900 px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
      />
      {savingDescription && <p class="mt-1 text-[11px] text-gray-400">Saving…</p>}
    </PanelSection>
  );
  const detailsSection = (
    <PanelSection title="Details">
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
        <DetailRow label="Forge scope">
          <button
            type="button"
            onClick={() => {
              currentSpaceScopeIdSignal.value = task.evolutionScopeId!;
              navigateToSpaceForge(routeSpaceId);
            }}
            class="truncate text-blue-300 hover:text-blue-200"
          >
            {scopeName ?? task.evolutionScopeId}
          </button>
        </DetailRow>
      )}
      {schedule && <DetailRow label="Schedule">{formatSchedule(schedule)}</DetailRow>}
    </PanelSection>
  );
  const dependsOnSection = task.dependsOn.length > 0 && (
    <PanelSection title="Depends on">
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
              <TaskPanelBadge class="border-gray-500/25 bg-gray-500/10 text-gray-400">
                —
              </TaskPanelBadge>
            )}
          </div>
        );
      })}
    </PanelSection>
  );
  const workflowSection = (
    <PanelSection title="Workflow">
      {workflowRun && (
        <DetailRow label="Run status">
          {getWorkflowRunExecutionStatusLabel(workflowRun.status)}
        </DetailRow>
      )}
      <select
        value={task.preferredWorkflowId ?? ''}
        disabled={savingWorkflow}
        onChange={(e) => handleWorkflowChange((e.target as HTMLSelectElement).value || null)}
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
      {workflow && (
        <div class="space-y-2 rounded-lg border border-white/10 bg-dark-800/60 p-3 text-sm">
          <div class="font-medium text-gray-200">{workflow.name}</div>
          {workflow.nodes.map((node, index) => (
            <div key={node.id} class="text-xs text-gray-400">
              {index + 1}. {node.name}
              {node.agents.length > 0 && (
                <>
                  <span class="text-gray-400"> — </span>
                  <span class="text-gray-400">
                    {node.agents.map((agent) => agent.name).join(', ')}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </PanelSection>
  );
  const agentsSection = (
    <PanelSection title="Agents">
      {overrideError && (
        <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {overrideError}
        </div>
      )}
      {workflow?.nodes && workflow.nodes.some((n) => n.agents.length > 0) ? (
        workflow.nodes.flatMap((node) =>
          node.agents.map((agent) => (
            <AgentConfigCard
              key={overrideKey(node.id, agent.name)}
              task={task}
              node={node}
              agent={agent}
              execution={findExecution(nodeExecutions, task.workflowRunId, node.id, agent.name)}
              canEditModels={canEditModels}
              spaceDefaultModel={space?.defaultModel}
              savingOverrideKey={savingOverrideKey}
              onModelChange={updateModelOverride}
            />
          ))
        )
      ) : (
        <p class="text-sm text-gray-400">
          {task.preferredWorkflowId
            ? 'Loading workflow…'
            : 'Select a workflow to configure agent models.'}
        </p>
      )}
    </PanelSection>
  );
  const gatesSection = workflow?.gates && workflow.gates.length > 0 && (
    <PanelSection title="Gates">
      {workflow.gates.map((gate) => (
        <GateCard key={gate.id} gate={gate} />
      ))}
    </PanelSection>
  );
  const resultSection = task.result && (
    <PanelSection title="Result summary">
      <p class="whitespace-pre-wrap text-sm text-gray-300">{task.result}</p>
    </PanelSection>
  );

  return (
    <div class="flex h-full min-w-0 flex-col overflow-hidden">
      {onClose ? (
        // Middle-column header — row layout with back button
        <div class="relative flex h-[88px] items-center bg-dark-900/30 px-4">
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
          <div class="min-w-0 flex-1 pl-3">
            <div class="flex min-w-0 items-center gap-2">
              <h2 class="min-w-0 truncate text-base font-semibold leading-6 text-gray-100">
                {task.title}
              </h2>
              {taskMenuItems.length > 0 && (
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
              )}
            </div>
            {badges}
          </div>
          <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
        </div>
      ) : (
        // Right-panel header — vertical stack (matches dev branch)
        <div class="relative flex h-[88px] flex-col justify-center bg-dark-900/30 px-5">
          <div class="pr-12">
            <h2 class="truncate text-base font-semibold leading-6 text-gray-100">{task.title}</h2>
            {badges}
          </div>
          <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
        </div>
      )}

      {onClose ? (
        // ── Middle-column flat-card view ──────────────────────────────
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="space-y-4 px-4 py-4">
            {descriptionSection}
            {detailsSection}
            {dependsOnSection}
            {workflowSection}
            {agentsSection}
            {gatesSection}
            {resultSection}
          </div>
        </div>
      ) : (
        // ── Right-panel tab view (matches dev branch) ─────────────────
        <>
          <div class="px-3 pb-3 pt-3">
            <div
              class={cn(
                'grid gap-1 rounded-lg border border-white/10 bg-dark-900/70 p-1',
                tabs.length === 3
                  ? 'grid-cols-3'
                  : tabs.length === 2
                    ? 'grid-cols-2'
                    : 'grid-cols-1'
              )}
            >
              {TASK_PANEL_TABS.filter((item) => tabs.includes(item.id)).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectTab(item.id)}
                  class={cn(
                    'min-w-0 rounded-md px-2 py-1.5 text-center text-xs font-medium transition-colors',
                    activeTab === item.id
                      ? 'bg-dark-700 text-gray-100 shadow-sm'
                      : 'text-gray-400 hover:bg-white/5 hover:text-gray-300'
                  )}
                  aria-pressed={activeTab === item.id}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-hidden">
            {activeTab === 'details' && (
              <div class="h-full overflow-y-auto px-4 pb-4">
                <div class="space-y-4">
                  {descriptionSection}
                  {detailsSection}
                  {dependsOnSection}
                  {resultSection}
                </div>
              </div>
            )}
            {activeTab === 'workflow' && (
              <div class="h-full overflow-y-auto px-4 pb-4">{workflowSection}</div>
            )}
            {activeTab === 'agents' && (
              <div class="h-full overflow-y-auto px-4 pb-4">{agentsSection}</div>
            )}
            {activeTab === 'gates' && (
              <div class="h-full overflow-y-auto px-4 pb-4">
                {gatesSection ?? <p class="text-sm text-gray-400">No gates configured.</p>}
              </div>
            )}
            {activeTab === 'timeline' && (
              <TaskTimelineFeed taskId={task.id} topInsetClass="" bottomInsetPx={16} />
            )}
            {activeTab === 'log' && task.workflowRunId && (
              <WorkflowExecutionLogFeed
                workflowRunId={task.workflowRunId}
                topInsetClass=""
                bottomInsetPx={16}
              />
            )}
            {activeTab === 'artifacts' && task.workflowRunId && (
              <TaskArtifactsPanel runId={task.workflowRunId} taskId={task.id} class="h-full" />
            )}
          </div>
        </>
      )}
    </div>
  );
}
