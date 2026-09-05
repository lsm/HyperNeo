import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { useEffect } from 'preact/hooks';

const mockModels = [
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    alias: 'claude-sonnet-4-6',
    family: 'sonnet',
    provider: 'anthropic',
    contextWindow: 200000,
    thinkingModes: 'granular' as const,
    description: '',
    releaseDate: '',
    available: true,
  },
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    alias: 'glm-5.3',
    family: 'glm',
    provider: 'glm',
    contextWindow: 1000000,
    thinkingModes: 'granular' as const,
    description: '',
    releaseDate: '',
    available: true,
  },
  {
    id: 'kimi-k2',
    name: 'Kimi K2',
    alias: 'kimi-k2',
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 1000000,
    thinkingModes: 'on' as const,
    description: '',
    releaseDate: '',
    available: true,
  },
  {
    id: 'kimi-k3-1m',
    name: 'Kimi K3 1M',
    alias: 'kimi-k3-1m',
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 1000000,
    thinkingModes: 'granular' as const,
    description: '',
    releaseDate: '',
    available: true,
  },
  {
    id: 'minimax-1',
    name: 'MiniMax 1',
    alias: 'minimax-1',
    family: 'minimax',
    provider: 'minimax',
    contextWindow: 100000,
    thinkingModes: 'off' as const,
    description: '',
    releaseDate: '',
    available: true,
  },
];

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
  WorkflowModelSelect: ({
    value,
    onChange,
    onModelsLoad,
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
    onModelsLoad?: (models: unknown[]) => void;
    testId: string;
    className?: string;
    id?: string;
  }) => {
    useEffect(() => {
      onModelsLoad?.(mockModels);
    }, []);

    return (
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
        <option value="kimi-k3-1m" data-provider="kimi" data-thinking-modes="granular">
          Kimi K3 1M
        </option>
        <option value="minimax-1" data-provider="minimax" data-thinking-modes="off">
          MiniMax 1
        </option>
      </select>
    );
  },
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

  it('hides the model select but keeps the thinking level select when hidden', () => {
    const { getByTestId, queryByTestId } = render(
      <TemplateModelFields value={EMPTY_VALUE} onChange={vi.fn()} hideModelSelect />
    );
    expect(getByTestId('template-model-fields')).toBeTruthy();
    expect(queryByTestId('template-model-fields-model-select')).toBeNull();
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
      thinkingLevel: 'off',
    });
  });

  it('resolves a model thinking mode from the loaded catalog', () => {
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: 'kimi-k2', provider: 'kimi', thinkingLevel: null }}
        onChange={vi.fn()}
      />
    );
    const select = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(['', 'off', 'think32k']);
  });

  it('clears an invalid initial thinking level once the catalog resolves', async () => {
    const onChange = vi.fn();
    render(
      <TemplateModelFields
        value={{ model: 'minimax-1', provider: 'minimax', thinkingLevel: 'think8k' }}
        onChange={onChange}
      />
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        model: 'minimax-1',
        provider: 'minimax',
        thinkingLevel: null,
      })
    );
  });

  it('preserves a saved thinking level when the selected model is absent from the catalog', async () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: 'kimi-k3-2m', provider: 'kimi', thinkingLevel: 'think8k' }}
        onChange={onChange}
      />
    );
    const select = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    await waitFor(() => {
      const values = Array.from(select.options).map((option) => option.value);
      expect(values).toEqual(['', 'off', 'think32k', 'think8k']);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('resolves a per-model thinking mode that differs from the provider default', async () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <TemplateModelFields
        value={{ model: 'kimi-k3-1m', provider: 'kimi', thinkingLevel: 'think8k' }}
        onChange={onChange}
      />
    );
    const select = getByTestId('template-model-fields-thinking-level') as HTMLSelectElement;
    await waitFor(() => {
      const values = Array.from(select.options).map((option) => option.value);
      expect(values).toEqual(['', 'off', 'think8k', 'think16k', 'think24k', 'think32k']);
    });
    expect(onChange).not.toHaveBeenCalled();
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
