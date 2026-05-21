import type { SpaceGoal, SpaceGoalEvent, SpaceTask } from '@neokai/shared';
import type { Signal } from '@preact/signals';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGoals = signal<SpaceGoal[]>([]);
const mockGoalEvents = signal<Map<string, SpaceGoalEvent[]>>(new Map());
const mockTasks = signal<SpaceTask[]>([]);
const mockWorkflows = signal<unknown[]>([]);
const mockListGoals = vi.fn(async () => [] as SpaceGoal[]);
const mockListGoalEvents = vi.fn(async () => [] as SpaceGoalEvent[]);
const mockPauseGoal = vi.fn();
const mockResumeGoal = vi.fn();
const mockArchiveGoal = vi.fn();
const mockCreateImmediateGoalTask = vi.fn();
const mockCreateGoal = vi.fn();
const mockUpdateGoal = vi.fn();

const { mockNavigateToSpaceTask, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
	mockNavigateToSpaceTask: vi.fn(),
	mockToastSuccess: vi.fn(),
	mockToastError: vi.fn(),
}));

vi.mock('../../../lib/router', () => ({
	navigateToSpaceTask: mockNavigateToSpaceTask,
}));

vi.mock('../../../lib/toast', () => ({
	toast: {
		success: mockToastSuccess,
		error: mockToastError,
	},
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: (string | false | null | undefined)[]) => args.filter(Boolean).join(' '),
	getRelativeTime: () => '1m ago',
}));

import { spaceStore } from '../../../lib/space-store';
import { SpaceGoals } from '../SpaceGoals';

const mutableSpaceStore = spaceStore as unknown as {
	goals: Signal<SpaceGoal[]>;
	goalEvents: Signal<Map<string, SpaceGoalEvent[]>>;
	tasks: Signal<SpaceTask[]>;
	workflows: Signal<unknown[]>;
	listGoals: typeof mockListGoals;
	listGoalEvents: typeof mockListGoalEvents;
	pauseGoal: typeof mockPauseGoal;
	resumeGoal: typeof mockResumeGoal;
	archiveGoal: typeof mockArchiveGoal;
	createImmediateGoalTask: typeof mockCreateImmediateGoalTask;
	createGoal: typeof mockCreateGoal;
	updateGoal: typeof mockUpdateGoal;
};

mutableSpaceStore.goals = mockGoals;
mutableSpaceStore.goalEvents = mockGoalEvents;
mutableSpaceStore.tasks = mockTasks;
mutableSpaceStore.workflows = mockWorkflows;
mutableSpaceStore.listGoals = mockListGoals;
mutableSpaceStore.listGoalEvents = mockListGoalEvents;
mutableSpaceStore.pauseGoal = mockPauseGoal;
mutableSpaceStore.resumeGoal = mockResumeGoal;
mutableSpaceStore.archiveGoal = mockArchiveGoal;
mutableSpaceStore.createImmediateGoalTask = mockCreateImmediateGoalTask;
mutableSpaceStore.createGoal = mockCreateGoal;
mutableSpaceStore.updateGoal = mockUpdateGoal;

function makeGoal(overrides: Partial<SpaceGoal> = {}): SpaceGoal {
	const now = Date.now();
	return {
		id: 'goal-1',
		spaceId: 'space-1',
		title: 'Keep release healthy',
		description: 'Maintain release train',
		status: 'active',
		type: 'recurring',
		priority: 'high',
		labels: ['release'],
		metrics: { open_bugs: 3 },
		summary: 'Builds are green',
		progress: 45,
		nextSteps: ['Watch CI'],
		preferredWorkflowId: null,
		taskScheduleId: 'schedule-1',
		autoTriggerNext: true,
		pendingNextRun: false,
		activeTaskId: null,
		lastTaskId: 'task-1',
		lastCheckInAt: now - 60_000,
		nextCheckInAt: now + 60_000,
		createdAt: now - 120_000,
		updatedAt: now,
		completedAt: null,
		...overrides,
	};
}

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	const now = Date.now();
	return {
		id: 'task-1',
		spaceId: 'space-1',
		taskNumber: 42,
		title: 'Investigate flaky build',
		description: '',
		status: 'done',
		priority: 'high',
		labels: ['goal'],
		dependsOn: [],
		goalId: 'goal-1',
		result: 'Fixed retry path',
		startedAt: now - 120_000,
		completedAt: now - 60_000,
		archivedAt: null,
		blockReason: null,
		approvalSource: null,
		approvalReason: null,
		approvedAt: null,
		pendingCheckpointType: null,
		reportedStatus: null,
		reportedSummary: null,
		createdAt: now - 180_000,
		updatedAt: now - 60_000,
		...overrides,
	};
}

function makeEvent(overrides: Partial<SpaceGoalEvent> = {}): SpaceGoalEvent {
	return {
		id: 'event-1',
		spaceId: 'space-1',
		goalId: 'goal-1',
		eventType: 'task_terminal',
		source: 'system',
		sourceTaskId: 'task-1',
		sourceSessionId: null,
		previousState: null,
		newState: null,
		diff: null,
		note: 'Task completed',
		createdAt: Date.now(),
		...overrides,
	};
}

describe('SpaceGoals', () => {
	beforeEach(() => {
		mockGoals.value = [];
		mockGoalEvents.value = new Map();
		mockTasks.value = [];
		mockWorkflows.value = [];
		mockListGoals.mockResolvedValue([]);
		mockListGoalEvents.mockResolvedValue([]);
		mockPauseGoal.mockImplementation(async (goalId: string) =>
			makeGoal({ id: goalId, status: 'paused' })
		);
		mockResumeGoal.mockImplementation(async (goalId: string) =>
			makeGoal({ id: goalId, status: 'active' })
		);
		mockArchiveGoal.mockImplementation(async (goalId: string) =>
			makeGoal({ id: goalId, status: 'archived' })
		);
		mockCreateImmediateGoalTask.mockImplementation(async (goalId: string) => ({
			goal: makeGoal({ id: goalId }),
			task: null,
			queued: false,
		}));
		mockCreateGoal.mockImplementation(async (params: Partial<SpaceGoal>) =>
			makeGoal({ id: 'goal-created', title: params.title ?? 'Created goal' })
		);
		mockUpdateGoal.mockImplementation(async (goalId: string, params: Partial<SpaceGoal>) =>
			makeGoal({ id: goalId, title: params.title ?? 'Updated goal' })
		);
		vi.clearAllMocks();
	});

	afterEach(() => cleanup());

	it('uses mobile drill-in classes and back navigation for goal details', async () => {
		mockGoals.value = [makeGoal()];

		const { container } = render(<SpaceGoals spaceId="space-1" />);

		const listPane = container.querySelector('.lg\\:w-\\[420px\\]');
		expect(listPane?.className).toContain('flex');
		expect(listPane?.className).toContain('lg:flex');

		fireEvent.click(await screen.findByRole('button', { name: /Keep release healthy/ }));
		expect(listPane?.className).toContain('hidden');
		expect(await screen.findByRole('button', { name: 'Goals' })).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'Goals' }));
		expect(listPane?.className).toContain('flex');
	});

	it('renders goal cards, detail state, linked tasks, and recent events', async () => {
		const goal = makeGoal();
		mockGoals.value = [goal];
		mockTasks.value = [makeTask()];
		mockGoalEvents.value = new Map([[goal.id, [makeEvent()]]]);

		render(<SpaceGoals spaceId="space-1" />);

		expect(await screen.findAllByText('Keep release healthy')).toHaveLength(2);
		expect(screen.getByText('45% complete')).toBeTruthy();
		expect(screen.getAllByText('Builds are green')).toHaveLength(2);
		expect(screen.getByText('Auto trigger next')).toBeTruthy();
		expect(screen.getByText('Enabled')).toBeTruthy();
		expect(screen.getByText('Idle')).toBeTruthy();
		expect(screen.getByText('open_bugs')).toBeTruthy();
		expect(screen.getByText('Watch CI')).toBeTruthy();
		expect(screen.getAllByText('Investigate flaky build')).toHaveLength(2);
		expect(screen.getByText('Task completed')).toBeTruthy();
		expect(mockListGoals).toHaveBeenCalledWith({ includeArchived: false });
		expect(mockListGoalEvents).toHaveBeenCalledWith(goal.id);
	});

	it('runs pause, resume, archive, and immediate task actions', async () => {
		mockGoals.value = [makeGoal({ status: 'active' })];

		render(<SpaceGoals spaceId="space-1" />);

		fireEvent.click(await screen.findByText('Pause'));
		await waitFor(() => expect(mockPauseGoal).toHaveBeenCalledWith('goal-1'));

		mockGoals.value = [makeGoal({ status: 'paused' })];
		fireEvent.click(await screen.findByText('Resume'));
		await waitFor(() => expect(mockResumeGoal).toHaveBeenCalledWith('goal-1'));

		mockGoals.value = [makeGoal({ status: 'active' })];
		fireEvent.click(await screen.findByText('Create task now'));
		await waitFor(() => expect(mockCreateImmediateGoalTask).toHaveBeenCalledWith('goal-1'));
		expect(mockToastSuccess).toHaveBeenCalledWith('Goal task created');

		fireEvent.click(await screen.findByText('Archive'));
		await waitFor(() => expect(mockArchiveGoal).toHaveBeenCalledWith('goal-1'));
	});

	it('creates a goal from the dialog payload', async () => {
		render(<SpaceGoals spaceId="space-1" />);

		fireEvent.click(await screen.findByText('Create'));
		fireEvent.input(screen.getByPlaceholderText('Keep release train healthy'), {
			target: { value: 'Ship beta' },
		});
		fireEvent.input(screen.getByPlaceholderText('release, health'), {
			target: { value: 'beta, launch' },
		});
		fireEvent.input(screen.getByPlaceholderText(/build_health: green/), {
			target: {
				value:
					'open_bugs: 2\nhealthy: true\nunset: null\ncode: "0012"\nobject: {"foo": 1}\narray: [1,2]',
			},
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create Goal' }));

		await waitFor(() => expect(mockCreateGoal).toHaveBeenCalled());
		expect(mockCreateGoal).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Ship beta',
				labels: ['beta', 'launch'],
				metrics: {
					open_bugs: 2,
					healthy: true,
					unset: null,
					code: '0012',
					object: '{"foo": 1}',
					array: '[1,2]',
				},
			})
		);
	});
});
