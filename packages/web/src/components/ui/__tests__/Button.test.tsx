// @ts-nocheck

import { render } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { Button } from '../Button';

describe('Button', () => {
  describe('Rendering', () => {
    it('should render children', () => {
      const { container } = render(<Button>Click Me</Button>);
      const button = container.querySelector('button');
      expect(button?.textContent).toBe('Click Me');
    });

    it('should render with custom className', () => {
      const { container } = render(<Button class="custom-class">Test</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('custom-class');
    });

    it('should render with icon', () => {
      const { container } = render(
        <Button icon={<span class="icon">Icon</span>}>With Icon</Button>
      );
      const icon = container.querySelector('.icon');
      expect(icon?.textContent).toBe('Icon');
    });
  });

  describe('Variants', () => {
    it('should render primary variant by default', () => {
      const { container } = render(<Button>Primary</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('bg-accent-hover');
    });

    it('should render secondary variant', () => {
      const { container } = render(<Button variant="secondary">Secondary</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('bg-surface-raised');
    });

    it('should render ghost variant', () => {
      const { container } = render(<Button variant="ghost">Ghost</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('hover:bg-surface-raised');
    });

    it('should render danger variant', () => {
      const { container } = render(<Button variant="danger">Danger</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('bg-danger');
    });

    it('should render approve variant with emerald background', () => {
      const { container } = render(<Button variant="approve">Approve</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('bg-emerald-600');
      expect(button?.className).toContain('hover:bg-emerald-700');
      expect(button?.className).toContain('text-accent-fg');
    });

    it('should render interrupt variant with amber outline', () => {
      const { container } = render(<Button variant="interrupt">Interrupt</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('border-warning');
      expect(button?.className).toContain('text-warning');
    });
  });

  describe('Sizes', () => {
    it('should render medium size by default', () => {
      const { container } = render(<Button>Medium</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('px-4');
    });

    it('should render xs size', () => {
      const { container } = render(<Button size="xs">XSmall</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('h-6');
      expect(button?.className).toContain('px-2');
      expect(button?.className).toContain('text-xs');
    });

    it('should render small size', () => {
      const { container } = render(<Button size="sm">Small</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('px-3');
    });

    it('should render large size', () => {
      const { container } = render(<Button size="lg">Large</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('px-6');
    });
  });

  describe('States', () => {
    it('should be disabled when disabled prop is true', () => {
      const { container } = render(<Button disabled>Disabled</Button>);
      const button = container.querySelector('button');
      expect(button?.disabled).toBe(true);
    });

    it('should show loading spinner when loading', () => {
      const { container } = render(<Button loading>Loading</Button>);
      const spinner = container.querySelector('.animate-spin');
      expect(spinner).toBeTruthy();
    });

    it('should be disabled when loading', () => {
      const { container } = render(<Button loading>Loading</Button>);
      const button = container.querySelector('button');
      expect(button?.disabled).toBe(true);
    });

    it('should hide icon when loading', () => {
      const { container } = render(
        <Button loading icon={<span class="icon">Icon</span>}>
          Loading
        </Button>
      );
      const icon = container.querySelector('.icon');
      expect(icon).toBeNull();
    });
  });

  describe('Layout', () => {
    it('should render full width when fullWidth is true', () => {
      const { container } = render(<Button fullWidth>Full Width</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('w-full');
    });

    it('should not render full width by default', () => {
      const { container } = render(<Button>Normal Width</Button>);
      const button = container.querySelector('button');
      expect(button?.className).not.toContain('w-full');
    });
  });

  describe('Interactions', () => {
    it('should call onClick when clicked', () => {
      const onClick = vi.fn(() => {});
      const { container } = render(<Button onClick={onClick}>Clickable</Button>);
      const button = container.querySelector('button');

      button?.click();

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('should not call onClick when disabled', () => {
      const onClick = vi.fn(() => {});
      const { container } = render(
        <Button onClick={onClick} disabled>
          Disabled
        </Button>
      );
      const button = container.querySelector('button');

      button?.click();

      expect(onClick).not.toHaveBeenCalled();
    });

    it('should not call onClick when loading', () => {
      const onClick = vi.fn(() => {});
      const { container } = render(
        <Button onClick={onClick} loading>
          Loading
        </Button>
      );
      const button = container.querySelector('button');

      button?.click();

      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('Button Types', () => {
    it('should default to button type', () => {
      const { container } = render(<Button>Button</Button>);
      const button = container.querySelector('button');
      expect(button?.type).toBe('button');
    });

    it('should render submit type', () => {
      const { container } = render(<Button type="submit">Submit</Button>);
      const button = container.querySelector('button');
      expect(button?.type).toBe('submit');
    });

    it('should render reset type', () => {
      const { container } = render(<Button type="reset">Reset</Button>);
      const button = container.querySelector('button');
      expect(button?.type).toBe('reset');
    });
  });

  describe('Additional Props', () => {
    it('should pass through additional HTML attributes', () => {
      const { container } = render(
        <Button data-testid="test-button" aria-label="Test Button">
          Test
        </Button>
      );
      const button = container.querySelector('button');
      expect(button?.getAttribute('data-testid')).toBe('test-button');
      expect(button?.getAttribute('aria-label')).toBe('Test Button');
    });
  });

  describe('Accessibility', () => {
    it('should have focus-visible styles', () => {
      const { container } = render(<Button>Accessible</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('focus-visible:outline-none');
      expect(button?.className).toContain('focus-visible:ring-2');
    });

    it('should have disabled cursor when disabled', () => {
      const { container } = render(<Button disabled>Disabled</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('disabled:cursor-not-allowed');
    });
  });

  describe('Transition', () => {
    it('should use quick transition from design tokens', () => {
      const { container } = render(<Button>Transition</Button>);
      const button = container.querySelector('button');
      expect(button?.className).toContain('transition-all');
      expect(button?.className).toContain('duration-150');
      expect(button?.className).toContain('ease-out');
    });
  });
});
