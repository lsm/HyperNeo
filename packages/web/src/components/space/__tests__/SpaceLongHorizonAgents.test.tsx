// @ts-nocheck

import type { SettingSource, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAgents,
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
} = vi.hoisted(() => {
  function makeSignal<T>(initial: T) {
    return { value: initial };
  }
  return {
    mockAgents: makeSignal<SpaceLongHorizonAgent[]>([]),
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
  };
});

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
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
    };
  },
}));

vi.mock('../../../lib/router', () => ({
  navigateToSpaceSession: mockNavigateToSpaceSession,
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

describe('SpaceLongHorizonAgents', () => {
  beforeEach(() => {
    cleanup();
    mockAgents.value = [];
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
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the Glass Workspace summary with Agents above the Templates section', () => {
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
    expect(getByTestId('agent-instance-count').textContent).toBe('1');
    expect(getByRole('region', { name: 'Agents' })).toBeTruthy();
    const templatesHeading = getByRole('heading', { name: 'Templates · 1' });
    const agentsHeading = getByRole('heading', { name: 'Agents · 1' });
    expect(
      agentsHeading.compareDocumentPosition(templatesHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(getByText('Research Long Horizon')).toBeTruthy();
    expect(getByText('QA Engineer')).toBeTruthy();
  });

  it('groups templates by label with an unlabeled custom bucket', () => {
    mockTemplates.value = [
      makeTemplate({ key: 'worker.swe', displayName: 'SWE Worker', labels: ['workflow-worker'] }),
      makeTemplate({
        key: 'space-manager.default',
        displayName: 'Space Manager',
        labels: ['long-horizon'],
      }),
      makeTemplate({ key: 'scribe', displayName: 'Scribe' }),
    ];

    const { getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByTestId('agent-template-count').textContent).toBe('3');
    const workers = getByTestId('agent-template-group-workflow-worker');
    const longHorizon = getByTestId('agent-template-group-long-horizon');
    const custom = getByTestId('agent-template-group-custom');
    expect(within(workers).getByText('SWE Worker')).toBeTruthy();
    expect(within(longHorizon).getByText('Space Manager')).toBeTruthy();
    expect(within(custom).getByText('Scribe')).toBeTruthy();
    expect(
      workers.compareDocumentPosition(longHorizon) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      longHorizon.compareDocumentPosition(custom) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('hides template groups that have no templates', () => {
    mockTemplates.value = [makeTemplate({ key: 'scribe', displayName: 'Scribe' })];

    const { getByTestId, queryByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByTestId('agent-template-group-custom')).toBeTruthy();
    expect(queryByTestId('agent-template-group-workflow-worker')).toBeNull();
    expect(queryByTestId('agent-template-group-long-horizon')).toBeNull();
    expect(getByTestId('agent-template-count').textContent).toBe('1');
  });

  it('marks built-in templates read-only and offers edit and delete on user templates', () => {
    mockTemplates.value = [
      makeTemplate({ key: 'worker.swe', displayName: 'SWE Worker', labels: ['workflow-worker'] }),
      makeTemplate({ key: 'scribe', displayName: 'Scribe' }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByText, getByRole, queryByRole, getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    const workers = getByTestId('agent-template-group-workflow-worker');
    expect(within(workers).getByText('Built-in')).toBeTruthy();
    expect(queryByRole('button', { name: 'Edit template SWE Worker' })).toBeNull();
    expect(queryByRole('button', { name: 'Delete template SWE Worker' })).toBeNull();
    expect(getByRole('button', { name: 'Edit template Scribe' })).toBeTruthy();
    expect(getByRole('button', { name: 'Delete template Scribe' })).toBeTruthy();
  });

  it('opens the template editor prefilled from a user template card and saves changes', async () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'scribe',
        handle: 'note-taker',
        displayName: 'Scribe',
        description: 'Takes notes.',
        instructions: 'Write everything down.',
        suggestedAutonomyLevel: 2,
        toolPermissions: { tools: ['Read'] },
        version: 7,
      }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByDisplayValue, getByText, queryByRole } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));

    expect(getByText('Edit template')).toBeTruthy();
    const keyInput = getByDisplayValue('scribe') as HTMLInputElement;
    expect(keyInput.disabled).toBe(true);
    expect(getByDisplayValue('note-taker')).toBeTruthy();
    expect(getByDisplayValue('Takes notes.')).toBeTruthy();
    expect(getByDisplayValue('Write everything down.')).toBeTruthy();

    fireEvent.input(getByDisplayValue('Scribe'), { target: { value: 'Scribe II' } });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({
        displayName: 'Scribe II',
        handle: 'note-taker',
        instructions: 'Write everything down.',
        tools: ['Read'],
        expectedVersion: 7,
      })
    );
    expect(mockCreateTemplate).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByRole('button', { name: 'Save changes' })).toBeNull());
  });

  it('shows scoped tool entries in the template editor and persists their removal', async () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'scribe',
        handle: 'scribe',
        displayName: 'Scribe',
        toolPermissions: { tools: ['Read', 'Bash(gh pr view:*)'] },
      }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));

    expect(getByText('Bash(gh pr view:*)')).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Remove Bash(gh pr view:*)' }));
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({ tools: ['Read'] })
    );
  });

  it('preserves a provider-only override when editing a template', async () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'scribe',
        handle: 'scribe',
        displayName: 'Scribe',
        model: null,
        provider: 'anthropic',
      }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByDisplayValue } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));
    fireEvent.input(getByDisplayValue('Scribe'), { target: { value: 'Scribe II' } });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    const providerEdit = mockUpdateTemplate.mock.calls[0][1];
    expect(providerEdit.displayName).toBe('Scribe II');
    expect(providerEdit).not.toHaveProperty('model');
    expect(providerEdit).not.toHaveProperty('provider');
    expect(providerEdit).not.toHaveProperty('modelPool');
  });

  it('preserves both model and pool on an unrelated edit of a dual-state template', async () => {
    const pool = [
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 1 },
    ];
    mockTemplates.value = [
      makeTemplate({
        key: 'scribe',
        handle: 'scribe',
        displayName: 'Scribe',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        modelPool: pool,
      }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByDisplayValue } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));
    fireEvent.input(getByDisplayValue('Scribe'), { target: { value: 'Scribe II' } });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    const dualEdit = mockUpdateTemplate.mock.calls[0][1];
    expect(dualEdit.displayName).toBe('Scribe II');
    expect(dualEdit).not.toHaveProperty('model');
    expect(dualEdit).not.toHaveProperty('provider');
    expect(dualEdit).not.toHaveProperty('modelPool');
  });

  it('preserves instruction whitespace on an unrelated template edit', async () => {
    const instructions = '    indented code block\nsecond line';
    mockTemplates.value = [
      makeTemplate({ key: 'scribe', handle: 'scribe', displayName: 'Scribe', instructions }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByDisplayValue } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));
    fireEvent.input(getByDisplayValue('Scribe'), { target: { value: 'Scribe II' } });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({ instructions })
    );
  });

  it('shows the fixed model, not the inert pool, for a dual-state template', () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'scribe',
        handle: 'scribe',
        displayName: 'Scribe',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        modelPool: [
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
        ],
      }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getAllByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));
    const entries = getAllByTestId('pool-entry-model-select') as HTMLSelectElement[];
    expect(entries).toHaveLength(1);
    expect(entries[0].value).toBe('claude-sonnet-4-6');
  });

  it('clears the fixed model when a dual-state template grows a second entry', async () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'scribe',
        handle: 'scribe',
        displayName: 'Scribe',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        modelPool: [
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
        ],
      }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByTestId, getAllByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[1], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({
        model: null,
        modelPool: [
          { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
          { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
        ],
      })
    );
  });

  it('sends the model fields when the editor changes the model on a template', async () => {
    mockTemplates.value = [
      makeTemplate({ key: 'scribe', handle: 'scribe', displayName: 'Scribe', version: 4 }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        expectedVersion: 4,
      })
    );
  });

  it('omits unchanged model fields from a template edit', async () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'scribe',
        handle: 'scribe',
        displayName: 'Scribe',
        model: 'retired-model-x',
        provider: 'anthropic',
      }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByDisplayValue } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));
    fireEvent.input(getByDisplayValue('Scribe'), { target: { value: 'Scribe II' } });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    const payload = mockUpdateTemplate.mock.calls[0][1];
    expect(payload).toEqual(
      expect.objectContaining({ displayName: 'Scribe II', expectedVersion: undefined })
    );
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('provider');
    expect(payload).not.toHaveProperty('modelPool');
  });

  it('folds a pending scoped tool draft into the save without clicking Add', async () => {
    mockTemplates.value = [
      makeTemplate({ key: 'scribe', handle: 'scribe', displayName: 'Scribe' }),
    ];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Edit template Scribe' }));
    fireEvent.input(getByTestId('lh-template-extra-tool-input'), {
      target: { value: 'Bash(gh pr view:*)' },
    });
    fireEvent.click(getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({ tools: ['Bash(gh pr view:*)'] })
    );
  });

  it('deletes a user template after confirmation, passing the captured version', async () => {
    mockTemplates.value = [makeTemplate({ key: 'scribe', displayName: 'Scribe', version: 3 })];
    mockUserTemplateKeys.value = new Set(['scribe']);

    const { getByRole, getByTestId, queryByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'Delete template Scribe' }));
    expect(getByTestId('confirm-modal')).toBeTruthy();
    fireEvent.click(getByTestId('confirm-delete-template'));

    await waitFor(() => expect(mockDeleteTemplate).toHaveBeenCalledWith('scribe', 3));
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('"Scribe" deleted');
    await waitFor(() => expect(queryByTestId('confirm-modal')).toBeNull());
  });

  it('surfaces the daemon RPC error and keeps the confirm dialog open', async () => {
    mockTemplates.value = [makeTemplate({ key: 'scribe', displayName: 'Scribe' })];
    mockUserTemplateKeys.value = new Set(['scribe']);
    mockDeleteTemplate.mockRejectedValueOnce(new Error('Template not found: scribe'));

    const { getByRole, getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'Delete template Scribe' }));
    fireEvent.click(getByTestId('confirm-delete-template'));

    await waitFor(() =>
      expect(getByTestId('confirm-modal-error').textContent).toBe('Template not found: scribe')
    );
    expect(getByTestId('confirm-modal')).toBeTruthy();
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
    expect(getByRole('button', { name: 'Close modal' })).toBeTruthy();
  });

  it('creates a template from the modal and closes it on success', async () => {
    const { getByRole, getByPlaceholderText, queryByRole } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: '  Release Readiness  ' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: '  release-readiness  ' },
    });
    fireEvent.input(getByPlaceholderText('A concise summary shown on the template card'), {
      target: { value: 'Checks release readiness.' },
    });
    fireEvent.input(getByPlaceholderText('What should agents created from this template do?'), {
      target: { value: 'Verify the release.' },
    });
    fireEvent.click(getByRole('button', { name: '4', exact: true }));
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate).toHaveBeenCalledWith({
      key: 'release-readiness.custom',
      handle: 'release-readiness',
      displayName: 'Release Readiness',
      description: 'Checks release readiness.',
      instructions: 'Verify the release.',
      suggestedAutonomyLevel: 4,
      tools: [],
      model: null,
      provider: null,
      modelPool: null,
      thinkingLevel: null,
      settingSources: null,
    });
    await waitFor(() => expect(queryByRole('button', { name: 'Create template' })).toBeNull());
  });

  it('mounts the tools editor in inherited mode inside the template editor', () => {
    const { getByRole, getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByRole('button', { name: 'New Template' }));

    expect(document.body.querySelector('[data-testid="tools-editor"]')).toBeTruthy();
    expect(getByText('(inherited)')).toBeTruthy();
    expect(chipInput('Bash').disabled).toBe(true);
  });

  it('creates a template carrying the tools selected in the editor', async () => {
    const { getByRole, getByTestId, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByTestId('tools-editor-preset-read-only'));
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['Read', 'Grep', 'Glob'],
      })
    );
  });

  it('persists an empty tools list when Inherit defaults is re-applied on a template', async () => {
    const { getByRole, getByTestId, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByTestId('tools-editor-preset-read-only'));
    fireEvent.click(getByTestId('tools-editor-preset-inherit-defaults'));
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [],
      })
    );
  });

  it('persists model override and thinking level from the template form', async () => {
    const { getByRole, getByPlaceholderText, getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    const thinkingSelect = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    thinkingSelect.value = 'think16k';
    fireEvent.change(thinkingSelect);
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        modelPool: null,
        thinkingLevel: 'think16k',
      })
    );
  });

  it('persists an explicit setting sources selection on template create', async () => {
    const { getByRole, getByText, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    expect(getByText('Inherits the space setting sources.')).toBeTruthy();

    fireEvent.click(settingSourceCheckbox('local'));
    expect(settingSourceCheckbox('local').checked).toBe(false);

    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].settingSources).toEqual(['user', 'project']);
  });

  it('clears a template setting sources override back to inherit', async () => {
    const { getByRole, getByText, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.click(settingSourceCheckbox('local'));
    fireEvent.click(getByRole('button', { name: 'Clear override — inherit from space' }));
    expect(getByText('Inherits the space setting sources.')).toBeTruthy();

    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].settingSources).toBeNull();
  });

  it('creates a template with a multi-model pool and no pinned model', async () => {
    const { getByRole, getByTestId, getAllByTestId, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[0], {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[1], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    const params = mockCreateTemplate.mock.calls[0][0];
    expect(params.modelPool).toEqual([
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
    expect(params.model).toBeNull();
    expect(params.provider).toBeNull();
  });

  it('omits modelPool when the template pool is left empty', async () => {
    const { getByRole, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].modelPool).toBeNull();
    expect(mockCreateTemplate.mock.calls[0][0].model).toBeNull();
  });

  it('drops unnamed pool entries when creating a template', async () => {
    const { getByRole, getByTestId, getAllByTestId, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[0], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.change(getAllByTestId('pool-entry-model-select')[2], {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].modelPool).toEqual([
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('replaces an earlier pool choice when the entry model is changed', async () => {
    const { getByRole, getByTestId, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    const params = mockCreateTemplate.mock.calls[0][0];
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.provider).toBe('anthropic');
    expect(params.modelPool).toBeNull();
  });

  it('clears the model when the last pool entry is removed', async () => {
    const { getByRole, getByTestId, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByTestId('pool-entry-remove-button'));
    const thinkingSelect = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    expect(thinkingSelect.value).toBe('');
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].model).toBeNull();
    expect(mockCreateTemplate.mock.calls[0][0].modelPool).toBeNull();
  });

  it('shows the store error and keeps the modal open when create fails', async () => {
    mockCreateTemplate.mockRejectedValueOnce(
      new Error('Template key already exists: release-readiness.custom')
    );
    const { getByRole, getByText, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness.custom'), {
      target: { value: 'release-readiness.custom' },
    });
    fireEvent.input(getByPlaceholderText('e.g. release-readiness'), {
      target: { value: 'release-readiness' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() =>
      expect(getByText('Template key already exists: release-readiness.custom')).toBeTruthy()
    );
    expect(getByRole('button', { name: 'Create template' })).toBeTruthy();
    expect((getByPlaceholderText('e.g. Release Readiness') as HTMLInputElement).value).toBe(
      'Release Readiness'
    );
  });

  it('requires name, key, and handle before persisting a template', async () => {
    const { getByRole, getByText, getByPlaceholderText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(getByText('Name is required')).toBeTruthy());
    expect(mockCreateTemplate).not.toHaveBeenCalled();

    fireEvent.input(getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(getByText('Template key is required')).toBeTruthy());
    expect(mockCreateTemplate).not.toHaveBeenCalled();
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

  it('prefills setting sources from a template card click', async () => {
    mockTemplates.value = [makeTemplate({ settingSources: ['user'] })];
    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Validates product quality.').closest('button')!);
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

  it('seeds model override and thinking level from the template when creating an agent', async () => {
    mockTemplates.value = [
      makeTemplate({
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        thinkingLevel: 'think16k',
      }),
    ];
    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Validates product quality.').closest('button')!);
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

    fireEvent.click(getByText('Validates product quality.').closest('button')!);
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

    fireEvent.click(getByText('Validates product quality.').closest('button')!);

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

    fireEvent.click(getByText('Validates product quality.').closest('button')!);
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

  it('renders a readable empty agents state pointing at the templates below', () => {
    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByText('No agents yet')).toBeTruthy();
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
    expect(liveCard?.textContent).toContain('Session');
    expect(getByText('Draft Agent').closest('[role="button"]')).toBeTruthy();
    expect(getByText('Start session')).toBeTruthy();
  });

  it('opens the first session of a sessionless agent and navigates to it', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    mockEnsureAgentSession.mockResolvedValue('space:agent:space-1:lh-1');

    const { getByText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" navigationSpaceId="space-slug" />
    );

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    await waitFor(() => {
      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith(
        'space-slug',
        'space:agent:space-1:lh-1'
      );
    });
    expect(mockEnsureAgentSession).toHaveBeenCalledWith('lh-1');
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

  it('navigates to an existing session without opening a new one', () => {
    mockAgents.value = [makeLongHorizonAgent()];

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'session-research');
    expect(mockEnsureAgentSession).not.toHaveBeenCalled();
  });

  it('reports a failed session start instead of navigating nowhere', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    mockEnsureAgentSession.mockRejectedValue(new Error('Space is paused'));

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Space is paused');
    });
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
});
