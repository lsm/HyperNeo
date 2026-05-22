import type {
	NodeExecution,
	SpaceTask,
	SpaceTaskPriority,
	SpaceTaskStatus,
	SpaceWorkflow,
	WorkflowNode,
	WorkflowNodeAgent,
} from '@neokai/shared';
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
import { cn } from '../../lib/utils';
import { TaskArtifactsPanel } from './TaskArtifactsPanel';
import { TaskTimelineFeed } from './TaskTimelineFeed';
import { WorkflowExecutionLogFeed } from './WorkflowExecutionLogFeed';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect';

interface TaskAuxiliaryPanelProps {
	spaceId: string;
	taskId: string;
	tab?: TaskRightPanelTab;
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

const TASK_PANEL_TABS: Array<{ id: TaskRightPanelTab; label: string; needsRun?: boolean }> = [
	{ id: 'details', label: 'Details' },
	{ id: 'workflow', label: 'Workflow' },
	{ id: 'agents', label: 'Agents' },
	{ id: 'gates', label: 'Gates', needsRun: true },
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

function PanelSection({ title, children }: { title: string; children: ComponentChildren }) {
	return (
		<section class="rounded-xl border border-white/10 bg-dark-900/50 p-4">
			<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
			<div class="mt-3 space-y-3">{children}</div>
		</section>
	);
}

function DetailRow({ label, children }: { label: string; children: ComponentChildren }) {
	return (
		<div class="flex items-start justify-between gap-3 text-sm">
			<span class="text-gray-500">{label}</span>
			<span class="min-w-0 text-right text-gray-200">{children}</span>
		</div>
	);
}

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

function formatTime(timestamp: number | null | undefined): string {
	if (!timestamp) return '—';
	return new Date(timestamp).toLocaleString();
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

function formatSchedule(schedule: {
	cronExpression?: string | null;
	timezone?: string;
	runAt?: number | null;
}) {
	if (schedule.cronExpression) return `${schedule.cronExpression} (${schedule.timezone})`;
	return formatTime(schedule.runAt);
}

function WorkflowStepCard({
	node,
	index,
	executions,
}: {
	node: WorkflowNode;
	index: number;
	executions: NodeExecution[];
}) {
	return (
		<div class="rounded-lg border border-white/10 bg-dark-800/60 p-3">
			<div class="flex items-center justify-between gap-3">
				<span class="text-sm font-medium text-gray-200">
					{index + 1}. {node.name}
				</span>
				<span class="text-xs text-gray-500">{executions[0]?.status ?? 'pending'}</span>
			</div>
			<div class="mt-2 text-xs text-gray-500">
				{node.agents.map((agent) => agent.name).join(', ')}
			</div>
		</div>
	);
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
					<div class="truncate text-xs text-gray-500">{node.name}</div>
				</div>
				<TaskPanelBadge class="border-white/10 bg-dark-900/70 text-gray-300">
					{execution?.status ?? 'Not started'}
				</TaskPanelBadge>
			</div>
			{locked ? (
				<DetailRow label="Model">
					<span class="font-mono text-xs">{effectiveModel}</span>
				</DetailRow>
			) : (
				<div>
					<label class="mb-1 block text-xs text-gray-500">Model override</label>
					<WorkflowModelSelect
						value={task.workflowModelOverrides?.[key]}
						onChange={(value) => onModelChange(node.id, agent.name, value)}
						testId={`task-agent-model-${node.id}-${agent.name}`}
						className="w-full rounded border border-dark-600 bg-dark-900 px-2 py-1.5 text-xs text-gray-200 disabled:opacity-50"
					/>
					<div class="mt-1 text-[11px] text-gray-600">
						Default: {agent.model ?? spaceDefaultModel ?? 'Space default'}
						{savingOverrideKey === key ? ' · Saving…' : ''}
					</div>
				</div>
			)}
			{agent.customPrompt?.value && (
				<p class="line-clamp-3 text-xs text-gray-500">{agent.customPrompt.value}</p>
			)}
		</div>
	);
}

function GateCard({ gate }: { gate: NonNullable<SpaceWorkflow['gates']>[number] }) {
	return (
		<div class="rounded-lg border border-white/10 bg-dark-800/60 p-3">
			<div class="text-sm font-medium text-gray-200">{gate.label ?? gate.id}</div>
			{gate.description && <div class="mt-1 text-xs text-gray-500">{gate.description}</div>}
			<div class="mt-2 text-xs text-gray-600">
				Required autonomy: {gate.requiredLevel ?? 'validation only'}
			</div>
		</div>
	);
}

export function TaskAuxiliaryPanel({ spaceId, taskId, tab }: TaskAuxiliaryPanelProps) {
	const task = spaceStore.tasks.value.find((item) => item.id === taskId) ?? null;
	const space = spaceStore.space.value;
	const workflowRun = task?.workflowRunId
		? (spaceStore.workflowRuns.value.find((run) => run.id === task.workflowRunId) ?? null)
		: null;
	const workflowId = workflowRun?.workflowId ?? task?.preferredWorkflowId ?? null;
	const workflowSummary = workflowId
		? (spaceStore.workflows.value.find((item) => item.id === workflowId) ?? null)
		: null;
	const [workflow, setWorkflow] = useState<SpaceWorkflow | null>(null);
	const [scopeName, setScopeName] = useState<string | null>(null);
	const [savingOverrideKey, setSavingOverrideKey] = useState<string | null>(null);
	const [overrideError, setOverrideError] = useState<string | null>(null);
	const pendingOverridesRef = useRef<Record<string, string> | null>(null);
	const tabs = task ? availableTabs(task) : [];
	const activeTab = task ? normalizeTab(task, tab) : 'timeline';

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
		spaceStore.fetchWorkflowDetail(workflowId).then((nextWorkflow) => {
			if (!cancelled) setWorkflow(nextWorkflow);
		});
		return () => {
			cancelled = true;
		};
	}, [workflowId]);

	useEffect(() => {
		pendingOverridesRef.current = task?.workflowModelOverrides ?? null;
	}, [task?.id, task?.workflowModelOverrides]);

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
			<div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500">
				Task not found
			</div>
		);
	}

	const selectTab = (nextTab: TaskRightPanelTab) => {
		rightPanelTargetSignal.value = { type: 'task', spaceId, taskId, tab: nextTab };
	};
	const goal = task.goalId
		? (spaceStore.goals.value.find((item) => item.id === task.goalId) ?? null)
		: null;
	const schedule = task.createdByTaskScheduleId
		? (spaceStore.schedules.value.find((item) => item.id === task.createdByTaskScheduleId) ?? null)
		: null;
	const nodeExecutions = spaceStore.nodeExecutions.value;
	const canEditModels = !task.workflowRunId && !task.startedAt && task.status === 'open';
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
			setOverrideError(err instanceof Error ? err.message : 'Failed to save model override');
		} finally {
			setSavingOverrideKey(null);
		}
	};

	return (
		<div class="flex h-full min-w-0 flex-col overflow-hidden">
			<div class="relative flex h-[88px] flex-col justify-center bg-dark-900/30 px-5">
				{/* pr-12 keeps labels clear of the floating right-panel toggle. */}
				<div class="pr-12">
					<h2 class="truncate text-base font-semibold leading-6 text-gray-100">{task.title}</h2>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<TaskPanelBadge class="min-w-16 justify-center border-dark-600 bg-dark-800/60 font-mono text-gray-300 tabular-nums">
							#{task.taskNumber}
						</TaskPanelBadge>
						<TaskPanelBadge class={STATUS_BADGE_CLASSES[task.status]}>
							{STATUS_LABELS[task.status]}
						</TaskPanelBadge>
						<TaskPanelBadge class={PRIORITY_BADGE_CLASSES[task.priority]}>
							{PRIORITY_LABELS[task.priority]} Priority
						</TaskPanelBadge>
					</div>
				</div>
				<div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
			</div>

			<div class="px-3 pb-3 pt-3">
				<div class="grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-dark-900/70 p-1">
					{TASK_PANEL_TABS.filter((item) => tabs.includes(item.id)).map((item) => (
						<button
							key={item.id}
							type="button"
							onClick={() => selectTab(item.id)}
							class={cn(
								'min-w-0 rounded-md px-2 py-1.5 text-center text-xs font-medium transition-colors',
								activeTab === item.id
									? 'bg-dark-700 text-gray-100 shadow-sm'
									: 'text-gray-500 hover:bg-white/5 hover:text-gray-300'
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
					<div class="h-full space-y-4 overflow-y-auto px-4 pb-6">
						<PanelSection title="Task setup">
							<DetailRow label="Status">{STATUS_LABELS[task.status]}</DetailRow>
							<DetailRow label="Priority">{PRIORITY_LABELS[task.priority]}</DetailRow>
							<DetailRow label="Created">{formatTime(task.createdAt)}</DetailRow>
							<DetailRow label="Started">{formatTime(task.startedAt)}</DetailRow>
							<DetailRow label="Completed">{formatTime(task.completedAt)}</DetailRow>
						</PanelSection>
						<PanelSection title="Context links">
							<DetailRow label="Goal">
								{goal ? (
									<button
										type="button"
										onClick={() => {
											currentSpaceGoalIdSignal.value = goal.id;
											navigateToSpaceGoals(spaceId);
										}}
										class="truncate text-blue-300 hover:text-blue-200"
									>
										{goal.title}
									</button>
								) : (
									'—'
								)}
							</DetailRow>
							<DetailRow label="Forge scope">
								{task.evolutionScopeId ? (
									<button
										type="button"
										onClick={() => {
											currentSpaceScopeIdSignal.value = task.evolutionScopeId!;
											navigateToSpaceForge(spaceId);
										}}
										class="truncate text-blue-300 hover:text-blue-200"
									>
										{scopeName ?? task.evolutionScopeId}
									</button>
								) : (
									'—'
								)}
							</DetailRow>
							<DetailRow label="Schedule">{schedule ? formatSchedule(schedule) : '—'}</DetailRow>
						</PanelSection>
						{task.result && (
							<PanelSection title="Result summary">
								<p class="whitespace-pre-wrap text-sm text-gray-300">{task.result}</p>
							</PanelSection>
						)}
					</div>
				)}
				{activeTab === 'workflow' && (
					<div class="h-full space-y-4 overflow-y-auto px-4 pb-6">
						<PanelSection title="Selected workflow">
							<DetailRow label="Name">
								{workflow?.name ?? workflowSummary?.name ?? 'Auto-select'}
							</DetailRow>
							<DetailRow label="Run status">{workflowRun?.status ?? 'Not started'}</DetailRow>
							<DetailRow label="Nodes">
								{workflow?.nodes.length ?? workflowSummary?.nodeCount ?? '—'}
							</DetailRow>
						</PanelSection>
						<PanelSection title="Workflow steps">
							{workflow?.nodes.map((node, index) => {
								const executions = nodeExecutions.filter(
									(execution) =>
										execution.workflowRunId === task.workflowRunId &&
										execution.workflowNodeId === node.id
								);
								return (
									<WorkflowStepCard
										key={node.id}
										node={node}
										index={index}
										executions={executions}
									/>
								);
							}) ?? (
								<p class="text-sm text-gray-500">Workflow will be selected when task starts.</p>
							)}
						</PanelSection>
					</div>
				)}
				{activeTab === 'agents' && (
					<div class="h-full space-y-4 overflow-y-auto px-4 pb-6">
						{overrideError && (
							<div class="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
								{overrideError}
							</div>
						)}
						<PanelSection title="Agent configuration">
							{workflow?.nodes.flatMap((node) =>
								node.agents.map((agent) => (
									<AgentConfigCard
										key={overrideKey(node.id, agent.name)}
										task={task}
										node={node}
										agent={agent}
										execution={findExecution(
											nodeExecutions,
											task.workflowRunId,
											node.id,
											agent.name
										)}
										canEditModels={canEditModels}
										spaceDefaultModel={space?.defaultModel}
										savingOverrideKey={savingOverrideKey}
										onModelChange={updateModelOverride}
									/>
								))
							) ?? (
								<p class="text-sm text-gray-500">
									Workflow agents will appear after workflow selection.
								</p>
							)}
						</PanelSection>
					</div>
				)}
				{activeTab === 'gates' && (
					<div class="h-full space-y-4 overflow-y-auto px-4 pb-6">
						<PanelSection title="Gates and approvals">
							{workflow?.gates?.length ? (
								workflow.gates.map((gate) => <GateCard key={gate.id} gate={gate} />)
							) : (
								<p class="text-sm text-gray-500">No gates configured.</p>
							)}
						</PanelSection>
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
		</div>
	);
}
