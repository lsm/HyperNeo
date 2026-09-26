import type { SettingSource, SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockTemplates,
  mockUserTemplateKeys,
  mockCreateTemplate,
  mockUpdateTemplate,
  mockDeleteTemplate,
} = vi.hoisted(() => {
  function makeSignal<T>(initial: T) {
    return { value: initial };
  }
  return {
    mockTemplates: makeSignal<SpaceLongHorizonAgentTemplate[]>([]),
    mockUserTemplateKeys: makeSignal<Set<string>>(new Set()),
    mockCreateTemplate: vi.fn().mockResolvedValue(undefined),
    mockUpdateTemplate: vi.fn().mockResolvedValue(undefined),
    mockDeleteTemplate: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      spaceId: { value: 'space-1' },
      agentTemplates: mockTemplates,
      userTemplateKeys: mockUserTemplateKeys,
      createTemplate: mockCreateTemplate,
      updateTemplate: mockUpdateTemplate,
      deleteTemplate: mockDeleteTemplate,
    };
  },
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
    children: import('preact').ComponentChildren;
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
import { SpaceTemplatesPanel } from '../SpaceTemplatesPanel';

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
    ownershipPatterns: [],
    toolPermissions: {},
    ...overrides,
  } as SpaceLongHorizonAgentTemplate;
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

function chipInput(tool: string): HTMLInputElement {
  const input = chipLabel(tool).querySelector('input');
  expect(input, `chip ${tool} input rendered`).toBeTruthy();
  return input as HTMLInputElement;
}

function renderPanel() {
  return render(
    <SpaceTemplatesPanel
      spaceId="space-1"
      templates={mockTemplates.value}
      userTemplateKeys={mockUserTemplateKeys.value}
    />
  );
}

describe('SpaceTemplatesPanel — template CRUD', () => {
  beforeEach(() => {
    cleanup();
    mockTemplates.value = [];
    mockUserTemplateKeys.value = new Set();
    mockCreateTemplate.mockClear();
    mockUpdateTemplate.mockClear();
    mockDeleteTemplate.mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the templates section with count and grouped rows', () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'qa',
        instructions: 'Test the product.',
      }),
    ];

    const { getByTestId, getByText, getByRole } = renderPanel();

    expect(getByTestId('agent-template-count').textContent).toBe('1');
    expect(getByText('QA Engineer')).toBeTruthy();
    expect(getByRole('button', { name: '+ New Template' })).toBeTruthy();
  });

  it('groups templates by label with an unlabeled custom bucket', () => {
    mockTemplates.value = [
      makeTemplate({ key: 'worker.swe', displayName: 'SWE Worker', labels: ['workflow-worker'] }),
      makeTemplate({
        key: 'task-manager.default',
        displayName: 'Task Manager',
        labels: ['long-horizon'],
      }),
      makeTemplate({ key: 'scribe', displayName: 'Scribe' }),
    ];

    const { getByTestId } = renderPanel();

    expect(getByTestId('agent-template-count').textContent).toBe('3');
    const workers = getByTestId('agent-template-group-workflow-worker');
    const longHorizon = getByTestId('agent-template-group-long-horizon');
    const custom = getByTestId('agent-template-group-custom');
    expect(within(workers).getByText('SWE Worker')).toBeTruthy();
    expect(within(longHorizon).getByText('Task Manager')).toBeTruthy();
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

    const { getByTestId, queryByTestId } = renderPanel();

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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
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

    const { getByRole, getByText } = renderPanel();

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

    const { getByRole, getByDisplayValue } = renderPanel();

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

    const { getByRole, getByDisplayValue } = renderPanel();

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

    const { getByRole, getByDisplayValue } = renderPanel();

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

    const { getByRole, getAllByTestId } = renderPanel();

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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
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

    const { getByRole, getByTestId } = renderPanel();

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

    const { getByRole, getByDisplayValue } = renderPanel();

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

    const { getByRole, getByTestId } = renderPanel();

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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
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

    const { getByRole, getByTestId } = renderPanel();

    fireEvent.click(getByRole('button', { name: 'Delete template Scribe' }));
    fireEvent.click(getByTestId('confirm-delete-template'));

    await waitFor(() =>
      expect(getByTestId('confirm-modal-error').textContent).toBe('Template not found: scribe')
    );
    expect(getByTestId('confirm-modal')).toBeTruthy();
  });

  it('clones a built-in template into an editable draft', async () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'qa',
        handle: 'qa',
        displayName: 'QA Engineer',
        description: 'Validates product quality.',
        instructions: 'Test the product.',
        suggestedAutonomyLevel: 3,
      }),
    ];

    const { getByRole, getByDisplayValue, getByText, getByPlaceholderText } = renderPanel();

    fireEvent.click(getByRole('button', { name: 'Clone template QA Engineer' }));

    expect(getByText('Clone QA Engineer')).toBeTruthy();
    expect(getByDisplayValue('QA Engineer copy')).toBeTruthy();
    expect(getByDisplayValue('qa-copy')).toBeTruthy();
    const keyInput = getByPlaceholderText('e.g. release-readiness.custom') as HTMLInputElement;
    expect(keyInput.disabled).toBe(false);

    fireEvent.input(keyInput, { target: { value: 'qa.custom' } });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'qa.custom',
        handle: 'qa-copy',
        displayName: 'QA Engineer copy',
        instructions: 'Test the product.',
        suggestedAutonomyLevel: 3,
      })
    );
    expect(mockUpdateTemplate).not.toHaveBeenCalled();
  });

  it('opens a dedicated template editor from New Template', () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'qa',
        instructions: 'Test the product.',
      }),
    ];
    const { getByRole, getByText } = renderPanel();

    expect(getByRole('heading', { name: /Agent Templates/ })).toBeTruthy();
    fireEvent.click(getByRole('button', { name: '+ New Template' }));

    expect(getByText('New template')).toBeTruthy();
    expect(getByRole('button', { name: 'Create template' })).toBeTruthy();
    expect(getByRole('button', { name: 'Close modal' })).toBeTruthy();
  });

  it('creates a template from the modal and closes it on success', async () => {
    const { getByRole, getByPlaceholderText, queryByRole } = render(
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
    const { getByRole, getByText } = renderPanel();

    fireEvent.click(getByRole('button', { name: '+ New Template' }));

    expect(document.body.querySelector('[data-testid="tools-editor"]')).toBeTruthy();
    expect(getByText('(inherited)')).toBeTruthy();
    expect(chipInput('Bash').disabled).toBe(true);
  });

  it('creates a template carrying the tools selected in the editor', async () => {
    const { getByRole, getByTestId, getByPlaceholderText } = render(
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
    const { getByRole, getByText, getByPlaceholderText } = renderPanel();

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
    const { getByRole, getByText, getByPlaceholderText } = renderPanel();

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
      <SpaceTemplatesPanel
        spaceId="space-1"
        templates={mockTemplates.value}
        userTemplateKeys={mockUserTemplateKeys.value}
      />
    );

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
    const { getByRole, getByText, getByPlaceholderText } = renderPanel();

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
    const { getByRole, getByText, getByPlaceholderText } = renderPanel();

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
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
  it('edits template instructions through the line-numbered textarea', () => {
    mockTemplates.value = [
      makeTemplate({
        key: 'qa',
        instructions: 'Test the product.',
      }),
    ];
    const { getByRole, getByPlaceholderText } = renderPanel();

    fireEvent.click(getByRole('button', { name: '+ New Template' }));
    const instructionsField = getByPlaceholderText(
      'What should agents created from this template do?'
    );
    expect(gutterNumbersFor(instructionsField)).toEqual(['1', '2', '3', '4', '5']);

    fireEvent.input(instructionsField, { target: { value: 'a\nb\nc\nd\ne\nf' } });
    expect(gutterNumbersFor(instructionsField)).toHaveLength(6);
  });
});
