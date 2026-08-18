// @ts-nocheck

import { render } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Spinner } from '../Spinner';

describe('Spinner', () => {
  describe('Rendering', () => {
    it('should render a div element', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('div');
      expect(spinner).toBeTruthy();
    });

    it('should have animation class', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('animate-spin');
    });

    it('should have rounded-full class', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('rounded-full');
    });

    it('should have transparent top border', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('border-t-transparent');
    });
  });

  describe('Sizes', () => {
    it('should render small size by default', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('w-4');
      expect(spinner?.className).toContain('h-4');
      expect(spinner?.className).toContain('border-2');
    });

    it('should render extra small size', () => {
      const { container } = render(<Spinner size="xs" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('w-3');
      expect(spinner?.className).toContain('h-3');
      expect(spinner?.className).toContain('border');
    });

    it('should render small size', () => {
      const { container } = render(<Spinner size="sm" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('w-4');
      expect(spinner?.className).toContain('h-4');
      expect(spinner?.className).toContain('border-2');
    });

    it('should render medium size', () => {
      const { container } = render(<Spinner size="md" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('w-5');
      expect(spinner?.className).toContain('h-5');
      expect(spinner?.className).toContain('border-2');
    });

    it('should render large size', () => {
      const { container } = render(<Spinner size="lg" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('w-6');
      expect(spinner?.className).toContain('h-6');
      expect(spinner?.className).toContain('border-2');
    });
  });

  describe('Colors', () => {
    it('should have default gray color', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('border-gray-500');
    });

    it('should accept custom color class', () => {
      const { container } = render(<Spinner color="border-blue-400" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('border-blue-400');
    });

    it('should accept different color classes', () => {
      const { container } = render(<Spinner color="border-red-500" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('border-red-500');
    });

    it('should accept green color class', () => {
      const { container } = render(<Spinner color="border-green-400" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('border-green-400');
    });
  });

  describe('Custom Classes', () => {
    it('should accept additional className', () => {
      const { container } = render(<Spinner className="mr-2" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('mr-2');
    });

    it('should combine custom className with default classes', () => {
      const { container } = render(<Spinner className="custom-spinner" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('custom-spinner');
      expect(spinner?.className).toContain('animate-spin');
      expect(spinner?.className).toContain('rounded-full');
    });

    it('should accept multiple custom classes', () => {
      const { container } = render(<Spinner className="mr-2 mt-1" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('mr-2');
      expect(spinner?.className).toContain('mt-1');
    });
  });

  describe('Accessibility', () => {
    it('should have role="status"', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('[role="status"]');
      expect(spinner).toBeTruthy();
    });

    it('should have aria-label', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('[aria-label="Loading"]');
      expect(spinner).toBeTruthy();
    });

    it('should have aria-label with value "Loading"', () => {
      const { container } = render(<Spinner />);
      const spinner = container.querySelector('div');
      expect(spinner?.getAttribute('aria-label')).toBe('Loading');
    });
  });

  describe('Combined Props', () => {
    it('should render with size and color', () => {
      const { container } = render(<Spinner size="lg" color="border-blue-500" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('w-6');
      expect(spinner?.className).toContain('h-6');
      expect(spinner?.className).toContain('border-blue-500');
    });

    it('should render with size, color, and className', () => {
      const { container } = render(
        <Spinner size="md" color="border-green-400" className="inline-block" />
      );
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('w-5');
      expect(spinner?.className).toContain('h-5');
      expect(spinner?.className).toContain('border-green-400');
      expect(spinner?.className).toContain('inline-block');
    });

    it('should render xs size with custom color', () => {
      const { container } = render(<Spinner size="xs" color="border-yellow-400" />);
      const spinner = container.querySelector('div');
      expect(spinner?.className).toContain('w-3');
      expect(spinner?.className).toContain('h-3');
      expect(spinner?.className).toContain('border-yellow-400');
    });
  });
});
