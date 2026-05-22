// @ts-nocheck
import type { NodeExecution, Space, SpaceGoal, SpaceTask, SpaceWorkflow } from '@neokai/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
	mockNavigateToSpaceForge,
	mockNavigateToSpaceGoals,
	mockSpace,
	mockTasks,
	mockGoals,
	mockWorkflows,
	mockWorkflowRuns,
	mockSchedules,
	mockNodeExecutions,
	mockEnsureConfigData,
	mockEnsureNodeExecutions,
	mockFetchWorkflowDetail,
	mockFetchEvolutionScope,
	mockUpdateTask,
} = vi.hoisted(() => {
	function makeSignal<T>(initial: T) {
		return { value: initial };
	}
	const workflows = makeSignal<SpaceWorkflow[]>([]);
	return {
		mockNavigateToSpaceForge: vi.fn(),
		mockNavigateToSpaceGoals: vi.fn(),
		mockSpace: makeSignal<Space | null>(null),
		mockTasks: makeSignal<SpaceTask[]>([]),
		mockGoals: makeSignal<SpaceGoal[]>([]),
		mockWorkflows: workflows,
		mockWorkflowRuns: makeSignal([]),
		mockSchedules: makeSignal([]),
		mockNodeExecutions: makeSignal<NodeExecution[]>([]),
		mockEnsureConfigData: vi.fn().mockResolvedValue(undefined),
		mockEnsureNodeExecutions: vi.fn().mockResolvedValue(undefined),
		mockFetchWorkflowDetail: vi.fn(
			async (id: string) => workflows.value.find((workflow) => workflow.id === id) ?? null
		),
		mockFetchEvolutionScope: vi.fn().mockResolvedValue({ id: 'scope-1', name: 'Launch Scope' }),
		mockUpdateTask: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock('../../../lib/router', () => ({
	navigateToSpaceForge: mockNavigateToSpaceForge,
	navigateToSpaceGoals: mockNavigateToSpaceGoals,
}));

vi.mock('../../../lib/signals', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
	};
});

const mockModelsResponse = {
	models: [
		{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', provider: 'anthropic' },
		{ id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', provider: 'anthropic' },
	],
};

vi.mock('../../../lib/connection-manager', () => ({
	connectionManager: {
		getHub: () =>
			Promise.resolve({
				request: vi.fn(async (method: string) => {
					if (method === 'models.list') return mockModelsResponse;
					return {};
				}),
			}),
		getHubIfConnected: () => ({
			request: vi.fn(async (method: string) => {
				if (method === 'models.list') return mockModelsResponse;
				return {};
			}),
		}),
	},
}));

vi.mock('../TaskTimelineFeed', () => ({
	TaskTimelineFeed: ({ taskId }: { taskId: string }) => (
		<div data-testid="task-timeline" data-task-id={taskId} />
	),
}));

vi.mock('../WorkflowExecutionLogFeed', () => ({
	WorkflowExecutionLogFeed: ({ workflowRunId }: { workflowRunId: string }) => (
		<div data-testid="workflow-log" data-run-id={workflowRunId} />
	),
}));

vi.mock('../TaskArtifactsPanel', () => ({
	TaskArtifactsPanel: ({ runId, taskId }: { runId: string; taskId: string }) => (
		<div data-testid="task-artifacts" data-run-id={runId} data-task-id={taskId} />
	),
}));

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
	WorkflowModelSelect: ({
		onChange,
		testId,
		className,
		value,
	}: {
		onChange: (value: string | undefined) => void;
		testId: string;
		className?: string;
		value?: string;
	}) => (
		<select
			data-testid={testId}
			class={className}
			value={value ?? ''}
			onChange={(event) => onChange((event.currentTarget as HTMLSelectElement).value || undefined)}
		>
			<option value="">— No override —</option>
			<option value="claude-opus-4-5">Claude Opus 4.5</option>
		</select>
	),
}));

vi.mock('../../../lib/utils', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('../../../lib/space-store', () => ({
	spaceStore: {
		space: mockSpace,
		tasks: mockTasks,
		goals: mockGoals,
		workflows: mockWorkflows,
		workflowRuns: mockWorkflowRuns,
		schedules: mockSchedules,
		nodeExecutions: mockNodeExecutions,
		ensureConfigData: mockEnsureConfigData,
		ensureNodeExecutions: mockEnsureNodeExecutions,
		fetchWorkflowDetail: mockFetchWorkflowDetail,
		fetchEvolutionScope: mockFetchEvolutionScope,
		updateTask: mockUpdateTask,
	},
}));

import { TaskAuxiliaryPanel } from '../TaskAuxiliaryPanel';
import {
	currentSpaceGoalIdSignal,
	currentSpaceScopeIdSignal,
	rightPanelTargetSignal,
} from '../../../lib/signals';

const NOW = 1_700_000_000_000;

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
	return {
		id: 'task-1',
		spaceId: 'space-1',
		taskNumber: 42,
		title: 'Ship task panel',
		description: 'Add workflow controls',
		status: 'open',
		priority: 'high',
		labels: [],
		dependsOn: [],
		result: null,
		createdAt: NOW,
		updatedAt: NOW,
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		blockReason: null,
		approvalSource: null,
		approvalReason: null,
		approvedAt: null,
		pendingCheckpointType: null,
		reportedStatus: null,
		reportedSummary: null,
		...overrides,
	};
}

function makeWorkflow(): SpaceWorkflow {
	return {
		id: 'workflow-1',
		spaceId: 'space-1',
		name: 'Coding Workflow',
		nodes: [
			{
				id: 'node-1',
				name: 'Coding',
				agents: [
					{
						agentId: 'agent-coder',
						name: 'coder',
						model: 'claude-sonnet-4-5',
						customPrompt: { mode: 'append', value: 'Write clean code.' },
					},
					{
						agentId: 'agent-reviewer',
						name: 'reviewer',
						model: 'claude-sonnet-4-5',
					},
				],
			},
		],
		startNodeId: 'node-1',
		gates: [
			{
				id: 'review-gate',
				label: 'Review Gate',
				description: 'Human review required',
				resetOnCycle: false,
				requiredLevel: 3,
			},
		],
		tags: [],
		completionAutonomyLevel: 3,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

describe('TaskAuxiliaryPanel', () => {
	beforeEach(() => {
		cleanup();
		mockSpace.value = {
			id: 'space-1',
			slug: 'space-1',
			workspacePath: '/tmp/workspace',
			name: 'Space',
			description: '',
			backgroundContext: '',
			instructions: '',
			defaultModel: 'space-default-model',
			sessionIds: [],
			status: 'active',
			paused: false,
			stopped: false,
			maxConcurrentTasks: 1,
			createdAt: NOW,
			updatedAt: NOW,
		};
		mockTasks.value = [makeTask({ preferredWorkflowId: 'workflow-1' })];
		mockGoals.value = [
			{
				id: 'goal-1',
				spaceId: 'space-1',
				title: 'Launch Goal',
				description: '',
				status: 'active',
				type: 'one_shot',
				priority: 'high',
				labels: [],
				metrics: {},
				summary: '',
				progress: 0,
				nextSteps: [],
				preferredWorkflowId: null,
				taskScheduleId: null,
				autoTriggerNext: false,
				pendingNextRun: false,
				activeTaskId: null,
				lastTaskId: null,
				lastCheckInAt: null,
				nextCheckInAt: null,
				createdAt: NOW,
				updatedAt: NOW,
				completedAt: null,
			},
		];
		mockWorkflows.value = [makeWorkflow()];
		mockWorkflowRuns.value = [];
		mockSchedules.value = [];
		mockNodeExecutions.value = [];
		mockEnsureConfigData.mockClear();
		mockEnsureNodeExecutions.mockClear();
		mockFetchWorkflowDetail.mockClear();
		mockFetchEvolutionScope.mockClear();
		mockUpdateTask.mockClear();
		mockNavigateToSpaceForge.mockClear();
		mockNavigateToSpaceGoals.mockClear();
		currentSpaceGoalIdSignal.value = null;
		currentSpaceScopeIdSignal.value = null;
		rightPanelTargetSignal.value = null;
	});

	afterEach(() => {
		cleanup();
	});

	it('renders task setup and context links in details tab', async () => {
		mockTasks.value = [
			makeTask({
				preferredWorkflowId: 'workflow-1',
				goalId: 'goal-1',
				evolutionScopeId: 'scope-1',
				result: 'Done summary',
			}),
		];
		const { getByText } = render(
			<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="details" />
		);

		expect(getByText('Ship task panel')).toBeTruthy();
		expect(getByText('#42')).toBeTruthy();
		expect(getByText('High Priority')).toBeTruthy();
		expect(getByText('Launch Goal')).toBeTruthy();
		await waitFor(() => expect(getByText('Launch Scope')).toBeTruthy());
		expect(getByText('Done summary')).toBeTruthy();
	});

	it('shows editable model selector before task starts', async () => {
		const { getAllByText, getByTestId, getByText } = render(
			<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="agents" />
		);

		await waitFor(() => expect(getByText('coder')).toBeTruthy());
		expect(getByTestId('task-agent-model-node-1-coder')).toBeTruthy();
		expect(getAllByText(/Default: claude-sonnet-4-5/).length).toBeGreaterThan(0);
	});

	it('persists model override from agents tab', async () => {
		const { getByTestId } = render(
			<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="agents" />
		);

		const select = await waitFor(() => getByTestId('task-agent-model-node-1-coder'));
		fireEvent.change(select, { target: { value: 'claude-opus-4-5' } });

		await waitFor(() =>
			expect(mockUpdateTask).toHaveBeenCalledWith('task-1', {
				workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
			})
		);
	});

	it('preserves rapid model override edits before store refreshes', async () => {
		const { getByTestId } = render(
			<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="agents" />
		);

		const coderSelect = await waitFor(() => getByTestId('task-agent-model-node-1-coder'));
		const reviewerSelect = await waitFor(() => getByTestId('task-agent-model-node-1-reviewer'));
		fireEvent.change(coderSelect, { target: { value: 'claude-opus-4-5' } });
		fireEvent.change(reviewerSelect, { target: { value: 'claude-opus-4-5' } });

		await waitFor(() =>
			expect(mockUpdateTask).toHaveBeenLastCalledWith('task-1', {
				workflowModelOverrides: {
					'node-1:coder': 'claude-opus-4-5',
					'node-1:reviewer': 'claude-opus-4-5',
				},
			})
		);
	});

	it('resets pending model overrides when task changes', async () => {
		const { getByTestId, rerender } = render(
			<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="agents" />
		);

		const coderSelect = await waitFor(() => getByTestId('task-agent-model-node-1-coder'));
		fireEvent.change(coderSelect, { target: { value: 'claude-opus-4-5' } });

		mockTasks.value = [
			makeTask({
				id: 'task-2',
				taskNumber: 43,
				title: 'Second task',
				preferredWorkflowId: 'workflow-1',
			}),
		];
		rerender(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-2" tab="agents" />);
		const reviewerSelect = await waitFor(() => getByTestId('task-agent-model-node-1-reviewer'));
		fireEvent.change(reviewerSelect, { target: { value: 'claude-opus-4-5' } });

		await waitFor(() =>
			expect(mockUpdateTask).toHaveBeenLastCalledWith('task-2', {
				workflowModelOverrides: { 'node-1:reviewer': 'claude-opus-4-5' },
			})
		);
	});

	it('locks model display after node execution starts', async () => {
		mockTasks.value = [
			makeTask({
				status: 'in_progress',
				workflowRunId: 'run-1',
				preferredWorkflowId: 'workflow-1',
				workflowModelOverrides: { 'node-1:coder': 'claude-opus-4-5' },
			}),
		];
		mockWorkflowRuns.value = [
			{
				id: 'run-1',
				spaceId: 'space-1',
				workflowId: 'workflow-1',
				title: 'Run',
				status: 'in_progress',
				createdAt: NOW,
				startedAt: NOW,
				updatedAt: NOW,
				completedAt: null,
			},
		];
		mockNodeExecutions.value = [
			{
				id: 'exec-1',
				workflowRunId: 'run-1',
				workflowNodeId: 'node-1',
				agentName: 'coder',
				agentId: 'agent-coder',
				agentSessionId: 'session-1',
				status: 'in_progress',
				result: null,
				data: null,
				createdAt: NOW,
				startedAt: NOW,
				completedAt: null,
				updatedAt: NOW,
			},
		];

		const { getByText, queryByTestId } = render(
			<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="agents" />
		);

		await waitFor(() => expect(getByText('in_progress')).toBeTruthy());
		expect(getByText('claude-opus-4-5')).toBeTruthy();
		expect(queryByTestId('task-agent-model-node-1-coder')).toBeNull();
		expect(mockEnsureNodeExecutions).toHaveBeenCalled();
	});

	it('shows workflow and gate context for running tasks', async () => {
		mockTasks.value = [makeTask({ status: 'in_progress', workflowRunId: 'run-1' })];
		mockWorkflowRuns.value = [
			{
				id: 'run-1',
				spaceId: 'space-1',
				workflowId: 'workflow-1',
				title: 'Run',
				status: 'in_progress',
				createdAt: NOW,
				startedAt: NOW,
				updatedAt: NOW,
				completedAt: null,
			},
		];
		const { getByText, rerender } = render(
			<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="workflow" />
		);

		await waitFor(() => expect(getByText('Coding Workflow')).toBeTruthy());
		expect(getByText('1. Coding')).toBeTruthy();
		expect(getByText('coder, reviewer')).toBeTruthy();

		rerender(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="gates" />);
		expect(getByText('Review Gate')).toBeTruthy();
		expect(getByText('Human review required')).toBeTruthy();
		expect(getByText('Required autonomy: 3')).toBeTruthy();
	});

	it('normalizes run-only tabs to details before run starts', async () => {
		render(<TaskAuxiliaryPanel spaceId="space-1" taskId="task-1" tab="artifacts" />);

		await waitFor(() =>
			expect(rightPanelTargetSignal.value).toEqual({
				type: 'task',
				spaceId: 'space-1',
				taskId: 'task-1',
				tab: 'details',
			})
		);
	});
});
