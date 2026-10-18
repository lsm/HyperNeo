import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { ThinkingLevelIcon } from '../ThinkingLevelIcon';

function ringArc(container: Element) {
  return container.querySelector('svg.absolute circle');
}

function litRays(container: Element) {
  return [...container.querySelectorAll('path[data-lit="true"]')].map((ray) =>
    ray.getAttribute('d')
  );
}

describe('ThinkingLevelIcon', () => {
  afterEach(() => cleanup());

  it.each([
    ['think8k', 1 / 6, '#d97706'],
    ['think16k', 2 / 6, '#ea8a0a'],
    ['think24k', 3 / 6, '#f59e0b'],
    ['think32k', 4 / 6, '#fbbf24'],
    ['think48k', 5 / 6, '#fcd34d'],
    ['think64k', 1, '#fde68a'],
  ] as const)('ring fills %s as a %s share in the level color', (level, share, color) => {
    const { container } = render(<ThinkingLevelIcon level={level} />);
    const arc = ringArc(container)!;
    const [lit, rest] = arc.getAttribute('stroke-dasharray')!.split(' ').map(Number);
    expect(lit / (lit + rest)).toBeCloseTo(share);
    expect(arc.getAttribute('stroke')).toBe(color);
  });

  it('thinking off leaves the ring empty and the whole bulb unlit', () => {
    const { container } = render(<ThinkingLevelIcon level="off" />);
    expect(ringArc(container)).toBeNull();
    expect(container.querySelector('[data-bulb-lit]')).toBeNull();
    expect(litRays(container)).toEqual([]);
    expect(container.querySelector('svg.thinking-bulb-unlit')).toBeTruthy();
  });

  it.each([
    ['think8k', '16.6', '0'],
    ['think16k', '4.5', '0'],
    ['think24k', '4.5', '0.75'],
  ] as const)('the bulb at %s lights from y=%s with inside opacity %s', (level, fromY, fill) => {
    const { container } = render(<ThinkingLevelIcon level={level} />);
    expect(container.querySelector('clipPath rect')?.getAttribute('y')).toBe(fromY);
    expect(container.querySelector('[data-bulb-lit] path')?.getAttribute('opacity')).toBe(fill);
  });

  it.each([
    ['think24k', []],
    ['think32k', ['M12 3v1']],
    ['think48k', ['M12 3v1', 'M21 12h-1', 'M4 12H3']],
    [
      'think64k',
      ['M12 3v1', 'M18.364 5.636l-.707.707', 'M21 12h-1', 'M4 12H3', 'M6.343 6.343l-.707-.707'],
    ],
  ] as const)('rays lit at %s', (level, rays) => {
    const { container } = render(<ThinkingLevelIcon level={level} />);
    expect(litRays(container)).toEqual(rays);
  });

  it('only 64k glows with a halo behind the bulb', () => {
    const glow = (level: 'think48k' | 'think64k') =>
      render(<ThinkingLevelIcon level={level} />).container.querySelector('circle[r="7.5"]');
    expect(glow('think48k')).toBeNull();
    cleanup();
    expect(glow('think64k')?.getAttribute('fill')).toBe('#fde68a');
  });
});
