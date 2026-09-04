import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
  WorkflowModelSelect: ({
    value,
    onChange,
    testId,
    className,
  }: {
    value?: string;
    provider?: string;
    onChange: (
      value: string | undefined,
      selection?: { provider: string; modelId: string }
    ) => void;
    testId: string;
    className?: string;
  }) => (
    <select
      data-testid={testId}
      value={value ?? ''}
      onChange={(e) => {
        const select = e.currentTarget as HTMLSelectElement;
        const nextValue = select.value || undefined;
        const provider = select.selectedOptions[0]?.getAttribute('data-provider') ?? 'anthropic';
        onChange(nextValue, nextValue ? { provider, modelId: nextValue } : undefined);
      }}
      class={className}
    >
      <option value="">— No override —</option>
      <option value="claude-sonnet-4-6" data-provider="anthropic">
        Claude Sonnet 4.6
      </option>
      <option value="glm-5.3" data-provider="glm">
        GLM-5.3
      </option>
    </select>
  ),
}));

import { TemplateModelFields, type TemplateModelFieldsValue } from '../TemplateModelFields';

afterEach(() => {
  cleanup();
});

const EMPTY_VALUE: TemplateModelFieldsValue = {
  model: null,
  provider: null,
  thinkingLevel: null,
};

describe('TemplateModelFields', () => {
  it('renders the model select and thinking level select', () => {
    const { getByTestId } = render(<TemplateModelFields value={EMPTY_VALUE} onChange={vi.fn()} />);
    expect(getByTestId('template-model-fields')).toBeTruthy();
    expect(getByTestId('template-model-fields-model-select')).toBeTruthy();
    expect(getByTestId('template-model-fields-thinking-level')).toBeTruthy();
  });

  it('pre-fills the model select from value', () => {
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: 'claude-sonnet-4-6', provider: 'anthropic', thinkingLevel: null }}
        onChange={vi.fn()}
      />
    );
    const select = getByTestId('template-model-fields-model-select') as HTMLSelectElement;
    expect(select.value).toBe('claude-sonnet-4-6');
  });

  it('emits model and provider when a model is selected', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<TemplateModelFields value={EMPTY_VALUE} onChange={onChange} />);
    const select = getByTestId('template-model-fields-model-select') as HTMLSelectElement;
    select.value = 'glm-5.3';
    fireEvent.change(select);
    expect(onChange).toHaveBeenCalledWith({
      model: 'glm-5.3',
      provider: 'glm',
      thinkingLevel: null,
    });
  });

  it('clears model and provider when the override is removed', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: 'claude-sonnet-4-6', provider: 'anthropic', thinkingLevel: 'think8k' }}
        onChange={onChange}
      />
    );
    const select = getByTestId('template-model-fields-model-select') as HTMLSelectElement;
    select.value = '';
    fireEvent.change(select);
    expect(onChange).toHaveBeenCalledWith({
      model: null,
      provider: null,
      thinkingLevel: 'think8k',
    });
  });

  it('pre-fills thinking level from value', () => {
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: null, provider: null, thinkingLevel: 'think16k' }}
        onChange={vi.fn()}
      />
    );
    const select = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    expect(select.value).toBe('think16k');
  });

  it('emits thinking level when an option is selected', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<TemplateModelFields value={EMPTY_VALUE} onChange={onChange} />);
    const select = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    select.value = 'think24k';
    fireEvent.change(select);
    expect(onChange).toHaveBeenCalledWith({
      model: null,
      provider: null,
      thinkingLevel: 'think24k',
    });
  });

  it('clears thinking level when the default option is selected', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: 'claude-sonnet-4-6', provider: 'anthropic', thinkingLevel: 'think8k' }}
        onChange={onChange}
      />
    );
    const select = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    select.value = '';
    fireEvent.change(select);
    expect(onChange).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      thinkingLevel: null,
    });
  });
});
