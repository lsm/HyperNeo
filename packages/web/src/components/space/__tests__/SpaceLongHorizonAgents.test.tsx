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
    // Replaces the former N per-agent `listLongHorizonAgentReminders` fan-out:
    // one round-trip receives `{ [agentId]: n }` for every configured agent.
    mockLongHorizonAgents.value = [
      makeLongHorizonAgent({ id: 'lh-1' }),
      makeLongHorizonAgent({ id: 'lh-2', handle: 'qa', displayName: 'QA' }),
    ];
    mockListLongHorizonAgentReminderCounts.mockResolvedValue({ 'lh-1': 3, 'lh-2': 0 });

    const { findByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    // Active count surfaces on the first agent's card; the zero-count agent
    // renders no reminder badge.
    expect(await findByText(/3 reminders/)).toBeTruthy();

    // Exactly one batched call carrying both agent ids.
    await waitFor(() => {
      expect(mockListLongHorizonAgentReminderCounts).toHaveBeenCalledTimes(1);
    });
    expect(mockListLongHorizonAgentReminderCounts).toHaveBeenCalledWith(['lh-1', 'lh-2']);
  });
});
