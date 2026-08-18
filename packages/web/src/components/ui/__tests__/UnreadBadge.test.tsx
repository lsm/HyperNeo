import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { UnreadBadge } from '../UnreadBadge';

describe('UnreadBadge', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the count', () => {
    const { container } = render(<UnreadBadge count={3} />);
    expect(container.textContent).toBe('3 unread');
  });

  it('exposes an accessible "unread" description for screen readers', () => {
    const { container } = render(<UnreadBadge count={3} />);
    const srOnly = container.querySelector('.sr-only');
    expect(srOnly?.textContent).toBe(' unread');
  });

  it('returns null for zero', () => {
    const { container } = render(<UnreadBadge count={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null for negative counts', () => {
    const { container } = render(<UnreadBadge count={-1} />);
    expect(container.firstChild).toBeNull();
  });

  it('caps the display at the configured max', () => {
    const { container } = render(<UnreadBadge count={150} max={99} />);
    expect(container.textContent).toBe('99+ unread');
  });

  it('uses the default max of 99', () => {
    const { container } = render(<UnreadBadge count={100} />);
    expect(container.textContent).toBe('99+ unread');
  });

  it('uses a high-contrast blue background for the white count', () => {
    const { container } = render(<UnreadBadge count={1} />);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('bg-blue-600');
  });
});
