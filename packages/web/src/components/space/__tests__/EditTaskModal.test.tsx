// @ts-nocheck

import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditTaskModal } from '../EditTaskModal';

const DEFAULT_PROPS = {
  initialTitle: 'My Task',
  initialDescription: 'Do the thing',
  initialPriority: 'normal' as const,
};

describe('EditTaskModal', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  function renderModal(overrides: Partial<Parameters<typeof EditTaskModal>[0]> = {}) {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const utils = render(
      <EditTaskModal
        isOpen={true}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...DEFAULT_PROPS}
        {...overrides}
      />
    );
    return { ...utils, onCancel, onConfirm };
  }

  it('does not render when isOpen is false', () => {
    const { queryByTestId } = render(
      <EditTaskModal
        isOpen={false}
        busy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        {...DEFAULT_PROPS}
      />
    );
    expect(queryByTestId('edit-task-modal-content')).toBeNull();
  });

  it('renders title input, description textarea, priority select, and buttons when open', () => {
    const { getByTestId, getByText } = renderModal();
    expect(getByTestId('edit-task-modal-content')).toBeTruthy();
    expect(getByTestId('edit-task-title')).toBeTruthy();
    expect(getByTestId('edit-task-description')).toBeTruthy();
    expect(getByTestId('edit-task-priority')).toBeTruthy();
    expect(getByTestId('edit-task-confirm')).toBeTruthy();
    expect(getByText('Cancel')).toBeTruthy();
  });

  it('confirm button is disabled when no changes are made', () => {
    const { getByTestId } = renderModal();
    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('confirm button is enabled when title changes', () => {
    const { getByTestId } = renderModal();
    fireEvent.input(getByTestId('edit-task-title'), { target: { value: 'New Title' } });
    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('confirm button is enabled when description changes', () => {
    const { getByTestId } = renderModal();
    fireEvent.input(getByTestId('edit-task-description'), {
      target: { value: 'New description' },
    });
    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('confirm button is enabled when priority changes', () => {
    const { getByTestId } = renderModal();
    fireEvent.input(getByTestId('edit-task-priority'), { target: { value: 'high' } });
    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('confirm sends only the changed title, not untouched fields', () => {
    const { getByTestId, onConfirm } = renderModal();
    fireEvent.input(getByTestId('edit-task-title'), { target: { value: 'New Title' } });
    fireEvent.click(getByTestId('edit-task-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      title: 'New Title',
    });
  });

  it('confirm is disabled when title is emptied', () => {
    const { getByTestId } = renderModal();
    fireEvent.input(getByTestId('edit-task-title'), { target: { value: '' } });
    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('confirm is disabled when title is whitespace-only', () => {
    const { getByTestId } = renderModal();
    fireEvent.input(getByTestId('edit-task-title'), { target: { value: '   ' } });
    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('confirm is disabled when only whitespace changes are made (semantic no-op)', () => {
    const { getByTestId } = renderModal();
    fireEvent.input(getByTestId('edit-task-title'), { target: { value: '  My Task  ' } });
    fireEvent.input(getByTestId('edit-task-description'), {
      target: { value: '  Do the thing  ' },
    });
    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('confirm forwards only changed fields', () => {
    const { getByTestId, onConfirm } = renderModal();
    fireEvent.input(getByTestId('edit-task-title'), {
      target: { value: '  Updated Title  ' },
    });
    fireEvent.input(getByTestId('edit-task-description'), {
      target: { value: '  New desc  ' },
    });
    fireEvent.click(getByTestId('edit-task-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      title: 'Updated Title',
      description: 'New desc',
    });
  });

  it('confirm forwards priority change only', () => {
    const { getByTestId, onConfirm } = renderModal();
    fireEvent.change(getByTestId('edit-task-priority'), { target: { value: 'urgent' } });
    fireEvent.click(getByTestId('edit-task-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      priority: 'urgent',
    });
  });

  it('cancel button fires onCancel', () => {
    const { getByText, onCancel } = renderModal();
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('busy=true disables confirm, cancel, and all inputs', () => {
    const { getByTestId, getByText } = renderModal({ busy: true });
    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    const cancel = getByText('Cancel') as HTMLButtonElement;
    const title = getByTestId('edit-task-title') as HTMLInputElement;
    const description = getByTestId('edit-task-description') as HTMLTextAreaElement;
    const priority = getByTestId('edit-task-priority') as HTMLSelectElement;
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(title.disabled).toBe(true);
    expect(description.disabled).toBe(true);
    expect(priority.disabled).toBe(true);
    expect(confirm.textContent).toContain('Saving');
  });

  it('busy=true does not call onCancel when cancel is clicked', () => {
    const { getByText, onCancel } = renderModal({ busy: true });
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('resets form fields between opens', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender, getByTestId } = render(
      <EditTaskModal
        isOpen={true}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...DEFAULT_PROPS}
      />
    );
    fireEvent.input(getByTestId('edit-task-title'), { target: { value: 'Stale Title' } });

    rerender(
      <EditTaskModal
        isOpen={false}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...DEFAULT_PROPS}
      />
    );
    rerender(
      <EditTaskModal
        isOpen={true}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...DEFAULT_PROPS}
      />
    );
    const title = getByTestId('edit-task-title') as HTMLInputElement;
    expect(title.value).toBe('My Task');
  });

  it('renders the inline error when the error prop is set', () => {
    const { getByTestId } = renderModal({ error: 'Update failed — try again' });
    const errEl = getByTestId('edit-task-error');
    expect(errEl.textContent).toContain('Update failed — try again');
    expect(errEl.getAttribute('role')).toBe('alert');
  });

  it('does not render the error region when error is null', () => {
    const { queryByTestId } = renderModal({ error: null });
    expect(queryByTestId('edit-task-error')).toBeNull();
  });

  it('does not overwrite user edits when initial props change while open', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender, getByTestId } = render(
      <EditTaskModal
        isOpen={true}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...DEFAULT_PROPS}
      />
    );
    fireEvent.input(getByTestId('edit-task-title'), { target: { value: 'My New Title' } });

    rerender(
      <EditTaskModal
        isOpen={true}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        initialTitle="Changed Externally"
        initialDescription="Do the thing"
        initialPriority="normal"
      />
    );

    const title = getByTestId('edit-task-title') as HTMLInputElement;
    expect(title.value).toBe('My New Title');
  });

  it('compares against frozen baseline, not live props, to avoid sending stale values', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender, getByTestId } = render(
      <EditTaskModal
        isOpen={true}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...DEFAULT_PROPS}
      />
    );

    rerender(
      <EditTaskModal
        isOpen={true}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        initialTitle="My Task"
        initialDescription="Updated externally"
        initialPriority="high"
      />
    );

    const confirm = getByTestId('edit-task-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
