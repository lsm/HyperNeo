import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { TaskRunComposer } from '../TaskRunComposer';

afterEach(() => cleanup());

describe('TaskRunComposer', () => {
  it('runs with the trimmed note and clears it once the start is accepted', async () => {
    const onRun = vi.fn(async () => true);
    const { getByTestId } = render(
      <TaskRunComposer taskId="t1" label="Run" busy={false} onRun={onRun} />
    );
    const note = getByTestId('task-run-note') as HTMLTextAreaElement;
    fireEvent.input(note, { target: { value: '  Use the staging database.  ' } });
    fireEvent.click(getByTestId('task-run-composer-button'));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith('Use the staging database.'));
    await waitFor(() => expect(note.value).toBe(''));
  });

  it('runs without a note and keeps the draft when the start is refused', async () => {
    const onRun = vi.fn(async () => false);
    const { getByTestId } = render(
      <TaskRunComposer
        taskId="t1"
        label="Run"
        busy={false}
        errorMessage="No free slot"
        onRun={onRun}
      />
    );
    fireEvent.click(getByTestId('task-run-composer-button'));
    await waitFor(() => expect(onRun).toHaveBeenCalledWith(null));
    const note = getByTestId('task-run-note') as HTMLTextAreaElement;
    fireEvent.input(note, { target: { value: 'keep me' } });
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onRun).toHaveBeenLastCalledWith('keep me'));
    expect(note.value).toBe('keep me');
    expect(getByTestId('task-run-composer').textContent).toContain('No free slot');
  });

  it('does not run while busy', () => {
    const onRun = vi.fn(async () => true);
    const { getByTestId } = render(<TaskRunComposer taskId="t1" label="Run" busy onRun={onRun} />);
    fireEvent.click(getByTestId('task-run-composer-button'));
    expect(onRun).not.toHaveBeenCalled();
  });
});
