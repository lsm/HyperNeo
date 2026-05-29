// @ts-nocheck

import type { SpaceAgent, SpaceLongHorizonAgent } from '@neokai/shared';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLongHorizonAgents,
  mockSpaceAgents,
  mockTemplates,
  mockConfigDataLoaded,
  mockEnsureConfigData,
  mockListLongHorizonAgentReminders,
  mockNavigateToSpaceSession,
} = vi.hoisted(() => {
  function makeSignal<T>(initial: T) {
    return { value: initial };
  }
  return {
    mockLongHorizonAgents: makeSignal<SpaceLongHorizonAgent[]>([]),
    mockSpaceAgents: makeSignal<SpaceAgent[]>([]),
    mockTemplates: makeSignal([]),
    mockConfigDataLoaded: makeSignal(true),
    mockEnsureConfigData: vi.fn().mockResolvedValue(undefined),
    mockListLongHorizonAgentReminders: vi.fn().mockResolvedValue([]),
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
      listLongHorizonAgentReminders: mockListLongHorizonAgentReminders,
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

function makeSpaceAgent(overrides: Partial<SpaceAgent> = {}): SpaceAgent {
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
    mockListLongHorizonAgentReminders.mockClear();
    mockNavigateToSpaceSession.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('prefers configured SpaceAgent details when handles overlap', () => {
    mockLongHorizonAgents.value = [makeLongHorizonAgent()];
    mockSpaceAgents.value = [makeSpaceAgent()];

    const { getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" selectedHandle="research" />
    );

    const detail = getByTestId('space-agent-detail');
    expect(detail.textContent).toContain('Configured Research');
    expect(detail.textContent).toContain('Configured Space Agent');
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
});
