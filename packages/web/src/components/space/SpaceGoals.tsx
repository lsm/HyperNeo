import type { SpaceGoal, SpaceGoalEvent, SpaceGoalStatus, SpaceTask } from '@neokai/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { navigateToSpaceTask } from '../../lib/router';
import { currentSpaceGoalIdSignal, rightPanelTargetSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { cn, getRelativeTime } from '../../lib/utils';
import { SpaceGoalDialog } from './SpaceGoalDialog';

interface SpaceGoalsProps {
	spaceId: string;
}

const STATUS_STYLES: Record<SpaceGoalStatus, string> = {
	active: 'border-green-800/40 bg-green-950/20 text-green-300',
	paused: 'border-amber-800/40 bg-amber-950/20 text-amber-300',
	completed: 'border-blue-800/40 bg-blue-950/20 text-blue-300',
	archived: 'border-gray-700 bg-gray-900/40 text-gray-400',
};

const TYPE_LABELS: Record<SpaceGoal['type'], string> = {
	one_shot: 'One-shot',
	measurable: 'Measurable',
	recurring: 'Recurring',
};

function formatDate(ts: number | null): string {
	if (!ts) return '—';
	return new Date(ts).toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

function goalTask(tasks: SpaceTask[], taskId: string | null): SpaceTask | null {
	if (!taskId) return null;
	return tasks.find((task) => task.id === taskId) ?? null;
}

function eventLabel(event: SpaceGoalEvent): string {
	return event.eventType.replace(/_/g, ' ');
}

function GoalStatusBadge({ status }: { status: SpaceGoalStatus }) {
	return (
		<span class={cn('rounded-full border px-2 py-0.5 text-xs font-medium', STATUS_STYLES[status])}>
			{status.replace(/_/g, ' ')}
		</span>
	);
}

function ProgressBar({ value }: { value: number }) {
	const safeValue = Math.max(0, Math.min(100, value));
	return (
		<div class="h-2 rounded-full bg-dark-700">
			<div class="h-2 rounded-full bg-blue-500" style={{ width: `${safeValue}%` }} />
		</div>
	);
}

function GoalCard({
	goal,
	selected,
	lastTask,
	onSelect,
}: {
	goal: SpaceGoal;
	selected: boolean;
	lastTask: SpaceTask | null;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			class={cn(
				'w-full rounded-xl border p-4 text-left transition-colors',
				selected
					? 'border-blue-500/60 bg-blue-950/20'
					: 'border-dark-700 bg-dark-900/50 hover:border-dark-600 hover:bg-dark-850/80'
			)}
		>
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<h3 class="truncate text-sm font-semibold text-gray-100">{goal.title}</h3>
						{goal.pendingNextRun && (
							<span class="rounded-full border border-amber-800/40 bg-amber-950/20 px-2 py-0.5 text-xs text-amber-300">
								Pending next
							</span>
						)}
					</div>
					<p class="mt-1 line-clamp-2 text-xs text-gray-500">{goal.summary || goal.description}</p>
				</div>
				<GoalStatusBadge status={goal.status} />
			</div>

			<div class="mt-3 space-y-2">
				<div class="flex items-center justify-between text-xs text-gray-500">
					<span>{goal.progress}% complete</span>
					<span class="capitalize">{goal.priority}</span>
				</div>
				<ProgressBar value={goal.progress} />
			</div>

			<div class="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-500">
				<div>
					<span class="block text-gray-600">Next check-in</span>
					<span class="text-gray-300">{formatDate(goal.nextCheckInAt)}</span>
				</div>
				<div>
					<span class="block text-gray-600">Last task</span>
					<span class="truncate text-gray-300">{lastTask?.title ?? goal.lastTaskId ?? '—'}</span>
				</div>
			</div>
		</button>
	);
}

function DetailSection({ title, children }: { title: string; children: ComponentChildren }) {
	return (
		<section class="rounded-xl border border-dark-700 bg-dark-900/50 p-4">
			<h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
			{children}
		</section>
	);
}

function GoalDetail({
	goal,
	tasks,
	events,
	onEdit,
	onRunAction,
	actionLoading,
	spaceId,
}: {
	goal: SpaceGoal;
	tasks: SpaceTask[];
	events: SpaceGoalEvent[];
	onEdit: () => void;
	onRunAction: (action: 'pause' | 'resume' | 'archive' | 'trigger') => void;
	actionLoading: boolean;
	spaceId: string;
}) {
	const linkedTasks = tasks
		.filter(
			(task) =>
				task.goalId === goal.id || task.id === goal.activeTaskId || task.id === goal.lastTaskId
		)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const activeTask = goalTask(tasks, goal.activeTaskId);
	const lastTask = goalTask(tasks, goal.lastTaskId);

	return (
		<div class="flex h-full flex-col overflow-hidden">
			<div class="border-b border-dark-700 p-5">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">
						<div class="mb-2 flex flex-wrap items-center gap-2">
							<GoalStatusBadge status={goal.status} />
							<span class="rounded-full border border-dark-600 px-2 py-0.5 text-xs text-gray-400">
								{TYPE_LABELS[goal.type]}
							</span>
							<span class="rounded-full border border-dark-600 px-2 py-0.5 text-xs capitalize text-gray-400">
								{goal.priority}
							</span>
						</div>
						<h2 class="text-lg font-semibold text-gray-100">{goal.title}</h2>
						<p class="mt-1 text-sm text-gray-500">{goal.description || 'No description'}</p>
					</div>
					<button
						type="button"
						onClick={onEdit}
						class="rounded-lg border border-dark-600 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-dark-800"
					>
						Edit
					</button>
				</div>

				<div class="mt-4 flex flex-wrap gap-2">
					{goal.status === 'active' && (
						<button
							type="button"
							disabled={actionLoading}
							onClick={() => onRunAction('pause')}
							class="rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-1.5 text-xs font-medium text-amber-300 disabled:opacity-50"
						>
							Pause
						</button>
					)}
					{goal.status === 'paused' && (
						<button
							type="button"
							disabled={actionLoading}
							onClick={() => onRunAction('resume')}
							class="rounded-lg border border-green-800/40 bg-green-950/20 px-3 py-1.5 text-xs font-medium text-green-300 disabled:opacity-50"
						>
							Resume
						</button>
					)}
					<button
						type="button"
						disabled={actionLoading || goal.status !== 'active'}
						onClick={() => onRunAction('trigger')}
						class="rounded-lg border border-blue-800/40 bg-blue-950/20 px-3 py-1.5 text-xs font-medium text-blue-300 disabled:opacity-50"
					>
						Create task now
					</button>
					{goal.status !== 'archived' && (
						<button
							type="button"
							disabled={actionLoading}
							onClick={() => onRunAction('archive')}
							class="rounded-lg border border-red-800/40 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-300 disabled:opacity-50"
						>
							Archive
						</button>
					)}
				</div>
			</div>

			<div class="flex-1 space-y-4 overflow-y-auto p-5">
				<DetailSection title="Rolling state">
					<div class="space-y-3">
						<p class="text-sm text-gray-300">{goal.summary || 'No summary yet'}</p>
						<div>
							<div class="mb-1 flex justify-between text-xs text-gray-500">
								<span>Progress</span>
								<span>{goal.progress}%</span>
							</div>
							<ProgressBar value={goal.progress} />
						</div>
						<div class="grid grid-cols-2 gap-3 text-xs text-gray-500">
							<div>
								<span class="block text-gray-600">Last check-in</span>
								<span class="text-gray-300">{formatDate(goal.lastCheckInAt)}</span>
							</div>
							<div>
								<span class="block text-gray-600">Next check-in</span>
								<span class="text-gray-300">{formatDate(goal.nextCheckInAt)}</span>
							</div>
							<div>
								<span class="block text-gray-600">Auto trigger next</span>
								<span class="text-gray-300">{goal.autoTriggerNext ? 'Enabled' : 'Off'}</span>
							</div>
							<div>
								<span class="block text-gray-600">Concurrency state</span>
								<span class="text-gray-300">
									{activeTask
										? 'Active task running'
										: goal.pendingNextRun
											? 'Pending next run'
											: 'Idle'}
								</span>
							</div>
						</div>
					</div>
				</DetailSection>

				<DetailSection title="Metrics">
					{Object.keys(goal.metrics).length === 0 ? (
						<p class="text-sm text-gray-500">No metrics recorded</p>
					) : (
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{Object.entries(goal.metrics).map(([key, value]) => (
								<div key={key} class="rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2">
									<span class="block text-xs text-gray-500">{key}</span>
									<span class="text-sm text-gray-200">{String(value ?? '—')}</span>
								</div>
							))}
						</div>
					)}
				</DetailSection>

				<DetailSection title="Next steps">
					{goal.nextSteps.length === 0 ? (
						<p class="text-sm text-gray-500">No next steps recorded</p>
					) : (
						<ul class="space-y-2 text-sm text-gray-300">
							{goal.nextSteps.map((step) => (
								<li key={step} class="flex gap-2">
									<span class="text-gray-600">•</span>
									<span>{step}</span>
								</li>
							))}
						</ul>
					)}
				</DetailSection>

				<DetailSection title="Linked tasks">
					{linkedTasks.length === 0 ? (
						<p class="text-sm text-gray-500">No linked tasks yet</p>
					) : (
						<div class="space-y-2">
							{linkedTasks.map((task) => (
								<button
									key={task.id}
									type="button"
									onClick={() => navigateToSpaceTask(spaceId, task.id)}
									class="w-full rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2 text-left hover:border-dark-600"
								>
									<div class="flex items-center justify-between gap-2">
										<span class="truncate text-sm text-gray-200">{task.title}</span>
										<span class="text-xs text-gray-500">#{task.taskNumber}</span>
									</div>
									<div class="mt-1 flex items-center gap-2 text-xs text-gray-500">
										<span>{task.status}</span>
										{task.result && <span class="truncate">{task.result}</span>}
									</div>
								</button>
							))}
						</div>
					)}
					{lastTask && !linkedTasks.some((task) => task.id === lastTask.id) && (
						<p class="mt-2 text-xs text-gray-500">Last task: {lastTask.title}</p>
					)}
				</DetailSection>

				<DetailSection title="Recent goal events">
					{events.length === 0 ? (
						<p class="text-sm text-gray-500">No events loaded</p>
					) : (
						<div class="space-y-2">
							{events.slice(0, 6).map((event) => (
								<div
									key={event.id}
									class="rounded-lg border border-dark-700 bg-dark-800/60 px-3 py-2"
								>
									<div class="flex items-center justify-between gap-2 text-xs">
										<span class="capitalize text-gray-300">{eventLabel(event)}</span>
										<span class="text-gray-500">{getRelativeTime(event.createdAt)}</span>
									</div>
									{event.note && <p class="mt-1 text-xs text-gray-500">{event.note}</p>}
								</div>
							))}
						</div>
					)}
				</DetailSection>
			</div>
		</div>
	);
}

export function SpaceGoals({ spaceId }: SpaceGoalsProps) {
	const goals = spaceStore.goals.value;
	const tasks = spaceStore.tasks.value;
	const selectedGoalId = currentSpaceGoalIdSignal.value;
	const [showArchived, setShowArchived] = useState(false);
	const [editingGoal, setEditingGoal] = useState<SpaceGoal | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [actionLoading, setActionLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		Promise.all([
			spaceStore.listGoals({ includeArchived: showArchived }),
			spaceStore.ensureConfigData(),
		])
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load goals');
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [spaceId, showArchived]);

	const visibleGoals = useMemo(() => {
		const filtered = showArchived ? goals : goals.filter((goal) => goal.status !== 'archived');
		return [...filtered].sort((a, b) => {
			if (a.status === 'active' && b.status !== 'active') return -1;
			if (a.status !== 'active' && b.status === 'active') return 1;
			return b.updatedAt - a.updatedAt;
		});
	}, [goals, showArchived]);

	useEffect(() => {
		return () => {
			currentSpaceGoalIdSignal.value = null;
			if (rightPanelTargetSignal.value?.type === 'goal') {
				rightPanelTargetSignal.value = null;
			}
		};
	}, [spaceId]);

	const selectedGoal =
		visibleGoals.find((goal) => goal.id === selectedGoalId) ?? visibleGoals[0] ?? null;
	const selectedEvents = selectedGoal
		? (spaceStore.goalEvents.value.get(selectedGoal.id) ?? [])
		: [];

	useEffect(() => {
		const nextGoalId = selectedGoal?.id ?? null;
		if (currentSpaceGoalIdSignal.value !== nextGoalId) {
			currentSpaceGoalIdSignal.value = nextGoalId;
		}
	}, [selectedGoal?.id]);

	useEffect(() => {
		if (!selectedGoal) return;
		spaceStore.listGoalEvents(selectedGoal.id).catch(() => {});
	}, [selectedGoal?.id]);

	const runAction = async (action: 'pause' | 'resume' | 'archive' | 'trigger') => {
		if (!selectedGoal) return;
		setActionLoading(true);
		try {
			if (action === 'pause') await spaceStore.pauseGoal(selectedGoal.id);
			else if (action === 'resume') await spaceStore.resumeGoal(selectedGoal.id);
			else if (action === 'archive') await spaceStore.archiveGoal(selectedGoal.id);
			else {
				const result = await spaceStore.createImmediateGoalTask(selectedGoal.id);
				if (result.queued) toast.success('Next goal task queued');
				else toast.success('Goal task created');
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Goal action failed');
		} finally {
			setActionLoading(false);
		}
	};

	return (
		<div class="flex h-full min-h-0 flex-col overflow-hidden lg:flex-row">
			<div class="flex min-h-0 w-full flex-col border-b border-dark-700 lg:w-[420px] lg:border-r lg:border-b-0">
				<div class="flex items-center justify-between gap-3 border-b border-dark-700 p-4">
					<div>
						<h2 class="text-sm font-semibold text-gray-100">Goals</h2>
						<p class="text-xs text-gray-500">Long-horizon Space objectives</p>
					</div>
					<div class="flex items-center gap-2">
						<label class="flex items-center gap-1.5 text-xs text-gray-500">
							<input
								type="checkbox"
								checked={showArchived}
								onChange={(e) => setShowArchived((e.target as HTMLInputElement).checked)}
								class="h-3.5 w-3.5 rounded border-dark-600 bg-dark-800"
							/>
							Archived
						</label>
						<button
							type="button"
							onClick={() => setCreateOpen(true)}
							class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
						>
							Create
						</button>
					</div>
				</div>

				<div class="flex-1 space-y-3 overflow-y-auto p-4">
					{loading && <p class="text-sm text-gray-500">Loading goals...</p>}
					{error && <p class="text-sm text-red-400">{error}</p>}
					{!loading && visibleGoals.length === 0 && (
						<div class="rounded-xl border border-dashed border-dark-700 p-8 text-center">
							<p class="text-sm text-gray-400">No goals yet</p>
							<p class="mt-1 text-xs text-gray-600">Create a goal to track long-horizon work.</p>
						</div>
					)}
					{visibleGoals.map((goal) => (
						<GoalCard
							key={goal.id}
							goal={goal}
							selected={selectedGoal?.id === goal.id}
							lastTask={goalTask(tasks, goal.lastTaskId)}
							onSelect={() => {
								currentSpaceGoalIdSignal.value = goal.id;
							}}
						/>
					))}
				</div>
			</div>

			<div class="min-h-[420px] min-w-0 flex-1 border-t border-dark-700 lg:min-h-0 lg:border-t-0">
				{selectedGoal ? (
					<GoalDetail
						goal={selectedGoal}
						tasks={tasks}
						events={selectedEvents}
						onEdit={() => setEditingGoal(selectedGoal)}
						onRunAction={(action) => void runAction(action)}
						actionLoading={actionLoading}
						spaceId={spaceId}
					/>
				) : (
					<div class="flex h-full items-center justify-center text-sm text-gray-500">
						Select a goal
					</div>
				)}
			</div>

			<SpaceGoalDialog
				isOpen={createOpen}
				onClose={() => setCreateOpen(false)}
				onSaved={(goal) => {
					currentSpaceGoalIdSignal.value = goal.id;
				}}
			/>
			<SpaceGoalDialog
				isOpen={Boolean(editingGoal)}
				goal={editingGoal}
				onClose={() => setEditingGoal(null)}
				onSaved={(goal) => {
					currentSpaceGoalIdSignal.value = goal.id;
				}}
			/>
		</div>
	);
}
