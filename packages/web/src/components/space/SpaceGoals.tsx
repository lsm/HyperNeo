import type { SpaceGoal, SpaceGoalEvent, SpaceGoalStatus, SpaceTask } from '@neokai/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { navigateToSpaceTask } from '../../lib/router';
import { currentSpaceGoalIdSignal, rightPanelTargetSignal } from '../../lib/signals';
import { spaceStore } from '../../lib/space-store';
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

function formatGoalCount(count: number): string {
	return `${count} ${count === 1 ? 'objective' : 'objectives'}`;
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

const GOAL_ACTION_BUTTON_CLASS =
	'h-8 rounded-md border px-3 text-xs font-medium transition-colors disabled:opacity-50';

function ProgressBar({ value }: { value: number }) {
	const safeValue = Math.max(0, Math.min(100, value));
	return (
		<div class="h-1.5 rounded-full bg-dark-800/80">
			<div
				class="h-1.5 rounded-full bg-blue-500 transition-[width]"
				style={{ width: `${safeValue}%` }}
			/>
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
				'group flex min-h-[10.5rem] w-full flex-col rounded-lg border p-4 text-left transition-colors',
				selected
					? 'border-blue-500/70 bg-blue-950/20 shadow-[0_0_0_1px_rgb(59_130_246_/_0.08)]'
					: 'border-dark-700 bg-dark-900/60 hover:border-dark-600 hover:bg-dark-850/80'
			)}
		>
			<div class="min-w-0">
				<h3 class="line-clamp-2 text-sm font-semibold leading-5 text-gray-100">{goal.title}</h3>
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<GoalStatusBadge status={goal.status} />
					<span class="rounded-full border border-dark-600 px-2 py-0.5 text-[11px] font-medium text-gray-400">
						{TYPE_LABELS[goal.type]}
					</span>
					{goal.pendingNextRun && (
						<span class="rounded-full border border-amber-800/40 bg-amber-950/20 px-2 py-0.5 text-xs text-amber-300">
							Pending next
						</span>
					)}
				</div>
				<p class="mt-2 line-clamp-2 min-h-8 text-xs leading-4 text-gray-400">
					{goal.summary || goal.description || 'No summary recorded yet'}
				</p>
			</div>

			<div class="mt-auto space-y-2 pt-4">
				<div class="flex items-center justify-between text-xs">
					<span class="font-medium text-gray-400">Progress</span>
					<span class="text-gray-300">{goal.progress}% complete</span>
				</div>
				<ProgressBar value={goal.progress} />
			</div>

			<div class="mt-3 grid grid-cols-3 gap-2 text-xs text-gray-500">
				<div>
					<span class="block text-gray-600">Next check-in</span>
					<span class="text-gray-300">{formatDate(goal.nextCheckInAt)}</span>
				</div>
				<div>
					<span class="block text-gray-600">Last task</span>
					<span class="truncate text-gray-300">{lastTask?.title ?? goal.lastTaskId ?? '—'}</span>
				</div>
				<div>
					<span class="block text-gray-600">Priority</span>
					<span class="capitalize text-gray-300">{goal.priority}</span>
				</div>
			</div>
		</button>
	);
}

function DetailSection({ title, children }: { title: string; children: ComponentChildren }) {
	return (
		<section class="rounded-lg bg-dark-900/65 p-4">
			<h3 class="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
			{children}
		</section>
	);
}

export function GoalDetail({
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
			<div class="relative flex h-[88px] flex-col justify-center bg-dark-900/30 px-5">
				{/* pr-12 keeps the header clear of the floating right-panel toggle. */}
				<div class="pr-12">
					<h2 class="truncate text-base font-semibold leading-6 text-gray-100">{goal.title}</h2>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<GoalStatusBadge status={goal.status} />
						<span class="rounded-full border border-dark-600 px-2 py-0.5 text-xs text-gray-400">
							{TYPE_LABELS[goal.type]}
						</span>
						<span class="rounded-full border border-dark-600 px-2 py-0.5 text-xs capitalize text-gray-400">
							{goal.priority}
						</span>
					</div>
				</div>
				<div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
			</div>

			<div class="flex flex-wrap gap-2 px-4 pt-4">
				<button
					type="button"
					onClick={onEdit}
					class={cn(
						GOAL_ACTION_BUTTON_CLASS,
						'border-dark-600 bg-dark-800 text-gray-200 hover:bg-dark-700'
					)}
				>
					Edit details
				</button>
				{goal.status === 'active' && (
					<button
						type="button"
						disabled={actionLoading}
						onClick={() => onRunAction('pause')}
						class={cn(
							GOAL_ACTION_BUTTON_CLASS,
							'border-dark-600 bg-dark-800 text-amber-200 hover:bg-dark-700'
						)}
					>
						Pause
					</button>
				)}
				{goal.status === 'paused' && (
					<button
						type="button"
						disabled={actionLoading}
						onClick={() => onRunAction('resume')}
						class={cn(
							GOAL_ACTION_BUTTON_CLASS,
							'border-dark-600 bg-dark-800 text-green-200 hover:bg-dark-700'
						)}
					>
						Resume
					</button>
				)}
				<button
					type="button"
					disabled={actionLoading || goal.status !== 'active'}
					onClick={() => onRunAction('trigger')}
					class={cn(
						GOAL_ACTION_BUTTON_CLASS,
						'border-blue-700 bg-blue-600 text-white hover:bg-blue-500'
					)}
				>
					Create task now
				</button>
				{goal.status !== 'archived' && (
					<button
						type="button"
						disabled={actionLoading}
						onClick={() => onRunAction('archive')}
						class={cn(
							GOAL_ACTION_BUTTON_CLASS,
							'border-dark-600 bg-dark-800 text-red-200 hover:bg-dark-700'
						)}
					>
						Archive
					</button>
				)}
			</div>

			<div class="flex-1 space-y-4 overflow-y-auto p-4">
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
	const [createOpen, setCreateOpen] = useState(false);
	const [loading, setLoading] = useState(false);
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

	// Clear selection + any open goal panel when leaving this space's Goals view.
	useEffect(() => {
		return () => {
			currentSpaceGoalIdSignal.value = null;
			if (rightPanelTargetSignal.value?.type === 'goal') rightPanelTargetSignal.value = null;
		};
	}, [spaceId]);

	const visibleGoals = useMemo(() => {
		const filtered = showArchived ? goals : goals.filter((goal) => goal.status !== 'archived');
		return [...filtered].sort((a, b) => {
			if (a.status === 'active' && b.status !== 'active') return -1;
			if (a.status !== 'active' && b.status === 'active') return 1;
			return b.updatedAt - a.updatedAt;
		});
	}, [goals, showArchived]);

	// Keep a valid default selection so the right-panel toggle always has a
	// target; re-pick the first goal if the current one is filtered out.
	useEffect(() => {
		if (selectedGoalId && visibleGoals.some((goal) => goal.id === selectedGoalId)) return;
		currentSpaceGoalIdSignal.value = visibleGoals[0]?.id ?? null;
	}, [visibleGoals, selectedGoalId]);

	const openGoal = (goalId: string) => {
		currentSpaceGoalIdSignal.value = goalId;
		rightPanelTargetSignal.value = { type: 'goal', spaceId, goalId };
	};

	return (
		<div class="flex h-full min-h-0 flex-col overflow-hidden">
			<div class="flex h-[88px] flex-shrink-0 items-center justify-between gap-3 border-b border-dark-700 px-4">
				<div>
					<h2 class="text-sm font-semibold text-gray-100">Active objectives</h2>
					<p class="text-xs text-gray-500">
						{formatGoalCount(visibleGoals.length)} tracking long-horizon Space outcomes
					</p>
				</div>
			</div>

			<div class="flex-1 overflow-y-auto p-4">
				<div class="mb-4 flex flex-wrap items-center gap-2">
					<button
						type="button"
						onClick={() => setCreateOpen(true)}
						class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-blue-500"
					>
						Create goal
					</button>
					<label class="flex items-center gap-1.5 rounded-lg border border-dark-700 bg-dark-900/60 px-2 py-1.5 text-xs text-gray-400">
						<input
							type="checkbox"
							checked={showArchived}
							onChange={(e) => setShowArchived((e.target as HTMLInputElement).checked)}
							class="h-3.5 w-3.5 rounded border-dark-600 bg-dark-800"
						/>
						Show archived
					</label>
				</div>
				{loading && <p class="text-sm text-gray-500">Loading goals...</p>}
				{error && <p class="text-sm text-red-400">{error}</p>}
				{!loading && visibleGoals.length === 0 && (
					<div class="rounded-lg border border-dashed border-dark-700 bg-dark-900/30 p-8 text-center">
						<p class="text-sm text-gray-400">No goals yet</p>
						<p class="mt-1 text-xs text-gray-600">Create a goal to track long-horizon work.</p>
					</div>
				)}
				{visibleGoals.length > 0 && (
					<div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))]">
						{visibleGoals.map((goal) => (
							<GoalCard
								key={goal.id}
								goal={goal}
								selected={selectedGoalId === goal.id}
								lastTask={goalTask(tasks, goal.lastTaskId)}
								onSelect={() => openGoal(goal.id)}
							/>
						))}
					</div>
				)}
			</div>

			<SpaceGoalDialog
				isOpen={createOpen}
				onClose={() => setCreateOpen(false)}
				onSaved={(goal) => openGoal(goal.id)}
			/>
		</div>
	);
}
