import type {
  EvidenceRef,
  EvolutionEpisode,
  EvolutionLesson,
  EvolutionScope,
  MetricSnapshot,
  SpaceGoal,
  TaskProposal,
} from '@hyperneo/shared';
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
import { ScopeDetailPanel } from '../ScopeDetailPanel';

const mockSpaceId = signal<string | null>('space-1');
const mockGoals = signal<SpaceGoal[]>([]);
const mockUpsertGoal = vi.fn((goal: SpaceGoal) => {
  mockGoals.value = [goal, ...mockGoals.value.filter((current) => current.id !== goal.id)];
});

const mutableSpaceStore = spaceStore as unknown as {
  spaceId: Signal<string | null>;
  goals: Signal<SpaceGoal[]>;
  upsertGoal: typeof mockUpsertGoal;
};
mutableSpaceStore.spaceId = mockSpaceId;
mutableSpaceStore.goals = mockGoals;
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
    revision: 2,
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
        domain: 'hyperneo_product',
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
    reason: 'Reduce HyperNeo friction',
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
    if (method === 'evolution.scope.get') {
      const { id } = (data as { id: string }) ?? { id: scope.id };
      return { scope: id === scope.id ? scope : makeScope({ id }) };
    }
    if (method === 'evolution.evidence.list') return { evidence };
    if (method === 'evolution.metricSnapshot.list') return { snapshots: [snapshot] };
    if (method === 'evolution.review.get') {
      return { episodes: [episode], lessons: [lesson], proposals: [proposal] };
    }
    if (method === 'evolution.lesson.list') {
      return { lessons: [makeLesson({ status: 'active' })] };
    }
    if (method === 'evolution.episode.createFromEvidence') {
      return {
        episode: makeEpisode({ id: 'episode-2', title: 'Generated episode' }),
        lessons: [makeLesson({ id: 'lesson-2', rule: 'Generated lesson' })],
        proposals: [makeProposal({ id: 'proposal-2', title: 'Generated proposal' })],
      };
    }
    if (method === 'evolution.episode.update') {
      return { episode: makeEpisode({ status: 'accepted' }) };
    }
    if (method === 'evolution.lesson.update') {
      const payload = data as { id: string; params: { status: EvolutionLesson['status'] } };
      return { lesson: makeLesson({ status: payload.params.status }) };
    }
    if (method === 'evolution.taskProposal.update') {
      const payload = data as { id: string; params: { status: TaskProposal['status'] } };
      return { proposal: makeProposal({ status: payload.params.status }) };
    }
    if (method === 'evolution.taskProposal.createTask') {
      const payload = data as { id: string; params?: Partial<TaskProposal> };
      return {
        proposal: makeProposal({ status: 'created', createdTaskId: 'task-1' }),
        task: { id: 'task-1', taskNumber: 7, title: payload.params?.title ?? 'Improve review UI' },
      };
    }
    if (method === 'evolution.rollup.apply') {
      return {
        episode: makeEpisode({ status: 'accepted', rollupAppliedAt: Date.now() }),
        goal: makeGoal({ summary: 'Rollup summary', progress: 80 }),
      };
    }
    if (method === 'evolution.evidence.addManualNote') {
      return { evidence: makeEvidence({ id: 'evidence-2', summary: 'Manual proof' }) };
    }
    if (method === 'evolution.metricSnapshot.create') {
      return { snapshot: makeSnapshot({ id: 'snapshot-2', values: { latency: 3 } }) };
    }
    if (method === 'evolution.scope.update') {
      const payload = data as {
        id: string;
        params: { policy?: EvolutionScope['policy']; policyPatch?: EvolutionScope['policy'] };
      };
      const basePolicy = makeScope().policy;
      const policy = payload.params.policy ?? {
        ...basePolicy,
        ...payload.params.policyPatch,
        automation: payload.params.policyPatch?.automation
          ? { ...(basePolicy.automation ?? {}), ...payload.params.policyPatch.automation }
          : basePolicy.automation,
      };
      return { scope: makeScope({ policy }) };
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
}

function renderPanel(scopeId = 'scope-1') {
  return render(<ScopeDetailPanel spaceId="space-1" scopeId={scopeId} />);
}

describe('ScopeDetailPanel', () => {
  beforeEach(() => {
    mockSpaceId.value = 'space-1';
    mockGoals.value = [makeGoal()];
    setupRequests();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders scope detail, linked goal, and metric definitions', async () => {
    renderPanel();

    expect(await screen.findByRole('heading', { name: 'Review quality scope' })).toBeTruthy();
    expect(screen.getAllByText('Improve code review outcomes').length).toBeGreaterThan(0);
    expect(screen.getByText('Linked recurring goal')).toBeTruthy();
    expect(screen.getByText('Reviews are faster')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'metrics' }));
    expect(screen.getAllByText('Review latency').length).toBeGreaterThan(0);
  });

  it('shows a fallback when the scope is missing', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'evolution.scope.get') return { scope: null };
      throw new Error(`Unexpected RPC ${method}`);
    });
    renderPanel('missing');

    expect(await screen.findByText('This scope is no longer available.')).toBeTruthy();
  });

  it('clears stale scope detail while loading a new scope target', async () => {
    let resolveScope2: (value: { scope: EvolutionScope }) => void = () => undefined;
    mockRequest.mockImplementation(async (method: string, data?: unknown) => {
      if (method === 'evolution.scope.get') {
        const { id } = data as { id: string };
        if (id === 'scope-2') {
          return new Promise((resolve) => {
            resolveScope2 = resolve;
          });
        }
        return { scope: makeScope({ id }) };
      }
      if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
      if (method === 'evolution.metricSnapshot.list') return { snapshots: [makeSnapshot()] };
      if (method === 'evolution.review.get') {
        return { episodes: [makeEpisode()], lessons: [makeLesson()], proposals: [makeProposal()] };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const { rerender } = renderPanel('scope-1');

    expect(await screen.findByRole('heading', { name: 'Review quality scope' })).toBeTruthy();
    rerender(<ScopeDetailPanel spaceId="space-1" scopeId="scope-2" />);

    await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Review quality scope' })).toBeNull();
    expect(screen.queryByTestId('scope-episode-judge-model-select')).toBeNull();

    resolveScope2({ scope: makeScope({ id: 'scope-2', name: 'Second scope' }) });
    expect(await screen.findByRole('heading', { name: 'Second scope' })).toBeTruthy();
  });

  it('clears pending automation updates when switching scopes', async () => {
    let resolveScope2: (value: { scope: EvolutionScope }) => void = () => undefined;
    mockRequest.mockImplementation(async (method: string, data?: unknown) => {
      if (method === 'evolution.scope.get') {
        const { id } = data as { id: string };
        if (id === 'scope-2') {
          return new Promise((resolve) => {
            resolveScope2 = resolve;
          });
        }
        return { scope: makeScope({ id }) };
      }
      if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
      if (method === 'evolution.metricSnapshot.list') return { snapshots: [makeSnapshot()] };
      if (method === 'evolution.review.get') {
        return { episodes: [makeEpisode()], lessons: [makeLesson()], proposals: [makeProposal()] };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const { rerender } = renderPanel('scope-1');

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.click(screen.getByLabelText('Enable count-based episode drafts'));

    rerender(<ScopeDetailPanel spaceId="space-1" scopeId="scope-2" />);
    await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy());
    resolveScope2({ scope: makeScope({ id: 'scope-2', name: 'Second scope' }) });
    await screen.findByRole('heading', { name: 'Second scope' });

    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(500);
      expect(mockRequest).not.toHaveBeenCalledWith(
        'evolution.scope.update',
        expect.objectContaining({ id: 'scope-1' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale in-flight automation saves after scope change', async () => {
    let resolveUpdate: (value: { scope: EvolutionScope }) => void = () => undefined;
    let resolveScope2: (value: { scope: EvolutionScope }) => void = () => undefined;
    mockRequest.mockImplementation(async (method: string, data?: unknown) => {
      if (method === 'evolution.scope.get') {
        const { id } = data as { id: string };
        if (id === 'scope-2') {
          return new Promise((resolve) => {
            resolveScope2 = resolve;
          });
        }
        return { scope: makeScope({ id }) };
      }
      if (method === 'evolution.scope.update') {
        return new Promise((resolve) => {
          resolveUpdate = resolve;
        });
      }
      if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
      if (method === 'evolution.metricSnapshot.list') return { snapshots: [makeSnapshot()] };
      if (method === 'evolution.review.get') {
        return { episodes: [makeEpisode()], lessons: [makeLesson()], proposals: [makeProposal()] };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    const { rerender } = renderPanel('scope-1');

    await screen.findByRole('heading', { name: 'Review quality scope' });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByLabelText('Enable count-based episode drafts'));
      await vi.advanceTimersByTimeAsync(300);

      expect(
        (screen.getByLabelText('Enable count-based episode drafts') as HTMLInputElement).disabled
      ).toBe(true);

      rerender(<ScopeDetailPanel spaceId="space-1" scopeId="scope-2" />);
      await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy());
      resolveScope2({ scope: makeScope({ id: 'scope-2', name: 'Second scope' }) });
      await screen.findByRole('heading', { name: 'Second scope' });

      resolveUpdate({ scope: makeScope({ id: 'scope-1' }) });
      await waitFor(() =>
        expect(
          (screen.getByLabelText('Enable count-based episode drafts') as HTMLInputElement).disabled
        ).toBe(false)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the judge model while preserving policy keys', async () => {
    setupRequests(makeScope({ policy: { maxActiveLessons: 3 } }));
    renderPanel();

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
        policyPatch: {
          episodeJudgeModel: 'claude-sonnet-4-6',
          episodeJudgeProvider: 'anthropic',
        },
      },
    });
  });

  it('updates completed-task automation settings while preserving threshold', async () => {
    setupRequests(
      makeScope({
        policy: {
          maxActiveLessons: 3,
          automation: { completedTaskThreshold: 7 },
        },
      })
    );
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByLabelText('Enable count-based episode drafts'));
      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Completed-task automation updated')
      );
      expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
        id: 'scope-1',
        params: {
          policyPatch: {
            automation: {
              completedTaskAutomationEnabled: false,
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send synthetic threshold for recurring goals when enabling', async () => {
    setupRequests(makeScope({ policy: { automation: { completedTaskAutomationEnabled: false } } }));
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByLabelText('Enable count-based episode drafts'));
      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Completed-task automation updated')
      );
      expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
        id: 'scope-1',
        params: {
          policyPatch: {
            automation: {
              completedTaskAutomationEnabled: true,
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends default threshold for non-recurring goals when enabling', async () => {
    mockGoals.value = [{ ...makeGoal(), type: 'one_shot' }];
    setupRequests(makeScope({ policy: { automation: { completedTaskAutomationEnabled: false } } }));
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByLabelText('Enable count-based episode drafts'));
      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Completed-task automation updated')
      );
      expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
        id: 'scope-1',
        params: {
          policyPatch: {
            automation: {
              completedTaskAutomationEnabled: true,
              completedTaskThreshold: 10,
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates completed-task automation threshold', async () => {
    setupRequests(makeScope({ policy: { automation: { completedTaskThreshold: 7 } } }));
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    mockRequest.mockClear();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('scope-completed-task-threshold-input'), {
        target: { value: '12' },
      });

      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Completed-task automation updated')
      );
      expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
        id: 'scope-1',
        params: {
          policyPatch: {
            automation: { completedTaskThreshold: 12 },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces rapid completed-task threshold edits', async () => {
    setupRequests(makeScope({ policy: { automation: { completedTaskThreshold: 7 } } }));
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    mockRequest.mockClear();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('scope-completed-task-threshold-input'), {
        target: { value: '12' },
      });
      fireEvent.change(screen.getByTestId('scope-completed-task-threshold-input'), {
        target: { value: '15' },
      });

      expect(
        (screen.getByTestId('scope-completed-task-threshold-input') as HTMLInputElement).disabled
      ).toBe(false);
      expect(mockRequest).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
          id: 'scope-1',
          params: {
            policyPatch: {
              automation: { completedTaskThreshold: 15 },
            },
          },
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces rapid checkbox toggles through the same debounce', async () => {
    setupRequests(makeScope({ policy: { automation: { completedTaskAutomationEnabled: false } } }));
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    mockRequest.mockClear();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByLabelText('Enable count-based episode drafts'));
      fireEvent.click(screen.getByLabelText('Enable count-based episode drafts'));

      expect(mockRequest).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Completed-task automation updated')
      );
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
        id: 'scope-1',
        params: {
          policyPatch: {
            automation: {
              completedTaskAutomationEnabled: false,
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('accumulates checkbox and threshold changes into a single patch', async () => {
    setupRequests(makeScope({ policy: { automation: { completedTaskAutomationEnabled: false } } }));
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    mockRequest.mockClear();
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByLabelText('Enable count-based episode drafts'));
      fireEvent.change(screen.getByTestId('scope-completed-task-threshold-input'), {
        target: { value: '12' },
      });

      expect(mockRequest).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Completed-task automation updated')
      );
      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
        id: 'scope-1',
        params: {
          policyPatch: {
            automation: {
              completedTaskAutomationEnabled: true,
              completedTaskThreshold: 12,
            },
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows default completed-task automation threshold', async () => {
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });

    expect(
      (screen.getByTestId('scope-completed-task-threshold-input') as HTMLInputElement).value
    ).toBe('10');
  });

  it('shows completed-task automation disabled for non-recurring default scopes', async () => {
    mockGoals.value = [makeGoal({ type: 'one_shot' })];
    setupRequests(makeScope({ policy: {} }));
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });

    expect(
      (screen.getByLabelText('Enable count-based episode drafts') as HTMLInputElement).checked
    ).toBe(false);
    expect(
      (screen.getByTestId('scope-completed-task-threshold-input') as HTMLInputElement).value
    ).toBe('10');
    expect(
      (screen.getByTestId('scope-completed-task-threshold-input') as HTMLInputElement).disabled
    ).toBe(true);
  });

  it('clears completed-task automation saving state on invalid input', async () => {
    setupRequests(makeScope({ policy: { automation: { completedTaskThreshold: 7 } } }));
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('scope-completed-task-threshold-input'), {
        target: { value: '0' },
      });

      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(screen.getByText('Completed-task threshold must be a positive integer')).toBeTruthy()
      );
      expect(screen.queryByText('Saving…')).toBeNull();
      expect(
        (screen.getByLabelText('Enable count-based episode drafts') as HTMLInputElement).disabled
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale completed-task automation update responses', async () => {
    let resolveFirst: (value: { scope: EvolutionScope }) => void = () => undefined;
    mockRequest.mockImplementation(async (method: string, data?: unknown) => {
      if (method === 'evolution.scope.get') {
        return { scope: makeScope({ policy: { automation: { completedTaskThreshold: 7 } } }) };
      }
      if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
      if (method === 'evolution.metricSnapshot.list') return { snapshots: [makeSnapshot()] };
      if (method === 'evolution.review.get') {
        return { episodes: [makeEpisode()], lessons: [makeLesson()], proposals: [makeProposal()] };
      }
      if (method === 'evolution.scope.update') {
        const payload = data as { params: { policyPatch: EvolutionScope['policy'] } };
        if (payload.params.policyPatch.automation?.completedTaskThreshold === 12) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { scope: makeScope({ policy: payload.params.policyPatch }) };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    renderPanel();
    mockRequest.mockClear();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByTestId('scope-completed-task-threshold-input'), {
        target: { value: '12' },
      });
      fireEvent.change(screen.getByTestId('scope-completed-task-threshold-input'), {
        target: { value: '13' },
      });

      vi.advanceTimersByTime(300);
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith('Completed-task automation updated')
      );
      resolveFirst({
        scope: makeScope({ policy: { automation: { completedTaskThreshold: 12 } } }),
      });

      await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
      expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
        id: 'scope-1',
        params: { policyPatch: { automation: { completedTaskThreshold: 13 } } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the judge model override', async () => {
    setupRequests(
      makeScope({
        policy: {
          maxActiveLessons: 3,
          episodeJudgeModel: 'claude-sonnet-4-5',
          episodeJudgeProvider: 'anthropic',
        },
      })
    );
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.change(screen.getByTestId('scope-episode-judge-model-select'), {
      target: { value: '' },
    });

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('Episode judge model override cleared')
    );
    expect(mockRequest).toHaveBeenCalledWith('evolution.scope.update', {
      id: 'scope-1',
      params: {
        policyPatch: {
          episodeJudgeModel: null,
          episodeJudgeProvider: null,
        },
      },
    });
  });

  it('ignores stale judge model update responses', async () => {
    let resolveFirst: (value: { scope: EvolutionScope }) => void = () => undefined;
    mockRequest.mockImplementation(async (method: string, data?: unknown) => {
      if (method === 'evolution.scope.get') return { scope: makeScope() };
      if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
      if (method === 'evolution.metricSnapshot.list') return { snapshots: [makeSnapshot()] };
      if (method === 'evolution.review.get') {
        return { episodes: [makeEpisode()], lessons: [makeLesson()], proposals: [makeProposal()] };
      }
      if (method === 'evolution.scope.update') {
        const payload = data as { params: { policyPatch: EvolutionScope['policy'] } };
        if (payload.params.policyPatch.episodeJudgeModel === 'claude-sonnet-4-6') {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { scope: makeScope({ policy: payload.params.policyPatch }) };
      }
      throw new Error(`Unexpected RPC ${method}`);
    });
    renderPanel();

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

  it('attaches a manual evidence note', async () => {
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.click(screen.getByRole('button', { name: 'evidence' }));
    fireEvent.input(
      screen.getByPlaceholderText('What happened? What evidence should Evolve remember?'),
      { target: { value: 'Manual proof' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Attach note' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Evidence note attached'));
    expect(mockRequest).toHaveBeenCalledWith('evolution.evidence.addManualNote', {
      scopeId: 'scope-1',
      summary: 'Manual proof',
    });
  });

  it('adds a metric snapshot from metric definitions', async () => {
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.click(screen.getByRole('button', { name: 'metrics' }));
    fireEvent.input(screen.getByPlaceholderText('hours'), { target: { value: '3' } });
    fireEvent.input(screen.getByPlaceholderText('Optional snapshot note'), {
      target: { value: 'Improved' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add snapshot' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Metric snapshot added'));
    expect(mockRequest).toHaveBeenCalledWith('evolution.metricSnapshot.create', {
      params: { scopeId: 'scope-1', values: { latency: 3 }, source: 'manual', note: 'Improved' },
    });
  });

  it('renders episode review and generates an episode from evidence', async () => {
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.click(screen.getByRole('button', { name: 'episodes' }));

    expect(
      await screen.findByText('Reviewer feedback identified recurring friction.')
    ).toBeTruthy();
    expect(screen.getByText('Use checklist before PR')).toBeTruthy();
    expect(screen.getByText('Improve review UI')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Reviewer found regression before merge/));
    expect(await screen.findByText('Evidence preflight: low confidence')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Generate low-confidence episode anyway'));
    fireEvent.click(screen.getByRole('button', { name: 'Create episode' }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('Episode "Generated episode" drafted')
    );
    expect(mockRequest).toHaveBeenCalledWith(
      'evolution.episode.createFromEvidence',
      { scopeId: 'scope-1', evidenceIds: ['evidence-1'], confirmLowConfidence: true },
      { timeout: 120000 }
    );
  });

  it('accepts the latest episode draft without hiding rollup controls', async () => {
    renderPanel();

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

  it('hides rollup controls for dismissed episodes', async () => {
    mockRequest.mockImplementation(async (method: string, data?: unknown) => {
      if (method === 'evolution.scope.get') return { scope: makeScope() };
      if (method === 'evolution.evidence.list') return { evidence: [makeEvidence()] };
      if (method === 'evolution.review.get') {
        return {
          episodes: [makeEpisode({ status: 'dismissed' })],
          lessons: [makeLesson()],
          proposals: [makeProposal()],
        };
      }
      throw new Error(`Unexpected RPC ${method} ${JSON.stringify(data)}`);
    });
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.click(screen.getByRole('button', { name: 'episodes' }));

    await screen.findByText('Reviewer feedback identified recurring friction.');
    expect(screen.queryByText('Manual rollup writeback')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply rollup' })).toBeNull();
  });

  it('activates a candidate lesson from the review UI', async () => {
    renderPanel();

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

  it('manages active lessons from the lessons tab', async () => {
    renderPanel();

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

  it('creates a task from a proposal', async () => {
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Task #7 created'));
    expect(mockRequest).toHaveBeenCalledWith('evolution.taskProposal.createTask', {
      id: 'proposal-1',
      params: undefined,
    });
  });

  it('dismisses a task proposal', async () => {
    renderPanel();

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

  it('applies a manual rollup to the linked recurring goal', async () => {
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
    fireEvent.input(await screen.findByLabelText('Rollup summary'), {
      target: { value: 'Rollup summary' },
    });
    fireEvent.input(screen.getByLabelText('Rollup next steps'), {
      target: { value: 'Create follow-up\nMeasure again' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply rollup' }));

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('evolution.rollup.apply', {
        episodeId: 'episode-1',
        goalUpdate: {
          summary: 'Rollup summary',
          nextSteps: ['Create follow-up', 'Measure again'],
        },
      })
    );
    expect(mockUpsertGoal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'goal-1', summary: 'Rollup summary' })
    );
  });

  it('skips the rollup goal cache update after switching spaces', async () => {
    renderPanel();

    await screen.findByRole('heading', { name: 'Review quality scope' });
    fireEvent.click(screen.getByRole('button', { name: 'episodes' }));
    fireEvent.input(await screen.findByLabelText('Rollup summary'), {
      target: { value: 'Rollup summary' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply rollup' }));
    mockSpaceId.value = 'space-2';

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('evolution.rollup.apply', expect.anything())
    );
    expect(mockUpsertGoal).not.toHaveBeenCalled();
  });
});
