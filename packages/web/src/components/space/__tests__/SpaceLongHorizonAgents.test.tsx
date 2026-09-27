// @ts-nocheck

import type { SettingSource, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markSpaceSessionRead, spaceSessionLastSeen } from '../../../lib/space-unread';

const mockDeleteAgent = vi.fn();
const {
  mockAgents,
  mockSessions,
  mockTemplates,
  mockUserTemplateKeys,
  mockConfigDataLoaded,
  mockEnsureConfigData,
  mockListAgentReminderCounts,
  mockCreateAgent,
  mockCreateTemplate,
  mockUpdateTemplate,
  mockDeleteTemplate,
  mockUpdateAgent,
  mockEnsureAgentSession,
  mockNavigateToSpaceSession,
  mockNavigateToSpaceAgent,
  mockNavigateToSpaceConfigure,
} = vi.hoisted(() => {
  function makeSignal<T>(initial: T) {
    return { value: initial };
  }
  return {
    mockAgents: makeSignal<SpaceLongHorizonAgent[]>([]),
    mockSessions: makeSignal([]),
    mockTemplates: makeSignal([]),
    mockUserTemplateKeys: makeSignal<Set<string>>(new Set()),
    mockConfigDataLoaded: makeSignal(true),
    mockEnsureConfigData: vi.fn().mockResolvedValue(undefined),
    mockListAgentReminderCounts: vi.fn().mockResolvedValue({}),
    mockCreateAgent: vi.fn().mockResolvedValue(undefined),
    mockCreateTemplate: vi.fn().mockResolvedValue(undefined),
    mockUpdateTemplate: vi.fn().mockResolvedValue(undefined),
    mockDeleteTemplate: vi.fn().mockResolvedValue(undefined),
    mockUpdateAgent: vi.fn().mockResolvedValue(undefined),
    mockEnsureAgentSession: vi.fn().mockResolvedValue('space:agent:space-1:lh-1'),
    mockNavigateToSpaceSession: vi.fn(),
    mockNavigateToSpaceAgent: vi.fn(),
    mockNavigateToSpaceConfigure: vi.fn(),
  };
});

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      sessions: mockSessions,
      spaceId: { value: 'space-1' },
      agentTemplates: mockTemplates,
      userTemplateKeys: mockUserTemplateKeys,
      configDataLoaded: mockConfigDataLoaded,
      ensureConfigData: mockEnsureConfigData,
      listAgentReminderCounts: mockListAgentReminderCounts,
      createAgent: mockCreateAgent,
      createTemplate: mockCreateTemplate,
      updateTemplate: mockUpdateTemplate,
      deleteTemplate: mockDeleteTemplate,
      updateAgent: mockUpdateAgent,
      ensureAgentSession: mockEnsureAgentSession,
      deleteAgent: (...args: unknown[]) => mockDeleteAgent(...args),
    };
  },
}));

vi.mock('../../../lib/router', () => ({
  navigateToSpaceSession: mockNavigateToSpaceSession,
  navigateToSpaceAgent: mockNavigateToSpaceAgent,
  navigateToSpaceConfigure: mockNavigateToSpaceConfigure,
}));

vi.mock('../../../lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
  WorkflowModelSelect: ({
    value,
    onChange,
    testId,
  }: {
    value?: string;
    onChange: (
      value: string | undefined,
      selection?: { provider: string; modelId: string }
    ) => void;
    testId: string;
  }) => (
    <select
      data-testid={testId}
      value={value ?? ''}
      onChange={(e) => {
        const next = (e.target as HTMLSelectElement).value || undefined;
        onChange(next, next ? { provider: 'anthropic', modelId: next } : undefined);
      }}
      onInput={(e) => {
        const next = (e.target as HTMLSelectElement).value || undefined;
        onChange(next, next ? { provider: 'anthropic', modelId: next } : undefined);
      }}
    >
      <option value="">— No override —</option>
      <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
      <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
    </select>
  ),
}));

vi.mock('../../ui/Button', () => ({
  Button: (props: {
    children: unknown;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
    title?: string;
  }) => (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      data-testid={props['data-testid']}
      title={props.title}
    >
      {props.children}
    </button>
  ),
}));

vi.mock('../../ui/ConfirmModal', () => ({
  ConfirmModal: (props: {
    onConfirm: () => void;
    onClose: () => void;
    confirmTestId?: string;
    error?: string | null;
  }) => (
    <div data-testid="confirm-modal">
      {props.error && <p data-testid="confirm-modal-error">{props.error}</p>}
      <button type="button" data-testid={props.confirmTestId} onClick={props.onConfirm}>
        confirm
      </button>
      <button type="button" data-testid="confirm-modal-close" onClick={props.onClose}>
        cancel
      </button>
    </div>
  ),
}));

import { toast } from '../../../lib/toast';
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
    settingSources: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const SETTING_SOURCE_LABELS: Record<SettingSource, string> = {
  user: 'User settings',
  project: 'Project settings + CLAUDE.md',
  local: 'Local settings',
};

function settingSourceCheckbox(source: SettingSource): HTMLInputElement {
  const wrapper = screen.getByText(SETTING_SOURCE_LABELS[source]).closest('label');
  if (!wrapper) throw new Error(`label not found for ${source}`);
  return within(wrapper).getByRole('checkbox') as HTMLInputElement;
}

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    key: 'qa',
    handle: 'qa',
    displayName: 'QA Engineer',
    description: 'Validates product quality.',
    instructions: 'Test the product.',
    suggestedAutonomyLevel: 2,
    suggestedEventSubscriptions: [],
    reminderDefaults: [],
    ...overrides,
  };
}

function gutterNumbersFor(textarea: Element): string[] {
  const gutter = (textarea.parentElement as Element).firstElementChild as Element;
  expect(gutter.getAttribute('aria-hidden')).toBe('true');
  return Array.from(gutter.querySelectorAll('span')).map((s) => s.textContent ?? '');
}

function chipLabel(tool: string): HTMLElement {
  const label = document.body.querySelector(`[data-testid="tools-editor-chip-${tool}"]`);
  expect(label, `chip ${tool} rendered`).toBeTruthy();
  return label as HTMLElement;
}

function chipInput(tool: string): HTMLInputElement {
  const input = chipLabel(tool).querySelector('input');
  expect(input, `chip ${tool} input rendered`).toBeTruthy();
  return input as HTMLInputElement;
}

function startAgentFromTemplate(key: string) {
  fireEvent.click(screen.getByRole('button', { name: '+ Custom agent' }));
  fireEvent.change(screen.getByTestId('agent-template-select'), { target: { value: key } });
}

describe('SpaceLongHorizonAgents', () => {
  beforeEach(() => {
    cleanup();
    mockAgents.value = [];
    mockSessions.value = [];
    spaceSessionLastSeen.value = new Map();
    mockTemplates.value = [];
    mockUserTemplateKeys.value = new Set();
    mockConfigDataLoaded.value = true;
    mockEnsureConfigData.mockClear();
    mockListAgentReminderCounts.mockClear();
    mockCreateAgent.mockClear();
    mockCreateTemplate.mockClear();
    mockUpdateTemplate.mockClear();
    mockDeleteTemplate.mockClear();
    mockUpdateAgent.mockClear();
    mockEnsureAgentSession.mockClear();
    mockEnsureAgentSession.mockResolvedValue('space:agent:space-1:lh-1');
    mockNavigateToSpaceSession.mockClear();
    mockNavigateToSpaceAgent.mockClear();
    mockNavigateToSpaceConfigure.mockClear();
    mockDeleteAgent.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the existing editor from the prominent custom agent action', () => {
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));

    expect(getByRole('region', { name: 'Agents' })).toBeTruthy();
    expect(getByRole('button', { name: 'Create agent' })).toBeTruthy();
    expect(getByRole('button', { name: 'Close modal' })).toBeTruthy();
  });

  it('edits agent instructions through the line-numbered textarea', async () => {
    mockAgents.value = [makeLongHorizonAgent()];
    const { getByRole, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    const instructionsField = getByPlaceholderText('What should this agent do?');
    expect(gutterNumbersFor(instructionsField)).toEqual(['1', '2', '3', '4', '5']);

    const typed = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
    fireEvent.input(instructionsField, { target: { value: typed } });
    expect(gutterNumbersFor(instructionsField)).toHaveLength(7);

    fireEvent.click(getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].instructions).toBe(typed);
  });

  it('sends autonomyLevel and preserves toolPermissions when tools are unchanged', async () => {
    mockAgents.value = [makeLongHorizonAgent({ toolPermissions: { mode: 'restricted' } })];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.autonomyLevel).toBe(2);
    expect(params.tools).toBeUndefined();
    expect(params.toolPermissions).toBeUndefined();
  });

  it('merges changed tools into existing toolPermissions for native agents', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ toolPermissions: { mode: 'restricted', tools: ['Read'] } }),
    ];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(chipLabel('Bash'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.tools).toBeUndefined();
    expect(params.toolPermissions).toEqual({ mode: 'restricted', tools: ['Read', 'Bash'] });
  });

  it('clears tool overrides when Inherit defaults is applied before saving', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ toolPermissions: { mode: 'restricted', tools: ['Read'] } }),
    ];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByTestId('tools-editor-preset-inherit-defaults'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.toolPermissions).toEqual({ mode: 'restricted', tools: [] });
  });

  it('discards a pending scoped tool draft when Inherit defaults is applied', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ toolPermissions: { mode: 'restricted', tools: ['Read'] } }),
    ];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.input(getByTestId('lh-agent-extra-tool-input'), {
      target: { value: 'Bash(gh pr view:*)' },
    });
    fireEvent.click(getByTestId('tools-editor-preset-inherit-defaults'));
    expect((getByTestId('lh-agent-extra-tool-input') as HTMLInputElement).value).toBe('');
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.toolPermissions).toEqual({ mode: 'restricted', tools: [] });
  });

  it('discards a pending scoped tool draft when a replacing preset is applied', async () => {
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.input(getByTestId('lh-agent-extra-tool-input'), {
      target: { value: 'Bash(gh pr view:*)' },
    });
    fireEvent.click(getByTestId('tools-editor-preset-read-only'));
    expect((getByTestId('lh-agent-extra-tool-input') as HTMLInputElement).value).toBe('');
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: 'runner',
        displayName: 'Runner',
        tools: ['Read', 'Grep', 'Glob'],
      })
    );
  });

  it('opens the tools editor in inherited mode for an agent without tool overrides', () => {
    mockAgents.value = [makeLongHorizonAgent()];
    const { getByRole, getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));

    expect(getByText('(inherited)')).toBeTruthy();
    expect(chipInput('Bash').disabled).toBe(true);
  });

  it('creates an agent with a multi-model pool and no pinned model', async () => {
    const { getByRole, getByTestId, getAllByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[0], {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[1], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    const params = mockCreateAgent.mock.calls[0][0];
    expect(params.modelPool).toEqual([
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
    expect(params.model).toBeNull();
  });

  it('stores a lone default pool entry as the scalar model, not a pool', async () => {
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    const params = mockCreateAgent.mock.calls[0][0];
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.provider).toBe('anthropic');
    expect(params.modelPool).toBeUndefined();
  });

  it('keeps a lone pool entry as a pool when its concurrency cap is not the default', async () => {
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.input(getByTestId('pool-entry-max-input'), { target: { value: '3' } });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    const params = mockCreateAgent.mock.calls[0][0];
    expect(params.model).toBeNull();
    expect(params.modelPool).toEqual([
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 3, weight: 100 },
    ]);
  });

  it('omits modelPool when the agent pool is left empty', async () => {
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent.mock.calls[0][0].modelPool).toBeUndefined();
  });

  it('preserves an existing pool when saving in pool mode', async () => {
    const pool = [
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
    ];
    mockAgents.value = [makeLongHorizonAgent({ modelPool: pool })];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    expect(getByTestId('agent-model-pool')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].modelPool).toEqual(pool);
  });

  it('keeps a stored lone default pool entry as a pool on an untouched save', async () => {
    const pool = [
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ];
    mockAgents.value = [makeLongHorizonAgent({ model: null, modelPool: pool })];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.modelPool).toEqual(pool);
    expect(params.model).toBeNull();
  });

  it('preserves the agent thinking level when the model stays a pool', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({
        model: null,
        thinkingLevel: 'think16k',
        modelPool: [
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
          { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 2, weight: 60 },
        ],
      }),
    ];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.thinkingLevel).toBe('think16k');
    expect(params.modelPool).toHaveLength(2);
  });

  it('preserves the agent thinking level when no model is pinned at all', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ model: null, modelPool: null, thinkingLevel: 'think32k' }),
    ];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.thinkingLevel).toBe('think32k');
    expect(params.model).toBeNull();
    expect(params.modelPool).toBeNull();
  });

  it('clears the pool when its only entry is removed', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({
        modelPool: [
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
        ],
      }),
    ];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByTestId('pool-entry-remove-button'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].modelPool).toBeNull();
    expect(mockUpdateAgent.mock.calls[0][1].model).toBeNull();
  });

  it('seeds a one-entry pool from an existing scalar model and saves it back unchanged', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ model: 'claude-sonnet-4-6', provider: 'anthropic' }),
    ];
    const { getByRole, getAllByTestId, getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    expect(getAllByTestId('pool-entry')).toHaveLength(1);
    expect((getByTestId('pool-entry-model-select') as HTMLSelectElement).value).toBe(
      'claude-sonnet-4-6'
    );
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.modelPool).toBeNull();
  });

  it('migrates an agent-level thinking level onto the seeded pool entry', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        thinkingLevel: 'think16k',
      }),
    ];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    expect((getByTestId('pool-entry-thinking-select') as HTMLSelectElement).value).toBe('think16k');
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.thinkingLevel).toBe('think16k');
    expect(params.modelPool).toBeNull();
  });

  it('drops the standalone agent thinking-level control', () => {
    mockAgents.value = [makeLongHorizonAgent({ model: 'claude-sonnet-4-6' })];
    const { getByRole, getAllByTestId, queryAllByRole } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    expect(getAllByTestId('pool-entry-thinking-select')).toHaveLength(1);
    expect(queryAllByRole('option', { name: 'Use app default' })).toHaveLength(0);
  });

  it('drops the single/pool mode toggle from the agent editor', () => {
    mockAgents.value = [makeLongHorizonAgent({ model: 'claude-sonnet-4-6' })];
    const { getByRole, getByTestId, queryByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    expect(getByTestId('agent-model-pool')).toBeTruthy();
    expect(queryByTestId('agent-model-mode-single')).toBeNull();
    expect(queryByTestId('agent-model-mode-pool')).toBeNull();
    expect(queryByTestId('space-agent-model-select')).toBeNull();
  });

  it('drops unnamed pool entries when saving', async () => {
    mockAgents.value = [makeLongHorizonAgent()];
    const { getByRole, getByTestId, getAllByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[0], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.change(getAllByTestId('pool-entry-model-select')[2], {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].modelPool).toEqual([
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('persists the selected provider when changing the sole pool entry model', async () => {
    mockAgents.value = [makeLongHorizonAgent({ model: 'claude-sonnet-4-6', provider: null })];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.provider).toBe('anthropic');
  });

  it('omits the provider key on an untouched save', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ model: 'claude-sonnet-4-6', provider: 'anthropic' }),
    ];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].provider).toBeUndefined();
  });

  it('clears the provider when a provider-qualified model grows into a pool', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ model: 'claude-sonnet-4-6', provider: 'anthropic' }),
    ];
    const { getByRole, getByTestId, getAllByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[1], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.model).toBeNull();
    expect(params.provider).toBeNull();
    expect(params.modelPool).toHaveLength(2);
  });

  it('omits the provider key on an untouched pool-mode save', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({
        model: null,
        modelPool: [
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
        ],
      }),
    ];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.provider).toBeUndefined();
    expect(params.modelPool).toEqual([
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
    ]);
  });

  it('prefills setting sources from an explicit agent override and persists toggles', async () => {
    mockAgents.value = [makeLongHorizonAgent({ settingSources: ['user', 'local'] })];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    expect(settingSourceCheckbox('user').checked).toBe(true);
    expect(settingSourceCheckbox('project').checked).toBe(false);
    expect(settingSourceCheckbox('local').checked).toBe(true);

    fireEvent.click(settingSourceCheckbox('project'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].settingSources).toEqual(['user', 'local', 'project']);
  });

  it('keeps settingSources null when an inheriting agent is saved untouched', async () => {
    mockAgents.value = [makeLongHorizonAgent({ settingSources: null })];
    const { getByRole, getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    expect(getByText('Inherits the space setting sources.')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].settingSources).toBeNull();
  });

  it('clears a setting sources override back to inherit on save', async () => {
    mockAgents.value = [makeLongHorizonAgent({ settingSources: ['user'] })];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByRole('button', { name: 'Clear override — inherit from space' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].settingSources).toBeNull();
  });

  it('persists an explicit setting sources selection on agent create', async () => {
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    fireEvent.click(settingSourceCheckbox('local'));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent.mock.calls[0][0].settingSources).toEqual(['user', 'project']);
  });

  it('derives a unique display name when a template name is already taken', () => {
    mockAgents.value = [makeLongHorizonAgent({ displayName: 'QA Engineer' })];
    mockTemplates.value = [makeTemplate()];
    const { getByDisplayValue, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    startAgentFromTemplate('qa');

    expect(getByDisplayValue('QA Engineer 2')).toBeTruthy();
  });

  it('prefills name, handle, and instructions from the template picker', () => {
    mockTemplates.value = [makeTemplate()];
    const { getByDisplayValue, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    startAgentFromTemplate('qa');

    expect((getByPlaceholderText('e.g. Release Manager') as HTMLInputElement).value).toBe(
      'QA Engineer'
    );
    expect((getByPlaceholderText('e.g. release-manager') as HTMLInputElement).value).toBe('qa');
    expect(getByDisplayValue('Test the product.')).toBeTruthy();
  });

  it('prefills setting sources from a template card click', async () => {
    mockTemplates.value = [makeTemplate({ settingSources: ['user'] })];
    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    startAgentFromTemplate('qa');
    expect(settingSourceCheckbox('user').checked).toBe(true);
    expect(settingSourceCheckbox('project').checked).toBe(false);
    expect(settingSourceCheckbox('local').checked).toBe(false);

    fireEvent.click(getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent.mock.calls[0][0].settingSources).toEqual(['user']);
  });

  it('derives a unique handle when the template handle is already taken', () => {
    mockAgents.value = [makeLongHorizonAgent({ handle: 'qa' })];
    mockTemplates.value = [makeTemplate()];
    const { getByDisplayValue, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    startAgentFromTemplate('qa');

    expect(getByDisplayValue('qa-2')).toBeTruthy();
  });

  it('creates an agent carrying the template key and prefilled fields', async () => {
    mockTemplates.value = [makeTemplate({ suggestedAutonomyLevel: 3 })];
    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    startAgentFromTemplate('qa');
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: 'qa',
        displayName: 'QA Engineer',
        templateKey: 'qa',
        instructions: 'Test the product.',
        autonomyLevel: 3,
        model: null,
        thinkingLevel: null,
      })
    );
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it('seeds model override and thinking level from the template when creating an agent', async () => {
    mockTemplates.value = [
      makeTemplate({
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        thinkingLevel: 'think16k',
      }),
    ];
    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    startAgentFromTemplate('qa');
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: 'qa',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        thinkingLevel: 'think16k',
      })
    );
  });

  it('seeds the model pool from the template when creating an agent', async () => {
    mockTemplates.value = [
      makeTemplate({
        modelPool: [
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
        ],
      }),
    ];
    const { getByText, getByTestId, getByRole } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    startAgentFromTemplate('qa');
    expect(getByTestId('agent-model-pool')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: 'qa',
        modelPool: [
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
        ],
      })
    );
  });

  it('prefills the tools editor from a template card click and persists the tools', async () => {
    mockTemplates.value = [
      makeTemplate({ toolPermissions: { tools: ['Read', 'Bash(gh pr view:*)'] } }),
    ];
    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    startAgentFromTemplate('qa');

    expect(chipInput('Read').checked).toBe(true);
    expect(chipInput('Read').disabled).toBe(false);
    expect(chipInput('Bash').checked).toBe(false);
    expect(getByText('Bash(gh pr view:*)')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: 'qa',
        tools: ['Read', 'Bash(gh pr view:*)'],
      })
    );
  });

  it('seeds suggested event subscriptions and reminder defaults from the template', async () => {
    const suggestedEventSubscriptions = [{ source: 'github', topic: 'pull_request.*', filter: {} }];
    const reminderDefaults = [
      {
        title: 'Review Space plan',
        body: 'Review active goals.',
        triggerType: 'cron',
        cronExpression: '0 9 * * 1',
        timezone: 'UTC',
      },
    ];
    mockTemplates.value = [makeTemplate({ suggestedEventSubscriptions, reminderDefaults })];
    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    startAgentFromTemplate('qa');
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: 'qa',
        suggestedEventSubscriptions,
        reminderDefaults,
      })
    );
  });

  it('creates a custom agent with a null template key', async () => {
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: 'runner',
        displayName: 'Runner',
        templateKey: null,
        settingSources: null,
      })
    );
    expect(mockCreateAgent.mock.calls[0][0].suggestedEventSubscriptions).toBeUndefined();
    expect(mockCreateAgent.mock.calls[0][0].reminderDefaults).toBeUndefined();
  });

  it('creates a custom agent carrying the tools selected in the editor', async () => {
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByTestId('tools-editor-preset-read-only'));
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: 'runner',
        displayName: 'Runner',
        templateKey: null,
        tools: ['Read', 'Grep', 'Glob'],
      })
    );
  });

  it('shows scoped tool entries outside the known grid and removes one individually', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({
        toolPermissions: { tools: ['Read', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)'] },
      }),
    ];
    const { getByRole, getByText, getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));

    expect(getByTestId('lh-agent-extra-tools')).toBeTruthy();
    expect(getByText('Bash(gh pr view:*)')).toBeTruthy();
    expect(getByText('Bash(gh pr diff:*)')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: 'Remove Bash(gh pr view:*)' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.toolPermissions).toEqual({ tools: ['Read', 'Bash(gh pr diff:*)'] });
  });

  it('adds a scoped tool entry from the additional-tools input', async () => {
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.input(getByTestId('lh-agent-extra-tool-input'), {
      target: { value: 'Bash(gh pr view:*)' },
    });
    fireEvent.click(getByRole('button', { name: 'Add', exact: true }));
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: 'runner',
        displayName: 'Runner',
        templateKey: null,
        tools: ['Bash(gh pr view:*)'],
      })
    );
  });

  it('includes a pending scoped tool draft when saving without clicking Add', async () => {
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = document.body.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.input(getByTestId('lh-agent-extra-tool-input'), {
      target: { value: 'Bash(gh pr diff:*)' },
    });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: 'runner',
        displayName: 'Runner',
        tools: ['Bash(gh pr diff:*)'],
      })
    );
  });

  it('renders a readable empty agents state pointing at template presets', () => {
    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByText('No agents yet')).toBeTruthy();
    expect(getByText('Add a custom agent, or pick a template when creating one.')).toBeTruthy();
  });

  it('shows the unified record for a shared handle (worker record no longer wins)', () => {
    mockAgents.value = [makeLongHorizonAgent()];

    const { getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" selectedHandle="research" />
    );

    const detail = getByTestId('space-agent-detail');
    expect(detail.textContent).toContain('Research Long Horizon');
    expect(detail.textContent).toContain('Long-horizon instructions');
    expect(detail.textContent).not.toContain('Configured Worker Agent');
  });

  it('uses the route space id for agent session navigation', () => {
    mockAgents.value = [makeLongHorizonAgent()];

    const { getByText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" navigationSpaceId="space-slug" />
    );

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-slug', 'research');
    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('shows session presence on instance cards', () => {
    mockAgents.value = [
      makeLongHorizonAgent(),
      makeLongHorizonAgent({
        id: 'lh-2',
        handle: 'draft',
        displayName: 'Draft Agent',
        sessionId: null,
      }),
    ];

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    const liveCard = getByText('Research Long Horizon').closest('[role="button"]');
    expect(liveCard?.textContent).toContain('Open chat');
    expect(getByText('Draft Agent').closest('[role="button"]')).toBeTruthy();
    expect(getByText('Start chat')).toBeTruthy();
  });

  it('shows conversation activity separately from agent lifecycle and reacts when read', async () => {
    mockAgents.value = [makeLongHorizonAgent()];
    mockSessions.value = [
      {
        id: 'session-research',
        status: 'active',
        processingState: JSON.stringify({ status: 'waiting_for_input' }),
        messageCount: 3,
      },
    ];
    render(<SpaceLongHorizonAgents spaceId="space-1" />);
    const card = screen.getByText('Research Long Horizon').closest('[role="button"]')!;
    expect(within(card).getByRole('img', { name: 'Waiting for input' })).toBeTruthy();
    expect(within(card).getByText('active')).toBeTruthy();
    expect(within(card).getByLabelText('3 unread messages')).toBeTruthy();
    expect(within(card).queryByTestId('agent-card-new-conversation')).toBeNull();

    markSpaceSessionRead('session-research', 3);
    await waitFor(() => expect(card.textContent).not.toContain('unread'));
  });

  it('opens the agent route for a sessionless agent without starting a session', () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];

    const { getByText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" navigationSpaceId="space-slug" />
    );

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-slug', 'research');
    expect(mockEnsureAgentSession).not.toHaveBeenCalled();
  });

  it('ignores Enter on a nested action button instead of opening the session', () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];

    const { getByRole } = render(
      <SpaceLongHorizonAgents spaceId="space-1" navigationSpaceId="space-slug" />
    );

    fireEvent.keyDown(getByRole('button', { name: 'Edit Research Long Horizon' }), {
      key: 'Enter',
    });

    expect(mockEnsureAgentSession).not.toHaveBeenCalled();
    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('loads active-reminder counts via a single batched RPC', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ id: 'lh-1' }),
      makeLongHorizonAgent({ id: 'lh-2', handle: 'qa', displayName: 'QA' }),
    ];
    mockListAgentReminderCounts.mockResolvedValue({ 'lh-1': 3, 'lh-2': 0 });

    const { findByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(await findByText(/3 reminders/)).toBeTruthy();

    await waitFor(() => {
      expect(mockListAgentReminderCounts).toHaveBeenCalledTimes(1);
    });
    expect(mockListAgentReminderCounts).toHaveBeenCalledWith(['lh-1', 'lh-2']);
  });

  it('carries the clone choice through the unpushed-commits confirmation', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: 'session-research' })];
    mockDeleteAgent
      .mockResolvedValueOnce({ clones: [{ id: 'c1', title: 'Clone one' }] })
      .mockResolvedValueOnce({ commitStatus: { hasCommitsAhead: true, commits: ['abc'] } })
      .mockResolvedValueOnce(null);

    render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(screen.getByLabelText('Delete Research Long Horizon'));
    fireEvent.click(await screen.findByTestId('agent-delete-confirm'));
    fireEvent.click(await screen.findByTestId('clone-choice-cascade'));
    fireEvent.click(await screen.findByTestId('agent-delete-commits-confirm'));

    await waitFor(() => expect(mockDeleteAgent).toHaveBeenCalledTimes(3));
    expect(mockDeleteAgent.mock.calls).toEqual([
      ['lh-1', undefined, undefined],
      ['lh-1', 'cascade', undefined],
      ['lh-1', 'cascade', true],
    ]);
  });
});
