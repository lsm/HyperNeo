// @ts-nocheck

import { render } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Skeleton, SkeletonMessage } from '../Skeleton';

describe('Skeleton', () => {
  describe('Variants', () => {
    it('should render text variant by default', () => {
      const { container } = render(<Skeleton />);
      const skeleton = container.querySelector('.skeleton');
      expect(skeleton?.className).toContain('rounded');
      expect(skeleton?.className).toContain('h-4');
    });

    it('should render circle variant', () => {
      const { container } = render(<Skeleton variant="circle" />);
      const skeleton = container.querySelector('.skeleton');
      expect(skeleton?.className).toContain('rounded-full');
    });

    it('should render rectangle variant', () => {
      const { container } = render(<Skeleton variant="rectangle" />);
      const skeleton = container.querySelector('.skeleton');
      expect(skeleton?.className).toContain('rounded-lg');
    });
  });

  describe('Sizing', () => {
    it('should apply width as number', () => {
      const { container } = render(<Skeleton width={100} />);
      const skeleton = container.querySelector('.skeleton') as HTMLElement;
      expect(skeleton?.style.width).toBe('100px');
    });

    it('should apply width as string', () => {
      const { container } = render(<Skeleton width="50%" />);
      const skeleton = container.querySelector('.skeleton') as HTMLElement;
      expect(skeleton?.style.width).toBe('50%');
    });

    it('should apply height as number', () => {
      const { container } = render(<Skeleton height={50} />);
      const skeleton = container.querySelector('.skeleton') as HTMLElement;
      expect(skeleton?.style.height).toBe('50px');
    });

    it('should apply height as string', () => {
      const { container } = render(<Skeleton height="2rem" />);
      const skeleton = container.querySelector('.skeleton') as HTMLElement;
      expect(skeleton?.style.height).toBe('2rem');
    });

    it('should apply both width and height', () => {
      const { container } = render(<Skeleton width={100} height={50} />);
      const skeleton = container.querySelector('.skeleton') as HTMLElement;
      expect(skeleton?.style.width).toBe('100px');
      expect(skeleton?.style.height).toBe('50px');
    });
  });

  describe('Custom Styling', () => {
    it('should apply custom className', () => {
      const { container } = render(<Skeleton class="custom-skeleton" />);
      const skeleton = container.querySelector('.skeleton');
      expect(skeleton?.className).toContain('custom-skeleton');
    });

    it('should merge custom className with variant classes', () => {
      const { container } = render(<Skeleton variant="circle" class="custom" />);
      const skeleton = container.querySelector('.skeleton');
      expect(skeleton?.className).toContain('rounded-full');
      expect(skeleton?.className).toContain('custom');
    });
  });
});

describe('SkeletonMessage', () => {
  it('should render avatar skeleton', () => {
    const { container } = render(<SkeletonMessage />);
    const skeletons = container.querySelectorAll('.skeleton');

    const circleSkeletons = Array.from(skeletons).filter((el) =>
      el.className.includes('rounded-full')
    );
    expect(circleSkeletons.length).toBeGreaterThan(0);
  });

  it('should render with flex layout', () => {
    const { container } = render(<SkeletonMessage />);
    const wrapper = container.querySelector('.flex.gap-3');
    expect(wrapper).toBeTruthy();
  });

  it('should render title and text skeletons', () => {
    const { container } = render(<SkeletonMessage />);
    const skeletons = container.querySelectorAll('.skeleton');

    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('should render avatar with fixed size', () => {
    const { container } = render(<SkeletonMessage />);
    const skeletons = container.querySelectorAll('.skeleton');
    const avatar = Array.from(skeletons).find((el) =>
      el.className.includes('rounded-full')
    ) as HTMLElement;

    expect(avatar?.style.width).toBe('40px');
    expect(avatar?.style.height).toBe('40px');
  });
});

describe('Skeleton Edge Cases', () => {
  it('should handle zero width', () => {
    const { container } = render(<Skeleton width={0} />);
    const skeleton = container.querySelector('.skeleton') as HTMLElement;
    expect(skeleton?.style.width === '0px' || skeleton?.style.width === '').toBe(true);
  });

  it('should handle zero height', () => {
    const { container } = render(<Skeleton height={0} />);
    const skeleton = container.querySelector('.skeleton') as HTMLElement;
    expect(skeleton?.style.height === '0px' || skeleton?.style.height === '').toBe(true);
  });

  it('should handle very large dimensions', () => {
    const { container } = render(<Skeleton width={9999} height={9999} />);
    const skeleton = container.querySelector('.skeleton') as HTMLElement;
    expect(skeleton?.style.width).toBe('9999px');
    expect(skeleton?.style.height).toBe('9999px');
  });

  it('should handle complex width strings', () => {
    const { container } = render(<Skeleton width="calc(100% - 20px)" />);
    const skeleton = container.querySelector('.skeleton') as HTMLElement;
    expect(skeleton?.style.width).toBe('calc(100% - 20px)');
  });
});
