import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { TouchTarget } from '../src/mod.ts';

afterEach(() => {
  cleanup();
});

describe('TouchTarget', () => {
  it('should render a span by default', () => {
    render(<TouchTarget />);
    const element = document.querySelector('span');
    expect(element).not.toBeNull();
    expect(element?.tagName.toLowerCase()).toBe('span');
  });

  it('should be aria-hidden', () => {
    render(<TouchTarget />);
    const element = document.querySelector('span');
    expect(element?.getAttribute('aria-hidden')).toBe('true');
  });

  it('should render with absolute positioning and inset-0 styles', () => {
    render(<TouchTarget />);
    const element = document.querySelector('span');
    const style = element?.style;
    expect(style?.position).toBe('absolute');
    expect(style?.inset).toBe('0');
  });

  it('should support custom as prop to render as different element', () => {
    render(<TouchTarget as="div" />);
    const element = document.querySelector('div');
    expect(element).not.toBeNull();
  });

  it('should pass through className', () => {
    render(<TouchTarget class="pointer-fine:hidden custom-class" />);
    const element = document.querySelector('span');
    expect(element?.className).toContain('pointer-fine:hidden');
    expect(element?.className).toContain('custom-class');
  });

  it('should render children when provided', () => {
    render(
      <TouchTarget>
        <span data-testid="child-span">Expanded touch area</span>
      </TouchTarget>
    );
    const childElement = document.querySelector('[data-testid="child-span"]');
    expect(childElement?.textContent).toBe('Expanded touch area');
  });

  it('should pass through additional props', () => {
    render(<TouchTarget data-testid="touch-target" />);
    const element = document.querySelector('[data-testid="touch-target"]');
    expect(element).not.toBeNull();
  });

  it('should have displayName set correctly', () => {
    expect(TouchTarget.displayName).toBe('TouchTarget');
  });
});
