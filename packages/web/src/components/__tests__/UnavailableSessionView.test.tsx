/**
 * Tests for UnavailableSessionView (task #873).
 *
 * Covers each error class's heading/detail/actions and the accessibility role,
 * so the per-cause unavailable state is rendered accurately instead of the
 * legacy collapsed "Failed to load session".
 */

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
    // None collapse to the legacy wording.
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
    const detail = getByTestId('session-unavailable-view').querySelector(
      '#session-unavailable-detail'
    );
    expect(detail?.textContent).toContain('underlying error: boom');
  });
});
