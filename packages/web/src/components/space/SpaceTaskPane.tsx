import {
  getWorkflowRunExecutionStatusLabel,
  isWorkflowRecoveryTransition,
  type MessageDeliveryMode,
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
import { SectionCard } from '../ui/SectionCard';
import { StatusBadge } from '../ui/StatusBadge';
import { EditTaskModal } from './EditTaskModal';
import { NodeAgentChoiceOverlay } from './NodeAgentChoiceOverlay';
import { PendingHookBanner } from './PendingHookBanner';
import { PendingPostApprovalBanner } from './PendingPostApprovalBanner';
import { PendingTaskCompletionBanner } from './PendingTaskCompletionBanner';
import { ReadOnlyWorkflowCanvas } from './ReadOnlyWorkflowCanvas';
import { SpaceTaskUnifiedThread } from './SpaceTaskUnifiedThread';
import { SubmitForReviewModal } from './SubmitForReviewModal';
import { TaskBlockedBanner } from './TaskBlockedBanner';
import { VoiceSurfaceContext } from '../../hooks/useVoiceRecorder';
import { voiceReturnTaskTargetSessionSignal } from '../../lib/voice/voice-composer-registry';
import { TaskCanvasToggleButton, TaskSessionChatComposer } from './TaskSessionChatComposer';
import { ImageDropOverlay } from '../ImageDropOverlay.tsx';
import { getTransitionActions } from './TaskStatusActions';
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

function formatTaskTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}

function TaskInfoRow({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="flex items-start justify-between gap-3 text-sm">
      <span class="text-gray-400">{label}</span>
      <span class="min-w-0 text-right text-gray-200">{children}</span>
    </div>
  );
}

export function SpaceTaskPane({
  taskId,
  spaceId,
  navigationSpaceId: routeSpaceId,
  onClose,
}: SpaceTaskPaneProps) {
  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [spaceId]);

  const tasks = spaceStore.tasks.value;
  const task = taskId ? (tasks.find((t) => t.id === taskId) ?? null) : null;
  const activityMembers: SpaceTaskActivityMember[] = taskId
    ? (spaceStore.taskActivity.value.get(taskId) ?? [])
    : [];

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
  const nodeClickGenRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [submitForReviewError, setSubmitForReviewError] = useState<string | null>(null);
  const [showEditTaskModal, setShowEditTaskModal] = useState(false);
  const [editTaskBusy, setEditTaskBusy] = useState(false);
  const [editTaskError, setEditTaskError] = useState<string | null>(null);
  const [nodeChoice, setNodeChoice] = useState<{
    taskId: string;
    nodeName: string;
    nodeId: string;
    choices: NodeChoice[];
  } | null>(null);
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

  const _runId = task?.workflowRunId ?? null;
  const _workflowRunForHook = _runId
    ? (spaceStore.workflowRuns.value.find((r) => r.id === _runId) ?? null)
    : null;
  const _workflowIdForHook = _workflowRunForHook?.workflowId ?? null;
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

  const workflowRun = task.workflowRunId
    ? (spaceStore.workflowRuns.value.find((r) => r.id === task.workflowRunId) ?? null)
    : null;
  const canvasWorkflowId = workflowRun?.workflowId ?? null;

  const workflowVersion = spaceStore.workflowVersions.value.get(canvasWorkflowId ?? '') ?? 0;
  useEffect(() => {
    if (!canvasWorkflowId) {
      setFullWorkflow(null);
      return;
    }
    let cancelled = false;
    setFullWorkflow(null);
    spaceStore.fetchWorkflowDetail(canvasWorkflowId).then((wf) => {
      if (!cancelled) setFullWorkflow(wf);
    });
    return () => {
      cancelled = true;
    };
  }, [canvasWorkflowId, workflowVersion]);

  const workflow = fullWorkflow;
  const preferredWorkflowName = task.preferredWorkflowId
    ? (spaceStore.workflows.value.find((w) => w.id === task.preferredWorkflowId)?.name ?? null)
    : null;
  const spaceAgents = spaceStore.agents.value;
  const nodeExecutions = spaceStore.nodeExecutions.value;
  const composerTargets: TaskComposerTarget[] = useMemo(() => {
    const composerWorkerMember = activityMembers.find(
      (m) =>
        m.kind === 'node_agent' &&
        m.nodeExecution?.isCurrentPostApproval === true &&
        (!task.postApprovalSessionId || m.sessionId === task.postApprovalSessionId)
    );
    let composerPostApprovalTarget: string | null =
      composerWorkerMember?.nodeExecution?.agentName ?? null;
    if (!composerPostApprovalTarget && workflow) {
      for (const n of workflow.nodes) {
        const t = n.postApproval?.targetAgent;
        if (t && t !== 'task-agent') {
          composerPostApprovalTarget = t;
          break;
        }
      }
      if (!composerPostApprovalTarget) {
        const t = workflow.postApproval?.targetAgent;
        if (t && t !== 'task-agent') composerPostApprovalTarget = t;
      }
    }
    const durableWorkerNodeId =
      composerWorkerMember?.nodeExecution?.nodeId ??
      (composerPostApprovalTarget
        ? (workflow?.nodes.find((n) => n.agents.some((a) => a.name === composerPostApprovalTarget))
            ?.id ?? null)
        : null);

    const nodeTargets =
      workflow?.nodes.flatMap((node) =>
        node.agents.map((agent) => {
          const matchingMembers = activityMembers.filter((m) => {
            if (m.kind !== 'node_agent') return false;
            if (m.nodeExecution?.nodeId && m.nodeExecution.nodeId !== node.id) return false;
            const execName = m.nodeExecution?.agentName;
            if (execName) return execName === agent.name;
            return normalizeTargetName(m.role) === normalizeTargetName(agent.name);
          });
          const member =
            matchingMembers.find(
              (m) =>
                m.nodeExecution?.isCurrentPostApproval === true &&
                (!task.postApprovalSessionId || m.sessionId === task.postApprovalSessionId)
            ) ??
            matchingMembers.find((m) => m.nodeExecution?.isCurrentPostApproval !== true) ??
            null;
          const nodeExecution =
            task.workflowRunId && node.id
              ? (nodeExecutions
                  .filter(
                    (execution) =>
                      execution.workflowRunId === task.workflowRunId &&
                      execution.workflowNodeId === node.id &&
                      execution.status !== 'cancelled' &&
                      execution.status !== 'pending' &&
                      execution.agentName === agent.name
                  )
                  .at(-1) ?? null)
              : null;
          const spaceAgent = spaceAgents.find((a) => a.id === agent.agentId) ?? null;
          const durableWorkerNode = durableWorkerNodeId === node.id && !!task.postApprovalSessionId;
          const durableWorkerSlot = durableWorkerNode && agent.name === composerPostApprovalTarget;
          const workerOwnsSlot =
            member?.nodeExecution?.isCurrentPostApproval === true || durableWorkerSlot;
          const durableSession = task.postApprovalSessionId ?? undefined;
          return {
            id: `node:${node.id}:${agent.name}`,
            kind: 'node_agent' as const,
            label: member?.label ?? spaceAgent?.name ?? formatAgentSlotLabel(agent.name),
            agentName: agent.name,
            nodeExecutionId: workerOwnsSlot ? undefined : nodeExecution?.id,
            nodeExecutionSessionId: workerOwnsSlot
              ? durableSession
              : (nodeExecution?.agentSessionId ?? undefined),
            nodeId: node.id,
            nodeName: node.name,
            state: member ? ACTIVITY_STATE_LABELS[member.state] : 'Not started',
          };
        })
      ) ?? [];

    const fallbackTargets: TaskComposerTarget[] = [];
    if (nodeTargets.length === 0 && activityMembers.length > 0) {
      const seen = new Set<string>();
      for (const m of activityMembers) {
        if (m.kind !== 'node_agent' || !m.role) continue;
        if (m.nodeExecution?.status === 'cancelled' || m.nodeExecution?.status === 'pending')
          continue;
        const name = normalizeTargetName(m.role);
        if (seen.has(name)) continue;
        const preferred =
          m.nodeExecution?.isCurrentPostApproval === true &&
          (!task.postApprovalSessionId || m.sessionId === task.postApprovalSessionId)
            ? m
            : (activityMembers.find(
                (other) =>
                  other.kind === 'node_agent' &&
                  normalizeTargetName(other.role ?? '') === name &&
                  other.nodeExecution?.isCurrentPostApproval === true &&
                  (!task.postApprovalSessionId || other.sessionId === task.postApprovalSessionId)
              ) ?? m);
        seen.add(name);
        if (
          preferred.nodeExecution?.isCurrentPostApproval === true &&
          !!task.postApprovalSessionId &&
          preferred.sessionId !== task.postApprovalSessionId
        ) {
          continue;
        }
        fallbackTargets.push({
          id: `activity:${preferred.sessionId ?? preferred.role}`,
          kind: 'node_agent',
          label: preferred.label,
          agentName: preferred.role,
          nodeExecutionId: preferred.nodeExecution?.nodeExecutionId,
          nodeExecutionSessionId:
            preferred.nodeExecution?.isCurrentPostApproval === true && task.postApprovalSessionId
              ? task.postApprovalSessionId
              : (preferred.sessionId ?? undefined),
          nodeId: preferred.nodeExecution?.nodeId,
          state: ACTIVITY_STATE_LABELS[preferred.state],
        });
      }
    }

    return [...nodeTargets, ...fallbackTargets];
  }, [
    workflow,
    activityMembers,
    task.workflowRunId,
    task.postApprovalSessionId,
    nodeExecutions,
    spaceAgents,
  ]);

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
  const taskAgentsLive =
    !isTerminalTask &&
    ['in_progress', 'review', 'approved', 'rate_limited', 'usage_limited'].includes(task.status);

  useEffect(() => {
    if (isTerminalTask && showEditTaskModal) {
      setShowEditTaskModal(false);
    }
  }, [isTerminalTask]);

  const activeAgentLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const m of activityMembers) {
      if (m.state === 'active' || m.state === 'queued' || m.state === 'waiting_for_input') {
        labels.add(m.label);
      }
    }
    return labels;
  }, [activityMembers]);
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
  const hasUnifiedWorkflowThread = spaceStore.hasTaskMessageActivity(task.id) !== false;
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

  const canSendThreadMessage = !isTerminalTask && !sendingThread && composerTargets.length > 0;

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
    hookSummaries as unknown as import('../../lib/task-banner').HookBannerSummary[]
  );
  const activeBanner =
    hasWorkflowHooks && hookFetchError && _runId && resolvedBanner === null
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

  const voiceReturnTargetSession = voiceReturnTaskTargetSessionSignal.value;
  useEffect(() => {
    if (!voiceReturnTargetSession) return;
    const target = composerTargets.find(
      (t) => t.nodeExecutionSessionId === voiceReturnTargetSession
    );
    if (!target) return;
    setSelectedTargetId(target.id);
    setTargetLocked(true);
    voiceReturnTaskTargetSessionSignal.value = null;
  }, [composerTargets, voiceReturnTargetSession]);

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

  useEffect(() => {
    spaceStore.ensureNodeExecutions(task?.workflowRunId ?? null).catch(() => {});
  }, [task?.workflowRunId]);

  useEffect(() => {
    return () => {
      spaceStore.ensureNodeExecutions(null).catch(() => {});
    };
  }, []);

  const handleCanvasToggle = useCallback(() => {
    if (!canShowCanvasTab) return;
    if (activeView === 'canvas') {
      navigateToSpaceTask(navigationSpaceId, taskId, 'thread', true);
      return;
    }
    spaceStore.ensureNodeExecutions(task?.workflowRunId ?? null).catch(() => {});
    navigateToSpaceTask(navigationSpaceId, taskId, 'canvas', true);
  }, [activeView, canShowCanvasTab, navigationSpaceId, taskId]);

  const handleNodeClick = async (nodeId: string, nodeName: string, agentSlotNames: string[]) => {
    const clickGen = ++nodeClickGenRef.current;
    let wf = workflow;
    if (!wf && task.postApprovalSessionId && canvasWorkflowId) {
      wf = await spaceStore.fetchWorkflowDetail(canvasWorkflowId).catch(() => null);
      if (
        !mountedRef.current ||
        currentTaskIdRef.current !== task.id ||
        nodeClickGenRef.current !== clickGen
      )
        return;
    }
    const currentTask = taskId
      ? (spaceStore.tasks.value.find((t) => t.id === taskId) ?? null)
      : null;
    if (!currentTask) return;
    const currentActivityMembers: SpaceTaskActivityMember[] = taskId
      ? (spaceStore.taskActivity.value.get(taskId) ?? [])
      : [];
    const currentNodeExecutions = spaceStore.nodeExecutions.value;
    const clickedNode = wf?.nodes.find((n) => n.id === nodeId) ?? null;
    const slotLabel = (agentName: string): string => {
      const slot = clickedNode?.agents.find((a) => a.name === agentName) ?? null;
      const spaceAgent = slot?.agentId ? spaceAgents.find((a) => a.id === slot.agentId) : undefined;
      return spaceAgent?.name ?? formatAgentSlotLabel(agentName);
    };
    const currentWorkerMember = currentActivityMembers.find(
      (m) =>
        m.kind === 'node_agent' &&
        m.nodeExecution?.isCurrentPostApproval === true &&
        (!currentTask.postApprovalSessionId || m.sessionId === currentTask.postApprovalSessionId)
    );
    let postApprovalTargetAgent: string | null =
      currentWorkerMember?.nodeExecution?.agentName ?? null;
    if (!postApprovalTargetAgent && wf) {
      for (const node of wf.nodes) {
        const target = node.postApproval?.targetAgent;
        if (target && target !== 'task-agent') {
          postApprovalTargetAgent = target;
          break;
        }
      }
      if (!postApprovalTargetAgent) {
        const target = wf.postApproval?.targetAgent;
        if (target && target !== 'task-agent') {
          postApprovalTargetAgent = target;
        }
      }
    }
    const postApprovalNodeId =
      currentWorkerMember?.nodeExecution?.nodeId ??
      (postApprovalTargetAgent
        ? (wf?.nodes.find((n) => n.agents.some((a) => a.name === postApprovalTargetAgent))?.id ??
          null)
        : null);

    const outcome = resolveNodeClick({
      taskId: currentTask.id,
      nodeId,
      nodeName,
      agentSlotNames,
      workflowRunId: currentTask.workflowRunId,
      nodeExecutions: currentNodeExecutions,
      activityMembers: currentActivityMembers,
      postApprovalSessionId: currentTask.postApprovalSessionId,
      postApprovalTargetAgent,
      postApprovalNodeId,
      resolveLabel: slotLabel,
      normalizeSlotName: normalizeTargetName,
    });

    switch (outcome.type) {
      case 'open_session': {
        const currentIsTerminal =
          currentTask.status === 'done' ||
          currentTask.status === 'cancelled' ||
          currentTask.status === 'archived';
        const taskContext = {
          taskId: currentTask.id,
          agentName: outcome.session.agentName,
          workflowNodeId: nodeId,
          sessionId: outcome.session.sessionId,
          ...(currentIsTerminal ? { readonly: true } : {}),
          ...(outcome.session.nodeExecutionId
            ? { nodeExecutionId: outcome.session.nodeExecutionId }
            : {}),
        };
        pushOverlayHistory(
          outcome.session.sessionId,
          outcome.session.label,
          undefined,
          taskContext
        );
        return;
      }
      case 'activate_slot':
        if (
          currentTask.status === 'done' ||
          currentTask.status === 'cancelled' ||
          currentTask.status === 'archived'
        ) {
          setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: [] });
          return;
        }
        if (currentTask.postApprovalSessionId && !postApprovalNodeId) {
          setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: [] });
          return;
        }
        pushOverlayHistoryForPendingAgent(currentTask.id, outcome.agentName, outcome.nodeId);
        return;
      case 'choose':
        if (
          currentTask.status === 'done' ||
          currentTask.status === 'cancelled' ||
          currentTask.status === 'archived'
        ) {
          setNodeChoice({
            taskId: currentTask.id,
            nodeName,
            nodeId,
            choices: outcome.choices.filter((c) => c.kind === 'live'),
          });
          return;
        }
        if (currentTask.postApprovalSessionId && !postApprovalNodeId) {
          const safeChoices = outcome.choices.filter((c) => c.kind === 'live');
          setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: safeChoices });
          return;
        }
        setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: outcome.choices });
        return;
      case 'empty':
        setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: [] });
        return;
    }
  };

  const handleNodeChoiceSelect = (choice: NodeChoice) => {
    const clickedNodeId = nodeChoice?.nodeId;
    setNodeChoice(null);
    if (choice.kind === 'live') {
      const taskContext: {
        taskId: string;
        agentName: string;
        workflowNodeId?: string;
        nodeExecutionId?: string;
        sessionId?: string;
        readonly?: boolean;
      } = {
        taskId: task.id,
        agentName: choice.agentName,
        ...(isTerminalTask ? { readonly: true } : {}),
        ...(clickedNodeId ? { workflowNodeId: clickedNodeId } : {}),
        ...(choice.nodeExecutionId ? { nodeExecutionId: choice.nodeExecutionId } : {}),
      };
      let liveSessionId: string;
      if (choice.nodeExecutionId) {
        const liveExec = nodeExecutions.find((e) => e.id === choice.nodeExecutionId);
        if (
          !liveExec?.agentSessionId ||
          liveExec.status === 'cancelled' ||
          liveExec.status === 'pending'
        )
          return;
        liveSessionId = liveExec.agentSessionId;
      } else {
        if (task.postApprovalSessionId) {
          const currentWorkerForSlot = activityMembers.find(
            (m) =>
              m.kind === 'node_agent' &&
              m.nodeExecution?.isCurrentPostApproval === true &&
              m.sessionId === task.postApprovalSessionId &&
              m.role === choice.agentName &&
              (!clickedNodeId || m.nodeExecution?.nodeId === clickedNodeId)
          );
          if (!currentWorkerForSlot) return;
          liveSessionId = task.postApprovalSessionId;
        } else if (isTerminalTask) {
          liveSessionId = choice.sessionId;
          pushOverlayHistory(liveSessionId, choice.label, undefined, {
            taskId: task.id,
            agentName: choice.agentName,
            sessionId: liveSessionId,
            readonly: true,
          });
          return;
        } else {
          return;
        }
      }
      taskContext.sessionId = liveSessionId;
      pushOverlayHistory(liveSessionId, choice.label, undefined, taskContext);
    } else {
      pushOverlayHistoryForPendingAgent(task.id, choice.agentName, choice.nodeId || clickedNodeId);
    }
  };

  const sendThreadMessage = async (
    nextMessage: string,
    target: TaskComposerTarget | null,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ): Promise<boolean> => {
    if (!nextMessage) return false;
    if (!runtimeSpaceId || !task) return false;
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
          ...(target.nodeId ? { workflowNodeId: target.nodeId } : {}),
        },
        images,
        deliveryMode
      );

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
      setSendingThread(false);
    }
  };

  const handleScrollToBottom = useCallback(() => {
    scrollToBottomRef.current?.(true);
    setAutoScrollEnabled(true);
  }, []);

  const handleStatusTransition = async (newStatus: SpaceTaskStatus) => {
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
  const filteredTransitionActions =
    task.status === 'review' || task.pendingCheckpointType === 'task_completion'
      ? allTransitionActions.filter(({ target }) => target !== 'done' && target !== 'cancelled')
      : allTransitionActions;

  const activeNodeSlots = new Set(
    activityMembers
      .filter(
        (m) =>
          m.kind === 'node_agent' &&
          m.nodeExecution?.nodeId &&
          m.nodeExecution?.status !== 'pending'
      )
      .map((m) => `${m.nodeExecution?.nodeId}|${m.role}`)
  );
  const declaredAgentSlots: Array<{ name: string; nodeName: string; nodeId: string }> = [];
  if (workflow) {
    for (const node of workflow.nodes) {
      for (const agent of node.agents) {
        if (activeNodeSlots.has(`${node.id}|${agent.name}`)) continue;
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
  const openableActivityMembers = activityMembers.filter(
    (m) => m.nodeExecution?.status !== 'pending'
  );
  const memberIsLive = (member: SpaceTaskActivityMember): boolean => {
    if (!taskAgentsLive) return false;
    if (member.kind === 'task_agent') {
      return (
        member.sessionId === task.taskAgentSessionId ||
        member.state === 'active' ||
        member.state === 'waiting_for_input' ||
        member.state === 'cooldown'
      );
    }
    if (member.nodeExecution?.status === 'cancelled') return false;
    if (member.nodeExecution?.nodeExecutionId) return true;
    return member.nodeExecution?.isCurrentPostApproval === true;
  };
  if (openableActivityMembers.length > 0) {
    taskActionItems.push(
      ...openableActivityMembers.map((member) => {
        const readOnly = isTerminalTask || !memberIsLive(member);
        return {
          label: `Open ${member.label} (${ACTIVITY_STATE_LABELS[member.state]})`,
          title: readOnly ? 'Opens read-only — resume the task to chat' : undefined,
          onClick: () => {
            pushOverlayHistory(
              member.sessionId,
              member.label,
              undefined,
              readOnly
                ? {
                    taskId: task.id,
                    agentName: member.role ?? '',
                    sessionId: member.sessionId,
                    readonly: true,
                  }
                : member.kind !== 'node_agent'
                  ? null
                  : {
                      taskId: task.id,
                      agentName: member.role,
                      sessionId: member.sessionId,
                      ...(member.nodeExecution?.nodeId
                        ? { workflowNodeId: member.nodeExecution.nodeId }
                        : {}),
                      ...(member.nodeExecution?.nodeExecutionId
                        ? { nodeExecutionId: member.nodeExecution.nodeExecutionId }
                        : {}),
                    }
            );
          },
        };
      })
    );
  }
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

      {(() => {
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
          ) : (
            <PendingHookBanner
              runId={banner.runId}
              spaceId={runtimeSpaceId}
              workflowId={canvasWorkflowId}
              summaries={hookSummaries}
              fetchError={hookFetchError}
              retry={retryHookFetch}
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
                  overlayTaskReadonly={!taskAgentsLive}
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
                <div class="h-full overflow-y-auto" data-testid="task-info-view">
                  <div class="mx-auto max-w-2xl space-y-4 px-4 py-6">
                    <SectionCard title="Description">
                      {task.description ? (
                        <p class="whitespace-pre-wrap text-sm text-gray-300">{task.description}</p>
                      ) : (
                        <p class="text-sm text-gray-500">No description yet.</p>
                      )}
                    </SectionCard>
                    <SectionCard title="Details">
                      <TaskInfoRow label="Status">{STATUS_LABELS[task.status]}</TaskInfoRow>
                      <TaskInfoRow label="Priority">
                        {PRIORITY_LABELS[task.priority]} Priority
                      </TaskInfoRow>
                      <TaskInfoRow label="Created">
                        {formatTaskTimestamp(task.createdAt)}
                      </TaskInfoRow>
                      <TaskInfoRow label="Workflow">
                        {workflow?.name ?? preferredWorkflowName ?? 'Auto-select'}
                      </TaskInfoRow>
                      {workflowRun && (
                        <TaskInfoRow label="Run status">
                          {getWorkflowRunExecutionStatusLabel(workflowRun.status)}
                        </TaskInfoRow>
                      )}
                    </SectionCard>
                    <p class="text-center text-xs text-gray-500" data-testid="task-info-view-hint">
                      This task has no agent activity yet.
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
              <VoiceSurfaceContext.Provider
                value={{
                  surfaceId: 'primary',
                  spaceId: spaceId ?? null,
                  taskId: task.id,
                }}
              >
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
              </VoiceSurfaceContext.Provider>
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
        isOpen={nodeChoice !== null && nodeChoice.taskId === taskId}
        nodeName={nodeChoice?.nodeName ?? ''}
        choices={nodeChoice?.choices ?? []}
        onSelect={handleNodeChoiceSelect}
        onClose={() => setNodeChoice(null)}
      />
    </div>
  );
}
