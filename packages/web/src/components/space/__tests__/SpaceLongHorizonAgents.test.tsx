// @ts-nocheck

import type { SettingSource, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAgents,
  mockTemplates,
  mockConfigDataLoaded,
  mockEnsureConfigData,
  mockListAgentReminderCounts,
  mockCreateAgent,
  mockUpdateAgent,
  mockNavigateToSpaceSession,
} = vi.hoisted(() => {
  function makeSignal<T>(initial: T) {
    return { value: initial };
  }
  return {
    mockAgents: makeSignal<SpaceLongHorizonAgent[]>([]),
    mockTemplates: makeSignal([]),
    mockConfigDataLoaded: makeSignal(true),
    mockEnsureConfigData: vi.fn().mockResolvedValue(undefined),
    mockListAgentReminderCounts: vi.fn().mockResolvedValue({}),
    mockCreateAgent: vi.fn().mockResolvedValue(undefined),
    mockUpdateAgent: vi.fn().mockResolvedValue(undefined),
    mockNavigateToSpaceSession: vi.fn(),
  };
});

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      agentTemplates: mockTemplates,
      configDataLoaded: mockConfigDataLoaded,
      ensureConfigData: mockEnsureConfigData,
      listAgentReminderCounts: mockListAgentReminderCounts,
      createAgent: mockCreateAgent,
      updateAgent: mockUpdateAgent,
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
    >
      <option value="">— No override —</option>
      <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
      <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
    </select>
  ),
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
    ...overrides,
  };
}

function gutterNumbersFor(textarea: Element): string[] {
  const gutter = (textarea.parentElement as Element).firstElementChild as Element;
  expect(gutter.getAttribute('aria-hidden')).toBe('true');
  return Array.from(gutter.querySelectorAll('span')).map((s) => s.textContent ?? '');
}

function chipLabel(container: Element, tool: string): HTMLElement {
  const label = container.querySelector(`[data-testid="tools-editor-chip-${tool}"]`);
  expect(label, `chip ${tool} rendered`).toBeTruthy();
  return label as HTMLElement;
}

function chipInput(container: Element, tool: string): HTMLInputElement {
  const input = chipLabel(container, tool).querySelector('input');
  expect(input, `chip ${tool} input rendered`).toBeTruthy();
  return input as HTMLInputElement;
}

describe('SpaceLongHorizonAgents', () => {
  beforeEach(() => {
    cleanup();
    mockAgents.value = [];
    mockTemplates.value = [];
    mockConfigDataLoaded.value = true;
    mockEnsureConfigData.mockClear();
    mockListAgentReminderCounts.mockClear();
    mockCreateAgent.mockClear();
    mockUpdateAgent.mockClear();
    mockNavigateToSpaceSession.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the Glass Workspace summary, configured cards, and template hierarchy', () => {
    mockAgents.value = [makeLongHorizonAgent()];
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

  it('edits template instructions through the line-numbered textarea', () => {
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
    const { getByRole, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    const instructionsField = getByPlaceholderText(
      'What should agents created from this template do?'
    );
    expect(gutterNumbersFor(instructionsField)).toEqual(['1', '2', '3', '4', '5']);

    fireEvent.input(instructionsField, { target: { value: 'a\nb\nc\nd\ne\nf' } });
    expect(gutterNumbersFor(instructionsField)).toHaveLength(6);
  });

  it('omits autonomyLevel when saving a migrated worker mirror', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({
        templateKey: 'migration.legacy_space_agent',
        toolPermissions: { tools: ['Read', 'Write'] },
      }),
    ];
    const { getByRole, container } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    expect(chipInput(container, 'Read').checked).toBe(true);
    expect(chipInput(container, 'Bash').checked).toBe(false);
    fireEvent.click(chipLabel(container, 'Bash'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.autonomyLevel).toBeUndefined();
    expect(params.tools).toEqual(['Read', 'Write', 'Bash']);
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
    const { getByRole, container } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(chipLabel(container, 'Bash'));
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
    const { getByRole, getByTestId, container } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = container.querySelectorAll('input[type="text"]');
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
    const { getByRole, getByText, container } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));

    expect(getByText('(inherited)')).toBeTruthy();
    expect(chipInput(container, 'Bash').disabled).toBe(true);
  });

  it('creates an agent with a model pool and no pinned model', async () => {
    const { getByRole, getByTestId, container } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = container.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    const params = mockCreateAgent.mock.calls[0][0];
    expect(params.modelPool).toEqual([
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
    expect(params.model).toBeNull();
  });

  it('omits modelPool when creating an agent in single mode', async () => {
    const { getByRole, container } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = container.querySelectorAll('input[type="text"]');
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

  it('clears the pool when saving after switching to single mode', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({
        modelPool: [
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
        ],
      }),
    ];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByTestId('agent-model-mode-single'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].modelPool).toBeNull();
  });

  it('clears the pinned model when switching to pool mode', async () => {
    mockAgents.value = [makeLongHorizonAgent({ model: 'claude-sonnet-4-6' })];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.model).toBeNull();
    expect(params.modelPool).toBeNull();
  });

  it('drops unnamed pool entries when saving', async () => {
    mockAgents.value = [makeLongHorizonAgent()];
    const { getByRole, getByTestId, getAllByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[1], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    expect(mockUpdateAgent.mock.calls[0][1].modelPool).toEqual([
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('sends modelPool for migrated worker mirrors', async () => {
    const pool = [
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 2, weight: 40 },
    ];
    mockAgents.value = [
      makeLongHorizonAgent({ templateKey: 'migration.legacy_space_agent', modelPool: pool }),
    ];
    const { getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.autonomyLevel).toBeUndefined();
    expect(params.modelPool).toEqual(pool);
  });

  it('persists the selected provider when changing the single model', async () => {
    mockAgents.value = [makeLongHorizonAgent({ model: 'claude-sonnet-4-6', provider: null })];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.change(getByTestId('space-agent-model-select'), {
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

  it('clears the provider when switching a provider-qualified model to pool mode', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ model: 'claude-sonnet-4-6', provider: 'anthropic' }),
    ];
    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledTimes(1));
    const params = mockUpdateAgent.mock.calls[0][1];
    expect(params.model).toBeNull();
    expect(params.provider).toBeNull();
    expect(params.modelPool).toBeNull();
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
    const { getByRole, container } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    fireEvent.click(settingSourceCheckbox('local'));
    const textInputs = container.querySelectorAll('input[type="text"]');
    fireEvent.input(textInputs[0], { target: { value: 'Runner' } });
    fireEvent.input(textInputs[1], { target: { value: 'runner' } });
    fireEvent.click(getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent.mock.calls[0][0].settingSources).toEqual(['user', 'project']);
  });

  it('disables autonomy editing for migrated worker mirrors', () => {
    mockAgents.value = [makeLongHorizonAgent({ templateKey: 'migration.legacy_space_agent' })];
    const { getByRole, getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit Research Long Horizon' }));

    for (const level of ['1', '2', '3', '4', '5']) {
      expect(
        (getByRole('button', { name: level, exact: true }) as HTMLButtonElement).disabled
      ).toBe(true);
    }
    expect(getByText('Autonomy cannot be edited on a migrated worker agent.')).toBeTruthy();
  });

  it('derives a unique display name when a template name is already taken', () => {
    mockAgents.value = [makeLongHorizonAgent({ displayName: 'QA Engineer' })];
    mockTemplates.value = [makeTemplate()];
    const { getByText, getByDisplayValue } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Validates product quality.').closest('button')!);

    expect(getByDisplayValue('QA Engineer 2')).toBeTruthy();
  });

  it('prefills name, handle, and instructions from a template card click', () => {
    mockTemplates.value = [makeTemplate()];
    const { getByText, getByDisplayValue } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Validates product quality.').closest('button')!);

    expect(getByDisplayValue('QA Engineer')).toBeTruthy();
    expect(getByDisplayValue('qa')).toBeTruthy();
    expect(getByDisplayValue('Test the product.')).toBeTruthy();
  });

  it('derives a unique handle when the template handle is already taken', () => {
    mockAgents.value = [makeLongHorizonAgent({ handle: 'qa' })];
    mockTemplates.value = [makeTemplate()];
    const { getByText, getByDisplayValue } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Validates product quality.').closest('button')!);

    expect(getByDisplayValue('qa-2')).toBeTruthy();
  });

  it('creates an agent carrying the template key and prefilled fields', async () => {
    mockTemplates.value = [makeTemplate({ suggestedAutonomyLevel: 3 })];
    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Validates product quality.').closest('button')!);
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

  it('creates a custom agent with a null template key', async () => {
    const { getByRole, container } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = container.querySelectorAll('input[type="text"]');
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
  });

  it('creates a custom agent carrying the tools selected in the editor', async () => {
    const { getByRole, getByTestId, container } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = container.querySelectorAll('input[type="text"]');
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
    const { getByRole, getByTestId, container } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = container.querySelectorAll('input[type="text"]');
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
    const { getByRole, getByTestId, container } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));
    const textInputs = container.querySelectorAll('input[type="text"]');
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

  it('renders a readable empty configured-agent state', () => {
    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByText('No configured agents yet')).toBeTruthy();
    expect(getByText('Add a custom agent or choose a template below.')).toBeTruthy();
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

    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-slug', 'session-research');
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
});
