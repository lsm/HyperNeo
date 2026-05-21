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

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
	WorkflowModelSelect: ({
		value,
		onChange,
		testId,
		className,
	}: {
		value?: string;
		onChange: (
			value: string | undefined,
			selection?: { modelId: string; provider: string }
		) => void;
		testId: string;
		className?: string;
	}) => {
		const handleChange = (event: Event) => {
			const modelId = (event.currentTarget as HTMLSelectElement).value || undefined;
			onChange(modelId, modelId ? { modelId, provider: 'anthropic' } : undefined);
		};
		return (
			<select
				data-testid={testId}
				value={value ?? ''}
				onChange={handleChange}
				onInput={handleChange}
				class={className}
			>
				<option value="">— No override —</option>
				<option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
				<option value="claude-opus-4-5">Claude Opus 4.5</option>
			</select>
		);
	},
}));

import { spaceStore } from '../../../lib/space-store';
import { SpaceForge } from '../SpaceForge';

const mockSpaceId = signal<string | null>('space-1');
const mockGoals = signal<SpaceGoal[]>([]);
const mockListGoals = vi.fn(async () => [] as SpaceGoal[]);
const mockUpsertGoal = vi.fn((goal: SpaceGoal) => {
	mockGoals.value = [goal, ...mockGoals.value.filter((current) => current.id !== goal.id)];
});

const mutableSpaceStore = spaceStore as unknown as {
	spaceId: Signal<string | null>;
	goals: Signal<SpaceGoal[]>;
	listGoals: typeof mockListGoals;
	upsertGoal: typeof mockUpsertGoal;
};
mutableSpaceStore.spaceId = mockSpaceId;
mutableSpaceStore.goals = mockGoals;
mutableSpaceStore.listGoals = mockListGoals;
mutableSpaceStore.upsertGoal = mockUpsertGoal;

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
		rollupAppliedAt: null,
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
		if (method === 'evolution.lesson.list') {
			expect(data).toEqual({ scopeId: scope.id, status: 'active' });
			return { lessons: [makeLesson({ status: 'active' })] };
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
			const payload = data as { id: string; params: { status: EvolutionLesson['status'] } };
			expect(payload.id).toBe('lesson-1');
			expect(['active', 'dismissed']).toContain(payload.params.status);
			return { lesson: makeLesson({ status: payload.params.status }) };
		}
		if (method === 'evolution.taskProposal.update') {
			const payload = data as { id: string; params: { status: TaskProposal['status'] } };
			expect(payload.id).toBe('proposal-1');
			expect(['accepted', 'dismissed']).toContain(payload.params.status);
			return { proposal: makeProposal({ status: payload.params.status }) };
		}
		if (method === 'evolution.taskProposal.createTask') {
			const payload = data as { id: string; params?: Partial<TaskProposal> };
			expect(payload.id).toBe('proposal-1');
			return {
				proposal: makeProposal({ status: 'created', createdTaskId: 'task-1' }),
				task: {
					id: 'task-1',
					taskNumber: 7,
					title: payload.params?.title ?? 'Improve review UI',
				},
			};
		}
		if (method === 'evolution.rollup.apply') {
			return {
				episode: makeEpisode({ status: 'accepted', rollupAppliedAt: Date.now() }),
				goal: makeGoal({ title: 'Improve review loop', summary: 'Rollup summary', progress: 80 }),
			};
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
		if (method === 'evolution.scope.update') {
			const payload = data as { id: string; params: { policy: EvolutionScope['policy'] } };
			expect(payload.id).toBe(scope.id);
			return { scope: makeScope({ policy: payload.params.policy }) };
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

	it('uses mobile drill-in classes and back navigation for scope details', async () => {
		const { container } = render(<SpaceForge spaceId="space-1" />);

		const scopeButton = await screen.findByRole('button', { name: /Review quality scope/ });
		const sidebar = container.querySelector('aside');
		expect(sidebar?.className).toContain('lg:flex');
		expect(sidebar?.className).toContain('lg:w-80');

		fireEvent.click(scopeButton);
		expect(sidebar?.className).toContain('hidden');
		expect(await screen.findByRole('button', { name: 'Scopes' })).toBeTruthy();

		const tabs = screen.getByRole('button', { name: 'overview' }).parentElement;
		expect(tabs?.className).toContain('overflow-x-auto');

		fireEvent.click(screen.getByRole('button', { name: 'Scopes' }));
		expect(sidebar?.className).toContain('flex');
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

	it('updates existing scope judge model while preserving policy keys', async () => {
		setupRequests(makeScope({ policy: { maxActiveLessons: 3 } }));
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.change(screen.getByTestId('scope-episode-judge-model-select'), {
			target: { value: 'claude-sonnet-4-6' },
		});

		await waitFor(() =>
			expect(mockToastSuccess).toHaveBeenCalledWith('Episode judge model updated')
		);
		expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
			id: 'scope-1',
			params: {
				policy: {
					maxActiveLessons: 3,
					episodeJudgeModel: 'claude-sonnet-4-6',
					episodeJudgeProvider: 'anthropic',
				},
			},
		});
	});

	it('clears existing scope judge model override', async () => {
		setupRequests(
			makeScope({
				policy: {
					maxActiveLessons: 3,
					episodeJudgeModel: 'claude-sonnet-4-5',
					episodeJudgeProvider: 'anthropic',
				},
			})
		);
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.change(screen.getByTestId('scope-episode-judge-model-select'), {
			target: { value: '' },
		});

		await waitFor(() =>
			expect(mockToastSuccess).toHaveBeenCalledWith('Episode judge model override cleared')
		);
		expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
			id: 'scope-1',
			params: { policy: { maxActiveLessons: 3 } },
		});
	});

	it('ignores stale judge model update responses', async () => {
		let resolveFirst: (value: { scope: EvolutionScope }) => void = () => undefined;
		mockRequest.mockImplementation(async (method: string, data?: unknown) => {
			if (method === 'evolution.scope.list') return { scopes: [makeScope()] };
			if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
			if (method === 'evolution.metricSnapshot.list') return { snapshots: [makeSnapshot()] };
			if (method === 'evolution.review.get') {
				return { episodes: [makeEpisode()], lessons: [makeLesson()], proposals: [makeProposal()] };
			}
			if (method === 'evolution.scope.update') {
				const payload = data as { params: { policy: EvolutionScope['policy'] } };
				if (payload.params.policy.episodeJudgeModel === 'claude-sonnet-4-6') {
					return new Promise((resolve) => {
						resolveFirst = resolve;
					});
				}
				return { scope: makeScope({ policy: payload.params.policy }) };
			}
			throw new Error(`Unexpected RPC ${method}`);
		});
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.change(screen.getByTestId('scope-episode-judge-model-select'), {
			target: { value: 'claude-sonnet-4-6' },
		});
		fireEvent.change(screen.getByTestId('scope-episode-judge-model-select'), {
			target: { value: 'claude-opus-4-5' },
		});

		await waitFor(() =>
			expect(mockToastSuccess).toHaveBeenCalledWith('Episode judge model updated')
		);
		expect(
			(screen.getByTestId('scope-episode-judge-model-select') as HTMLSelectElement).value
		).toBe('claude-opus-4-5');

		resolveFirst({ scope: makeScope({ policy: { episodeJudgeModel: 'claude-sonnet-4-6' } }) });

		await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
		expect(
			(screen.getByTestId('scope-episode-judge-model-select') as HTMLSelectElement).value
		).toBe('claude-opus-4-5');
	});

	it('invalidates pending judge model saves before scope selection commits', async () => {
		let resolveFirst: (value: { scope: EvolutionScope }) => void = () => undefined;
		mockRequest.mockImplementation(async (method: string, data?: unknown) => {
			if (method === 'evolution.scope.list') {
				return {
					scopes: [
						makeScope({ id: 'scope-1', name: 'Review quality scope' }),
						makeScope({ id: 'scope-2', name: 'Other scope', policy: {} }),
					],
				};
			}
			if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
			if (method === 'evolution.metricSnapshot.list') return { snapshots: [makeSnapshot()] };
			if (method === 'evolution.review.get') {
				return { episodes: [makeEpisode()], lessons: [makeLesson()], proposals: [makeProposal()] };
			}
			if (method === 'evolution.scope.update') {
				return new Promise((resolve) => {
					resolveFirst = resolve;
				});
			}
			throw new Error(`Unexpected RPC ${method}`);
		});
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.change(screen.getByTestId('scope-episode-judge-model-select'), {
			target: { value: 'claude-sonnet-4-6' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Other scope/ }));
		resolveFirst({ scope: makeScope({ policy: { episodeJudgeModel: 'claude-sonnet-4-6' } }) });

		expect(await screen.findByRole('heading', { name: 'Other scope' })).toBeTruthy();
		expect(mockToastSuccess).not.toHaveBeenCalledWith('Episode judge model updated');
		expect(screen.queryByText('Saving…')).toBeNull();
	});

	it('clears judge model save state after scope selection changes', async () => {
		mockRequest.mockImplementation(async (method: string, data?: unknown) => {
			if (method === 'evolution.scope.list') {
				return {
					scopes: [
						makeScope({ id: 'scope-1', name: 'Review quality scope' }),
						makeScope({ id: 'scope-2', name: 'Other scope', policy: {} }),
					],
				};
			}
			if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
			if (method === 'evolution.metricSnapshot.list') return { snapshots: [makeSnapshot()] };
			if (method === 'evolution.review.get') {
				return { episodes: [makeEpisode()], lessons: [makeLesson()], proposals: [makeProposal()] };
			}
			if (method === 'evolution.scope.update') {
				return new Promise(() => undefined);
			}
			throw new Error(`Unexpected RPC ${method}`);
		});
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.change(screen.getByTestId('scope-episode-judge-model-select'), {
			target: { value: 'claude-sonnet-4-6' },
		});
		expect(await screen.findByText('Saving…')).toBeTruthy();

		fireEvent.click(screen.getByRole('button', { name: /Other scope/ }));

		expect(await screen.findByRole('heading', { name: 'Other scope' })).toBeTruthy();
		expect(screen.queryByText('Saving…')).toBeNull();
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

	it('accepts latest episode draft from review UI without hiding rollup controls', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		expect(await screen.findByText('Manual rollup writeback')).toBeTruthy();
		fireEvent.click((await screen.findAllByRole('button', { name: 'Accept' }))[0]);

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.episode.update', {
				id: 'episode-1',
				params: { status: 'accepted' },
			})
		);
		expect(screen.getByText('Manual rollup writeback')).toBeTruthy();
	});

	it('shows rollup controls for accepted episodes until rollup is applied', async () => {
		const acceptedEpisode = makeEpisode({ status: 'accepted' });
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'evolution.scope.list') return { scopes: [makeScope()] };
			if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
			if (method === 'evolution.review.get') {
				return {
					episodes: [acceptedEpisode],
					lessons: [makeLesson()],
					proposals: [makeProposal()],
				};
			}
			throw new Error(`Unexpected RPC ${method}`);
		});

		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));

		expect(await screen.findByText('Manual rollup writeback')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Apply rollup' })).toBeTruthy();
	});

	it('hides rollup controls for dismissed episodes', async () => {
		const dismissedEpisode = makeEpisode({ status: 'dismissed' });
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'evolution.scope.list') return { scopes: [makeScope()] };
			if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
			if (method === 'evolution.review.get') {
				return {
					episodes: [dismissedEpisode],
					lessons: [makeLesson()],
					proposals: [makeProposal()],
				};
			}
			throw new Error(`Unexpected RPC ${method}`);
		});

		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));

		await screen.findByText('Reviewer feedback identified recurring friction.');
		expect(screen.queryByText('Manual rollup writeback')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Apply rollup' })).toBeNull();
	});

	it('hides rollup controls once rollup is applied', async () => {
		const appliedEpisode = makeEpisode({ status: 'accepted', rollupAppliedAt: Date.now() });
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'evolution.scope.list') return { scopes: [makeScope()] };
			if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
			if (method === 'evolution.review.get') {
				return { episodes: [appliedEpisode], lessons: [makeLesson()], proposals: [makeProposal()] };
			}
			throw new Error(`Unexpected RPC ${method}`);
		});

		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));

		await screen.findByText('Reviewer feedback identified recurring friction.');
		expect(screen.queryByText('Manual rollup writeback')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Apply rollup' })).toBeNull();
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

	it('manages active lessons from scope detail', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'lessons' }));

		expect(await screen.findByText('Use checklist before PR')).toBeTruthy();
		fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.lesson.update', {
				id: 'lesson-1',
				params: { status: 'dismissed' },
			})
		);
	});

	it('creates task from proposal from review UI', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Create Task' }));

		await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Task #7 created'));
		expect(mockRequest).toHaveBeenCalledWith('evolution.taskProposal.createTask', {
			id: 'proposal-1',
			params: undefined,
		});
	});

	it('edits and creates task from proposal from review UI', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Edit & Create' }));
		fireEvent.input(screen.getByLabelText('Proposal title'), {
			target: { value: 'Edited review UI task' },
		});
		fireEvent.click(await screen.findByRole('button', { name: 'Save & Create' }));

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.taskProposal.createTask', {
				id: 'proposal-1',
				params: {
					title: 'Edited review UI task',
					description: 'Make accept/dismiss actions clearer',
					reason: 'Reduce NeoKai friction',
					priority: 'high',
				},
			})
		);
	});

	it('dismisses task proposal from review UI', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		fireEvent.click((await screen.findAllByRole('button', { name: 'Dismiss' }))[2]);

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.taskProposal.update', {
				id: 'proposal-1',
				params: { status: 'dismissed' },
			})
		);
	});

	it('applies manual rollup to linked recurring goal from review UI', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		fireEvent.input(await screen.findByLabelText('Rollup summary'), {
			target: { value: 'Rollup summary' },
		});
		fireEvent.input(screen.getByLabelText('Rollup progress'), { target: { value: '80' } });
		fireEvent.input(screen.getByLabelText('Rollup next steps'), {
			target: { value: 'Create follow-up\nMeasure again' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Apply rollup' }));

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.rollup.apply', {
				episodeId: 'episode-1',
				goalUpdate: {
					summary: 'Rollup summary',
					progress: 80,
					nextSteps: ['Create follow-up', 'Measure again'],
				},
			})
		);
		expect(mockUpsertGoal).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'goal-1', summary: 'Rollup summary', progress: 80 })
		);
	});

	it('skips rollup goal cache update after switching spaces', async () => {
		render(<SpaceForge spaceId="space-1" />);

		await screen.findByRole('heading', { name: 'Review quality scope' });
		fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
		fireEvent.input(await screen.findByLabelText('Rollup summary'), {
			target: { value: 'Rollup summary' },
		});
		fireEvent.input(screen.getByLabelText('Rollup progress'), { target: { value: '80' } });
		fireEvent.click(screen.getByRole('button', { name: 'Apply rollup' }));
		mockSpaceId.value = 'space-2';

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('evolution.rollup.apply', expect.anything())
		);
		expect(mockUpsertGoal).not.toHaveBeenCalled();
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
		fireEvent.input(screen.getByTestId('forge-scope-model-select'), {
			target: { value: 'claude-sonnet-4-6' },
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
				policy: {
					episodeJudgeModel: 'claude-sonnet-4-6',
					episodeJudgeProvider: 'anthropic',
				},
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
