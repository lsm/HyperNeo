import { cleanup, render, screen } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { Skeleton } from '../src/mod.ts';

afterEach(() => {
  cleanup();
});

describe('Skeleton', () => {
  describe('role and accessibility', () => {
    it('renders with role="presentation"', () => {
      render(<Skeleton />);
      const el = document.querySelector('[role="presentation"]');
      expect(el).not.toBeNull();
    });

    it('has aria-hidden="true"', () => {
      render(<Skeleton />);
      const el = document.querySelector('[data-slot="skeleton"]');
      expect(el?.getAttribute('aria-hidden')).toBe('true');
    });
  });

  describe('data-slot', () => {
    it('has data-slot="skeleton"', () => {
      render(<Skeleton />);
      const el = document.querySelector('[data-slot="skeleton"]');
      expect(el).not.toBeNull();
    });
  });

  describe('data-animation', () => {
    it('defaults to data-animation="pulse"', () => {
      render(<Skeleton />);
      const el = document.querySelector('[data-slot="skeleton"]');
      expect(el?.getAttribute('data-animation')).toBe('pulse');
    });

    it('sets data-animation="wave"', () => {
      render(<Skeleton animation="wave" />);
      const el = document.querySelector('[data-slot="skeleton"]');
      expect(el?.getAttribute('data-animation')).toBe('wave');
    });

    it('sets data-animation="none"', () => {
      render(<Skeleton animation="none" />);
      const el = document.querySelector('[data-slot="skeleton"]');
      expect(el?.getAttribute('data-animation')).toBe('none');
    });

    it('sets data-animation="pulse" explicitly', () => {
      render(<Skeleton animation="pulse" />);
      const el = document.querySelector('[data-slot="skeleton"]');
      expect(el?.getAttribute('data-animation')).toBe('pulse');
    });
  });

  describe('default element', () => {
    it('renders as div by default', () => {
      const { container } = render(<Skeleton />);
      const div = container.querySelector('div[data-slot="skeleton"]');
      expect(div).not.toBeNull();
    });
  });

  describe('polymorphic as prop', () => {
    it('renders as span with as="span"', () => {
      const { container } = render(<Skeleton as="span" />);
      const span = container.querySelector('span[data-slot="skeleton"]');
      expect(span).not.toBeNull();
    });

    it('renders as li with as="li"', () => {
      const { container } = render(
        <ul>
          <Skeleton as="li" />
        </ul>
      );
      const li = container.querySelector('li[data-slot="skeleton"]');
      expect(li).not.toBeNull();
    });

    it('renders as section with as="section"', () => {
      const { container } = render(<Skeleton as="section" />);
      const section = container.querySelector('section[data-slot="skeleton"]');
      expect(section).not.toBeNull();
    });
  });

  describe('ref forwarding', () => {
    it('component accepts a ref prop and renders correctly', () => {
      function WithRef() {
        const ref = useRef<HTMLElement>(null);
        return <Skeleton ref={ref} data-testid="skeleton-with-ref" />;
      }
      render(<WithRef />);
      const el = document.querySelector('[data-testid="skeleton-with-ref"]');
      expect(el).not.toBeNull();
      expect(el?.getAttribute('data-slot')).toBe('skeleton');
    });
  });

  describe('additional props', () => {
    it('passes through className', () => {
      const { container } = render(<Skeleton class="my-skeleton" />);
      const el = container.querySelector('[data-slot="skeleton"]');
      expect(el?.className).toContain('my-skeleton');
    });

    it('passes through data-testid', () => {
      render(<Skeleton data-testid="my-skeleton" />);
      const el = document.querySelector('[data-testid="my-skeleton"]');
      expect(el).not.toBeNull();
    });

    it('passes through id prop', () => {
      render(<Skeleton id="skeleton-1" />);
      const el = document.querySelector('[data-slot="skeleton"]');
      expect(el?.getAttribute('id')).toBe('skeleton-1');
    });
  });

  describe('children', () => {
    it('renders children inside skeleton', () => {
      render(
        <Skeleton>
          <span data-testid="child">inner</span>
        </Skeleton>
      );
      expect(document.querySelector('[data-testid="child"]')).not.toBeNull();
    });
  });
});
