// @ts-nocheck

import { render } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { IconButton } from '../IconButton';

describe('IconButton', () => {
  describe('Rendering', () => {
    it('should render icon children', () => {
      const { container } = render(
        <IconButton>
          <span class="test-icon">Icon</span>
        </IconButton>
      );
      const icon = container.querySelector('.test-icon');
      expect(icon?.textContent).toBe('Icon');
    });

    it('should render with custom className', () => {
      const { container } = render(
        <IconButton class="custom-icon">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('custom-icon');
    });

    it('should render with title attribute', () => {
      const { container } = render(
        <IconButton title="Click me">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.title).toBe('Click me');
    });
  });

  describe('Variants', () => {
    it('should render ghost variant by default', () => {
      const { container } = render(
        <IconButton>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('hover:bg-dark-800');
    });

    it('should render solid variant', () => {
      const { container } = render(
        <IconButton variant="solid">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('bg-dark-800');
    });

    it('should render default variant', () => {
      const { container } = render(
        <IconButton variant="default">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('bg-dark-800');
    });

    it('should render danger variant', () => {
      const { container } = render(
        <IconButton variant="danger">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('text-red-400');
      expect(button?.className).toContain('hover:bg-red-500/10');
    });
  });

  describe('Active State', () => {
    it('should not be active by default', () => {
      const { container } = render(
        <IconButton>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).not.toContain('bg-indigo-500/20');
    });

    it('should apply accent styles when active', () => {
      const { container } = render(
        <IconButton active>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('bg-indigo-500/20');
      expect(button?.className).toContain('text-indigo-400');
    });
  });

  describe('Sizes', () => {
    it('should render medium size by default', () => {
      const { container } = render(
        <IconButton>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('p-2');
    });

    it('should render small size', () => {
      const { container } = render(
        <IconButton size="sm">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('p-1.5');
    });

    it('should render large size', () => {
      const { container } = render(
        <IconButton size="lg">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('p-3');
    });
  });

  describe('States', () => {
    it('should not be disabled by default', () => {
      const { container } = render(
        <IconButton>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.disabled).toBe(false);
    });

    it('should be disabled when disabled prop is true', () => {
      const { container } = render(
        <IconButton disabled>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.disabled).toBe(true);
    });
  });

  describe('Interactions', () => {
    it('should call onClick when clicked', () => {
      const onClick = vi.fn(() => {});
      const { container } = render(
        <IconButton onClick={onClick}>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');

      button?.click();

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('should not call onClick when disabled', () => {
      const onClick = vi.fn(() => {});
      const { container } = render(
        <IconButton onClick={onClick} disabled>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');

      button?.click();

      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('Button Types', () => {
    it('should default to button type', () => {
      const { container } = render(
        <IconButton>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.type).toBe('button');
    });

    it('should render submit type', () => {
      const { container } = render(
        <IconButton type="submit">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.type).toBe('submit');
    });

    it('should render reset type', () => {
      const { container } = render(
        <IconButton type="reset">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.type).toBe('reset');
    });
  });

  describe('Accessibility', () => {
    it('should have aria-label matching title', () => {
      const { container } = render(
        <IconButton title="Settings">
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.getAttribute('aria-label')).toBe('Settings');
    });

    it('should have focus-visible styles', () => {
      const { container } = render(
        <IconButton>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('focus-visible:outline-none');
      expect(button?.className).toContain('focus-visible:ring-2');
    });

    it('should have disabled cursor when disabled', () => {
      const { container } = render(
        <IconButton disabled>
          <span>Icon</span>
        </IconButton>
      );
      const button = container.querySelector('button');
      expect(button?.className).toContain('disabled:cursor-not-allowed');
    });
  });
});
