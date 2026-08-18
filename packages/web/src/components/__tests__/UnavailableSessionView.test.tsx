import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { UnavailableSessionView } from '../UnavailableSessionView';

afterEach(() => {
  cleanup();
});

describe('UnavailableSessionView', () => {
  it('renders the alertdialog role + kind on the root for a11y', () => {
    const { getByTestId } = render(<UnavailableSessionView kind="not-found" actions={[]} />);
    const root = getByTestId('session-unavailable-view');
    expect(root.getAttribute('role')).toBe('alertdialog');
    expect(root.getAttribute('data-unavailable-kind')).toBe('not-found');
  });

  it.each([
    'not-found',
    'unauthorized',
    'archived',
    'terminated',
    'timeout',
    'disconnected',
    'unknown',
  ] as const)('renders a distinct, non-generic heading for %s', (kind) => {
    const { getByTestId } = render(<UnavailableSessionView kind={kind} actions={[]} />);
    const heading = getByTestId('session-unavailable-view').querySelector('h3');
    expect(heading?.textContent).toBeTruthy();
    expect(heading?.textContent).not.toContain('Failed to load session');
  });

  it('renders the supplied actions and invokes them on click', () => {
    const onBack = vi.fn();
    const onRetry = vi.fn();
    const { getByText } = render(
      <UnavailableSessionView
        kind="not-found"
        actions={[
          { label: 'Go back', onClick: onBack, testId: 'unavailable-back' },
          { label: 'Try again', onClick: onRetry, testId: 'unavailable-retry' },
        ]}
      />
    );
    fireEvent.click(getByText('Go back'));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText('Try again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows no action buttons when none are provided (no empty fallback shell)', () => {
    const { getByTestId } = render(<UnavailableSessionView kind="unknown" actions={[]} />);
    const root = getByTestId('session-unavailable-view');
    expect(root.querySelector('button')).toBeNull();
  });

  it('shows a custom detail line when provided', () => {
    const { getByTestId } = render(
      <UnavailableSessionView kind="unknown" actions={[]} detail="underlying error: boom" />
    );
    const detail = getByTestId('session-unavailable-view').querySelector('p');
    expect(detail?.textContent).toContain('underlying error: boom');
  });

  it('uses per-instance aria IDs so two mounted instances do not collide', () => {
    const { getAllByRole } = render(
      <>
        <UnavailableSessionView kind="not-found" actions={[]} />
        <UnavailableSessionView kind="timeout" actions={[]} />
      </>
    );
    const dialogs = getAllByRole('alertdialog');
    expect(dialogs).toHaveLength(2);
    const headings = dialogs.map((d) => d.querySelector('h3')?.id);
    const details = dialogs.map((d) => d.querySelector('p')?.id);
    expect(new Set(headings).size).toBe(2);
    expect(new Set(details).size).toBe(2);
    for (const d of dialogs) {
      expect(d.querySelector('h3')?.id).toBe(d.getAttribute('aria-labelledby'));
      expect(d.querySelector('p')?.id).toBe(d.getAttribute('aria-describedby'));
    }
  });
});
