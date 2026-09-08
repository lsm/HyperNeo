// @ts-nocheck

import type { SettingSource, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAgents,
  mockTemplates,
  mockConfigDataLoaded,
  mockRuntimeState,
  mockEnsureConfigData,
  mockListAgentReminderCounts,
  mockCreateAgent,
  mockCreateTemplate,
  mockUpdateAgent,
  mockReapplyAgentTemplate,
  mockNavigateToSpaceSession,
  mockEnsureAgentSession,
} = vi.hoisted(() => {
  function makeSignal<T>(initial: T) {
    return { value: initial };
  }
  return {
    mockAgents: makeSignal<SpaceLongHorizonAgent[]>([]),
    mockTemplates: makeSignal([]),
    mockConfigDataLoaded: makeSignal(true),
    mockRuntimeState: makeSignal<'running' | 'paused' | 'stopped' | null>('running'),
    mockEnsureConfigData: vi.fn().mockResolvedValue(undefined),
    mockListAgentReminderCounts: vi.fn().mockResolvedValue({}),
    mockCreateAgent: vi.fn().mockResolvedValue(undefined),
    mockCreateTemplate: vi.fn().mockResolvedValue(undefined),
    mockUpdateAgent: vi.fn().mockResolvedValue(undefined),
    mockReapplyAgentTemplate: vi.fn().mockResolvedValue({ displayName: 'Research Long Horizon' }),
    mockNavigateToSpaceSession: vi.fn(),
    mockEnsureAgentSession: vi.fn().mockResolvedValue('space:agent:space-1:lh-1'),
  };
});

vi.mock('../../../lib/space-store', () => ({
  get spaceStore() {
    return {
      agents: mockAgents,
      agentTemplates: mockTemplates,
      configDataLoaded: mockConfigDataLoaded,
      runtimeState: mockRuntimeState,
      ensureConfigData: mockEnsureConfigData,
      listAgentReminderCounts: mockListAgentReminderCounts,
      createAgent: mockCreateAgent,
      createTemplate: mockCreateTemplate,
      updateAgent: mockUpdateAgent,
      reapplyAgentTemplate: mockReapplyAgentTemplate,
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
import {
  currentSpaceAgentHandleSignal,
  currentSpaceIdSignal,
  currentSpaceSessionIdSignal,
  currentSpaceViewModeSignal,
} from '../../../lib/signals';
import {
  openFreshnessStage,
  openNavigateStage,
  openProvisionStage,
  openRouteStage,
  SpaceLongHorizonAgents,
} from '../SpaceLongHorizonAgents';

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
    mockCreateTemplate.mockClear();
    mockUpdateAgent.mockClear();
    mockNavigateToSpaceSession.mockClear();
    mockEnsureAgentSession.mockClear();
    mockEnsureAgentSession.mockResolvedValue('space:agent:space-1:lh-1');
    vi.mocked(toast.error).mockClear();
    currentSpaceSessionIdSignal.value = null;
    currentSpaceIdSignal.value = null;
    currentSpaceViewModeSignal.value = null;
    currentSpaceAgentHandleSignal.value = null;
    mockRuntimeState.value = 'running';
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the Glass Workspace summary with Templates above the Agents section', () => {
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
      templatesHeading.compareDocumentPosition(agentsHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(getByText('Research Long Horizon')).toBeTruthy();
    expect(getByText('QA Engineer')).toBeTruthy();
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

    const { getByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

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

    const { getByTestId, queryByTestId } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByTestId('agent-template-group-custom')).toBeTruthy();
    expect(queryByTestId('agent-template-group-workflow-worker')).toBeNull();
    expect(queryByTestId('agent-template-group-long-horizon')).toBeNull();
    expect(getByTestId('agent-template-count').textContent).toBe('1');
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
    const { getByRole, getByText, container } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByRole('button', { name: 'New Template' }));

    expect(container.querySelector('[data-testid="tools-editor"]')).toBeTruthy();
    expect(getByText('(inherited)')).toBeTruthy();
    expect(chipInput(container, 'Bash').disabled).toBe(true);
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
    const modelSelect = getByTestId('space-agent-model-select') as HTMLSelectElement;
    modelSelect.value = 'claude-sonnet-4-6';
    fireEvent.change(modelSelect);
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

  it('creates a template with a model pool and no pinned model', async () => {
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
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    const params = mockCreateTemplate.mock.calls[0][0];
    expect(params.modelPool).toEqual([
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
    expect(params.model).toBeNull();
    expect(params.provider).toBeNull();
  });

  it('omits modelPool when creating a template in single mode', async () => {
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
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.click(getByTestId('agent-model-mode-single'));
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].modelPool).toBeNull();
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
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getAllByTestId('pool-entry-model-select')[1], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].modelPool).toEqual([
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('clears the pinned model when creating a template in pool mode', async () => {
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
    const modelSelect = getByTestId('space-agent-model-select') as HTMLSelectElement;
    modelSelect.value = 'claude-sonnet-4-6';
    fireEvent.change(modelSelect);
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    const params = mockCreateTemplate.mock.calls[0][0];
    expect(params.model).toBeNull();
    expect(params.provider).toBeNull();
    expect(params.modelPool).toEqual([
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('discards the single-model selection when switching to pool mode', async () => {
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
    const modelSelect = getByTestId('space-agent-model-select') as HTMLSelectElement;
    modelSelect.value = 'claude-sonnet-4-6';
    fireEvent.change(modelSelect);
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    fireEvent.click(getByTestId('agent-model-mode-single'));
    expect((getByTestId('space-agent-model-select') as HTMLSelectElement).value).toBe('');
    const thinkingSelect = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    expect(thinkingSelect.value).toBe('');
    fireEvent.click(getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].model).toBeNull();
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
    const { getByText, getByRole, container } = render(
      <SpaceLongHorizonAgents spaceId="space-1" />
    );

    fireEvent.click(getByText('Validates product quality.').closest('button')!);

    expect(chipInput(container, 'Read').checked).toBe(true);
    expect(chipInput(container, 'Read').disabled).toBe(false);
    expect(chipInput(container, 'Bash').checked).toBe(false);
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
    expect(mockCreateAgent.mock.calls[0][0].suggestedEventSubscriptions).toBeUndefined();
    expect(mockCreateAgent.mock.calls[0][0].reminderDefaults).toBeUndefined();
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

  it('renders a readable empty agents state pointing at the templates above', () => {
    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByText('No agents yet')).toBeTruthy();
    expect(getByText('Add a custom agent or choose a template above.')).toBeTruthy();
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

  it('re-applies the template from agent detail after confirmation', async () => {
    mockAgents.value = [makeLongHorizonAgent({ templateKey: 'coder.v1' })];
    mockReapplyAgentTemplate.mockResolvedValue(makeLongHorizonAgent({ templateKey: 'coder.v1' }));

    const { getByTestId, queryByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" selectedHandle="research" />
    );

    fireEvent.click(getByTestId('reapply-template-button'));
    fireEvent.click(getByTestId('confirm-reapply-template'));

    await waitFor(() => expect(mockReapplyAgentTemplate).toHaveBeenCalledWith('lh-1'));
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Re-applied template to "Research Long Horizon"'
    );
    await waitFor(() => expect(queryByTestId('confirm-modal')).toBeNull());
  });

  it('shows the RPC error and keeps the confirm dialog open when re-apply fails', async () => {
    mockAgents.value = [makeLongHorizonAgent({ templateKey: 'coder.v1' })];
    mockReapplyAgentTemplate.mockRejectedValue(new Error('Template not found: coder.v1'));

    const { getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" selectedHandle="research" />
    );

    fireEvent.click(getByTestId('reapply-template-button'));
    fireEvent.click(getByTestId('confirm-reapply-template'));

    await waitFor(() =>
      expect(getByTestId('confirm-modal-error').textContent).toBe('Template not found: coder.v1')
    );
    expect(getByTestId('confirm-modal')).toBeTruthy();
  });

  it('disables re-apply template for migrated worker mirrors and explains why', () => {
    mockAgents.value = [makeLongHorizonAgent({ templateKey: 'migration.legacy_space_agent' })];

    const { getByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" selectedHandle="research" />
    );

    const button = getByTestId('reapply-template-button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(getByTestId('space-agent-detail').textContent).toContain(
      'edit the worker agent instead'
    );
  });

  it('omits re-apply template for agents without a template', () => {
    mockAgents.value = [makeLongHorizonAgent({ templateKey: null })];

    const { queryByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" selectedHandle="research" />
    );

    expect(queryByTestId('reapply-template-button')).toBeNull();
  });

  it('keeps the confirm dialog open when dismissed while re-apply is pending', async () => {
    mockAgents.value = [makeLongHorizonAgent({ templateKey: 'coder.v1' })];
    let resolveReapply: (agent: unknown) => void = () => {};
    mockReapplyAgentTemplate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReapply = resolve;
        })
    );

    const { getByTestId, queryByTestId } = render(
      <SpaceLongHorizonAgents spaceId="space-1" selectedHandle="research" />
    );

    fireEvent.click(getByTestId('reapply-template-button'));
    fireEvent.click(getByTestId('confirm-reapply-template'));
    fireEvent.click(getByTestId('confirm-modal-close'));

    expect(getByTestId('confirm-modal')).toBeTruthy();

    resolveReapply(makeLongHorizonAgent({ templateKey: 'coder.v1' }));
    await waitFor(() => expect(queryByTestId('confirm-modal')).toBeNull());
  });

  it('uses the route space id for agent session navigation', () => {
    mockAgents.value = [makeLongHorizonAgent()];

    const { getByText } = render(
      <SpaceLongHorizonAgents spaceId="space-1" navigationSpaceId="space-slug" />
    );

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-slug', 'session-research');
    expect(mockEnsureAgentSession).not.toHaveBeenCalled();
  });

  it('shows session presence separately from clickability on instance cards', () => {
    mockAgents.value = [
      makeLongHorizonAgent(),
      makeLongHorizonAgent({
        id: 'lh-2',
        handle: 'draft',
        displayName: 'Draft Agent',
        status: 'paused',
        sessionId: null,
      }),
      makeLongHorizonAgent({
        id: 'lh-3',
        handle: 'frozen',
        displayName: 'Frozen Agent',
        status: 'paused',
        sessionId: 'session-frozen',
      }),
    ];

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    const liveCard = getByText('Research Long Horizon').closest('[role="button"]');
    expect(liveCard?.textContent).toContain('Session');
    expect(getByText('Draft Agent').closest('[role="button"]')).toBeNull();
    expect(getByText('No session')).toBeTruthy();
    const frozenCard = getByText('Frozen Agent').closest('div.min-h-32');
    expect(frozenCard?.textContent).toContain('Session');
    expect(frozenCard?.getAttribute('role')).toBe('button');
  });

  it('ensures then opens the deterministic session for an active sessionless instance', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    await waitFor(() => {
      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith(
        'space-1',
        'space:agent:space-1:lh-1'
      );
    });
    expect(mockEnsureAgentSession).toHaveBeenCalledWith('lh-1');
  });

  it('shows a toast instead of navigating when ensuring the session fails', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    mockEnsureAgentSession.mockRejectedValueOnce(new Error('Agent session unavailable: lh-1'));

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Agent session unavailable: lh-1');
    });
    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('keeps paused instance cards inert and hides archived ones', () => {
    mockAgents.value = [
      makeLongHorizonAgent({ status: 'paused', sessionId: null }),
      makeLongHorizonAgent({
        id: 'lh-2',
        handle: 'gone',
        displayName: 'Gone Agent',
        status: 'archived',
        sessionId: null,
      }),
    ];

    const { getByText, queryByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon'));

    expect(queryByText('Gone Agent')).toBeNull();
    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
    expect(mockEnsureAgentSession).not.toHaveBeenCalled();
  });

  it('opens on card keystrokes but ignores keystrokes from nested card actions', () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];

    const { getByText, getByLabelText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.keyDown(getByLabelText('Edit Research Long Horizon'), { key: 'Enter' });

    expect(mockEnsureAgentSession).not.toHaveBeenCalled();

    fireEvent.keyDown(getByText('Research Long Horizon').closest('[role="button"]')!, {
      key: 'Enter',
    });

    expect(mockEnsureAgentSession).toHaveBeenCalledWith('lh-1');
  });

  it('does not hijack a newer navigation when a slow ensure completes late', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ sessionId: null }),
      makeLongHorizonAgent({
        id: 'lh-2',
        handle: 'ready',
        displayName: 'Ready Agent',
        sessionId: 'session-ready',
      }),
    ];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    fireEvent.click(getByText('Ready Agent').closest('[role="button"]')!);
    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'session-ready');
    currentSpaceSessionIdSignal.value = 'session-ready';

    resolveEnsure('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).toHaveBeenCalledTimes(1);
  });

  it('lets the latest unstamped card click win regardless of resolution order', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ sessionId: null }),
      makeLongHorizonAgent({
        id: 'lh-2',
        handle: 'second',
        displayName: 'Second Agent',
        sessionId: null,
      }),
    ];
    const pending: Array<(sessionId: string) => void> = [];
    mockEnsureAgentSession.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          pending.push(resolve);
        })
    );

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    fireEvent.click(getByText('Second Agent').closest('[role="button"]')!);

    pending[1]('space:agent:space-1:lh-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockNavigateToSpaceSession).toHaveBeenCalledTimes(1);
    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'space:agent:space-1:lh-2');

    pending[0]('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockNavigateToSpaceSession).toHaveBeenCalledTimes(1);
  });

  it('does not navigate back when the route moves to another space mid-ensure', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    currentSpaceIdSignal.value = 'space-other';

    resolveEnsure('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('suppresses failure toasts from superseded card opens', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ sessionId: null }),
      makeLongHorizonAgent({
        id: 'lh-2',
        handle: 'second',
        displayName: 'Second Agent',
        sessionId: null,
      }),
    ];
    const settle: Array<{
      resolve: (sessionId: string) => void;
      reject: (err: Error) => void;
    }> = [];
    mockEnsureAgentSession.mockImplementation(
      () =>
        new Promise<string>((resolve, reject) => {
          settle.push({ resolve, reject });
        })
    );

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    fireEvent.click(getByText('Second Agent').closest('[role="button"]')!);

    settle[1].resolve('space:agent:space-1:lh-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'space:agent:space-1:lh-2');

    settle[0].reject(new Error('first failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast.error).not.toHaveBeenCalled();
    expect(mockNavigateToSpaceSession).toHaveBeenCalledTimes(1);
  });

  it('suppresses failure toasts once the route has moved on', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    let rejectEnsure: (err: Error) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((_, reject) => {
          rejectEnsure = reject;
        })
    );

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    currentSpaceViewModeSignal.value = 'tasks';

    rejectEnsure(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not navigate when the agent-detail handle changes mid-ensure', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    currentSpaceAgentHandleSignal.value = 'other-agent';

    resolveEnsure('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('invalidates a pending open when the card unmounts', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText, unmount } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    unmount();

    resolveEnsure('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('invalidates a pending open when a nested card action is chosen', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText, getByLabelText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    fireEvent.click(getByLabelText('Edit Research Long Horizon'));

    resolveEnsure('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it("invalidates another card's pending open before showing card actions", async () => {
    mockAgents.value = [
      makeLongHorizonAgent({ sessionId: null }),
      makeLongHorizonAgent({
        id: 'lh-2',
        handle: 'second',
        displayName: 'Second Agent',
        sessionId: null,
      }),
    ];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText, getByLabelText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Second Agent').closest('[role="button"]')!);
    fireEvent.click(getByLabelText('Edit Research Long Horizon'));

    resolveEnsure('space:agent:space-1:lh-2');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('does not cancel the active open when an unrelated card unmounts', async () => {
    const second = makeLongHorizonAgent({
      id: 'lh-2',
      handle: 'second',
      displayName: 'Second Agent',
      sessionId: null,
    });
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null }), second];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText, rerender } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Second Agent').closest('[role="button"]')!);
    mockAgents.value = [second];
    rerender(<SpaceLongHorizonAgents spaceId="space-1" />);

    resolveEnsure('space:agent:space-1:lh-2');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'space:agent:space-1:lh-2');
  });

  it('admits a new open after a superseded request without waiting for it to settle', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    let resolveFirst: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const { getByText, getByLabelText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    fireEvent.click(getByLabelText('Edit Research Long Horizon'));
    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    await waitFor(() => {
      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith(
        'space-1',
        'space:agent:space-1:lh-1'
      );
    });

    resolveFirst('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockNavigateToSpaceSession).toHaveBeenCalledTimes(1);
  });

  it('invalidates a pending open when a pane dialog opens', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText, getByRole } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    fireEvent.click(getByRole('button', { name: '+ Custom agent' }));

    resolveEnsure('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('keeps derived cards inert while the space cannot provision', () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    mockRuntimeState.value = 'paused';

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    expect(getByText('Research Long Horizon').closest('[role="button"]')).toBeNull();
    fireEvent.click(getByText('Research Long Horizon'));

    expect(mockEnsureAgentSession).not.toHaveBeenCalled();
    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('keeps persisted sessions openable while the space is paused', () => {
    mockAgents.value = [makeLongHorizonAgent()];
    mockRuntimeState.value = 'paused';

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);

    expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'session-research');
    expect(mockEnsureAgentSession).not.toHaveBeenCalled();
  });

  it('invalidates a pending open when the agent-detail handle changes', async () => {
    mockAgents.value = [makeLongHorizonAgent({ sessionId: null })];
    let resolveEnsure: (sessionId: string) => void = () => {};
    mockEnsureAgentSession.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveEnsure = resolve;
        })
    );

    const { getByText, rerender } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    fireEvent.click(getByText('Research Long Horizon').closest('[role="button"]')!);
    rerender(<SpaceLongHorizonAgents spaceId="space-1" selectedHandle="qa" />);

    resolveEnsure('space:agent:space-1:lh-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  describe('open-agent-session stages', () => {
    const NULL_ROUTE = {
      space: null,
      canonical: null,
      session: null,
      view: null,
      task: null,
      handle: null,
    };

    it('route stage navigates directly for stamped agents', () => {
      const markOpenSeq = vi.fn();
      const out = openRouteStage(makeLongHorizonAgent(), 'space-1', markOpenSeq);

      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'session-research');
      expect(out.openHalt).toBe('opened_direct');
      expect(out.routeAtOpen).toBeNull();
      expect(markOpenSeq).toHaveBeenCalledWith(out.openSeq);
    });

    it('route stage snapshots the route for unstamped agents', () => {
      const out = openRouteStage(makeLongHorizonAgent({ sessionId: null }), 'space-1', vi.fn());

      expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
      expect(out.openHalt).toBeUndefined();
      expect(out.routeAtOpen).toEqual(NULL_ROUTE);
      expect(out.openSeq).toBeGreaterThan(0);
    });

    it('provision stage records the ensured id when fresh', async () => {
      mockEnsureAgentSession.mockResolvedValueOnce('space:agent:space-1:lh-1');
      const routed = openRouteStage(makeLongHorizonAgent({ sessionId: null }), 'space-1', vi.fn());

      const out = await openProvisionStage(
        makeLongHorizonAgent({ sessionId: null }),
        routed.openSeq,
        routed.routeAtOpen
      );

      expect(out.ensuredSessionId).toBe('space:agent:space-1:lh-1');
      expect(out.openHalt).toBeUndefined();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('provision stage toasts the current request on an unchanged route', async () => {
      mockEnsureAgentSession.mockRejectedValueOnce(new Error('boom'));
      const routed = openRouteStage(makeLongHorizonAgent({ sessionId: null }), 'space-1', vi.fn());

      const out = await openProvisionStage(
        makeLongHorizonAgent({ sessionId: null }),
        routed.openSeq,
        routed.routeAtOpen
      );

      expect(out.openHalt).toBe('ensure_failed');
      expect(toast.error).toHaveBeenCalledWith('boom');
    });

    it('provision stage stays silent for superseded or rerouted requests', async () => {
      mockEnsureAgentSession.mockRejectedValueOnce(new Error('boom'));
      const superseded = openRouteStage(
        makeLongHorizonAgent({ sessionId: null }),
        'space-1',
        vi.fn()
      );
      openRouteStage(makeLongHorizonAgent({ sessionId: null }), 'space-1', vi.fn());
      await openProvisionStage(
        makeLongHorizonAgent({ sessionId: null }),
        superseded.openSeq,
        superseded.routeAtOpen
      );
      expect(toast.error).not.toHaveBeenCalled();

      mockEnsureAgentSession.mockRejectedValueOnce(new Error('boom'));
      const rerouted = openRouteStage(
        makeLongHorizonAgent({ sessionId: null }),
        'space-1',
        vi.fn()
      );
      currentSpaceViewModeSignal.value = 'tasks';
      await openProvisionStage(
        makeLongHorizonAgent({ sessionId: null }),
        rerouted.openSeq,
        rerouted.routeAtOpen
      );
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('freshness stage halts superseded and rerouted requests', () => {
      const superseded = openRouteStage(
        makeLongHorizonAgent({ sessionId: null }),
        'space-1',
        vi.fn()
      );
      openRouteStage(makeLongHorizonAgent({ sessionId: null }), 'space-1', vi.fn());
      expect(openFreshnessStage(superseded.openSeq, superseded.routeAtOpen)).toBe('superseded');

      const rerouted = openRouteStage(
        makeLongHorizonAgent({ sessionId: null }),
        'space-1',
        vi.fn()
      );
      currentSpaceIdSignal.value = 'space-other';
      expect(openFreshnessStage(rerouted.openSeq, rerouted.routeAtOpen)).toBe('route_changed');
    });

    it('freshness stage admits fresh requests and the navigate stage routes them', () => {
      const routed = openRouteStage(makeLongHorizonAgent({ sessionId: null }), 'space-1', vi.fn());

      expect(openFreshnessStage(routed.openSeq, routed.routeAtOpen)).toBeUndefined();
      openNavigateStage('space-1', 'ensured-1');
      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'ensured-1');

      openNavigateStage('space-1', null);
      expect(mockNavigateToSpaceSession).toHaveBeenCalledTimes(1);
    });
  });

  it('treats the space chat as the coordinator session', async () => {
    mockAgents.value = [
      makeLongHorizonAgent({
        handle: 'coordinator',
        displayName: 'Lead Coordinator',
        sessionId: null,
      }),
    ];
    mockEnsureAgentSession.mockResolvedValueOnce('space:chat:space-1');

    const { getByText } = render(<SpaceLongHorizonAgents spaceId="space-1" />);

    const card = getByText('Lead Coordinator').closest('[role="button"]')!;
    expect(card.textContent).toContain('Session');
    fireEvent.click(card);

    await waitFor(() => {
      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'space:chat:space-1');
    });
    expect(mockEnsureAgentSession).toHaveBeenCalledWith('lh-1');
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
