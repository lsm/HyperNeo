import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { ThinkingLevelIcon } from '../ThinkingLevelIcon';

describe('ThinkingLevelIcon', () => {
  afterEach(() => cleanup());

  it.each([
    ['think8k', '0.25'],
    ['think16k', '0.5'],
    ['think24k', '0.75'],
    ['think32k', '1'],
  ] as const)('lights %s as a %s share of the ring', (level, share) => {
    const { container } = render(<ThinkingLevelIcon ring level={level} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('data-thinking-share')).toBe(share);
    expect(svg.querySelectorAll('circle')).toHaveLength(2);
    expect(svg.querySelectorAll('circle')[1].getAttribute('stroke-dasharray')).toBeTruthy();
    expect(svg.getAttribute('class')).toContain('text-warning');
  });

  it('shows only the unlit track when thinking is off', () => {
    const { container } = render(<ThinkingLevelIcon ring level="off" />);
    const svg = container.querySelector('svg')!;
    expect(svg.querySelectorAll('circle')).toHaveLength(1);
    expect(svg.getAttribute('class')).toContain('text-fg-muted');
  });

  it('keeps the plain bulb without a ring by default', () => {
    const { container } = render(<ThinkingLevelIcon level="think16k" />);
    expect(container.querySelector('[data-thinking-share]')).toBeNull();
  });
});
