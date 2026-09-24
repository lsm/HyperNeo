import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloneChoiceDialog } from '../CloneChoiceDialog';

describe('CloneChoiceDialog', () => {
  afterEach(() => cleanup());

  it('lists the clones and sends the chosen action', () => {
    const onChoose = vi.fn();
    const onCancel = vi.fn();
    render(
      <CloneChoiceDialog
        clones={[
          { id: 'c1', title: 'First' },
          { id: 'c2', title: 'Second' },
        ]}
        action="delete"
        subject="agent"
        busy={false}
        onChoose={onChoose}
        onCancel={onCancel}
      />
    );

    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
    expect(screen.getByTestId('clone-choice-cascade').textContent).toBe('Delete them too');
    expect(screen.getByTestId('clone-choice-flatten').textContent).toBe(
      'Keep them as their own agents'
    );

    fireEvent.click(screen.getByTestId('clone-choice-flatten'));
    expect(onChoose).toHaveBeenCalledWith('flatten');
    fireEvent.click(screen.getByTestId('clone-choice-cascade'));
    expect(onChoose).toHaveBeenCalledWith('cascade');
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables every choice while busy', () => {
    render(
      <CloneChoiceDialog
        clones={[{ id: 'c1', title: 'First' }]}
        action="archive"
        subject="session"
        busy
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    for (const id of ['clone-choice-cascade', 'clone-choice-flatten']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByText('Cancel') as HTMLButtonElement).disabled).toBe(true);
  });
});
