import { cleanup, render, screen } from '@testing-library/preact';
import { useRef } from 'preact/hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { Spinner } from '../src/mod.ts';

afterEach(() => {
  cleanup();
});

describe('Spinner', () => {
  describe('role and accessibility', () => {
    it('renders with role="status"', () => {
      render(<Spinner />);
      const spinner = screen.getByRole('status');
      expect(spinner).not.toBeNull();
    });

    it('has default aria-label "Loading"', () => {
      render(<Spinner />);
      const spinner = screen.getByRole('status');
      expect(spinner.getAttribute('aria-label')).toBe('Loading');
    });

    it('custom label prop sets aria-label', () => {
      render(<Spinner label="Saving data" />);
      const spinner = screen.getByRole('status');
      expect(spinner.getAttribute('aria-label')).toBe('Saving data');
    });

    it('contains sr-only text for screen readers', () => {
      render(<Spinner label="Processing" />);
      const srSpan = document.querySelector('span[role="status"] span');
      expect(srSpan?.textContent).toBe('Processing');
    });

    it('sr-only span is visually hidden via inline style', () => {
      render(<Spinner label="Loading" />);
      const spinner = screen.getByRole('status');
      const srSpan = spinner.querySelector('span');
      expect(srSpan).not.toBeNull();
      const style = srSpan?.getAttribute('style') ?? '';
      expect(style).toContain('position');
    });
  });

  describe('data-slot', () => {
    it('has data-slot="spinner"', () => {
      render(<Spinner />);
      const spinner = screen.getByRole('status');
      expect(spinner.getAttribute('data-slot')).toBe('spinner');
    });
  });

  describe('default element', () => {
    it('renders as span by default', () => {
      const { container } = render(<Spinner />);
      const span = container.querySelector('span[role="status"]');
      expect(span).not.toBeNull();
    });
  });

  describe('polymorphic as prop', () => {
    it('renders as custom element with as="div"', () => {
      const { container } = render(<Spinner as="div" />);
      const div = container.querySelector('div[role="status"]');
      expect(div).not.toBeNull();
    });

    it('renders as custom element with as="p"', () => {
      const { container } = render(<Spinner as="p" />);
      const p = container.querySelector('p[role="status"]');
      expect(p).not.toBeNull();
    });
  });

  describe('ref forwarding', () => {
    it('component accepts a ref prop and renders correctly', () => {
      function WithRef() {
        const ref = useRef<HTMLElement>(null);
        return <Spinner ref={ref} data-testid="spinner-with-ref" />;
      }
      render(<WithRef />);
      const el = screen.getByTestId('spinner-with-ref');
      expect(el).not.toBeNull();
      expect(el.getAttribute('role')).toBe('status');
    });
  });

  describe('additional props', () => {
    it('passes through className', () => {
      render(<Spinner class="my-spinner" />);
      const spinner = screen.getByRole('status');
      expect(spinner.className).toContain('my-spinner');
    });

    it('passes through data-testid', () => {
      render(<Spinner data-testid="my-spinner" />);
      expect(screen.getByTestId('my-spinner')).not.toBeNull();
    });

    it('passes through additional arbitrary props', () => {
      render(<Spinner id="spinner-1" />);
      const spinner = screen.getByRole('status');
      expect(spinner.getAttribute('id')).toBe('spinner-1');
    });
  });

  describe('children', () => {
    it('renders custom children alongside sr-only text', () => {
      render(
        <Spinner>
          <svg data-testid="spin-icon" aria-hidden="true" />
        </Spinner>
      );
      expect(screen.getByTestId('spin-icon')).not.toBeNull();
    });
  });

  describe('default label', () => {
    it('sr-only span shows "Loading" by default', () => {
      render(<Spinner />);
      const spinner = screen.getByRole('status');
      const srSpan = spinner.querySelector('span');
      expect(srSpan?.textContent).toBe('Loading');
    });
  });
});
