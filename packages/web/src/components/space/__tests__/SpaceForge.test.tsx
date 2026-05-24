import type { EvolutionScope, SpaceGoal } from '@neokai/shared';
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

import { currentSpaceScopeIdSignal, rightPanelTargetSignal } from '../../../lib/signals';
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

function setupRequests(scopes = [makeScope()]) {
  mockRequest.mockImplementation(async (method: string) => {
    if (method === 'evolution.scope.list') return { scopes };
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
    currentSpaceScopeIdSignal.value = null;
    rightPanelTargetSignal.value = null;
    setupRequests();
  });

  afterEach(() => {
    cleanup();
    currentSpaceScopeIdSignal.value = null;
    rightPanelTargetSignal.value = null;
    vi.clearAllMocks();
  });

  it('renders scope list cards without inline detail', async () => {
    render(<SpaceForge spaceId="space-1" />);

    expect(await screen.findByRole('heading', { name: 'Review quality scope' })).toBeTruthy();
    expect(screen.getByText('Improve code review outcomes')).toBeTruthy();
    expect(screen.getByText('Goal: Improve review loop')).toBeTruthy();
    expect(screen.queryByText('Linked recurring goal')).toBeNull();
  });

  it('writes the current scope selection for the right-panel toggle', async () => {
    setupRequests([makeScope(), makeScope({ id: 'scope-2', name: 'Second scope' })]);
    const { unmount } = render(<SpaceForge spaceId="space-1" />);

    await waitFor(() => expect(currentSpaceScopeIdSignal.value).toBe('scope-1'));
    fireEvent.click(screen.getByRole('button', { name: /Second scope/ }));
    expect(currentSpaceScopeIdSignal.value).toBe('scope-2');
    expect(rightPanelTargetSignal.value).toEqual({
      type: 'scope',
      spaceId: 'space-1',
      scopeId: 'scope-2',
    });

    unmount();

    expect(currentSpaceScopeIdSignal.value).toBeNull();
    expect(rightPanelTargetSignal.value).toBeNull();
  });

  it('creates scope with linked recurring goal and metrics', async () => {
    render(<SpaceForge spaceId="space-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create scope' }));
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
    fireEvent.click(screen.getAllByRole('button', { name: 'Create scope' }).at(-1)!);

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
    fireEvent.click(await screen.findByRole('button', { name: 'Create scope' }));
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
