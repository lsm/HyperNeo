import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { EdgeConfigPanel } from '../EdgeConfigPanel';
import type { EdgeConfigPanelProps, EdgeTransition } from '../EdgeConfigPanel';

afterEach(() => cleanup());

function makeTransition(overrides?: Partial<EdgeTransition>): EdgeTransition {
  return {
    id: 'trans-1',
    fromStepName: 'Step A',
    toStepName: 'Step B',
    condition: { type: 'always' },
    ...overrides,
  };
}

function makeProps(
  transition: EdgeTransition,
  overrides?: Partial<EdgeConfigPanelProps>
): EdgeConfigPanelProps {
  return {
    transition,
    onUpdateCondition: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('EdgeConfigPanel', () => {
  it('renders from step name', () => {
    const { getByTestId } = render(<EdgeConfigPanel {...makeProps(makeTransition())} />);
    expect(getByTestId('from-step-name').textContent).toBe('Step A');
  });

  it('renders to step name', () => {
    const { getByTestId } = render(<EdgeConfigPanel {...makeProps(makeTransition())} />);
    expect(getByTestId('to-step-name').textContent).toBe('Step B');
  });

  it('shows condition type selector with current value "always"', () => {
    const { getByTestId } = render(<EdgeConfigPanel {...makeProps(makeTransition())} />);
    const select = getByTestId('condition-type-select') as HTMLSelectElement;
    expect(select.value).toBe('always');
  });

  it('shows condition type selector with current value "human"', () => {
    const { getByTestId } = render(
      <EdgeConfigPanel {...makeProps(makeTransition({ condition: { type: 'human' } }))} />
    );
    const select = getByTestId('condition-type-select') as HTMLSelectElement;
    expect(select.value).toBe('human');
  });

  it('shows condition type selector with current value "condition"', () => {
    const { getByTestId } = render(
      <EdgeConfigPanel
        {...makeProps(makeTransition({ condition: { type: 'condition', expression: 'true' } }))}
      />
    );
    const select = getByTestId('condition-type-select') as HTMLSelectElement;
    expect(select.value).toBe('condition');
  });

  it('does not show expression input for "always" type', () => {
    const { queryByTestId } = render(<EdgeConfigPanel {...makeProps(makeTransition())} />);
    expect(queryByTestId('condition-expression')).toBeNull();
  });

  it('does not show expression input for "human" type', () => {
    const { queryByTestId } = render(
      <EdgeConfigPanel {...makeProps(makeTransition({ condition: { type: 'human' } }))} />
    );
    expect(queryByTestId('condition-expression')).toBeNull();
  });

  it('shows expression input for "condition" type', () => {
    const { getByTestId } = render(
      <EdgeConfigPanel
        {...makeProps(makeTransition({ condition: { type: 'condition', expression: '' } }))}
      />
    );
    expect(getByTestId('condition-expression')).toBeTruthy();
  });

  it('expression input reflects current expression value', () => {
    const { getByTestId } = render(
      <EdgeConfigPanel
        {...makeProps(
          makeTransition({ condition: { type: 'condition', expression: 'test -f out.txt' } })
        )}
      />
    );
    const input = getByTestId('condition-expression') as HTMLInputElement;
    expect(input.value).toBe('test -f out.txt');
  });

  it('changing condition type from always to human calls onUpdateCondition', () => {
    const onUpdateCondition = vi.fn();
    const { getByTestId } = render(
      <EdgeConfigPanel {...makeProps(makeTransition(), { onUpdateCondition })} />
    );
    const select = getByTestId('condition-type-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'human' } });
    expect(onUpdateCondition).toHaveBeenCalledWith('trans-1', 'human', undefined);
  });

  it('changing condition type to condition preserves existing expression', () => {
    const onUpdateCondition = vi.fn();
    const { getByTestId } = render(
      <EdgeConfigPanel
        {...makeProps(makeTransition({ condition: { type: 'always', expression: 'my-expr' } }), {
          onUpdateCondition,
        })}
      />
    );
    const select = getByTestId('condition-type-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'condition' } });
    expect(onUpdateCondition).toHaveBeenCalledWith('trans-1', 'condition', 'my-expr');
  });

  it('changing condition type away from condition clears expression', () => {
    const onUpdateCondition = vi.fn();
    const { getByTestId } = render(
      <EdgeConfigPanel
        {...makeProps(
          makeTransition({ condition: { type: 'condition', expression: 'test -f out.txt' } }),
          { onUpdateCondition }
        )}
      />
    );

    const select = getByTestId('condition-type-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'always' } });
    expect(onUpdateCondition).toHaveBeenCalledWith('trans-1', 'always', undefined);
  });

  it('editing expression calls onUpdateCondition with updated expression', () => {
    const onUpdateCondition = vi.fn();
    const { getByTestId } = render(
      <EdgeConfigPanel
        {...makeProps(makeTransition({ condition: { type: 'condition', expression: 'old' } }), {
          onUpdateCondition,
        })}
      />
    );
    const input = getByTestId('condition-expression') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'new-expr' } });
    expect(onUpdateCondition).toHaveBeenCalledWith('trans-1', 'condition', 'new-expr');
  });

  it('shows expression input for task_result type with Match value label', () => {
    const { getByTestId, getByText } = render(
      <EdgeConfigPanel
        {...makeProps(makeTransition({ condition: { type: 'task_result', expression: 'passed' } }))}
      />
    );
    expect(getByTestId('condition-expression')).toBeTruthy();
    expect(getByText('Match value')).toBeTruthy();
  });

  it('editing task_result expression calls onUpdateCondition with task_result type', () => {
    const onUpdateCondition = vi.fn();
    const { getByTestId } = render(
      <EdgeConfigPanel
        {...makeProps(
          makeTransition({ condition: { type: 'task_result', expression: 'passed' } }),
          { onUpdateCondition }
        )}
      />
    );
    const input = getByTestId('condition-expression') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'failed' } });
    expect(onUpdateCondition).toHaveBeenCalledWith('trans-1', 'task_result', 'failed');
  });

  it('switching from condition to task_result preserves expression', () => {
    const onUpdateCondition = vi.fn();
    const { getByTestId } = render(
      <EdgeConfigPanel
        {...makeProps(
          makeTransition({ condition: { type: 'condition', expression: 'test -f out.txt' } }),
          { onUpdateCondition }
        )}
      />
    );
    const select = getByTestId('condition-type-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'task_result' } });
    expect(onUpdateCondition).toHaveBeenCalledWith('trans-1', 'task_result', 'test -f out.txt');
  });

  it('clicking delete button calls onDelete with transition id', () => {
    const onDelete = vi.fn();
    const { getByTestId } = render(
      <EdgeConfigPanel {...makeProps(makeTransition(), { onDelete })} />
    );
    fireEvent.click(getByTestId('delete-transition-button'));
    expect(onDelete).toHaveBeenCalledWith('trans-1');
  });

  it('clicking close button calls onClose', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <EdgeConfigPanel {...makeProps(makeTransition(), { onClose })} />
    );
    fireEvent.click(getByTestId('close-button'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
