import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusDot } from '../StatusDot';

describe('StatusDot', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a dot with the tone background', () => {
    const { container } = render(<StatusDot tone="success" />);
    const dot = container.querySelector('span > span');
    expect(dot?.className).toContain('bg-success');
  });

  it('adds pulse animation when pulse is true', () => {
    const { container } = render(<StatusDot tone="info" pulse />);
    const dot = container.querySelector('span > span');
    expect(dot?.className).toContain('animate-pulse');
  });

  it('does not pulse by default', () => {
    const { container } = render(<StatusDot tone="info" />);
    const dot = container.querySelector('span > span');
    expect(dot?.className).not.toContain('animate-pulse');
  });

  it('prevents the dot from shrinking inside flex rows', () => {
    const { container } = render(<StatusDot tone="neutral" />);
    const wrapper = container.querySelector('span');
    expect(wrapper?.className).toContain('flex-shrink-0');
  });

  it('applies size classes to the wrapper', () => {
    const { container } = render(<StatusDot tone="neutral" size="md" />);
    const wrapper = container.querySelector('span');
    expect(wrapper?.className).toContain('w-2.5');
  });

  it('applies additional classes', () => {
    const { container } = render(<StatusDot tone="danger" className="ml-1" />);
    const wrapper = container.querySelector('span');
    expect(wrapper?.className).toContain('ml-1');
  });

  it('exposes an accessible image role when a label is provided', () => {
    const { container } = render(<StatusDot tone="warning" aria-label="Blocked" />);
    const wrapper = container.querySelector('span');
    expect(wrapper?.getAttribute('role')).toBe('img');
    expect(wrapper?.getAttribute('aria-label')).toBe('Blocked');
    expect(wrapper?.getAttribute('aria-hidden')).toBeNull();
  });

  it('hides unlabeled dots from assistive tech as decorative', () => {
    const { container } = render(<StatusDot tone="info" />);
    const wrapper = container.querySelector('span');
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper?.getAttribute('role')).toBeNull();
    expect(wrapper?.getAttribute('aria-label')).toBeNull();
  });
});
