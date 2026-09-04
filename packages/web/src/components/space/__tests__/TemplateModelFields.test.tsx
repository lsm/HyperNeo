import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
  WorkflowModelSelect: ({
    value,
    onChange,
    testId,
    className,
    id,
  }: {
    value?: string;
    provider?: string;
    onChange: (
      value: string | undefined,
      selection?: {
        provider: string;
        modelId: string;
        thinkingModes?: 'off' | 'on' | 'granular';
      }
    ) => void;
    testId: string;
    className?: string;
    id?: string;
  }) => (
    <select
      data-testid={testId}
      id={id}
      value={value ?? ''}
      onChange={(e) => {
        const select = e.currentTarget as HTMLSelectElement;
        const nextValue = select.value || undefined;
        const selected = select.selectedOptions[0];
        const provider = selected?.getAttribute('data-provider') ?? 'anthropic';
        const thinkingModes = selected?.getAttribute('data-thinking-modes') as
          | 'off'
          | 'on'
          | 'granular'
          | undefined;
        onChange(
          nextValue,
          nextValue
            ? {
                provider,
                modelId: nextValue,
                ...(thinkingModes ? { thinkingModes } : {}),
              }
            : undefined
        );
      }}
      class={className}
    >
      <option value="">— No override —</option>
      <option value="claude-sonnet-4-6" data-provider="anthropic" data-thinking-modes="granular">
        Claude Sonnet 4.6
      </option>
      <option value="glm-5.3" data-provider="glm" data-thinking-modes="granular">
        GLM-5.3
      </option>
      <option value="kimi-k2" data-provider="kimi" data-thinking-modes="on">
        Kimi K2
      </option>
      <option value="minimax-1" data-provider="minimax" data-thinking-modes="off">
        MiniMax 1
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

  it('associates labels with their selects via htmlFor/id', () => {
    const { getByTestId } = render(<TemplateModelFields value={EMPTY_VALUE} onChange={vi.fn()} />);
    const modelLabel = getByTestId('template-model-fields').querySelector(
      'label[for="template-model-fields-model-select"]'
    );
    const thinkingLabel = getByTestId('template-model-fields').querySelector(
      'label[for="template-model-fields-thinking-level"]'
    );
    expect(modelLabel).toBeTruthy();
    expect(thinkingLabel).toBeTruthy();
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

  it('emits model, provider, and thinkingModes when a model is selected', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<TemplateModelFields value={EMPTY_VALUE} onChange={onChange} />);
    const select = getByTestId('template-model-fields-model-select') as HTMLSelectElement;
    select.value = 'glm-5.3';
    fireEvent.change(select);
    expect(onChange).toHaveBeenCalledWith({
      model: 'glm-5.3',
      provider: 'glm',
      thinkingModes: 'granular',
      thinkingLevel: null,
    });
  });

  it('clears model metadata when the override is removed', () => {
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
      thinkingModes: null,
      thinkingLevel: 'think8k',
    });
  });

  it('clears an unsupported thinking level when a model without thinking is selected', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: null, provider: null, thinkingLevel: 'think8k' }}
        onChange={onChange}
      />
    );
    const select = getByTestId('template-model-fields-model-select') as HTMLSelectElement;
    select.value = 'minimax-1';
    fireEvent.change(select);
    expect(onChange).toHaveBeenCalledWith({
      model: 'minimax-1',
      provider: 'minimax',
      thinkingModes: 'off',
      thinkingLevel: null,
    });
  });

  it('keeps a supported thinking level when a model with on mode is selected', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: null, provider: null, thinkingLevel: 'off' }}
        onChange={onChange}
      />
    );
    const select = getByTestId('template-model-fields-model-select') as HTMLSelectElement;
    select.value = 'kimi-k2';
    fireEvent.change(select);
    expect(onChange).toHaveBeenCalledWith({
      model: 'kimi-k2',
      provider: 'kimi',
      thinkingModes: 'on',
      thinkingLevel: 'off',
    });
  });

  it('renders only Off/On options for a provider with on mode', () => {
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: 'kimi-k2', provider: 'kimi', thinkingModes: 'on', thinkingLevel: null }}
        onChange={vi.fn()}
      />
    );
    const select = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(['', 'off', 'think32k']);
  });

  it('renders no thinking options for a provider with off mode', () => {
    const { getByTestId } = render(
      <TemplateModelFields
        value={{
          model: 'minimax-1',
          provider: 'minimax',
          thinkingModes: 'off',
          thinkingLevel: null,
        }}
        onChange={vi.fn()}
      />
    );
    const select = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(select.options[0].value).toBe('');
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

  it('clears an invalid initial thinking level once options are known', async () => {
    const onChange = vi.fn();
    render(
      <TemplateModelFields
        value={{
          model: 'minimax-1',
          provider: 'minimax',
          thinkingModes: 'off',
          thinkingLevel: 'think8k',
        }}
        onChange={onChange}
      />
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        model: 'minimax-1',
        provider: 'minimax',
        thinkingModes: 'off',
        thinkingLevel: null,
      })
    );
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
