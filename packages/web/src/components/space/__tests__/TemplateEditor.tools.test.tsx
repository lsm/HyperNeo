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

function chipInput(container: Element, tool: string): HTMLInputElement {
  const label = container.querySelector(`[data-testid="tools-editor-chip-${tool}"]`);
  expect(label, `chip ${tool} rendered`).toBeTruthy();
  return (label as Element).querySelector('input') as HTMLInputElement;
}

describe('TemplateEditor tools', () => {
  beforeEach(() => {
    mockCreateTemplate.mockReset().mockResolvedValue(undefined);
    mockUpdateTemplate.mockReset().mockResolvedValue(undefined);
  });

  it('mounts the tools editor in inherited mode for a new template', () => {
    const { getByText, container } = renderEditor(null);

    expect(container.querySelector('[data-testid="tools-editor"]')).toBeTruthy();
    expect(getByText('(inherited)')).toBeTruthy();
    expect(chipInput(container, 'Bash').disabled).toBe(true);
  });

  it('creates a template carrying the tools selected in the editor', async () => {
    const view = renderEditor(null);
    fillRequiredFields(view);

    fireEvent.click(view.getByTestId('tools-editor-preset-read-only'));
    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['Read', 'Grep', 'Glob'] })
    );
  });

  it('persists an empty tools list when Inherit defaults is re-applied', async () => {
    const view = renderEditor(null);
    fillRequiredFields(view);

    fireEvent.click(view.getByTestId('tools-editor-preset-read-only'));
    fireEvent.click(view.getByTestId('tools-editor-preset-inherit-defaults'));
    fireEvent.click(view.getByRole('button', { name: 'Create template' }));

    await waitFor(() => expect(mockCreateTemplate).toHaveBeenCalledTimes(1));
    expect(mockCreateTemplate).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
  });

  it('shows scoped tool entries and persists their removal', async () => {
    const view = renderEditor(
      makeTemplate({
        key: 'scribe',
        handle: 'scribe',
        displayName: 'Scribe',
        toolPermissions: { tools: ['Read', 'Bash(gh pr view:*)'] },
      })
    );

    expect(view.getByText('Bash(gh pr view:*)')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Remove Bash(gh pr view:*)' }));
    fireEvent.click(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({ tools: ['Read'] })
    );
  });

  it('folds a pending scoped tool draft into the save without clicking Add', async () => {
    const view = renderEditor(makeTemplate({ key: 'scribe', handle: 'scribe' }));

    fireEvent.input(view.getByTestId('lh-template-extra-tool-input'), {
      target: { value: 'Bash(gh pr view:*)' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockUpdateTemplate).toHaveBeenCalledTimes(1));
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      'scribe',
      expect.objectContaining({ tools: ['Bash(gh pr view:*)'] })
    );
  });
});
