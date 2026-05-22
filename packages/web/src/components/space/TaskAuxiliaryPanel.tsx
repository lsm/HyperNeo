import type { SpaceTask, SpaceTaskPriority, SpaceTaskStatus } from '@neokai/shared';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { rightPanelTargetSignal, type TaskRightPanelTab } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';
import { TaskArtifactsPanel } from './TaskArtifactsPanel';
import { TaskTimelineFeed } from './TaskTimelineFeed';
import { WorkflowExecutionLogFeed } from './WorkflowExecutionLogFeed';

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

function availableTabs(task: SpaceTask): TaskRightPanelTab[] {
	return TASK_PANEL_TABS.filter((item) => !item.needsRun || task.workflowRunId).map(
		(item) => item.id
	);
}

function normalizeTab(task: SpaceTask, tab: TaskRightPanelTab | undefined): TaskRightPanelTab {
	const tabs = availableTabs(task);
	if (tab && tabs.includes(tab)) return tab;
	return tabs.includes('artifacts') ? 'artifacts' : 'timeline';
}

export function TaskAuxiliaryPanel({ spaceId, taskId, tab }: TaskAuxiliaryPanelProps) {
	const task = spaceStore.tasks.value.find((item) => item.id === taskId) ?? null;
	const tabs = task ? availableTabs(task) : [];
	const activeTab = task ? normalizeTab(task, tab) : 'timeline';

	useEffect(() => {
		if (!task) return;
		if (tab === activeTab) return;
		rightPanelTargetSignal.value = { type: 'task', spaceId, taskId, tab: activeTab };
	}, [activeTab, spaceId, tab, task, taskId]);

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
				<div
					class={cn(
						'grid gap-1 rounded-lg border border-white/10 bg-dark-900/70 p-1',
						tabs.length === 3 ? 'grid-cols-3' : tabs.length === 2 ? 'grid-cols-2' : 'grid-cols-1'
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
