import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { ThinkingLevelIcon } from '../ThinkingLevelIcon';

function ringArc(container: Element) {
  return container.querySelector('svg.absolute circle');
}

describe('ThinkingLevelIcon', () => {
  afterEach(() => cleanup());

  it.each([
    ['think8k', 1 / 6],
    ['think16k', 2 / 6],
    ['think24k', 3 / 6],
    ['think32k', 4 / 6],
    ['think48k', 5 / 6],
    ['think64k', 1],
  ] as const)('ring lights %s as a %s share around the glowing bulb', (level, share) => {
    const { container } = render(<ThinkingLevelIcon ring level={level} />);
    const [lit, rest] = ringArc(container)!
      .getAttribute('stroke-dasharray')!
      .split(' ')
      .map(Number);
    expect(lit / (lit + rest)).toBeCloseTo(share);
    expect(container.querySelector('svg:not(.absolute) circle[fill="currentColor"]')).toBeTruthy();
  });

  it('ring shows an unlit outline and a dim bulb when thinking is off', () => {
    const { container } = render(<ThinkingLevelIcon ring level="off" />);
    expect(ringArc(container)).toBeNull();
    expect(container.querySelector('[data-thinking-level="off"]')?.className).toContain('border');
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('text-fg-muted');
  });

  it('keeps the plain bulb without a ring by default', () => {
    const { container } = render(<ThinkingLevelIcon level="think16k" />);
    expect(container.querySelector('[data-thinking-level]')).toBeNull();
    expect(ringArc(container)).toBeNull();
  });
});
