import {
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
  // Monotonic counter bumped on every node click so an async handleNodeClick
  // continuation can detect that a newer click superseded it (not just a task
  // switch) and bail before overwriting the newer node's result.
  const nodeClickGenRef = useRef(0);
  // Cleared on unmount so an async handleNodeClick continuation (the
  // workflow-detail fetch) can't push overlay state after the pane is gone.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
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

  // Resolve runId/workflowId here (before the early returns) so the hook-state
  // hook is always called — React's Rules of Hooks require a stable call order.
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
    // The durable node the post-approval worker spawns on — the node DECLARING
    // the target agent slot (spawnPostApprovalSubSession scans for that slot),
    // NOT task.postApprovalSourceNodeId (the SUBMITTER node, which may differ).
    // Mirrors handleNodeClick's postApprovalNodeId: prefer the current worker
    // member's nodeId, else the workflow node whose agents include the route's
    // target agent.
    const composerWorkerMember = activityMembers.find(
      (m) =>
        m.kind === 'node_agent' &&
        m.nodeExecution?.isCurrentPostApproval === true &&
        // Durable cross-check (mirrors handleNodeClick's currentWorkerMember):
        // a snapshot-lagging W1 must not supply the durable worker node while
        // postApprovalSessionId already points at W2.
        (!task.postApprovalSessionId || m.sessionId === task.postApprovalSessionId)
    );
    let composerPostApprovalTarget: string | null =
      // Prefer the current worker member's own slot name (mirrors handleNodeClick)
      // so the durable fallback works even when the workflow detail isn't loaded
      // and survives a post-spawn route edit (provenanceName != new targetAgent).
      composerWorkerMember?.nodeExecution?.agentName ?? null;
    // Fall back to the workflow route ONLY when no durable member identity is
    // available — an unconditional overwrite would let an edited route rename
    // the target and strip the actual worker slot of its durable protection.
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
          // EXACT name match when the member has execution identity (mirrors
          // resolveTargetSessionId) so separator-distinct siblings (qa / qa_one)
          // don't collide; normalized matching only for role-only members.
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
                // Durable cross-check: a lagging W1 must not claim its old slot
                // while postApprovalSessionId already points at W2.
                (!task.postApprovalSessionId || m.sessionId === task.postApprovalSessionId)
            ) ??
            // Fallback to a NON-worker member; a stale current W1 (session !=
            // durable) must NOT be trusted — matchingMembers[0] could select it
            // and its isCurrentPostApproval flag would drop the old slot's pin.
            matchingMembers.find((m) => m.nodeExecution?.isCurrentPostApproval !== true) ??
            null;
          // nodeExecutions is ORDER BY created_at ASC; the NEWEST matching
          // execution is authoritative (mirror the daemon's .at(-1) reuse
          // path). Exclude cancelled/pending residue rows that retain a dead
          // agentSessionId.
          const nodeExecution =
            task.workflowRunId && node.id
              ? (nodeExecutions
                  .filter(
                    (execution) =>
                      execution.workflowRunId === task.workflowRunId &&
                      execution.workflowNodeId === node.id &&
                      execution.status !== 'cancelled' &&
                      execution.status !== 'pending' &&
                      // EXACT slot name (mirrors the resolver) so separator-
                      // distinct siblings (qa-one / qa_one) don't cross-bind.
                      execution.agentName === agent.name
                  )
                  .at(-1) ?? null)
              : null;
          const spaceAgent = spaceAgents.find((a) => a.id === agent.agentId) ?? null;
          // When the current post-approval worker owns this node+slot, the
          // slot's live identity is the execution-less worker — NOT the stale
          // ordinary node_execution row a review-then-merge slot may also
          // carry. Drop the execution pin so the composer's model/thinking/
          // context and sendThreadMessage route to the worker (via
          // matchesPostApproval) instead of the ordinary session. The durable
          // postApprovalSessionId is carried as nodeExecutionSessionId so the
          // binding path (resolveTargetSessionId) can prefer it over a lagging
          // snapshot.
          // workerOwnsSlot must survive an activity snapshot gap: derive it
          // from the DURABLE post-approval signal (this node is the worker's
          // DECLARING node — durableWorkerNodeId — AND a worker session exists)
          // in addition to the transient member flag. Without this, a resnapshot
          // that briefly omits the worker member flips it false and the composer
          // regains the stale ordinary execution pin, routing sends to the
          // ordinary session instead of the worker.
          const durableWorkerNode = durableWorkerNodeId === node.id && !!task.postApprovalSessionId;
          // The durable fallback applies ONLY to the worker's OWN target slot —
          // the declared slot whose name equals the post-approval target agent.
          // (member.role === agent.name was trivially true for every populated
          // slot on the worker's node, hijacking live siblings like coder on a
          // merger node and routing their sends to the merger.)
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

    // Fallback: when the workflow definition is unavailable (async fetch race,
    // deleted/renamed workflow, stale run metadata), derive targets from live
    // activity members so the composer still works against running agents.
    const fallbackTargets: TaskComposerTarget[] = [];
    if (nodeTargets.length === 0 && activityMembers.length > 0) {
      const seen = new Set<string>();
      for (const m of activityMembers) {
        if (m.kind !== 'node_agent' || !m.role) continue;
        // Exclude cancelled / pending-with-retained-session members (dead
        // session) — advertising one would route sends into a session the
        // daemon's route filter won't inject into.
        if (m.nodeExecution?.status === 'cancelled' || m.nodeExecution?.status === 'pending')
          continue;
        const name = normalizeTargetName(m.role);
        if (seen.has(name)) continue;
        // Prefer the durable-current worker over a historical W1 that may have a
        // newer updatedAt (W1 encountered first would otherwise be kept while
        // sends route to W2).
        const preferred =
          m.nodeExecution?.isCurrentPostApproval === true &&
          (!task.postApprovalSessionId || m.sessionId === task.postApprovalSessionId)
            ? m
            : (activityMembers.find(
                (other) =>
                  other.kind === 'node_agent' &&
                  normalizeTargetName(other.role ?? '') === name &&
                  other.nodeExecution?.isCurrentPostApproval === true &&
                  // Durable cross-check: a lagging W1 must not be preferred
                  // while postApprovalSessionId already points at W2.
                  (!task.postApprovalSessionId || other.sessionId === task.postApprovalSessionId)
              ) ?? m);
        seen.add(name);
        // When the chosen member is flagged isCurrentPostApproval but its
        // session differs from the durable pointer (snapshot-lag W1 while the
        // durable is W2), DROP its nodeExecutionId — the pinned id would defeat
        // both resolveTargetSessionId's durable override and the daemon's
        // matchesPostApproval, pinning display+send to W1. With no execution
        // pin, the durable session carry below dominates.
        // When the only member for this role is a snapshot-lagging W1 (flagged
        // current but session != durable W2), WITHHOLD the target entirely —
        // pairing W2's session with W1's node/role would send a provenance that
        // the daemon rejects (or that lazy-activates the wrong ordinary slot).
        // Wait for W2's provenance to arrive instead of offering a broken target.
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
          // For the current worker, carry the DURABLE pointer so
          // resolveTargetSessionId's durable override fires even on this
          // degraded path (a transient W1 id would otherwise let the composer
          // bind W1 while sends route to W2).
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

  // The global recording chip asked this task thread to restore a specific
  // recipient (the target whose session owns the recording). Select + lock it
  // once its target row is present, then clear the request so a later mount
  // does not re-select a stale target.
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

  // Ensure node-execution liveness is loaded for thread-view workflow tasks, not
  // only when the canvas is toggled. The composer target's nodeExecutionSessionId
  // (the execution's live agentSessionId) is derived from this; without it the
  // session latch can't detect a detached worker, so opening a task directly in
  // thread would leave a stale session latched.
  // Passing null (standalone task / no task) tears down any prior run's
  // subscription so only the open task's run — if any — stays live.
  useEffect(() => {
    spaceStore.ensureNodeExecutions(task?.workflowRunId ?? null).catch(() => {});
  }, [task?.workflowRunId]);

  // Release the node-execution subscription when the pane unmounts (closing the
  // pane or navigating to another view in the same space) so no run keeps
  // streaming with no open task. Empty deps → cleanup runs only on unmount, not
  // on every task switch (the [workflowRunId] effect above handles rescoping).
  // ensureNodeExecutions(null) is a safe no-op when nothing is active.
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
    // Resolve the clicked node STRICTLY by its persisted node ID + declared
    // agent slot identity — never falling back to another node's session. The
    // previous "last resort: use the task's own agentSessionId" fallback was
    // the root cause of clicking an unstarted node B opening node A's chat.
    // See lib/node-click-resolver.ts for the full decision table.
    //
    // The canvas can become interactive before this pane's async fullWorkflow
    // fetch resolves. For ordinary node clicks that's fine (the resolver falls
    // back to live-member/node-execution identity), but the spawned merger
    // session (task.postApprovalSessionId) is only identifiable once we know
    // the post-approval route, which comes from the workflow. So when a merger
    // might be involved and the detail isn't loaded yet, fetch it before
    // resolving — otherwise a merger click would resolve as an unstarted slot
    // and a follow-up send could spawn a duplicate ordinary merger session.
    // Gated on postApprovalSessionId so ordinary clicks stay synchronous.
    const clickGen = ++nodeClickGenRef.current;
    let wf = workflow;
    if (!wf && task.postApprovalSessionId && canvasWorkflowId) {
      wf = await spaceStore.fetchWorkflowDetail(canvasWorkflowId).catch(() => null);
      // The await may have spanned a task switch, another node click, OR an
      // unmount; bail if the user has moved on so a slow fetch can't complete
      // an obsolete click or push overlay state after unmount.
      if (
        !mountedRef.current ||
        currentTaskIdRef.current !== task.id ||
        nodeClickGenRef.current !== clickGen
      )
        return;
    }
    // Re-read reactive values from the CURRENT store/refs after the await — the
    // render-time closure captured `task`, `activityMembers`, `nodeExecutions`
    // which may have been superseded by a reactive rebind during the fetch.
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
      // Exact match (the resolver/labels preserve separator-distinct slots):
      // normalizing would collapse qa-one / qa_one onto the first slot.
      const slot = clickedNode?.agents.find((a) => a.name === agentName) ?? null;
      const spaceAgent = slot?.agentId ? spaceAgents.find((a) => a.id === slot.agentId) : undefined;
      return spaceAgent?.name ?? formatAgentSlotLabel(agentName);
    };
    // Agent the workflow's post-approval route targets (e.g. 'merger'). The
    // spawned merger session carries no node_execution row, so its identity is
    // tied to this slot via task.postApprovalSessionId inside the resolver.
    // Mirror collectPostApprovalRoutes: prefer node-level routes, then fall
    // back to the legacy workflow-level route for persisted workflows that
    // predate node-level post-approval.
    // Prefer the durable post-approval worker identity from the current
    // activity member (agentName + nodeId captured at spawn) over the mutable
    // workflow route — re-deriving from `wf` would send a stale/edited name
    // while the daemon knows the worker by its provenance name, breaking
    // matchesPostApproval and misrouting the reply.
    const currentWorkerMember = currentActivityMembers.find(
      (m) =>
        m.kind === 'node_agent' &&
        m.nodeExecution?.isCurrentPostApproval === true &&
        // Accept the member only when its session matches the DURABLE pointer —
        // a snapshot-lagging member (W1) for a task whose postApprovalSessionId
        // already advanced to W2 would otherwise open W2 with W1's node/agent
        // context. Withhold until the matching activity identity arrives.
        // Compare against the REFRESHED task pointer (currentTask), not the
        // render-time task — the await may have spanned a W1→W2 advance.
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
    // Resolve the node that actually declares the post-approval target slot —
    // the node the merger session was spawned for. Binding postApprovalSessionId
    // to this exact node ID prevents multiple same-named nodes from each opening
    // the singular merger session. Prefer the durable node on the current
    // worker's activity member; fall back to the workflow, matching the spawn
    // path exactly (slot.name === targetAgent) so separator-distinct slots
    // (qa_one / qa-one) aren't collapsed.
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
        // Route overlay sends through space.task.sendMessage so the daemon
        // restores + delivers to the right session. For a real node-execution
        // session the execution id selects it directly; for the execution-less
        // post-approval merger (no nodeExecutionId) the handler's
        // matchesPostApproval path resolves the worker via
        // getPostApprovalWorkerSession and calls restorePostApprovalWorkerSession
        // before delivery — so a post-restart merger reply still reaches the
        // worker with its node-agent tools. workflowNodeId keeps both paths
        // node-scoped.
        // Use the REFRESHED task (post-await) for the terminal check — the
        // task may transition to done/cancelled while the workflow fetch was
        // in flight, and a historical session must open read-only.
        const currentIsTerminal =
          currentTask.status === 'done' ||
          currentTask.status === 'cancelled' ||
          currentTask.status === 'archived';
        const taskContext = {
          taskId: currentTask.id,
          agentName: outcome.session.agentName,
          workflowNodeId: nodeId,
          sessionId: outcome.session.sessionId,
          // A terminal task's canvas session is historical — open read-only.
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
        // On a TERMINAL task, an unstarted slot can never activate (the daemon
        // rejects terminal tasks) — don't offer a pending composer that only
        // errors. Show the empty state instead.
        if (
          currentTask.status === 'done' ||
          currentTask.status === 'cancelled' ||
          currentTask.status === 'archived'
        ) {
          setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: [] });
          return;
        }
        // If a merger exists (postApprovalSessionId) but its node identity
        // couldn't be resolved (no durable worker member AND no workflow
        // detail), do NOT activate — activating a merger node without identity
        // would spawn a duplicate ordinary merger session. Gate on identity
        // availability (postApprovalNodeId), not on wf alone — durable worker
        // identity can exist without wf, so !wf would wrongly block an
        // unrelated unstarted node's activation until the fetch recovers.
        if (currentTask.postApprovalSessionId && !postApprovalNodeId) {
          setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: [] });
          return;
        }
        // Unstarted single-slot node: open its OWN pending-agent overlay,
        // carrying the node ID so the first message activates only this node
        // (not another node that reuses the same slot name).
        pushOverlayHistoryForPendingAgent(currentTask.id, outcome.agentName, outcome.nodeId);
        return;
      case 'choose':
        // On a TERMINAL task, pending choices can never activate (the daemon
        // rejects terminal tasks) — withhold them; live choices stay (read-only).
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
        // Same identity-unavailability guard as activate_slot (postApprovalNodeId,
        // not wf): don't offer pending choices that could activate a duplicate
        // merger when identity is unavailable. Preserve live choices — they
        // can't activate a duplicate and may belong to an unrelated node.
        if (currentTask.postApprovalSessionId && !postApprovalNodeId) {
          const safeChoices = outcome.choices.filter((c) => c.kind === 'live');
          setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: safeChoices });
          return;
        }
        // Multi-agent node (several live) or multi-slot unstarted node: let
        // the user pick rather than silently selecting an arbitrary slot.
        setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: outcome.choices });
        return;
      case 'empty':
        // Zero-agent node: present a clear empty state, no fallback.
        setNodeChoice({ taskId: currentTask.id, nodeName, nodeId, choices: [] });
        return;
    }
  };

  const handleNodeChoiceSelect = (choice: NodeChoice) => {
    // All choices belong to the one node the overlay was opened for; capture
    // its ID before clearing so the live branch can scope routing to it.
    const clickedNodeId = nodeChoice?.nodeId;
    setNodeChoice(null);
    if (choice.kind === 'live') {
      // Mirror open_session: always route through space.task.sendMessage so a
      // live execution-less post-approval worker (no nodeExecutionId) is
      // restored + delivered via matchesPostApproval, and a real node-execution
      // choice is selected by id. workflowNodeId keeps both node-scoped.
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
        // On a terminal task, an execution-backed live choice is historical —
        // open read-only so a send can't inject into the completed worker.
        ...(isTerminalTask ? { readonly: true } : {}),
        ...(clickedNodeId ? { workflowNodeId: clickedNodeId } : {}),
        ...(choice.nodeExecutionId ? { nodeExecutionId: choice.nodeExecutionId } : {}),
      };
      // sessionId is set below after revalidation and merged into taskContext.
      // Revalidate the session id at selection time: nodeChoice.choices is
      // snapshotted at click time, so an execution that rebinds while the modal
      // is open (restart/recovery/spawn) would otherwise open a stale session.
      // For an execution-backed choice, require a CURRENT live agentSessionId —
      // if the execution is now detached/removed (null session), do NOT fall
      // back to the stale snapshot (the modal is already closed; the user can
      // re-click for fresh choices). The snapshot fallback is kept ONLY for
      // execution-less merger choices (no nodeExecutionId), whose session id is
      // the durable postApprovalSessionId.
      let liveSessionId: string;
      if (choice.nodeExecutionId) {
        const liveExec = nodeExecutions.find((e) => e.id === choice.nodeExecutionId);
        // A cancelled / pending-with-retained-session execution retains its stale
        // agentSessionId (resetWorkflowNodeExecutionForSpawnRetry keeps it) —
        // don't open it; the daemon could rehydrate/inject into the failed
        // session while the pending execution is still eligible to spawn a
        // replacement.
        if (
          !liveExec?.agentSessionId ||
          liveExec.status === 'cancelled' ||
          liveExec.status === 'pending'
        )
          return;
        liveSessionId = liveExec.agentSessionId;
      } else {
        // Execution-less (merger) choice. If the current pointer is set, use it
        // (a W1→W2 swap while the modal was open must not open the stale W1
        // snapshot — it would diverge from where sends route). If the pointer is
        // cleared on a TERMINAL task (worker completed / task done), the
        // historical workers are still viewable read-only — open the choice's
        // snapshot. On a non-terminal task a cleared pointer mid-flow is stale —
        // reject.
        if (task.postApprovalSessionId) {
          // The current worker (W2) substituted for the snapshotted W1 must
          // still belong to the CHOSEN node+slot — otherwise the overlay would
          // display W2 under W1's identity and sends would fail provenance.
          // Find the current worker member at the clicked node with this slot's
          // role; if none, the W1→W2 swap moved the worker elsewhere — close
          // the stale chooser.
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
          // Historical worker on a terminal task: open it with an explicit
          // readonly marker (no send override / composer) — the daemon would
          // otherwise restore + inject into the completed worker.
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
        images,
        deliveryMode
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
    task.status === 'review' || task.pendingCheckpointType === 'task_completion'
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
  // Key liveness by (nodeId, agentName) so two nodes reusing a slot name are
  // tracked independently — otherwise node A's live 'reviewer' would hide node
  // B's unstarted 'reviewer' from the pending dropdown.
  const activeNodeSlots = new Set(
    activityMembers
      .filter(
        (m) =>
          m.kind === 'node_agent' &&
          m.nodeExecution?.nodeId &&
          // Exclude cancelled / pending-with-retained-session rows so a dead
          // slot doesn't suppress its workflow-declared pending-activation
          // entry.
          m.nodeExecution?.status !== 'cancelled' &&
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
    (m) =>
      // Exclude cancelled / pending-with-retained-session rows — their dead
      // agentSessionId would pin a session the daemon's route filter (now
      // excluding cancelled/pending) won't inject into, so a send would fall
      // through to lazy-activation and spawn a fresh session (divergence).
      m.nodeExecution?.status !== 'cancelled' && m.nodeExecution?.status !== 'pending'
  );
  if (openableActivityMembers.length > 0) {
    taskActionItems.push(
      ...openableActivityMembers.map((member) => ({
        label: `Open ${member.label} (${ACTIVITY_STATE_LABELS[member.state]})`,
        onClick: () => {
          pushOverlayHistory(
            member.sessionId,
            member.label,
            undefined,
            // On a TERMINAL task, open historical members READ-ONLY (explicit
            // readonly marker) — a live context would keep the composer active
            // and inject into the completed worker. Non-node members (Task
            // Agent / Space Agent) on an ACTIVE task route via the generic
            // contextless message.send path, not the workflow node-agent
            // sender (space.task.sendMessage only resolves node agents).
            isTerminalTask
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
                    // Pin the displayed session + node scope so a superseded
                    // worker (W1 after W2) opens/sends to ITS OWN session (via
                    // the daemon's hint path) instead of the current worker.
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
        //   blocked > post_approval_blocked > task_completion_pending > hook_pending
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
          ) : (
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
