// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import type { WorkerAgentModelPoolEntry } from '@hyperneo/shared';

vi.mock('../visual-editor/WorkflowModelSelect', () => ({
  WorkflowModelSelect: ({
    value,
    onChange,
    testId,
    className,
  }: {
    value?: string;
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
        const value = (e.target as HTMLSelectElement).value || undefined;
        onChange(value, value ? { provider: 'anthropic', modelId: value } : undefined);
      }}
      class={className}
    >
      <option value="">— No override —</option>
      <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
      <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
      <option value="gpt-5.4">GPT-5.4</option>
    </select>
  ),
}));

import { ModelPoolEditor } from '../ModelPoolEditor';

interface HostState {
  mode: 'single' | 'pool';
  model: string;
  provider: string;
  modelPool: WorkerAgentModelPoolEntry[];
}

let hostState: HostState;

function TestHost({ initial }: { initial: Partial<HostState> }) {
  const [state, setState] = useState<HostState>({
    mode: 'single',
    model: '',
    provider: '',
    modelPool: [],
    ...initial,
  });
  hostState = state;
  return (
    <ModelPoolEditor
      mode={state.mode}
      model={state.model}
      provider={state.provider}
      modelPool={state.modelPool}
      onModeChange={(mode) => setState((prev) => ({ ...prev, mode }))}
      onModelChange={(model, provider) => setState((prev) => ({ ...prev, model, provider }))}
      onModelPoolChange={(modelPool) => setState((prev) => ({ ...prev, modelPool }))}
    />
  );
}

function renderEditor(initial: Partial<HostState> = {}) {
  return render(<TestHost initial={initial} />);
}

describe('ModelPoolEditor', () => {
  beforeEach(() => {
    cleanup();
    hostState = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to single mode with no pool controls', () => {
    const { getByTestId, queryByTestId } = renderEditor();
    expect(getByTestId('space-agent-model-select')).toBeTruthy();
    expect(queryByTestId('agent-model-pool')).toBeNull();
  });

  it('shows pool controls and hides the single select in pool mode', () => {
    const { getByTestId, queryByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    expect(queryByTestId('space-agent-model-select')).toBeNull();
    expect(getByTestId('agent-model-pool')).toBeTruthy();
  });

  it('seeds one empty entry when switching to pool mode', () => {
    const { getByTestId, getAllByTestId } = renderEditor();
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    expect(hostState.mode).toBe('pool');
    expect(getAllByTestId('pool-entry')).toHaveLength(1);
    expect(hostState.modelPool).toEqual([{ model: '', maxConcurrent: 1, weight: 100 }]);
  });

  it('does not reseed existing entries when switching to pool mode', () => {
    const existing: WorkerAgentModelPoolEntry[] = [
      { model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 },
    ];
    const { getByTestId, getAllByTestId } = renderEditor({ mode: 'single', modelPool: existing });
    fireEvent.click(getByTestId('agent-model-mode-pool'));
    expect(hostState.modelPool).toEqual(existing);
    expect(getAllByTestId('pool-entry')).toHaveLength(1);
  });

  it('appends entries with the add button in pool mode', () => {
    const { getByTestId, getAllByTestId } = renderEditor({ mode: 'pool', modelPool: [] });
    fireEvent.click(getByTestId('pool-add-model-button'));
    expect(getAllByTestId('pool-entry')).toHaveLength(1);
    expect(hostState.modelPool).toEqual([{ model: '', maxConcurrent: 1, weight: 100 }]);
    fireEvent.click(getByTestId('pool-add-model-button'));
    expect(getAllByTestId('pool-entry')).toHaveLength(2);
    expect(hostState.modelPool[1]).toEqual({ model: '', maxConcurrent: 1, weight: 100 });
  });

  it('updates the entry model and provider through the select', () => {
    const { getByTestId } = renderEditor({ mode: 'pool', modelPool: [] });
    fireEvent.click(getByTestId('pool-add-model-button'));
    fireEvent.change(getByTestId('pool-entry-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    expect(hostState.modelPool).toEqual([
      { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
    ]);
  });

  it('clearing an entry select resets the model and provider', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [
        { model: 'claude-sonnet-4-6', provider: 'anthropic', maxConcurrent: 1, weight: 100 },
      ],
    });
    fireEvent.change(getByTestId('pool-entry-model-select'), { target: { value: '' } });
    expect(hostState.modelPool[0].model).toBe('');
    expect(hostState.modelPool[0].provider).toBeUndefined();
  });

  it('accepts max values of 1 or more and floors them', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    fireEvent.input(getByTestId('pool-entry-max-input'), { target: { value: '8' } });
    expect(hostState.modelPool[0].maxConcurrent).toBe(8);
    fireEvent.input(getByTestId('pool-entry-max-input'), { target: { value: '3.9' } });
    expect(hostState.modelPool[0].maxConcurrent).toBe(3);
  });

  it('ignores invalid max input and restores the retained value on blur', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    const maxInput = getByTestId('pool-entry-max-input') as HTMLInputElement;
    fireEvent.input(maxInput, { target: { value: '0' } });
    expect(hostState.modelPool[0].maxConcurrent).toBe(2);
    fireEvent.blur(maxInput);
    expect(maxInput.value).toBe('2');
    fireEvent.input(maxInput, { target: { value: '-3' } });
    expect(hostState.modelPool[0].maxConcurrent).toBe(2);
    fireEvent.blur(maxInput);
    expect(maxInput.value).toBe('2');
    fireEvent.input(maxInput, { target: { value: 'abc' } });
    expect(hostState.modelPool[0].maxConcurrent).toBe(2);
    fireEvent.blur(maxInput);
    expect(maxInput.value).toBe('2');
  });

  it('preserves fractional text while editing the max input', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 4, weight: 40 }],
    });
    const maxInput = getByTestId('pool-entry-max-input') as HTMLInputElement;
    fireEvent.input(maxInput, { target: { value: '3.' } });
    expect(maxInput.value).toBe('3.');
    expect(hostState.modelPool[0].maxConcurrent).toBe(3);
    fireEvent.input(maxInput, { target: { value: '3.9' } });
    expect(maxInput.value).toBe('3.9');
    expect(hostState.modelPool[0].maxConcurrent).toBe(3);
    fireEvent.blur(maxInput);
    expect(maxInput.value).toBe('3');
  });

  it('accepts weights of 0 or more and preserves non-integer values', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    const weightInput = getByTestId('pool-entry-weight-input') as HTMLInputElement;
    fireEvent.input(weightInput, { target: { value: '50' } });
    expect(hostState.modelPool[0].weight).toBe(50);
    fireEvent.input(weightInput, { target: { value: '2.5' } });
    expect(hostState.modelPool[0].weight).toBe(2.5);
    fireEvent.input(weightInput, { target: { value: '0' } });
    expect(hostState.modelPool[0].weight).toBe(0);
    fireEvent.input(weightInput, { target: { value: '150' } });
    expect(hostState.modelPool[0].weight).toBe(150);
  });

  it('rejects negative and invalid weight input, restoring the retained value on blur', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    const weightInput = getByTestId('pool-entry-weight-input') as HTMLInputElement;
    fireEvent.input(weightInput, { target: { value: '-1' } });
    expect(hostState.modelPool[0].weight).toBe(40);
    fireEvent.blur(weightInput);
    expect(weightInput.value).toBe('40');
    fireEvent.input(weightInput, { target: { value: 'NaN' } });
    expect(hostState.modelPool[0].weight).toBe(40);
    fireEvent.blur(weightInput);
    expect(weightInput.value).toBe('40');
  });

  it('preserves fractional text while editing the weight input', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    const weightInput = getByTestId('pool-entry-weight-input') as HTMLInputElement;
    fireEvent.input(weightInput, { target: { value: '2.' } });
    expect(weightInput.value).toBe('2.');
    expect(hostState.modelPool[0].weight).toBe(2);
    fireEvent.input(weightInput, { target: { value: '2.5' } });
    expect(weightInput.value).toBe('2.5');
    expect(hostState.modelPool[0].weight).toBe(2.5);
    fireEvent.blur(weightInput);
    expect(weightInput.value).toBe('2.5');
  });

  it('clearing a numeric input snaps back to the retained entry value on blur', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    const maxInput = getByTestId('pool-entry-max-input') as HTMLInputElement;
    fireEvent.input(maxInput, { target: { value: '' } });
    expect(hostState.modelPool[0].maxConcurrent).toBe(2);
    fireEvent.blur(maxInput);
    expect(maxInput.value).toBe('2');
    const weightInput = getByTestId('pool-entry-weight-input') as HTMLInputElement;
    fireEvent.input(weightInput, { target: { value: '' } });
    expect(hostState.modelPool[0].weight).toBe(40);
    fireEvent.blur(weightInput);
    expect(weightInput.value).toBe('40');
  });

  it('marks the numeric inputs required so an empty draft blocks keyboard submit', () => {
    const { getByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    expect((getByTestId('pool-entry-max-input') as HTMLInputElement).required).toBe(true);
    expect((getByTestId('pool-entry-weight-input') as HTMLInputElement).required).toBe(true);
  });

  it('removes only the entry at the removed index', () => {
    const { getAllByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [
        { model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 },
        { model: 'claude-sonnet-4-6', maxConcurrent: 3, weight: 60 },
      ],
    });
    fireEvent.click(getAllByTestId('pool-entry-remove-button')[0]);
    expect(hostState.modelPool).toEqual([
      { model: 'claude-sonnet-4-6', maxConcurrent: 3, weight: 60 },
    ]);
  });

  it('shows the empty-pool hint when no entries are configured', () => {
    const { getByText, queryAllByTestId } = renderEditor({ mode: 'pool', modelPool: [] });
    expect(
      getByText('No pool models — this agent uses the space default until one is added.')
    ).toBeTruthy();
    expect(queryAllByTestId('pool-entry')).toHaveLength(0);
  });

  it('switches back to single mode and hides pool controls', () => {
    const { getByTestId, queryByTestId } = renderEditor({
      mode: 'pool',
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 2, weight: 40 }],
    });
    fireEvent.click(getByTestId('agent-model-mode-single'));
    expect(hostState.mode).toBe('single');
    expect(queryByTestId('agent-model-pool')).toBeNull();
    expect(getByTestId('space-agent-model-select')).toBeTruthy();
  });

  it('emits model and provider changes in single mode', () => {
    const { getByTestId } = renderEditor({ mode: 'single', model: '', provider: '' });
    fireEvent.change(getByTestId('space-agent-model-select'), {
      target: { value: 'claude-sonnet-4-6' },
    });
    expect(hostState.model).toBe('claude-sonnet-4-6');
    expect(hostState.provider).toBe('anthropic');
  });

  it('clearing the single select resets model and provider to empty strings', () => {
    const { getByTestId } = renderEditor({
      mode: 'single',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
    fireEvent.change(getByTestId('space-agent-model-select'), { target: { value: '' } });
    expect(hostState.model).toBe('');
    expect(hostState.provider).toBe('');
  });

  it('renders the model error message when provided', () => {
    const { getByText } = render(
      <ModelPoolEditor
        mode="single"
        model=""
        provider=""
        modelPool={[]}
        error="Model is required"
        onModeChange={vi.fn()}
        onModelChange={vi.fn()}
        onModelPoolChange={vi.fn()}
      />
    );
    expect(getByText('Model is required')).toBeTruthy();
  });
});
