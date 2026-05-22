import {
	isWorkflowRecoveryTransition,
	type MessageImage,
	type SpaceTaskActivityMember,
	type SpaceTaskActivityState,
	type SpaceTaskPriority,
	type SpaceTaskStatus,
} from '@neokai/shared';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { TaskComposerTarget } from '../../hooks';
import { borderColors } from '../../lib/design-tokens';
import {
	navigateToSpaceTask,
	pushOverlayHistory,
	pushOverlayHistoryForPendingAgent,
} from '../../lib/router';
import {
	currentSpaceIdSignal,
	currentSpaceTaskViewTabSignal,
	rightPanelTargetSignal,
} from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { resolveActiveTaskBanner } from '../../lib/task-banner.ts';
import { cn } from '../../lib/utils';
import { ScrollToBottomButton } from '../ScrollToBottomButton';
import { Dropdown, type DropdownMenuItem } from '../ui/Dropdown';
import { EditTaskModal } from './EditTaskModal';
import { PendingGateBanner } from './PendingGateBanner';
import { PendingPostApprovalBanner } from './PendingPostApprovalBanner';
import { PendingTaskCompletionBanner } from './PendingTaskCompletionBanner';
import { ReadOnlyWorkflowCanvas } from './ReadOnlyWorkflowCanvas';
import { SpaceTaskUnifiedThread } from './SpaceTaskUnifiedThread';
import { SubmitForReviewModal } from './SubmitForReviewModal';
import { TaskBlockedBanner } from './TaskBlockedBanner';
import { TaskCanvasToggleButton, TaskSessionChatComposer } from './TaskSessionChatComposer';
import { getTransitionActions } from './TaskStatusActions';
import { useRunGateSummaries } from './use-run-gate-summaries.ts';

interface SpaceTaskPaneProps {
	taskId: string | null;
	spaceId?: string;
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

const STATUS_BADGE_CLASSES: Record<SpaceTaskStatus, string> = {
	draft: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
	open: 'border-gray-500/30 bg-gray-500/10 text-gray-300',
	in_progress: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
	review: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
	approved: 'border-green-500/30 bg-green-500/10 text-green-300',
	done: 'border-green-500/25 bg-green-500/10 text-green-400',
	blocked: 'border-red-500/30 bg-red-500/10 text-red-300',
	cancelled: 'border-gray-500/25 bg-gray-500/10 text-gray-500',
	archived: 'border-gray-500/25 bg-gray-500/10 text-gray-500',
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

export function SpaceTaskPane({ taskId, spaceId, onClose }: SpaceTaskPaneProps) {
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
	const [fullWorkflow, setFullWorkflow] = useState<import('@neokai/shared').SpaceWorkflow | null>(
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

	if (!taskId) {
		return (
			<div class="flex items-center justify-center h-full p-6">
				<p class="text-sm text-gray-600 text-center">Select a task to view details</p>
			</div>
		);
	}

	if (!task) {
		return (
			<div class="flex items-center justify-center h-full p-6">
				<p class="text-sm text-gray-600 text-center">Task not found</p>
			</div>
		);
	}

	const runtimeSpaceId = spaceId ?? task.spaceId;
	const navigationSpaceId = spaceId ?? currentSpaceIdSignal.value ?? task.spaceId;
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
		rightPanelTargetSignal.value = {
			type: 'task',
			spaceId: navigationSpaceId,
			taskId: task.id,
			tab: auxiliaryPanelTab,
		};
		navigateToSpaceTask(navigationSpaceId, task.id, 'thread', true);
	}, [auxiliaryPanelTab, navigationSpaceId, task.id, task.workflowRunId]);

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
	const canShowCanvasTab = !!task.workflowRunId && !!canvasWorkflowId;
	const activitySummary = STATUS_LABELS[task.status];
	const activeBanner = resolveActiveTaskBanner(task, gateSummaries);
	const showHeaderStatusBadge = activeBanner === null;
	const agentActionLabel =
		task.activeSession === 'leader'
			? 'View Leader Session'
			: task.activeSession === 'worker'
				? 'View Worker Session'
				: agentSessionId
					? 'View Agent Session'
					: 'Open Coordinator';
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

	const handleCanvasToggle = useCallback(() => {
		if (!canShowCanvasTab) return;
		if (activeView === 'canvas') {
			navigateToSpaceTask(navigationSpaceId, taskId, 'thread', true);
			return;
		}
		spaceStore.ensureNodeExecutions().catch(() => {});
		navigateToSpaceTask(navigationSpaceId, taskId, 'canvas', true);
	}, [activeView, canShowCanvasTab, navigationSpaceId, taskId]);

	const handleNodeClick = (_nodeId: string, _nodeName: string, _agentSlotNames: string[]) => {
		// Match against activity member roles (slot names like “reviewer”, “coder”).
		// m.role is the agent slot name stored in the DB and directly corresponds to _agentSlotNames.
		// For multi-agent nodes, returns the first matching member.
		const nodeMember = activityMembers.find(
			(m) => m.kind === 'node_agent' && _agentSlotNames.includes(m.role)
		);
		if (nodeMember) {
			pushOverlayHistory(nodeMember.sessionId, nodeMember.label, undefined, {
				taskId: task.id,
				agentName: nodeMember.role,
				...(nodeMember.nodeExecution?.nodeExecutionId
					? { nodeExecutionId: nodeMember.nodeExecution.nodeExecutionId }
					: {}),
			});
			return;
		}

		// Last resort: use the task’s own agentSessionId
		if (agentSessionId) {
			pushOverlayHistory(agentSessionId, agentActionLabel);
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
				await spaceStore.updateTask(task.id, { status: newStatus });
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
			priority: import('@neokai/shared').SpaceTaskPriority;
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
	const declaredAgentSlots: Array<{ name: string; nodeName: string }> = [];
	if (workflow) {
		for (const node of workflow.nodes) {
			for (const agent of node.agents) {
				if (activityRoles.has(agent.name)) continue;
				declaredAgentSlots.push({ name: agent.name, nodeName: node.name });
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
					pushOverlayHistoryForPendingAgent(task.id, slot.name);
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
								<TaskMetaBadge class={cn(STATUS_BADGE_CLASSES[task.status])}>
									<span data-testid="task-status-label">{activitySummary}</span>
								</TaskMetaBadge>
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
				//   blocked > post_approval_blocked > task_completion_pending > gate_pending
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
						// gate_pending — PendingGateBanner renders rows for every
						// waiting gate on the run.
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
					>
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
										<p class="mt-2 text-xs text-gray-500">
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
		</div>
	);
}
