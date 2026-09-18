// @ts-nocheck

import { fireEvent, render, waitFor } from '@testing-library/preact';
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

describe('TemplateEditor model configuration', () => {
  beforeEach(() => {
    mockCreateTemplate.mockReset().mockResolvedValue(undefined);
    mockUpdateTemplate.mockReset().mockResolvedValue(undefined);
  });

  it('omits modelPool when the pool is left empty', async () => {
    const view = renderEditor(null);
    fillRequiredFields(view);

    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate.mock.calls[0][0].modelPool).toBeNull();
    expect(mockCreateTemplate.mock.calls[0][0].model).toBeNull();
  });

  it('stores a lone default pool entry as the scalar model, not a pool', async () => {
    const view = renderEditor(null);
    fillRequiredFields(view);

    fireEvent.click(view.getByTestId('pool-add-model-button'));
    fireEvent.change(view.getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    const params = mockCreateTemplate.mock.calls[0][0];
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.provider).toBe('anthropic');
    expect(params.modelPool).toBeNull();
  });

  it('clears the pinned model once a second pool entry exists', async () => {
    const view = renderEditor(null);
    fillRequiredFields(view);

    fireEvent.click(view.getByTestId('pool-add-model-button'));
    fireEvent.change(view.getAllByTestId('pool-entry-model-select')[0], {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(view.getByTestId('pool-add-model-button'));
    fireEvent.change(view.getAllByTestId('pool-entry-model-select')[1], {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    const params = mockCreateTemplate.mock.calls[0][0];
    expect(params.model).toBeNull();
    expect(params.provider).toBeNull();
    expect(params.modelPool).toEqual([
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('sends the model fields when the model changes on an existing template', async () => {
    const view = renderEditor(makeTemplate({ key: 'scribe', displayName: 'Scribe', version: 4 }));

    fireEvent.click(view.getByTestId('pool-add-model-button'));
    fireEvent.change(view.getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Save changes' }));

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

  it('omits the model fields on an untouched scalar template that pins a thinking level', async () => {
    const view = renderEditor(
      makeTemplate({
        key: 'scribe',
        displayName: 'Scribe',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        thinkingLevel: 'think16k',
      })
    );

    fireEvent.input(view.getByDisplayValue('Scribe'), { target: { value: 'Scribe II' } });
    fireEvent.click(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    const edit = mockUpdateTemplate.mock.calls[0][1];
    expect(edit.thinkingLevel).toBe('think16k');
    expect(edit).not.toHaveProperty('model');
    expect(edit).not.toHaveProperty('provider');
    expect(edit).not.toHaveProperty('modelPool');
  });

  it('keeps a stored lone default pool entry as a pool when its model is changed', async () => {
    const view = renderEditor(
      makeTemplate({
        key: 'scribe',
        displayName: 'Scribe',
        model: null,
        modelPool: [
          { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
        ],
      })
    );

    fireEvent.change(view.getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-haiku-4-5' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    const edit = mockUpdateTemplate.mock.calls[0][1];
    expect(edit.model).toBeNull();
    expect(edit.modelPool).toEqual([
      { model: 'claude-haiku-4-5', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('preserves a provider-only override on an unrelated edit', async () => {
    const view = renderEditor(
      makeTemplate({ key: 'scribe', displayName: 'Scribe', model: null, provider: 'anthropic' })
    );

    fireEvent.input(view.getByDisplayValue('Scribe'), { target: { value: 'Scribe II' } });
    fireEvent.click(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    const edit = mockUpdateTemplate.mock.calls[0][1];
    expect(edit.displayName).toBe('Scribe II');
    expect(edit).not.toHaveProperty('model');
    expect(edit).not.toHaveProperty('provider');
    expect(edit).not.toHaveProperty('modelPool');
  });
});
