import type {
	EvolutionEpisode,
	EvolutionLesson,
	EvolutionScope,
	EvidenceRef,
	MetricSnapshot,
	SpaceGoal,
	TaskProposal,
} from '@neokai/shared';
import type { Signal } from '@preact/signals';
import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockToastSuccess } = vi.hoisted(() => ({
	mockRequest: vi.fn(),
	mockToastSuccess: vi.fn(),
}));

vi.mock('../../../hooks/useMessageHub', () => ({
	useMessageHub: () => ({ request: mockRequest }),
}));

vi.mock('../../../lib/toast', () => ({
	toast: { success: mockToastSuccess },
}));

import { spaceStore } from '../../../lib/space-store';
import { SpaceForge } from '../SpaceForge';

const mockSpaceId = signal<string | null>('space-1');
const mockGoals = signal<SpaceGoal[]>([]);
const mockListGoals = vi.fn(async () => [] as SpaceGoal[]);

const mutableSpaceStore = spaceStore as unknown as {
	spaceId: Signal<string | null>;
	goals: Signal<SpaceGoal[]>;
	listGoals: typeof mockListGoals;
};
mutableSpaceStore.spaceId = mockSpaceId;
mutableSpaceStore.goals = mockGoals;
mutableSpaceStore.listGoals = mockListGoals;

function makeGoal(overrides: Partial<SpaceGoal> = {}): SpaceGoal {
	const now = Date.now();
	return {
		id: 'goal-1',
		spaceId: 'space-1',
		title: 'Improve review loop',
		description: 'Track reviewer health',
		status: 'active',
		type: 'recurring',
		priority: 'normal',
		labels: [],
		metrics: {},
		summary: 'Reviews are faster',
		progress: 60,
		nextSteps: ['Collect more data'],
		preferredWorkflowId: null,
		taskScheduleId: null,
		autoTriggerNext: false,
		pendingNextRun: false,
		activeTaskId: null,
		lastTaskId: null,
		lastCheckInAt: null,
		nextCheckInAt: null,
		createdAt: now,
		updatedAt: now,
		completedAt: null,
		...overrides,
	};
}

function makeScope(overrides: Partial<EvolutionScope> = {}): EvolutionScope {
	const now = Date.now();
	return {
		id: 'scope-1',
		spaceId: 'space-1',
		spaceGoalId: 'goal-1',
		kind: 'project',
		name: 'Review quality scope',
		objective: 'Improve code review outcomes',
		parentScopeId: null,
		metricDefinitions: [
			{ key: 'latency', label: 'Review latency', direction: 'decrease', unit: 'hours' },
		],
		policy: {},
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeEvidence(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
	return {
		id: 'evidence-1',
		scopeId: 'scope-1',
		kind: 'manual_note',
		summary: 'Reviewer found regression before merge',
		sourceId: null,
		metadata: {},
		createdAt: Date.now(),
		...overrides,
	};
}

function makeSnapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
	const now = Date.now();
	return {
		id: 'snapshot-1',
		scopeId: 'scope-1',
		capturedAt: now,
		values: { latency: 4 },
		source: 'manual',
		note: 'First capture',
		createdAt: now,
		...overrides,
	};
}

function makeEpisode(overrides: Partial<EvolutionEpisode> = {}): EvolutionEpisode {
	const now = Date.now();
	return {
		id: 'episode-1',
		scopeId: 'scope-1',
		status: 'draft',
		title: 'Review loop episode',
		timeWindow: { start: now - 1000, end: now },
		evidenceIds: ['evidence-1'],
		outcomeSummary: 'Reviewer feedback identified recurring friction.',
		findings: [
			{
				domain: 'workflow',
				kind: 'optimization',
				impact: 'medium',
				confidence: 0.8,
				evidence: ['evidence-1'],
				proposedAction: 'Keep checklist before review',
			},
			{
				domain: 'neokai_product',
				kind: 'friction',
				impact: 'high',
				confidence: 0.9,
				evidence: ['evidence-1'],
				proposedAction: 'Make review actions clearer',
			},
		],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeLesson(overrides: Partial<EvolutionLesson> = {}): EvolutionLesson {
	const now = Date.now();
	return {
		id: 'lesson-1',
		scopeId: 'scope-1',
		status: 'candidate',
		appliesTo: ['workflow'],
		rule: 'Use checklist before PR',
		why: 'Checklist reduced comments',
		evidenceEpisodeIds: ['episode-1'],
		confidence: 0.7,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeProposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
	const now = Date.now();
	return {
		id: 'proposal-1',
		scopeId: 'scope-1',
		title: 'Improve review UI',
		description: 'Make accept/dismiss actions clearer',
		reason: 'Reduce NeoKai friction',
		priority: 'high',
		status: 'proposed',
		evidenceEpisodeIds: ['episode-1'],
		createdTaskId: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function setupRequests(scope = makeScope()) {
	const evidence = [makeEvidence()];
	const snapshot = makeSnapshot();
	const episode = makeEpisode();
	const lesson = makeLesson();
	const proposal = makeProposal();
	mockRequest.mockImplementation(async (method: string, data?: unknown) => {
		if (method === 'evolution.scope.list') return { scopes: [scope] };
		if (method === 'evolution.evidence.list') return { evidence };
		if (method === 'evolution.metricSnapshot.list') return { snapshots: [snapshot] };
		if (method === 'evolution.review.get') {
			return { episodes: [episode], lessons: [lesson], proposals: [proposal] };
		}
		if (method === 'evolution.episode.createFromEvidence') {
			expect(data).toEqual({ scopeId: scope.id, evidenceIds: ['evidence-1'] });
			return {
				episode: makeEpisode({ id: 'episode-2', title: 'Generated episode' }),
				lessons: [makeLesson({ id: 'lesson-2', rule: 'Generated lesson' })],
				proposals: [makeProposal({ id: 'proposal-2', title: 'Generated proposal' })],
			};
		}
		if (method === 'evolution.episode.update') {
			expect(data).toEqual({ id: 'episode-1', params: { status: 'accepted' } });
			return { episode: makeEpisode({ status: 'accepted' }) };
		}
		if (method === 'evolution.lesson.update') {
			expect(data).toEqual({ id: 'lesson-1', params: { status: 'active' } });
			return { lesson: makeLesson({ status: 'active' }) };
		}
		if (method === 'evolution.taskProposal.update') {
			expect(data).toEqual({ id: 'proposal-1', params: { status: 'accepted' } });
			return { proposal: makeProposal({ status: 'accepted' }) };
		}
		if (method === 'evolution.evidence.addManualNote') {
			expect(data).toEqual({ scopeId: scope.id, summary: 'Manual proof' });
			return { evidence: makeEvidence({ id: 'evidence-2', summary: 'Manual proof' }) };
		}
		if (method === 'evolution.metricSnapshot.create') {
			expect(data).toEqual({
				params: {
					scopeId: scope.id,
					values: { latency: 3 },
					source: 'manual',
					note: 'Improved',
				},
			});
			return { snapshot: makeSnapshot({ id: 'snapshot-2', values: { latency: 3 } }) };
		}
		if (method === 'evolution.scope.create') {
			return {
				scope: makeScope({ id: 'scope-2', name: 'New scope', objective: 'Track review loop' }),
			};
		}
		throw new Error(`Unexpected RPC ${method}`);
	});
}

describe('SpaceForge', () => {
	beforeEach(() => {
		mockSpaceId.value = 'space-1';
		mockGoals.value = [makeGoal()];
		mockListGoals.mockResolvedValue(mockGoals.value);
		setupRequests();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('renders scope list, detail, linked goal, and metric definitions', async () => {
		render(<SpaceForge spaceId="space-1" />);

		expect(await screen.findByRole('heading', { name: 'Review quality scope' })).toBeTruthy();
		expect(screen.getAllByText('Improve code review outcomes').length).toBeGreaterThan(0);
		expect(screen.getByText('Linked recurring goal')).toBeTruthy();
		expect(screen.getByText('Reviews are faster')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: 'metrics' }));
		expect(screen.getAllByText('Review latency').length).toBeGreaterThan(0);
	});

	it('attaches manual evidence note', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'evidence' }));
		fireEvent.input(
			screen.getByPlaceholderText('What happened? What evidence should Forge remember?'),
			{
				target: { value: 'Manual proof' },
			}
		);
		fireEvent.click(screen.getByRole('button', { name: 'Attach note' }));

		await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Evidence note attached'));
		expect(mockRequest).toHaveBeenCalledWith('evolution.evidence.addManualNote', {
			scopeId: 'scope-1',
			summary: 'Manual proof',
		});
	});

	it('adds metric snapshot from metric definitions', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'metrics' }));
		fireEvent.input(screen.getByPlaceholderText('hours'), { target: { value: '3' } });
		fireEvent.input(screen.getByPlaceholderText('Optional snapshot note'), {
			target: { value: 'Improved' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Add snapshot' }));

		await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Metric snapshot added'));
		expect(mockRequest).toHaveBeenCalledWith('evolution.metricSnapshot.create', {
			params: {
				scopeId: 'scope-1',
				values: { latency: 3 },
				source: 'manual',
				note: 'Improved',
			},
		});
	});

	it('renders episode review and generates episode from selected evidence', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));

		expect(
			await screen.findByText('Reviewer feedback identified recurring friction.')
		).toBeTruthy();
		expect(screen.getByText('Findings by domain')).toBeTruthy();
		expect(screen.getByText('NeoKai friction findings')).toBeTruthy();
		expect(screen.getByText('Use checklist before PR')).toBeTruthy();
		expect(screen.getByText('Improve review UI')).toBeTruthy();

		fireEvent.click(screen.getByLabelText(/Reviewer found regression before merge/));
		fireEvent.click(screen.getByRole('button', { name: 'Create episode' }));

		await waitFor(() =>
			expect(mockToastSuccess).toHaveBeenCalledWith('Episode "Generated episode" drafted')
		);
		expect(mockRequest).toHaveBeenCalledWith(
			'evolution.episode.createFromEvidence',
			{
				scopeId: 'scope-1',
				evidenceIds: ['evidence-1'],
			},
			{ timeout: 120000 }
		);
	});

	it('accepts latest episode draft from review UI', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		fireEvent.click((await screen.findAllByRole('button', { name: 'Accept' }))[0]);

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.episode.update', {
				id: 'episode-1',
				params: { status: 'accepted' },
			})
		);
	});

	it('activates candidate lesson from review UI', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.lesson.update', {
				id: 'lesson-1',
				params: { status: 'active' },
			})
		);
	});

	it('accepts task proposal from review UI', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		fireEvent.click((await screen.findAllByRole('button', { name: 'Accept' }))[1]);

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.taskProposal.update', {
				id: 'proposal-1',
				params: { status: 'accepted' },
			})
		);
	});

	it('creates scope with linked recurring goal and metrics', async () => {
		render(<SpaceForge spaceId="space-1" />);

		fireEvent.click(await screen.findByRole('button', { name: 'New' }));
		fireEvent.input(screen.getByPlaceholderText('Improve code review loop'), {
			target: { value: 'New scope' },
		});
		fireEvent.input(screen.getByPlaceholderText('What should this scope prove or improve?'), {
			target: { value: 'Track review loop' },
		});
		fireEvent.input(screen.getByLabelText('Linked recurring goal'), {
			target: { value: 'goal-1' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Add metric' }));
		fireEvent.input(screen.getByPlaceholderText('key'), { target: { value: 'quality' } });
		fireEvent.input(screen.getByPlaceholderText('Label'), { target: { value: 'Review quality' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create scope' }));

		await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Scope "New scope" created'));
		expect(mockRequest).toHaveBeenCalledWith('evolution.scope.create', {
			params: {
				spaceId: 'space-1',
				kind: 'project',
				name: 'New scope',
				objective: 'Track review loop',
				spaceGoalId: 'goal-1',
				metricDefinitions: [
					{
						key: 'quality',
						label: 'Review quality',
						direction: 'increase',
						unit: undefined,
						targetValue: undefined,
					},
				],
			},
		});
	});

	it('clears stale scope detail while loading a different space', async () => {
		let resolveSpaceOne: (value: { scopes: EvolutionScope[] }) => void = () => undefined;
		mockRequest.mockImplementation(async (method: string, data?: unknown) => {
			if (method !== 'evolution.scope.list') throw new Error(`Unexpected RPC ${method}`);
			const { spaceId } = data as { spaceId: string };
			if (spaceId === 'space-1') {
				return new Promise((resolve) => {
					resolveSpaceOne = resolve;
				});
			}
			return { scopes: [makeScope({ id: 'scope-2', spaceId, name: 'Space B scope' })] };
		});

		const { rerender } = render(<SpaceForge spaceId="space-1" />);
		resolveSpaceOne({ scopes: [makeScope({ name: 'Space A scope' })] });
		expect(await screen.findByRole('heading', { name: 'Space A scope' })).toBeTruthy();

		rerender(<SpaceForge spaceId="space-2" />);

		expect(screen.queryByRole('heading', { name: 'Space A scope' })).toBeNull();
		expect(await screen.findByRole('heading', { name: 'Space B scope' })).toBeTruthy();
	});

	it('ignores stale scope-list responses after space changes', async () => {
		let resolveSpaceOne: (value: { scopes: EvolutionScope[] }) => void = () => undefined;
		mockRequest.mockImplementation(async (method: string, data?: unknown) => {
			if (method !== 'evolution.scope.list') throw new Error(`Unexpected RPC ${method}`);
			const { spaceId } = data as { spaceId: string };
			if (spaceId === 'space-1') {
				return new Promise((resolve) => {
					resolveSpaceOne = resolve;
				});
			}
			return { scopes: [makeScope({ id: 'scope-2', spaceId, name: 'Current space scope' })] };
		});

		const { rerender } = render(<SpaceForge spaceId="space-1" />);
		rerender(<SpaceForge spaceId="space-2" />);
		expect(await screen.findByRole('heading', { name: 'Current space scope' })).toBeTruthy();

		resolveSpaceOne({ scopes: [makeScope({ name: 'Stale space scope' })] });

		await waitFor(() =>
			expect(screen.queryByRole('heading', { name: 'Stale space scope' })).toBeNull()
		);
		expect(screen.getByRole('heading', { name: 'Current space scope' })).toBeTruthy();
	});

	it('preserves newly created scopes against in-flight initial loads', async () => {
		let resolveList: (value: { scopes: EvolutionScope[] }) => void = () => undefined;
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'evolution.scope.list') {
				return new Promise((resolve) => {
					resolveList = resolve;
				});
			}
			if (method === 'evolution.scope.create') {
				return {
					scope: makeScope({ id: 'scope-2', name: 'New scope', objective: 'Track review loop' }),
				};
			}
			throw new Error(`Unexpected RPC ${method}`);
		});

		render(<SpaceForge spaceId="space-1" />);
		fireEvent.click(await screen.findByRole('button', { name: 'New' }));
		fireEvent.input(screen.getByPlaceholderText('Improve code review loop'), {
			target: { value: 'New scope' },
		});
		fireEvent.input(screen.getByPlaceholderText('What should this scope prove or improve?'), {
			target: { value: 'Track review loop' },
		});
		fireEvent.click(screen.getAllByRole('button', { name: 'Create scope' }).at(-1)!);

		expect(await screen.findByRole('heading', { name: 'New scope' })).toBeTruthy();
		resolveList({ scopes: [makeScope({ id: 'scope-1', name: 'Existing scope' })] });

		await waitFor(() => expect(screen.getByRole('heading', { name: 'New scope' })).toBeTruthy());
		await waitFor(() => expect(screen.getByText('Existing scope')).toBeTruthy());
	});
});
