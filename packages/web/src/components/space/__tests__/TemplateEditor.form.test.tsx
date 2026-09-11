// @ts-nocheck

import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateTemplate, mockUpdateTemplate } = vi.hoisted(() => ({
  mockCreateTemplate: vi.fn().mockResolvedValue(undefined),
  mockUpdateTemplate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/space-store', () => ({
  spaceStore: {
    createTemplate: mockCreateTemplate,
    updateTemplate: mockUpdateTemplate,
  },
}));

vi.mock('../../../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

import { TemplateEditor } from '../TemplateEditor';

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

function renderEditor(template: Record<string, unknown> | null) {
  return render(<TemplateEditor template={template} onSaved={vi.fn()} onCancel={vi.fn()} />);
}

function fillRequiredFields(view: ReturnType<typeof renderEditor>) {
  fireEvent.input(view.getByPlaceholderText('e.g. Release Readiness'), {
    target: { value: 'Release Readiness' },
  });
  fireEvent.input(view.getByPlaceholderText('e.g. release-readiness.custom'), {
    target: { value: 'release-readiness.custom' },
  });
  fireEvent.input(view.getByPlaceholderText('e.g. release-readiness'), {
    target: { value: 'release-readiness' },
  });
}

const SETTING_SOURCE_LABELS = {
  user: 'User settings',
  project: 'Project settings + CLAUDE.md',
  local: 'Local settings',
};

function settingSourceCheckbox(source: 'user' | 'project' | 'local'): HTMLInputElement {
  const wrapper = screen.getByText(SETTING_SOURCE_LABELS[source]).closest('label');
  if (!wrapper) throw new Error(`label not found for ${source}`);
  return within(wrapper).getByRole('checkbox') as HTMLInputElement;
}

describe('TemplateEditor form', () => {
  beforeEach(() => {
    mockCreateTemplate.mockReset().mockResolvedValue(undefined);
    mockUpdateTemplate.mockReset().mockResolvedValue(undefined);
  });

  it('requires name, key, and handle before persisting', async () => {
    const view = renderEditor(null);

    fireEvent.click(view.getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(view.getByText('Name is required')).toBeTruthy());
    expect(mockCreateTemplate).not.toHaveBeenCalled();

    fireEvent.input(view.getByPlaceholderText('e.g. Release Readiness'), {
      target: { value: 'Release Readiness' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(view.getByText('Template key is required')).toBeTruthy());
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it('shows the store error and keeps the form open with its values when create fails', async () => {
    mockCreateTemplate.mockRejectedValueOnce(
      new Error('Template key already exists: release-readiness.custom')
    );
    const view = renderEditor(null);
    fillRequiredFields(view);

    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() =>
      expect(view.getByText('Template key already exists: release-readiness.custom')).toBeTruthy()
    );
    expect(view.getByRole('button', { name: 'Create template' })).toBeTruthy();
    expect((view.getByPlaceholderText('e.g. Release Readiness') as HTMLInputElement).value).toBe(
      'Release Readiness'
    );
  });

  it('persists an explicit setting sources selection', async () => {
    const view = renderEditor(null);
    expect(view.getByText('Inherits the space setting sources.')).toBeTruthy();

    fireEvent.click(settingSourceCheckbox('local'));
    expect(settingSourceCheckbox('local').checked).toBe(false);
    fillRequiredFields(view);
    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].settingSources).toEqual(['user', 'project']);
  });

  it('clears a setting sources override back to inherit', async () => {
    const view = renderEditor(null);

    fireEvent.click(settingSourceCheckbox('local'));
    fireEvent.click(view.getByRole('button', { name: 'Clear override — inherit from space' }));
    expect(view.getByText('Inherits the space setting sources.')).toBeTruthy();
    fillRequiredFields(view);
    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].settingSources).toBeNull();
  });

  it('preserves instruction whitespace on an unrelated edit', async () => {
    const instructions = '    indented code block\nsecond line';
    const view = renderEditor(
      makeTemplate({ key: 'scribe', handle: 'scribe', displayName: 'Scribe', instructions })
    );

    fireEvent.input(view.getByDisplayValue('Scribe'), { target: { value: 'Scribe II' } });
    fireEvent.click(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({ instructions })
    );
  });
});
