// @ts-nocheck

import type { SpaceWorkerAgent, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLongHorizonAgents,
  mockSpaceAgents,
  mockTemplates,
  mockConfigDataLoaded,
  mockEnsureConfigData,
  mockListLongHorizonAgentReminderCounts,
  mockNavigateToSpaceSession,
} = vi.hoisted(() => {
  function makeSignal<T>(initial: T) {
    return { value: initial };
  }
  return {
    mockLongHorizonAgents: makeSignal<SpaceLongHorizonAgent[]>([]),
    mockSpaceAgents: makeSignal<SpaceWorkerAgent[]>([]),
    mockTemplates: makeSignal([]),
    mockConfigDataLoaded: makeSignal(true),
    mockEnsureConfigData: vi.fn().mockResolvedValue(undefined),
    mockListLongHorizonAgentReminderCounts: vi.fn().mockResolvedValue({}),
    mockNavigateToSpaceSession: vi.fn(),
  };
});

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      longHorizonAgents: mockLongHorizonAgents,
      agents: mockSpaceAgents,
      longHorizonAgentTemplates: mockTemplates,
      configDataLoaded: mockConfigDataLoaded,
      ensureConfigData: mockEnsureConfigData,
      listLongHorizonAgentReminderCounts: mockListLongHorizonAgentReminderCounts,
    };
  },
}));

vi.mock('../../../lib/router', () => ({
  navigateToSpaceSession: mockNavigateToSpaceSession,
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
  WorkflowModelSelect: () => <select data-testid="model-select" />,
}));

vi.mock('../../ui/Button', () => ({
  Button: (props: { children: unknown; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  ),
}));

vi.mock('../../ui/ConfirmModal', () => ({
  ConfirmModal: () => null,
}));

import { SpaceLongHorizonAgents } from '../SpaceLongHorizonAgents';

function makeLongHorizonAgent(
  overrides: Partial<SpaceLongHorizonAgent> = {}
): SpaceLongHorizonAgent {
  return {
    id: 'lh-1',
    spaceId: 'space-1',
    handle: 'research',
    displayName: 'Research Long Horizon',
    instructions: 'Long-horizon instructions',
    status: 'active',
    autonomyLevel: 2,
    sessionId: 'session-research',
    model: null,
    thinkingLevel: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeSpaceAgent(overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    name: 'Configured Research',
    handle: 'research',
    status: 'active',
    customPrompt: 'Configured agent instructions',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('SpaceLongHorizonAgents', () => {
  beforeEach(() => {
    cleanup();
    mockLongHorizonAgents.value = [];
    mockSpaceAgents.value = [];
    mockTemplates.value = [];
    mockConfigDataLoaded.value = true;
    mockEnsureConfigData.mockClear();
    mockListLongHorizonAgentReminderCounts.mockClear();
    mockNavigateToSpaceSession.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the Glass Workspace summary, configured cards, and template hierarchy', () => {
    mockLongHorizonAgents.value = [makeLongHorizonAgent()];
    mockTemplates.value = [
      {
        key: 'qa',
        handle: 'qa',
        displayName: 'QA Engineer',
        description: 'Validates product quality.',
        instructions: 'Test the product.',
        suggestedAutonomyLevel: 2,
      },
    ];

    const { getByTestId, getByRole, getByText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    expect(getByTestId('space-agents-introduction')).toBeTruthy();
    expect(getByTestId('configured-agent-count').textContent).toBe('1');
    expect(getByTestId('agent-template-count').textContent).toBe('1');
    expect(getByRole('region', { name: 'Configured agents' })).toBeTruthy();
    expect(getByRole('heading', { name: 'Templates · 1' })).toBeTruthy();
    expect(getByText('Research Long Horizon')).toBeTruthy();
    expect(getByText('QA Engineer')).toBeTruthy();
  });

  it('opens a dedicated template editor from New Template', () => {
    mockTemplates.value = [
      {
        key: 'qa',
        handle: 'qa',
        displayName: 'QA Engineer',
        description: 'Validates product quality.',
        instructions: 'Test the product.',
        suggestedAutonomyLevel: 2,
      },
    ];
    const { getByRole, getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByRole('heading', { name: 'Templates · 1' })).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'New Template' }));

    expect(getByText('New template')).toBeTruthy();
    expect(getByRole('button', { name: 'Create template' })).toBeTruthy();
    expect(getByRole('button', { name: 'Close template editor' })).toBeTruthy();
  });

  it('opens the existing editor from the prominent custom agent action', () => {
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));

    expect(getByRole('region', { name: 'Configured agents' })).toBeTruthy();
    expect(getByRole('button', { name: 'Create agent' })).toBeTruthy();
    expect(getByRole('button', { name: 'Close agent editor' })).toBeTruthy();
  });

  it('renders a readable empty configured-agent state', () => {
    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByText('No configured agents yet')).toBeTruthy();
    expect(getByText('Add a custom agent or choose a template below.')).toBeTruthy();
  });

  it('prefers configured SpaceWorkerAgent details when handles overlap', () => {
    mockLongHorizonAgents.value = [makeLongHorizonAgent()];
    mockSpaceAgents.value = [makeSpaceAgent()];

    const { getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" selectedHandle="research" />
    );

    const detail = getByTestId('space-agent-detail');
    expect(detail.textContent).toContain('Configured Research');
    expect(detail.textContent).toContain('Configured Worker Agent');
    expect(detail.textContent).not.toContain('Research Long Horizon');
  });

  it('uses the route space id for agent session navigation', () => {
    mockLongHorizonAgents.value = [makeLongHorizonAgent()];

    const { getByText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" navigationSpaceId="space-slug" />
    );

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-slug', 'session-research');
  });

  it('loads active-reminder counts via a single batched RPC', async () => {
    mockLongHorizonAgents.value = [
      makeLongHorizonAgent({ id: 'lh-1' }),
      makeLongHorizonAgent({ id: 'lh-2', handle: 'qa', displayName: 'QA' }),
    ];
    mockListLongHorizonAgentReminderCounts.mockResolvedValue({ 'lh-1': 3, 'lh-2': 0 });

    const { findByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(await findByText(/3 reminders/)).toBeTruthy();

    await waitFor(() => {
      expect(mockListLongHorizonAgentReminderCounts).toHaveBeenCalledTimes(1);
    });
    expect(mockListLongHorizonAgentReminderCounts).toHaveBeenCalledWith(['lh-1', 'lh-2']);
  });
});
