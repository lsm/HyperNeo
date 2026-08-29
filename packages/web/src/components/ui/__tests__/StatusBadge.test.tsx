import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBadge } from '../StatusBadge';

describe('StatusBadge', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the label text', () => {
    const { container } = render(<StatusBadge tone="warning" label="Blocked" />);
    expect(container.textContent).toBe('Blocked');
  });

  it('renders children when no label is provided', () => {
    const { container } = render(<StatusBadge tone="info">In Progress</StatusBadge>);
    expect(container.textContent).toBe('In Progress');
  });

  it('applies the soft tone classes', () => {
    const { container } = render(<StatusBadge tone="special" label="Review" />);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('border-cat-purple/30');
    expect(badge?.className).toContain('bg-cat-purple/10');
    expect(badge?.className).toContain('text-cat-purple');
  });

  it('applies additional classes', () => {
    const { container } = render(<StatusBadge tone="success" label="Done" className="ml-1" />);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('ml-1');
  });

  it('prevents multiword labels from wrapping', () => {
    const { container } = render(<StatusBadge tone="special" label="Awaiting Review" />);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('whitespace-nowrap');
  });
});
