import type { SpaceGoal, SpaceGoalStatus, SpaceTaskPriority } from '@neokai/shared';
import type { ComponentChildren } from 'preact';
import { spaceStore } from '../../lib/space-store';
import { cn } from '../../lib/utils';

interface GoalDetailPanelProps {
	spaceId: string;
	goalId: string;
}

const STATUS_CLASSES: Record<SpaceGoalStatus, string> = {
	active: 'border-green-500/30 bg-green-500/10 text-green-300',
	paused: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
	completed: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
	archived: 'border-gray-500/25 bg-gray-500/10 text-gray-500',
};

const PRIORITY_CLASSES: Record<SpaceTaskPriority, string> = {
	low: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
	normal: 'border-gray-500/25 bg-gray-500/10 text-gray-400',
	high: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
	urgent: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const TYPE_LABELS: Record<SpaceGoal['type'], string> = {
	one_shot: 'One-shot',
	measurable: 'Measurable',
	recurring: 'Recurring',
};

function GoalPanelBadge({
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

function formatDate(ts: number | null): string {
	if (!ts) return 'None';
	return new Date(ts).toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

export function GoalDetailPanel({ spaceId, goalId }: GoalDetailPanelProps) {
	const goal =
		spaceStore.spaceId.value === spaceId
			? (spaceStore.goals.value.find((item) => item.id === goalId) ?? null)
			: null;
	const tasks = spaceStore.spaceId.value === spaceId ? spaceStore.tasks.value : [];

	if (!goal) {
		return (
			<div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500">
				Goal not found
			</div>
		);
	}

	const linkedTasks = tasks
		.filter(
			(task) =>
				task.goalId === goal.id || task.id === goal.activeTaskId || task.id === goal.lastTaskId
		)
		.sort((a, b) => b.updatedAt - a.updatedAt);

	return (
		<div class="flex h-full min-w-0 flex-col overflow-hidden">
			<div class="relative flex h-[88px] flex-col justify-center bg-dark-900/30 px-5">
				<div class="pr-12">
					<h2 class="truncate text-base font-semibold leading-6 text-gray-100">{goal.title}</h2>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<GoalPanelBadge class={STATUS_CLASSES[goal.status]}>
							{goal.status.replace(/_/g, ' ')}
						</GoalPanelBadge>
						<GoalPanelBadge class="border-dark-600 bg-dark-800/60 text-gray-300">
							{TYPE_LABELS[goal.type]}
						</GoalPanelBadge>
						<GoalPanelBadge class={PRIORITY_CLASSES[goal.priority]}>
							{goal.priority} Priority
						</GoalPanelBadge>
					</div>
				</div>
				<div class="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-dark-700" />
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div class="space-y-5">
					<section>
						<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Summary</h3>
						<p class="mt-2 text-sm leading-6 text-gray-300">
							{goal.summary || goal.description || 'No summary yet.'}
						</p>
					</section>

					<section>
						<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Progress</h3>
						<div class="mt-2 h-2 rounded-full bg-dark-700">
							<div
								class="h-2 rounded-full bg-green-500"
								style={{ width: `${Math.max(0, Math.min(100, goal.progress))}%` }}
							/>
						</div>
						<p class="mt-2 text-xs text-gray-500">{goal.progress}% complete</p>
					</section>

					<section class="grid grid-cols-2 gap-3 text-xs">
						<div>
							<div class="text-gray-600">Last check-in</div>
							<div class="mt-1 text-gray-300">{formatDate(goal.lastCheckInAt)}</div>
						</div>
						<div>
							<div class="text-gray-600">Next check-in</div>
							<div class="mt-1 text-gray-300">{formatDate(goal.nextCheckInAt)}</div>
						</div>
					</section>

					{goal.nextSteps.length > 0 && (
						<section>
							<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">
								Next Steps
							</h3>
							<ul class="mt-2 space-y-2 text-sm text-gray-300">
								{goal.nextSteps.map((step) => (
									<li key={step} class="rounded-md border border-dark-700 bg-dark-900/40 px-3 py-2">
										{step}
									</li>
								))}
							</ul>
						</section>
					)}

					<section>
						<h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">
							Linked Tasks
						</h3>
						<div class="mt-2 space-y-2">
							{linkedTasks.length === 0 ? (
								<p class="text-sm text-gray-500">No linked tasks yet.</p>
							) : (
								linkedTasks.slice(0, 8).map((task) => (
									<div
										key={task.id}
										class="rounded-md border border-dark-700 bg-dark-900/40 px-3 py-2"
									>
										<div class="truncate text-sm text-gray-200">{task.title}</div>
										<div class="mt-1 font-mono text-[11px] text-gray-500">#{task.taskNumber}</div>
									</div>
								))
							)}
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
