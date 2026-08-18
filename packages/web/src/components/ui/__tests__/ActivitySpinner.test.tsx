import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivitySpinner } from '../ActivitySpinner';

describe('ActivitySpinner', () => {
  afterEach(() => {
    cleanup();
  });

  it('defaults to the info tone border color', () => {
    const { container } = render(<ActivitySpinner />);
    const spinner = container.querySelector('[role="status"]');
    expect(spinner?.className).toContain('border-blue-500');
  });

  it('derives the border color from the tone', () => {
    const { container } = render(<ActivitySpinner tone="warning" />);
    const spinner = container.querySelector('[role="status"]');
    expect(spinner?.className).toContain('border-amber-500');
  });

  it('applies additional classes', () => {
    const { container } = render(<ActivitySpinner tone="success" className="mr-2" />);
    const spinner = container.querySelector('[role="status"]');
    expect(spinner?.className).toContain('mr-2');
  });
});
