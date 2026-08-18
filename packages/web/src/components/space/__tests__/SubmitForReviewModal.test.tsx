import { cleanup, fireEvent, render } from '@testing-library/preact';
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmitForReviewModal } from '../SubmitForReviewModal';

describe('SubmitForReviewModal', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  function renderModal(overrides: Partial<Parameters<typeof SubmitForReviewModal>[0]> = {}) {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const utils = render(
      <SubmitForReviewModal
        isOpen={true}
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...overrides}
      />
    );
    return { ...utils, onCancel, onConfirm };
  }

  it('does not render when isOpen is false', () => {
    const { queryByTestId } = render(
      <SubmitForReviewModal isOpen={false} busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />
    );
    expect(queryByTestId('submit-for-review-modal-content')).toBeNull();
  });

  it('renders the body, reason textarea, and confirm/cancel buttons when open', () => {
    const { getByTestId, getByText } = renderModal();
    expect(getByTestId('submit-for-review-modal-content')).toBeTruthy();
    expect(getByTestId('submit-for-review-reason')).toBeTruthy();
    expect(getByTestId('submit-for-review-confirm')).toBeTruthy();
    expect(getByText('Cancel')).toBeTruthy();
  });

  it('confirm forwards the trimmed reason', () => {
    const { getByTestId, onConfirm } = renderModal();
    fireEvent.input(getByTestId('submit-for-review-reason'), {
      target: { value: '  please review the migration  ' },
    });
    fireEvent.click(getByTestId('submit-for-review-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('please review the migration');
  });

  it('confirm passes null when the reason is empty or whitespace-only', () => {
    const { getByTestId, onConfirm } = renderModal();
    fireEvent.click(getByTestId('submit-for-review-confirm'));
    expect(onConfirm).toHaveBeenLastCalledWith(null);

    fireEvent.input(getByTestId('submit-for-review-reason'), {
      target: { value: '     ' },
    });
    fireEvent.click(getByTestId('submit-for-review-confirm'));
    expect(onConfirm).toHaveBeenLastCalledWith(null);
  });

  it('cancel button fires onCancel', () => {
    const { getByText, onCancel } = renderModal();
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('busy=true disables the confirm button, cancel button, and reason textarea', () => {
    const { getByTestId, getByText } = renderModal({ busy: true });
    const confirm = getByTestId('submit-for-review-confirm') as HTMLButtonElement;
    const cancel = getByText('Cancel') as HTMLButtonElement;
    const reason = getByTestId('submit-for-review-reason') as HTMLTextAreaElement;
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(reason.disabled).toBe(true);
    expect(confirm.textContent).toContain('Submitting');
  });

  it('busy=true does not call onCancel when cancel is clicked (button is inert)', () => {
    const { getByText, onCancel } = renderModal({ busy: true });
    fireEvent.click(getByText('Cancel'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('resets the reason field between opens so prior text does not leak', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender, getByTestId } = render(
      <SubmitForReviewModal isOpen={true} busy={false} onCancel={onCancel} onConfirm={onConfirm} />
    );
    fireEvent.input(getByTestId('submit-for-review-reason'), {
      target: { value: 'leftover text' },
    });

    rerender(
      <SubmitForReviewModal isOpen={false} busy={false} onCancel={onCancel} onConfirm={onConfirm} />
    );
    rerender(
      <SubmitForReviewModal isOpen={true} busy={false} onCancel={onCancel} onConfirm={onConfirm} />
    );
    const reason = getByTestId('submit-for-review-reason') as HTMLTextAreaElement;
    expect(reason.value).toBe('');
  });

  it('renders the inline error when the `error` prop is set', () => {
    const { getByTestId } = renderModal({ error: 'Network down — please retry' });
    const errEl = getByTestId('submit-for-review-error');
    expect(errEl.textContent).toContain('Network down — please retry');
    expect(errEl.getAttribute('role')).toBe('alert');
  });

  it('does not render the inline error region when `error` is null/undefined', () => {
    const { queryByTestId } = renderModal({ error: null });
    expect(queryByTestId('submit-for-review-error')).toBeNull();
  });
});
