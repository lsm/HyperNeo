// @ts-nocheck

import { render, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { Collapsible } from '../Collapsible';

describe('Collapsible', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('should render trigger element', () => {
      const { container } = render(
        <Collapsible trigger={<span>Click to expand</span>}>
          <p>Content</p>
        </Collapsible>
      );
      const trigger = container.querySelector('button');
      expect(trigger?.textContent).toContain('Click to expand');
    });

    it('should render children content', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={true}>
          <p>Collapsible content</p>
        </Collapsible>
      );
      const content = container.querySelector('p');
      expect(content?.textContent).toBe('Collapsible content');
    });

    it('should render chevron icon', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} class="custom-collapsible">
          <p>Content</p>
        </Collapsible>
      );
      const collapsible = container.querySelector('.custom-collapsible');
      expect(collapsible).toBeTruthy();
    });
  });

  describe('Open/Close Toggle', () => {
    it('should be closed by default', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );
      const content = container.querySelector('div[style*="height"]');
      expect(content?.style.height).toBe('0px');
    });

    it('should open when trigger is clicked', async () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      await waitFor(() => {
        const button = container.querySelector('button');
        expect(button?.getAttribute('aria-expanded')).toBe('true');
      });
    });

    it('should close when trigger is clicked again', async () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={true}>
          <p>Content</p>
        </Collapsible>
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      await waitFor(() => {
        const button = container.querySelector('button');
        expect(button?.getAttribute('aria-expanded')).toBe('false');
      });
    });

    it('should rotate chevron when open', async () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      await waitFor(() => {
        const svg = container.querySelector('svg');
        const svgClass = svg?.getAttribute('class') || '';
        expect(svgClass).toContain('rotate-180');
      });
    });

    it('should not rotate chevron when closed', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const svg = container.querySelector('svg');
      const svgClass = svg?.getAttribute('class') || '';
      expect(svgClass).not.toContain('rotate-180');
    });
  });

  describe('Controlled Mode', () => {
    it('should respect controlled open prop', () => {
      const { container, rerender } = render(
        <Collapsible trigger={<span>Trigger</span>} open={false}>
          <p>Content</p>
        </Collapsible>
      );

      let button = container.querySelector('button');
      expect(button?.getAttribute('aria-expanded')).toBe('false');

      rerender(
        <Collapsible trigger={<span>Trigger</span>} open={true}>
          <p>Content</p>
        </Collapsible>
      );

      button = container.querySelector('button');
      expect(button?.getAttribute('aria-expanded')).toBe('true');
    });

    it('should call onOpenChange when toggling', () => {
      const onOpenChange = vi.fn(() => {});
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} onOpenChange={onOpenChange}>
          <p>Content</p>
        </Collapsible>
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      expect(onOpenChange).toHaveBeenCalledWith(true);
    });

    it('should call onOpenChange with false when closing', () => {
      const onOpenChange = vi.fn(() => {});
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={true} onOpenChange={onOpenChange}>
          <p>Content</p>
        </Collapsible>
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('should not update internal state in controlled mode', () => {
      const onOpenChange = vi.fn(() => {});
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} open={false} onOpenChange={onOpenChange}>
          <p>Content</p>
        </Collapsible>
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      expect(onOpenChange).toHaveBeenCalledWith(true);

      const button = container.querySelector('button');
      expect(button?.getAttribute('aria-expanded')).toBe('false');
    });
  });

  describe('defaultOpen Prop', () => {
    it('should be open when defaultOpen is true', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={true}>
          <p>Content</p>
        </Collapsible>
      );

      const button = container.querySelector('button');
      expect(button?.getAttribute('aria-expanded')).toBe('true');
    });

    it('should be closed when defaultOpen is false', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={false}>
          <p>Content</p>
        </Collapsible>
      );

      const button = container.querySelector('button');
      expect(button?.getAttribute('aria-expanded')).toBe('false');
    });

    it('should allow toggling with defaultOpen', async () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={true}>
          <p>Content</p>
        </Collapsible>
      );

      const trigger = container.querySelector('button');
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');

      trigger?.click();

      await waitFor(() => {
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
      });
    });
  });

  describe('Accessibility', () => {
    it('should have aria-expanded attribute', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const button = container.querySelector('button');
      expect(button?.hasAttribute('aria-expanded')).toBe(true);
    });

    it('should have aria-expanded=false when closed', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const button = container.querySelector('button');
      expect(button?.getAttribute('aria-expanded')).toBe('false');
    });

    it('should have aria-expanded=true when open', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={true}>
          <p>Content</p>
        </Collapsible>
      );

      const button = container.querySelector('button');
      expect(button?.getAttribute('aria-expanded')).toBe('true');
    });

    it('should be keyboard accessible (button element)', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const button = container.querySelector('button');
      expect(button).toBeTruthy();
      expect(button?.tagName.toLowerCase()).toBe('button');
    });
  });

  describe('Styling', () => {
    it('should have full width trigger', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const button = container.querySelector('button');
      expect(button?.className).toContain('w-full');
    });

    it('should have flex layout for trigger', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const button = container.querySelector('button');
      expect(button?.className).toContain('flex');
      expect(button?.className).toContain('items-center');
      expect(button?.className).toContain('justify-between');
    });

    it('should have transition classes on content', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const contentWrapper = container.querySelector('.transition-all');
      expect(contentWrapper).toBeTruthy();
    });

    it('should have transition on chevron', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const svg = container.querySelector('svg');
      const svgClass = svg?.getAttribute('class') || '';
      expect(svgClass).toContain('transition-transform');
    });

    it('should have padding on content', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={true}>
          <p>Content</p>
        </Collapsible>
      );

      const contentInner = container.querySelector('.pt-2');
      expect(contentInner).toBeTruthy();
    });
  });

  describe('Animation', () => {
    it('should animate height change', async () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content with some text for height</p>
        </Collapsible>
      );

      const trigger = container.querySelector('button');

      let contentWrapper = container.querySelector('div[style*="height"]');
      expect(contentWrapper?.style.height).toBe('0px');

      trigger?.click();

      await waitFor(() => {
        contentWrapper = container.querySelector('div[style*="height"]');
        const height = contentWrapper?.style.height;
        expect(height === 'auto' || (height && parseInt(height) > 0)).toBe(true);
      });
    });

    it('should have duration-200 transition', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const contentWrapper = container.querySelector('.duration-200');
      expect(contentWrapper).toBeTruthy();
    });

    it('should have ease-in-out timing function', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const contentWrapper = container.querySelector('.ease-in-out');
      expect(contentWrapper).toBeTruthy();
    });
  });

  describe('Content Visibility', () => {
    it('should hide overflow when closed', () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>}>
          <p>Content</p>
        </Collapsible>
      );

      const contentWrapper = container.querySelector('div[style*="height: 0px"]');
      expect(contentWrapper?.style.overflow).toBe('hidden');
    });

    it('should show overflow when open', async () => {
      const { container } = render(
        <Collapsible trigger={<span>Trigger</span>} defaultOpen={true}>
          <p>Content</p>
        </Collapsible>
      );

      await waitFor(() => {
        const contentWrapper = container.querySelector('div[style*="height"]');
        expect(
          contentWrapper?.style.overflow === 'visible' || contentWrapper?.style.overflow === ''
        ).toBe(true);
      });
    });
  });
});
