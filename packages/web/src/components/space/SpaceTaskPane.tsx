import {
  isWorkflowRecoveryTransition,
  type MessageImage,
  type SpaceTaskActivityMember,
  type SpaceTaskActivityState,
  type SpaceTaskPriority,
  type SpaceTaskStatus,
} from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TaskComposerTarget, FileDropHandler } from '../../hooks';
import { useImageDropZone } from '../../hooks';
import { borderColors } from '../../lib/design-tokens';
import { getTaskStatusConfig } from '../../lib/task-status';
import {
  navigateToSpaceTask,
  pushOverlayHistory,
  pushOverlayHistoryForPendingAgent,
} from '../../lib/router';
import { resolveNodeClick, type NodeChoice } from '../../lib/node-click-resolver';
import {
  currentSpaceIdSignal,
  currentSpaceTaskViewTabSignal,
  rightPanelTargetSignal,
} from '../../lib/signals';
import { buildMarkDonePayload } from '../../lib/space-task-helpers';
import { spaceStore } from '../../lib/space-store';
import { resolveActiveTaskBanner } from '../../lib/task-banner.ts';
import { cn } from '../../lib/utils';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { Dropdown, type DropdownMenuItem } from '../ui/Dropdown';
import { StatusBadge } from '../ui/StatusBadge';
import { EditTaskModal } from './EditTaskModal';
import { NodeAgentChoiceOverlay } from './NodeAgentChoiceOverlay';
import { PendingGateBanner } from './PendingGateBanner';
import { PendingHookBanner } from './PendingHookBanner';
import { PendingPostApprovalBanner } from './PendingPostApprovalBanner';
import { PendingTaskCompletionBanner } from './PendingTaskCompletionBanner';
import { ReadOnlyWorkflowCanvas } from './ReadOnlyWorkflowCanvas';
import { SpaceTaskUnifiedThread } from './SpaceTaskUnifiedThread';
import { SubmitForReviewModal } from './SubmitForReviewModal';
import { TaskBlockedBanner } from './TaskBlockedBanner';
import { TaskCanvasToggleButton, TaskSessionChatComposer } from './TaskSessionChatComposer';
import { ImageDropOverlay } from '../ImageDropOverlay.tsx';
import { getTransitionActions } from './TaskStatusActions';
import { useRunGateSummaries } from './use-run-gate-summaries.ts';
import { useRunHookStates } from './use-run-hook-states.ts';

interface SpaceTaskPaneProps {
  taskId: string | null;
  spaceId?: string;
  navigationSpaceId?: string;
  onClose?: () => void;
}

const STATUS_LABELS: Record<SpaceTaskStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  in_progress: 'In Progress',
  review: 'Awaiting Review',
  // `approved` is the post-approval staging status: tasks land here when an
  // agent calls `approve_task`, then the PostApprovalRouter dispatches the
  // follow-up (auto-merge, human gate, or no-route → `done`).
  approved: 'Approved',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  archived: 'Archived',
  rate_limited: 'Rate Limited',
  usage_limited: 'Usage Limited',
};

const PRIORITY_LABELS: Record<SpaceTaskPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

const ACTIVITY_STATE_LABELS: Record<SpaceTaskActivityState, string> = {
  active: 'Active',
  queued: 'Queued',
  idle: 'Idle',
  cooldown: 'Cooldown',
  waiting_for_input: 'Waiting',
  completed: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const PRIORITY_BADGE_CLASSES: Record<SpaceTaskPriority, string> = {
  low: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
  normal: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
  high: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
  urgent: 'border-red-500/30 bg-red-500/10 text-red-300',
};

function getTaskActionLabel(
  task: { status: SpaceTaskStatus; workflowRunId?: string | null },
  target: SpaceTaskStatus,
  label: string
): string {
  if (!task.workflowRunId || !isWorkflowRecoveryTransition(task.status, target)) {
    return label;
  }
  if (label.toLowerCase().includes('reopen')) {
    return 'Reopen workflow';
  }
  return target === 'in_progress' ? 'Resume workflow' : 'Reopen workflow';
}

function formatAgentSlotLabel(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeTargetName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/(?:\s+agent)+$/, '')
    .replace(/[\s_-]+/g, '');
}

function TaskMetaBadge({
  children,
  class: className,
}: {
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <span
      class={cn(
        'inline-flex h-6 max-w-[8.5rem] items-center rounded-md border px-2 text-[11px] font-medium leading-none whitespace-nowrap',
        className
      )}
    >
      <span class="truncate">{children}</span>
    </span>
  );
}

function formatTaskThreadError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Task Agent session not started')) {
    return 'Task thread is still starting. Try sending again in a moment.';
  }
  if (message.includes('Session not found')) {
    return 'Task thread points to a stale session. Keep this pane open while it reconnects.';
  }
  return message || 'Failed to update task thread';
}

function formatEditTaskError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message || 'Failed to update task';
}

export function SpaceTaskPane({
  taskId,
  spaceId,
  navigationSpaceId: routeSpaceId,
  onClose,
}: SpaceTaskPaneProps) {
  // Lazy-load agents/workflows needed for mention autocomplete and canvas
  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [spaceId]);

  const tasks = spaceStore.tasks.value;
  const task = taskId ? (tasks.find((t) => t.id === taskId) ?? null) : null;
  const activityMembers: SpaceTaskActivityMember[] = taskId
    ? (spaceStore.taskActivity.value.get(taskId) ?? [])
    : [];

  const [ensuringThread, setEnsuringThread] = useState(false);
  const [threadSendError, setThreadSendError] = useState<string | null>(null);
  const [sendingThread, setSendingThread] = useState(false);
  const [statusTransitioning, setStatusTransitioning] = useState(false);
  const [showSubmitForReviewModal, setShowSubmitForReviewModal] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [targetLocked, setTargetLocked] = useState(false);
  const [hasComposerDraft, setHasComposerDraft] = useState(false);
  const [visibleTargetName, setVisibleTargetName] = useState<string | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [threadScroller, setThreadScroller] = useState<HTMLDivElement | null>(null);
  const [taskComposerElement, setTaskComposerElement] = useState<HTMLDivElement | null>(null);
  const [taskComposerPaddingPx, setTaskComposerPaddingPx] = useState(144);
  const threadPanelRef = useRef<HTMLDivElement>(null);
  const scrollToBottomRef = useRef<((smooth?: boolean) => void) | null>(null);
  const draftWasActiveRef = useRef(false);
  const currentTaskIdRef = useRef<string | null>(taskId);
  currentTaskIdRef.current = taskId;
  // Modal-local error feedback. Separate from `threadSendError` because
  // `threadSendError` is rendered inside `TaskSessionChatComposer`, which is
  // only mounted when the inline composer is visible. A failed submit-for-
  // review RPC needs to surface inside the modal regardless of composer
  // visibility — see `SubmitForReviewModalProps.error`.
  const [submitForReviewError, setSubmitForReviewError] = useState<string | null>(null);
  const [showEditTaskModal, setShowEditTaskModal] = useState(false);
  const [editTaskBusy, setEditTaskBusy] = useState(false);
  const [editTaskError, setEditTaskError] = useState<string | null>(null);
  // Identity-safe node-click picker. Set when a clicked node resolves to an
  // ambiguous (multi-agent / multi-slot) or zero-agent state; selecting a
  // choice transitions into the proper session/pending overlay.
  const [nodeChoice, setNodeChoice] = useState<{ nodeName: string; choices: NodeChoice[] } | null>(
    null
  );
  const [fullWorkflow, setFullWorkflow] = useState<import('@hyperneo/shared').SpaceWorkflow | null>(
    null
  );
  const activeView = currentSpaceTaskViewTabSignal.value;

  useEffect(() => {
    setThreadSendError(null);
    setSelectedTargetId(null);
    setTargetLocked(false);
    setHasComposerDraft(false);
    setVisibleTargetName(null);
    setAutoScrollEnabled(true);
    setShowScrollButton(false);
    setThreadScroller(null);
    scrollToBottomRef.current = null;
    draftWasActiveRef.current = false;
    setShowEditTaskModal(false);
    setEditTaskBusy(false);
    setEditTaskError(null);
    setNodeChoice(null);
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    spaceStore.subscribeTaskActivity(taskId).catch(() => {
      // Ignore subscription errors — activity list is best-effort
    });
    return () => {
      spaceStore.unsubscribeTaskActivity(taskId);
    };
  }, [taskId]);

  // Resolve runId/workflowId here (before the early returns) so the gate-status
  // hook is always called — React's Rules of Hooks require a stable call order.
  const _runId = task?.workflowRunId ?? null;
  const _workflowRunForHook = _runId
    ? (spaceStore.workflowRuns.value.find((r) => r.id === _runId) ?? null)
    : null;
  const _workflowIdForHook = _workflowRunForHook?.workflowId ?? null;
  const { summaries: gateSummaries } = useRunGateSummaries(_runId, _workflowIdForHook);
  const {
    summaries: hookSummaries,
    fetchError: hookFetchError,
    retry: retryHookFetch,
    hasHooks: hasWorkflowHooks,
  } = useRunHookStates(_runId, _workflowIdForHook);
  const navigationSpaceIdForTask =
    routeSpaceId ?? currentSpaceIdSignal.value ?? spaceId ?? task?.spaceId;
  const targetSpaceIdForTask = spaceId ?? task?.spaceId ?? navigationSpaceIdForTask;

  useEffect(() => {
    if (!taskId || !targetSpaceIdForTask) return;
    const currentTarget = rightPanelTargetSignal.value;
    if (currentTarget?.type === 'task' && currentTarget.taskId === taskId) return;
    if (currentTarget === null) return;
    rightPanelTargetSignal.value = {
      type: 'task',
      spaceId: targetSpaceIdForTask,
      taskId,
      tab: 'details',
    };
  }, [targetSpaceIdForTask, taskId]);

  if (!taskId) {
    return (
      <div class="flex items-center justify-center h-full p-6">
        <p class="text-sm text-gray-400 text-center">Select a task to view details</p>
      </div>
    );
  }

  if (!task) {
    return (
      <div class="flex items-center justify-center h-full p-6">
        <p class="text-sm text-gray-400 text-center">Task not found</p>
      </div>
    );
  }

  const navigationSpaceId = navigationSpaceIdForTask ?? task.spaceId;
  const runtimeSpaceId = spaceId ?? task.spaceId;
  const auxiliaryPanelTab =
    activeView === 'timeline' || activeView === 'log' || activeView === 'artifacts'
      ? activeView
      : null;

  useEffect(() => {
    if (!auxiliaryPanelTab) return;
    if ((auxiliaryPanelTab === 'log' || auxiliaryPanelTab === 'artifacts') && !task.workflowRunId) {
      navigateToSpaceTask(navigationSpaceId, task.id, 'thread', true);
      return;
    }
    if (!targetSpaceIdForTask) return;
    rightPanelTargetSignal.value = {
      type: 'task',
      spaceId: targetSpaceIdForTask,
      taskId: task.id,
      tab: auxiliaryPanelTab,
    };
    navigateToSpaceTask(navigationSpaceId, task.id, 'thread', true);
  }, [auxiliaryPanelTab, navigationSpaceId, targetSpaceIdForTask, task.id, task.workflowRunId]);

  // Resolve the primary agent session from activity members (node-agent sessions).
  // Previously derived from threadSessionId (task-agent session), which no longer exists.
  const agentSessionId =
    activityMembers.find((m) => m.kind === 'node_agent' && m.sessionId)?.sessionId ?? null;

  // Resolve workflowId from the active run for canvas mode
  const workflowRun = task.workflowRunId
    ? (spaceStore.workflowRuns.value.find((r) => r.id === task.workflowRunId) ?? null)
    : null;
  const canvasWorkflowId = workflowRun?.workflowId ?? null;

  // Fetch full workflow detail for composer targets and declared-agent slots.
  // spaceStore.workflows only holds lightweight summaries.
  // Read the workflow version so the effect re-runs when the same workflow
  // is edited in place (spaceStore bumps the version on spaceWorkflow.updated).
  const workflowVersion = spaceStore.workflowVersions.value.get(canvasWorkflowId ?? '') ?? 0;
  useEffect(() => {
    if (!canvasWorkflowId) {
      setFullWorkflow(null);
      return;
    }
    let cancelled = false;
    // Clear stale workflow immediately so composer targets and @mention
    // candidates are never derived from a previous workflow while the new
    // fetch is in flight.
    setFullWorkflow(null);
    spaceStore.fetchWorkflowDetail(canvasWorkflowId).then((wf) => {
      if (!cancelled) setFullWorkflow(wf);
    });
    return () => {
      cancelled = true;
    };
  }, [canvasWorkflowId, workflowVersion]);

  // Scope @mention autocomplete to workflow agents only (no agents for non-workflow tasks)
  const workflow = fullWorkflow;
  const spaceAgents = spaceStore.agents.value;
  const nodeExecutions = spaceStore.nodeExecutions.value;
  const composerTargets: TaskComposerTarget[] = useMemo(() => {
    const nodeTargets =
      workflow?.nodes.flatMap((node) =>
        node.agents.map((agent) => {
          const member =
            activityMembers.find(
              (m) =>
                m.kind === 'node_agent' &&
                (normalizeTargetName(m.role) === normalizeTargetName(agent.name) ||
                  normalizeTargetName(m.nodeExecution?.agentName) ===
                    normalizeTargetName(agent.name))
            ) ?? null;
          const nodeExecution =
            task.workflowRunId && node.id
              ? (nodeExecutions.find(
                  (execution) =>
                    execution.workflowRunId === task.workflowRunId &&
                    execution.workflowNodeId === node.id &&
                    normalizeTargetName(execution.agentName) === normalizeTargetName(agent.name)
                ) ?? null)
              : null;
          const spaceAgent = spaceAgents.find((a) => a.id === agent.agentId) ?? null;
          return {
            id: `node:${node.id}:${agent.name}`,
            kind: 'node_agent' as const,
            label: member?.label ?? spaceAgent?.name ?? formatAgentSlotLabel(agent.name),
            agentName: agent.name,
            nodeExecutionId: nodeExecution?.id,
            nodeExecutionSessionId: nodeExecution?.agentSessionId ?? undefined,
            nodeId: node.id,
            nodeName: node.name,
            state: member ? ACTIVITY_STATE_LABELS[member.state] : 'Not started',
          };
        })
      ) ?? [];

    // Fallback: when the workflow definition is unavailable (async fetch race,
    // deleted/renamed workflow, stale run metadata), derive targets from live
    // activity members so the composer still works against running agents.
    const fallbackTargets: TaskComposerTarget[] = [];
    if (nodeTargets.length === 0 && activityMembers.length > 0) {
      const seen = new Set<string>();
      for (const m of activityMembers) {
        if (m.kind !== 'node_agent' || !m.role) continue;
        const name = normalizeTargetName(m.role);
        if (seen.has(name)) continue;
        seen.add(name);
        fallbackTargets.push({
          id: `activity:${m.sessionId ?? m.role}`,
          kind: 'node_agent',
          label: m.label,
          agentName: m.role,
          nodeExecutionId: m.nodeExecution?.nodeExecutionId,
          nodeExecutionSessionId: m.sessionId ?? undefined,
          nodeId: m.nodeExecution?.nodeId,
          state: ACTIVITY_STATE_LABELS[m.state],
        });
      }
    }

    return [...nodeTargets, ...fallbackTargets];
  }, [workflow, activityMembers, task.workflowRunId, nodeExecutions, spaceAgents]);

  // Extract per-agent default models from the workflow definition so the
  // composer can show the workflow-defined model as the default for agents
  // that haven't started yet. Keyed by target ID (node:${nodeId}:${agentName})
  // to avoid collisions when multiple nodes reuse the same agent slot name.
  const defaultAgentModels = useMemo(() => {
    const map = new Map<string, string>();
    if (!workflow) return map;
    for (const node of workflow.nodes) {
      for (const agent of node.agents) {
        if (agent.model) {
          map.set(`node:${node.id}:${agent.name}`, agent.model);
        }
      }
    }
    return map;
  }, [workflow]);

  const mentionCandidates = composerTargets
    .filter((target) => target.kind === 'node_agent' && target.agentName)
    .map((target) => ({ id: target.id, name: target.agentName as string }));

  const isTerminalTask =
    task.status === 'done' || task.status === 'cancelled' || task.status === 'archived';

  // Close edit modal if the task becomes terminal while the modal is open
  // (e.g. another client transitions the task to done/cancelled/archived).
  useEffect(() => {
    if (isTerminalTask && showEditTaskModal) {
      setShowEditTaskModal(false);
    }
  }, [isTerminalTask]);

  // Per-agent activity. Each member that's currently executing (not idle /
  // completed / failed / interrupted) contributes its label to the active set.
  // The thread feed keys the live rail off this set so that, in multi-session
  // workflows, every still-running agent's trailing non-terminal block renders
  // its own active rail — a single boolean would collapse incorrectly when one
  // agent's terminal result row lands after another agent's last visible row.
  //
  // `useMemo` keeps the `Set` reference stable between renders when the
  // activity-members snapshot hasn't changed, so descendants that diff
  // `activeAgentLabels` by identity (or use it as a hook dependency) don't
  // see spurious churn on every re-render of the pane.
  //
  // Aggregate boolean is still useful for UI bits that ask "is anything
  // running?" (the chat composer's processing indicator), so derive it from
  // the set rather than recomputing from `activityMembers`.
  const activeAgentLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const m of activityMembers) {
      if (m.state === 'active' || m.state === 'queued' || m.state === 'waiting_for_input') {
        labels.add(m.label);
      }
    }
    return labels;
  }, [activityMembers]);
  // Worker members in rate-limit cooldown / provider auth error, for the pinned
  // banners above the feed. Derived from the same activity subscription that
  // drives the live rails so the banners appear/disappear reactively as the
  // session transitions in and out of cooldown / error state.
  const cooldownBannerMembers = useMemo(
    () =>
      activityMembers
        .filter((m) => m.rateLimitCooldown && m.sessionId)
        .map((m) => ({
          sessionId: m.sessionId,
          label: m.label,
          retryCount: m.rateLimitCooldown!.retryCount,
          maxRetries: m.rateLimitCooldown!.maxRetries,
          retryAt: m.rateLimitCooldown!.retryAt,
        })),
    [activityMembers]
  );
  const authErrorBannerMembers = useMemo(
    () =>
      activityMembers
        .filter((m) => m.sessionId && m.sessionError?.category === 'provider_auth_error')
        .map((m) => ({
          sessionId: m.sessionId,
          label: m.label,
          message: m.sessionError?.message ?? '',
          providerId: m.sessionError?.providerId ?? null,
        })),
    [activityMembers]
  );
  const hasUnifiedWorkflowThread =
    !!task.workflowRunId || !!agentSessionId || activityMembers.length > 0;
  const showInlineComposer = !isTerminalTask;

  useLayoutEffect(() => {
    if (!showInlineComposer) {
      setTaskComposerPaddingPx(12);
      return;
    }

    const composer = taskComposerElement;
    if (!composer) return;

    const syncComposerPadding = () => {
      const composerHeight = Math.max(
        composer.getBoundingClientRect().height,
        composer.scrollHeight
      );
      setTaskComposerPaddingPx(Math.max(144, Math.ceil(composerHeight) + 16));
    };

    syncComposerPadding();

    const resizeObserver = new ResizeObserver(syncComposerPadding);
    resizeObserver.observe(composer);

    return () => resizeObserver.disconnect();
  }, [showInlineComposer, taskComposerElement, threadSendError]);

  const canSendThreadMessage =
    !isTerminalTask && !ensuringThread && !sendingThread && composerTargets.length > 0;

  // Thread-column image drop zone. The inline composer registers its file-drop
  // handler upward via registerDropTarget; this column owns the drag/drop surface
  // so an image can be dropped anywhere over the thread (feed + composer).
  const dropFilesRef = useRef<FileDropHandler | null>(null);
  const registerDropTarget = useCallback((fn: FileDropHandler | null) => {
    dropFilesRef.current = fn;
  }, []);
  const { isDragging, dragHandlers } = useImageDropZone((files) => {
    void dropFilesRef.current?.(files);
  }, canSendThreadMessage);
  const canShowCanvasTab = !!task.workflowRunId && !!canvasWorkflowId;
  const activitySummary = STATUS_LABELS[task.status];
  const resolvedBanner = resolveActiveTaskBanner(
    task,
    hookSummaries as unknown as import('../../lib/task-banner').HookBannerSummary[],
    gateSummaries
  );
  const activeBanner =
    hasWorkflowHooks &&
    hookFetchError &&
    _runId &&
    (resolvedBanner === null || resolvedBanner.kind === 'gate_pending')
      ? ({ kind: 'hook_pending', runId: _runId } as const)
      : resolvedBanner;
  const showHeaderStatusBadge = activeBanner === null;
  const visibleTarget = visibleTargetName
    ? composerTargets.find(
        (target) =>
          normalizeTargetName(target.label) === normalizeTargetName(visibleTargetName) ||
          normalizeTargetName(target.agentName) === normalizeTargetName(visibleTargetName)
      )
    : null;
  const defaultTarget =
    visibleTarget ?? composerTargets.find((t) => t.kind === 'node_agent') ?? null;
  const selectedTarget =
    composerTargets.find((target) => target.id === selectedTargetId) ?? defaultTarget;

  useEffect(() => {
    if (selectedTargetId && composerTargets.some((target) => target.id === selectedTargetId)) {
      return;
    }
    setSelectedTargetId(defaultTarget?.id ?? null);
  }, [composerTargets, defaultTarget?.id, selectedTargetId]);

  useEffect(() => {
    if (targetLocked || hasComposerDraft || !defaultTarget) return;
    if (selectedTargetId === defaultTarget.id) return;
    setSelectedTargetId(defaultTarget.id);
  }, [defaultTarget, hasComposerDraft, selectedTargetId, targetLocked]);

  useEffect(() => {
    if (activeView !== 'thread' || !showInlineComposer) return;
    const root = threadPanelRef.current;
    if (!root) return;
    const scroller =
      threadScroller ??
      root.querySelector<HTMLElement>('[data-testid="space-task-unified-thread"] > div');
    if (!scroller) return;

    let frame = 0;
    const updateVisibleTarget = (options?: { unlockManualTarget?: boolean }) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rootRect = scroller.getBoundingClientRect();
        const targetAnchorY = rootRect.top + rootRect.height * 0.72;
        const turns = Array.from(
          root.querySelectorAll<HTMLElement>('[data-testid="minimal-thread-turn"]')
        );
        let best: { targetName: string; distance: number; visibleHeight: number } | null = null;
        for (const turn of turns) {
          const rect = turn.getBoundingClientRect();
          const visibleTop = Math.max(rect.top, rootRect.top);
          const visibleBottom = Math.min(rect.bottom, rootRect.bottom);
          const visibleHeight = visibleBottom - visibleTop;
          if (visibleHeight < 8) continue;
          const targetName =
            turn.dataset.toLabel || turn.dataset.agentLabel || turn.dataset.fromLabel || null;
          if (!targetName) continue;
          const visibleCenter = visibleTop + visibleHeight / 2;
          const distance = Math.abs(visibleCenter - targetAnchorY);
          if (
            !best ||
            distance < best.distance ||
            (distance === best.distance && visibleHeight >= best.visibleHeight)
          ) {
            best = { targetName, distance, visibleHeight };
          }
        }
        setVisibleTargetName(best?.targetName ?? null);
        if (options?.unlockManualTarget && targetLocked && !hasComposerDraft && !sendingThread) {
          setTargetLocked(false);
        }
      });
    };

    const handleScroll = () => updateVisibleTarget({ unlockManualTarget: true });
    const observer = new MutationObserver(() => updateVisibleTarget());
    observer.observe(root, { childList: true, subtree: true });
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    updateVisibleTarget();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', handleScroll);
    };
  }, [
    activeView,
    hasComposerDraft,
    sendingThread,
    showInlineComposer,
    targetLocked,
    threadScroller,
  ]);

  useEffect(() => {
    if (activeView === 'canvas' && !canShowCanvasTab) {
      navigateToSpaceTask(navigationSpaceId, taskId, 'thread', true);
    }
  }, [activeView, canShowCanvasTab, navigationSpaceId, taskId]);

  // Ensure node-execution liveness is loaded for thread-view workflow tasks, not
  // only when the canvas is toggled. The composer target's nodeExecutionSessionId
  // (the execution's live agentSessionId) is derived from this; without it the
  // session latch can't detect a detached worker, so opening a task directly in
  // thread would leave a stale session latched.
  useEffect(() => {
    if (!task?.workflowRunId) return;
    spaceStore.ensureNodeExecutions().catch(() => {});
  }, [task?.workflowRunId]);

  const handleCanvasToggle = useCallback(() => {
    if (!canShowCanvasTab) return;
    if (activeView === 'canvas') {
      navigateToSpaceTask(navigationSpaceId, taskId, 'thread', true);
      return;
    }
    spaceStore.ensureNodeExecutions().catch(() => {});
    navigateToSpaceTask(navigationSpaceId, taskId, 'canvas', true);
  }, [activeView, canShowCanvasTab, navigationSpaceId, taskId]);

  const handleNodeClick = (nodeId: string, nodeName: string, agentSlotNames: string[]) => {
    // Resolve the clicked node STRICTLY by its persisted node ID + declared
    // agent slot identity — never falling back to another node's session. The
    // previous "last resort: use the task's own agentSessionId" fallback was
    // the root cause of clicking an unstarted node B opening node A's chat.
    // See lib/node-click-resolver.ts for the full decision table.
    const clickedNode = workflow?.nodes.find((n) => n.id === nodeId) ?? null;
    const slotLabel = (agentName: string): string => {
      const slot =
        clickedNode?.agents.find(
          (a) => normalizeTargetName(a.name) === normalizeTargetName(agentName)
        ) ?? null;
      const spaceAgent = slot?.agentId ? spaceAgents.find((a) => a.id === slot.agentId) : undefined;
      return spaceAgent?.name ?? formatAgentSlotLabel(agentName);
    };
    // Agent the workflow's post-approval route targets (e.g. 'merger'). The
    // spawned merger session carries no node_execution row, so its identity is
    // tied to this slot via task.postApprovalSessionId inside the resolver.
    // Mirror collectPostApprovalRoutes: prefer node-level routes, then fall
    // back to the legacy workflow-level route for persisted workflows that
    // predate node-level post-approval.
    let postApprovalTargetAgent: string | null = null;
    if (workflow) {
      for (const node of workflow.nodes) {
        const target = node.postApproval?.targetAgent;
        if (target && target !== 'task-agent') {
          postApprovalTargetAgent = target;
          break;
        }
      }
      if (!postApprovalTargetAgent) {
        const target = workflow.postApproval?.targetAgent;
        if (target && target !== 'task-agent') {
          postApprovalTargetAgent = target;
        }
      }
    }

    const outcome = resolveNodeClick({
      taskId: task.id,
      nodeId,
      nodeName,
      agentSlotNames,
      workflowRunId: task.workflowRunId,
      nodeExecutions,
      activityMembers,
      postApprovalSessionId: task.postApprovalSessionId,
      postApprovalTargetAgent,
      resolveLabel: slotLabel,
      normalizeSlotName: normalizeTargetName,
    });

    switch (outcome.type) {
      case 'open_session':
        pushOverlayHistory(outcome.session.sessionId, outcome.session.label, undefined, {
          taskId: task.id,
          agentName: outcome.session.agentName,
          ...(outcome.session.nodeExecutionId
            ? { nodeExecutionId: outcome.session.nodeExecutionId }
            : {}),
        });
        return;
      case 'activate_slot':
        // Unstarted single-slot node: open its OWN pending-agent overlay,
        // carrying the node ID so the first message activates only this node
        // (not another node that reuses the same slot name).
        pushOverlayHistoryForPendingAgent(task.id, outcome.agentName, outcome.nodeId);
        return;
      case 'choose':
        // Multi-agent node (several live) or multi-slot unstarted node: let
        // the user pick rather than silently selecting an arbitrary slot.
        setNodeChoice({ nodeName, choices: outcome.choices });
        return;
      case 'empty':
        // Zero-agent node: present a clear empty state, no fallback.
        setNodeChoice({ nodeName, choices: [] });
        return;
    }
  };

  const handleNodeChoiceSelect = (choice: NodeChoice) => {
    setNodeChoice(null);
    if (choice.kind === 'live') {
      pushOverlayHistory(choice.sessionId, choice.label, undefined, {
        taskId: task.id,
        agentName: choice.agentName,
        ...(choice.nodeExecutionId ? { nodeExecutionId: choice.nodeExecutionId } : {}),
      });
    } else {
      pushOverlayHistoryForPendingAgent(task.id, choice.agentName, choice.nodeId);
    }
  };

  const sendThreadMessage = async (
    nextMessage: string,
    target: TaskComposerTarget | null,
    images?: MessageImage[]
  ): Promise<boolean> => {
    if (!nextMessage) return false;
    if (!runtimeSpaceId || !task) return false;
    // Require an explicit node_agent target — messages without one are rejected
    // by the daemon ("Target agent is required"). Guard here to avoid a round-trip.
    if (target?.kind !== 'node_agent' || !target.agentName) {
      setThreadSendError('Select a target agent before sending.');
      return false;
    }

    try {
      setSendingThread(true);
      setThreadSendError(null);

      const result = await spaceStore.sendTaskMessage(
        task.id,
        nextMessage,
        {
          kind: 'node_agent',
          agentName: target.agentName,
          ...(target.nodeExecutionId ? { nodeExecutionId: target.nodeExecutionId } : {}),
          // Carry the node ID so lazy activation targets the exact node when
          // multiple nodes reuse the same agent slot name.
          ...(target.nodeId ? { workflowNodeId: target.nodeId } : {}),
        },
        images
      );

      // When the daemon queued the message for a not-yet-spawned agent,
      // keep the draft and surface a user-visible signal so the message
      // is never silently lost.
      if (result?.delivered === false && !result?.queued) {
        setThreadSendError(
          'Agent is starting — your message could not be delivered. Try again in a moment.'
        );
        return false;
      }

      setTargetLocked(false);
      setHasComposerDraft(false);
      draftWasActiveRef.current = false;
      return true;
    } catch (err) {
      setThreadSendError(formatTaskThreadError(err));
      return false;
    } finally {
      setEnsuringThread(false);
      setSendingThread(false);
    }
  };

  const handleScrollToBottom = useCallback(() => {
    scrollToBottomRef.current?.(true);
    setAutoScrollEnabled(true);
  }, []);

  const handleStatusTransition = async (newStatus: SpaceTaskStatus) => {
    // Submitting for review is the human counterpart of the agent
    // `submit_for_approval` tool — it must stamp pending-completion metadata
    // so `PendingTaskCompletionBanner` renders. Open the optional-reason
    // modal instead of issuing a bare status update; the modal calls
    // `spaceStore.submitForReview` on confirm.
    if (newStatus === 'review') {
      setThreadSendError(null);
      setSubmitForReviewError(null);
      setShowSubmitForReviewModal(true);
      return;
    }
    try {
      setStatusTransitioning(true);
      setThreadSendError(null);
      if (task.status === 'draft' && newStatus === 'open') {
        await spaceStore.publishTask(task.id);
      } else if (task.workflowRunId && newStatus === 'cancelled') {
        if (task.status === 'blocked') {
          await spaceStore.updateTask(task.id, { status: newStatus });
        } else {
          await spaceStore.cancelWorkflowRun(task.workflowRunId);
        }
      } else if (task.workflowRunId && isWorkflowRecoveryTransition(task.status, newStatus)) {
        await spaceStore.recoverWorkflowTask(task.id, newStatus);
      } else {
        // Mark Done routes through `buildMarkDonePayload` so the `approved →
        // done` path clears post-approval fields — same payload the
        // `PendingPostApprovalBanner` uses (task #849, G4). Other transitions
        // are a bare status update.
        const payload = newStatus === 'done' ? buildMarkDonePayload(task) : { status: newStatus };
        await spaceStore.updateTask(task.id, payload);
      }
    } catch (err) {
      setThreadSendError(formatTaskThreadError(err));
    } finally {
      setStatusTransitioning(false);
    }
  };

  const handleSubmitForReviewConfirm = async (reason: string | null) => {
    try {
      setStatusTransitioning(true);
      setSubmitForReviewError(null);
      await spaceStore.submitForReview(task.id, reason);
      setShowSubmitForReviewModal(false);
    } catch (err) {
      // Render the error inside the modal — `threadSendError` is invisible
      // when the inline composer is hidden, which would leave the modal
      // frozen with no feedback after a failed submit.
      setSubmitForReviewError(formatTaskThreadError(err));
    } finally {
      setStatusTransitioning(false);
    }
  };

  const handleEditTaskConfirm = async (
    updates: Partial<{
      title: string;
      description: string;
      priority: import('@hyperneo/shared').SpaceTaskPriority;
    }>
  ) => {
    // Capture the current taskId before the async gap. After `await`,
    // the closure's `task` is stale (captured at render time), so we
    // read `currentTaskIdRef.current` which is updated on each render.
    const savedTaskId = task.id;
    try {
      setEditTaskBusy(true);
      setEditTaskError(null);
      await spaceStore.updateTask(savedTaskId, updates);
      if (currentTaskIdRef.current === savedTaskId) {
        setShowEditTaskModal(false);
      }
    } catch (err) {
      if (currentTaskIdRef.current === savedTaskId) {
        setEditTaskError(formatEditTaskError(err));
      }
    } finally {
      if (currentTaskIdRef.current === savedTaskId) {
        setEditTaskBusy(false);
      }
    }
  };

  const allTransitionActions = getTransitionActions(task.status);
  // Mirrors the filter in `TaskStatusActions`: any task in `review` is
  // "awaiting human approval via a dedicated banner" — the bare review→done /
  // review→cancelled buttons would bypass `PostApprovalRouter` and the
  // approval metadata stamping. Hide them so the only Approve / Cancel path
  // is the banner. Non-approval escape hatches (Reopen, Archive) stay.
  const filteredTransitionActions =
    task.status === 'review' ||
    task.pendingCheckpointType === 'task_completion' ||
    task.pendingCheckpointType === 'gate'
      ? allTransitionActions.filter(({ target }) => target !== 'done' && target !== 'cancelled')
      : allTransitionActions;

  // Merge live activity members with workflow-declared agents so the dropdown
  // renders every peer the task can ever address — even those that haven't
  // spawned a session yet. Activity members are the source of truth for state;
  // the workflow definition is the source of truth for "what peers exist".
  //
  // Without this merge, a workflow-declared agent (e.g. `reviewer`) would not
  // appear until the workflow tick loop activates its node, which made the
  // peer feel "missing" to the user even though Task Agent send_message can
  // already lazily activate it on first contact (see Task #133).
  const activityRoles = new Set(
    activityMembers.filter((m) => m.kind === 'node_agent').map((m) => m.role)
  );
  const declaredAgentSlots: Array<{ name: string; nodeName: string; nodeId: string }> = [];
  if (workflow) {
    for (const node of workflow.nodes) {
      for (const agent of node.agents) {
        if (activityRoles.has(agent.name)) continue;
        declaredAgentSlots.push({ name: agent.name, nodeName: node.name, nodeId: node.id });
      }
    }
  }

  const taskActionItems: DropdownMenuItem[] = [];
  if (!isTerminalTask) {
    taskActionItems.push({
      label: 'Edit title, description, or priority',
      onClick: () => {
        setEditTaskError(null);
        setShowEditTaskModal(true);
      },
    });
  }
  if (activityMembers.length > 0) {
    taskActionItems.push(
      ...activityMembers.map((member) => ({
        label: `Open ${member.label} (${ACTIVITY_STATE_LABELS[member.state]})`,
        onClick: () => {
          pushOverlayHistory(
            member.sessionId,
            member.label,
            undefined,
            member.kind === 'node_agent'
              ? {
                  taskId: task.id,
                  agentName: member.role,
                  ...(member.nodeExecution?.nodeExecutionId
                    ? { nodeExecutionId: member.nodeExecution.nodeExecutionId }
                    : {}),
                }
              : null
          );
        },
      }))
    );
  }
  // Workflow-declared agents that have never spawned a session yet. We surface
  // them as clickable entries that open a "pending" overlay routed by agent
  // name; the first message the user sends from that overlay invokes
  // `space.task.activateNodeAgent`, which lazily spawns the workflow node.
  // Once `taskActivity` reflects the new session, the overlay hydrates to a
  // normal session-mode chat and this entry is replaced by the live member
  // from `activityMembers` above.
  if (declaredAgentSlots.length > 0) {
    taskActionItems.push(
      ...declaredAgentSlots.map((slot) => ({
        label: `Open ${slot.name} (Not started)`,
        onClick: () => {
          pushOverlayHistoryForPendingAgent(task.id, slot.name, slot.nodeId);
        },
        title: `${slot.name} hasn't been activated yet. Sending the first message will start its session.`,
      }))
    );
  }
  if (filteredTransitionActions.length > 0) {
    if (taskActionItems.length > 0) {
      taskActionItems.push({ type: 'divider' as const });
    }
    taskActionItems.push(
      ...filteredTransitionActions.map(({ target, label }) => ({
        label: getTaskActionLabel(task, target, label),
        onClick: () => {
          handleStatusTransition(target);
        },
        disabled: statusTransitioning,
        danger: target === 'cancelled' || target === 'archived',
      }))
    );
  }

  return (
    <div class="flex flex-col h-full overflow-hidden bg-dark-900">
      <div
        data-tauri-drag-region
        class={`flex h-[88px] flex-shrink-0 items-center bg-dark-850 border-b px-4 ${borderColors.ui.default}`}
      >
        <div class="flex w-full items-center gap-3 pr-12" data-tauri-drag-region>
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
          <div class="min-w-0 flex-1" data-tauri-drag-region>
            <div class="flex min-w-0 items-center gap-2" data-tauri-drag-region>
              <h2
                class="min-w-0 truncate text-base font-semibold leading-6 text-gray-100"
                title={task.title}
                data-tauri-drag-region
              >
                {task.title}
              </h2>
              {taskActionItems.length > 0 && (
                <Dropdown
                  items={taskActionItems}
                  position="right"
                  trigger={
                    <button
                      type="button"
                      class="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-dark-800 hover:text-gray-200"
                      data-testid="task-actions-menu-trigger"
                      aria-label="Task Actions"
                      title="Task Actions"
                    >
                      <svg
                        class="h-4 w-4"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <circle cx="10" cy="4" r="1.75" />
                        <circle cx="10" cy="10" r="1.75" />
                        <circle cx="10" cy="16" r="1.75" />
                      </svg>
                    </button>
                  }
                />
              )}
            </div>
            <div class="mt-2 flex min-w-0 flex-wrap items-center gap-2 overflow-hidden">
              <span class="inline-flex h-6 min-w-16 items-center justify-center rounded-md border border-dark-600 bg-dark-800/60 px-2 font-mono text-[11px] font-medium leading-none text-gray-300 tabular-nums">
                #{task.taskNumber}
              </span>
              {showHeaderStatusBadge && (
                <span data-testid="task-status-label">
                  <StatusBadge
                    tone={getTaskStatusConfig(task.status).tone}
                    label={activitySummary}
                  />
                </span>
              )}
              <TaskMetaBadge class={PRIORITY_BADGE_CLASSES[task.priority]}>
                {PRIORITY_LABELS[task.priority]} Priority
              </TaskMetaBadge>
            </div>
          </div>
        </div>
      </div>

      {/* Banner block lives outside the tab content so blocked / pending
			    banners stay visible regardless of which tab the user is on.
			    `resolveActiveTaskBanner` returns null when no banner applies —
			    the wrapping fragment then renders nothing and the block takes
			    zero height. */}
      {(() => {
        // Single-slot precedence renderer — at most one banner is ever
        // shown. Precedence (high → low):
        //   blocked > post_approval_blocked > task_completion_pending > hook_pending > gate_pending
        // The helper captures the rule so it can be unit-tested
        // independently of the render tree.
        const banner = activeBanner;
        if (!banner) return null;
        const child =
          banner.kind === 'blocked' ? (
            <TaskBlockedBanner
              task={task}
              spaceId={runtimeSpaceId}
              onStatusTransition={handleStatusTransition}
            />
          ) : banner.kind === 'post_approval_blocked' ? (
            <PendingPostApprovalBanner task={task} spaceId={runtimeSpaceId} />
          ) : banner.kind === 'task_completion_pending' ? (
            <PendingTaskCompletionBanner task={task} spaceId={runtimeSpaceId} />
          ) : banner.kind === 'hook_pending' ? (
            // hook_pending — PendingHookBanner renders rows for every
            // blocked or retryable hook on the run.
            <PendingHookBanner
              runId={banner.runId}
              spaceId={runtimeSpaceId}
              workflowId={canvasWorkflowId}
              summaries={hookSummaries}
              fetchError={hookFetchError}
              retry={retryHookFetch}
            />
          ) : (
            // gate_pending — PendingGateBanner renders rows for every
            // waiting gate on the run. Legacy workflows only.
            <PendingGateBanner
              runId={banner.runId}
              spaceId={runtimeSpaceId}
              workflowId={canvasWorkflowId}
            />
          );
        return (
          <div class="flex-shrink-0" data-testid="task-pane-banner">
            {child}
          </div>
        );
      })()}

      <div class="flex-1 min-h-0 overflow-hidden relative" data-testid="task-pane-content">
        {activeView === 'canvas' && task.workflowRunId && canvasWorkflowId ? (
          <div class="relative h-full" data-testid="canvas-view">
            <ReadOnlyWorkflowCanvas
              workflowId={canvasWorkflowId}
              runId={task.workflowRunId}
              spaceId={spaceId}
              onNodeClick={handleNodeClick}
              class="h-full"
            />
            {canShowCanvasTab && (
              <div class="pointer-events-none absolute top-4 right-4 z-20">
                <TaskCanvasToggleButton
                  active={true}
                  onClick={handleCanvasToggle}
                  class="pointer-events-auto shadow-lg shadow-black/30"
                />
              </div>
            )}
          </div>
        ) : (
          <div
            class="h-full flex flex-col relative"
            style={`--task-composer-offset: ${taskComposerPaddingPx}px;`}
            {...dragHandlers}
          >
            {isDragging && <ImageDropOverlay />}
            {canShowCanvasTab && (
              <div class="pointer-events-none absolute top-4 right-4 z-20">
                <TaskCanvasToggleButton
                  active={false}
                  onClick={handleCanvasToggle}
                  class="pointer-events-auto shadow-lg shadow-black/30"
                />
              </div>
            )}
            <div ref={threadPanelRef} class="flex-1 min-h-0" data-testid="task-thread-panel">
              {hasUnifiedWorkflowThread ? (
                <SpaceTaskUnifiedThread
                  taskId={task.id}
                  bottomInsetPx={taskComposerPaddingPx}
                  activeAgentLabels={activeAgentLabels}
                  overlayTaskId={task.id}
                  cooldownBannerMembers={cooldownBannerMembers}
                  authErrorBannerMembers={authErrorBannerMembers}
                  autoScrollEnabled={autoScrollEnabled}
                  onShowScrollButtonChange={setShowScrollButton}
                  onScrollToBottomChange={(scrollToBottom) => {
                    scrollToBottomRef.current = scrollToBottom;
                  }}
                  onScrollerChange={setThreadScroller}
                />
              ) : (
                <div class="h-full overflow-y-auto">
                  <div class="min-h-[calc(100%+1px)] px-4 py-10 text-center">
                    <p class="text-sm text-gray-300">
                      {ensuringThread
                        ? 'Starting task thread...'
                        : 'Task thread is not available yet.'}
                    </p>
                    <p class="mt-2 text-xs text-gray-400">
                      {ensuringThread
                        ? 'Connecting task and node-agent streams.'
                        : 'Keep this view open while the task thread starts.'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {showScrollButton && (
              <ScrollToBottomButton
                onClick={handleScrollToBottom}
                bottomClass="bottom-[var(--task-composer-offset)]"
                autoScroll={autoScrollEnabled}
              />
            )}

            {showInlineComposer && (
              <TaskSessionChatComposer
                mentionCandidates={mentionCandidates}
                targets={composerTargets}
                selectedTargetId={selectedTarget?.id ?? null}
                canSend={canSendThreadMessage}
                isSending={sendingThread}
                autoScroll={autoScrollEnabled}
                errorMessage={threadSendError}
                activityMembers={activityMembers}
                defaultAgentModels={defaultAgentModels}
                taskId={task.id}
                onAutoScrollChange={setAutoScrollEnabled}
                onTargetSelect={(targetId) => {
                  setSelectedTargetId(targetId);
                  setTargetLocked(true);
                }}
                onDraftActiveChange={(hasDraft) => {
                  setHasComposerDraft(hasDraft);
                  if (draftWasActiveRef.current && !hasDraft) setTargetLocked(false);
                  draftWasActiveRef.current = hasDraft;
                }}
                onComposerRef={setTaskComposerElement}
                onSend={sendThreadMessage}
                registerDropTarget={registerDropTarget}
              />
            )}
          </div>
        )}
      </div>
      <SubmitForReviewModal
        isOpen={showSubmitForReviewModal}
        busy={statusTransitioning}
        onCancel={() => {
          if (!statusTransitioning) setShowSubmitForReviewModal(false);
        }}
        onConfirm={handleSubmitForReviewConfirm}
        error={submitForReviewError}
      />
      <EditTaskModal
        isOpen={showEditTaskModal}
        busy={editTaskBusy}
        initialTitle={task.title}
        initialDescription={task.description ?? ''}
        initialPriority={task.priority}
        onCancel={() => {
          if (!editTaskBusy) setShowEditTaskModal(false);
        }}
        onConfirm={handleEditTaskConfirm}
        error={editTaskError}
      />
      <NodeAgentChoiceOverlay
        isOpen={nodeChoice !== null}
        nodeName={nodeChoice?.nodeName ?? ''}
        choices={nodeChoice?.choices ?? []}
        onSelect={handleNodeChoiceSelect}
        onClose={() => setNodeChoice(null)}
      />
    </div>
  );
}
