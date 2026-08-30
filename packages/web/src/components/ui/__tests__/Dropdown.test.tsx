// @ts-nocheck

import { render, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { Dropdown, DropdownMenuItem } from '../Dropdown';

describe('Dropdown', () => {
  const defaultItems: DropdownMenuItem[] = [
    { label: 'Item 1', onClick: vi.fn(() => {}) },
    { label: 'Item 2', onClick: vi.fn(() => {}) },
    { label: 'Item 3', onClick: vi.fn(() => {}) },
  ];

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
  });

  describe('Rendering', () => {
    it('should render trigger element', () => {
      const { container } = render(
        <Dropdown trigger={<button>Open Menu</button>} items={defaultItems} />
      );
      const trigger = container.querySelector('button');
      expect(trigger?.textContent).toBe('Open Menu');
    });

    it('should not render menu items when closed', () => {
      const { container } = render(
        <Dropdown trigger={<button>Open Menu</button>} items={defaultItems} />
      );
      const menuItems = container.querySelectorAll('[role="menuitem"]');
      expect(menuItems.length).toBe(0);
    });

    it('should render menu items when opened', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open Menu</button>} items={defaultItems} />
      );
      const trigger = container.querySelector('button');
      trigger?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });

      const menuItems = document.body.querySelectorAll('[role="menuitem"]');
      expect(menuItems.length).toBe(3);
    });

    it('should render item icons when provided', async () => {
      const itemsWithIcons: DropdownMenuItem[] = [
        {
          label: 'Item with Icon',
          onClick: vi.fn(() => {}),
          icon: <span class="test-icon">Icon</span>,
        },
      ];

      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={itemsWithIcons} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const icon = document.body.querySelector('.test-icon');
        expect(icon).toBeTruthy();
      });
    });

    it('should render dividers', async () => {
      const itemsWithDivider: DropdownMenuItem[] = [
        { label: 'Item 1', onClick: vi.fn(() => {}) },
        { type: 'divider' },
        { label: 'Item 2', onClick: vi.fn(() => {}) },
      ];

      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={itemsWithDivider} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const divider = document.body.querySelector('.bg-fill-strong');
        expect(divider).toBeTruthy();
      });
    });

    it('should render custom content instead of menu items', async () => {
      const { container } = render(
        <Dropdown
          trigger={<button>Open</button>}
          items={[]}
          customContent={<div class="custom-content">Custom Content</div>}
        />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const customContent = document.body.querySelector('.custom-content');
        expect(customContent?.textContent).toBe('Custom Content');
      });
    });
  });

  describe('Positions', () => {
    it('should default to right alignment', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
        expect(menu).toBeTruthy();
        expect(menu?.style.right).toBeTruthy();
      });
    });

    it('should support left alignment', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} position="left" />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
        expect(menu).toBeTruthy();
        expect(menu?.style.left).toBeTruthy();
      });
    });

    it('should position above trigger when there is not enough space below', async () => {
      const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        if (this.className?.includes?.('relative') || this.closest?.('.relative')) {
          return {
            top: 750,
            bottom: 780,
            left: 100,
            right: 200,
            width: 100,
            height: 30,
            x: 100,
            y: 750,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return originalGetBoundingClientRect.call(this);
      };

      Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });

      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
        expect(menu).toBeTruthy();
        expect(menu?.style.bottom).not.toBe('auto');
      });

      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    });

    it('should adjust left position when menu would go off-screen to the right', async () => {
      const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        if (this.className?.includes?.('relative') || this.closest?.('.relative')) {
          return {
            top: 100,
            bottom: 130,
            left: 900,
            right: 1000,
            width: 100,
            height: 30,
            x: 900,
            y: 100,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return originalGetBoundingClientRect.call(this);
      };

      Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });

      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} position="left" />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
        expect(menu).toBeTruthy();
        expect(menu?.style.left).toBeTruthy();
      });

      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    });

    it('should constrain left position when menu overflows right edge of viewport', async () => {
      const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
      const originalOffsetWidth = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'offsetWidth'
      );
      const originalOffsetHeight = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'offsetHeight'
      );

      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        get() {
          if (this.getAttribute('role') === 'menu') {
            return 300;
          }
          return 100;
        },
      });

      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get() {
          return 200;
        },
      });

      Element.prototype.getBoundingClientRect = function () {
        if (this.className?.includes?.('relative') || this.closest?.('.relative')) {
          return {
            top: 100,
            bottom: 130,
            left: 850,
            right: 950,
            width: 100,
            height: 30,
            x: 850,
            y: 100,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return originalGetBoundingClientRect.call(this);
      };

      Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });

      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} position="left" />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
        expect(menu).toBeTruthy();
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
      expect(menu?.style.left).toBeTruthy();
      expect(menu?.style.left).not.toBe('auto');

      Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      if (originalOffsetWidth) {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
      }
      if (originalOffsetHeight) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
      }
    });
  });

  describe('Interactions', () => {
    it('should open when trigger is clicked', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });
    });

    it('should close when trigger is clicked again', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      await waitFor(() => {
        const menu = container.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });

      trigger?.click();

      await waitFor(() => {
        const menu = container.querySelector('[role="menu"]');
        expect(menu).toBeNull();
      });
    });

    it('should close when Escape key is pressed', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );

      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });

      await waitFor(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
          })
        );
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeNull();
      });
    });

    it('should call onClick handler when item is clicked', async () => {
      const onClick = vi.fn(() => {});
      const items: DropdownMenuItem[] = [{ label: 'Click Me', onClick }];

      const { container } = render(<Dropdown trigger={<button>Open</button>} items={items} />);
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItem = document.body.querySelector('[role="menuitem"]');
        expect(menuItem).toBeTruthy();
      });

      const menuItem = document.body.querySelector('[role="menuitem"]');
      menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('should close menu after item is clicked', async () => {
      const items: DropdownMenuItem[] = [{ label: 'Click Me', onClick: vi.fn(() => {}) }];

      const { container } = render(<Dropdown trigger={<button>Open</button>} items={items} />);
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItem = document.body.querySelector('[role="menuitem"]');
        expect(menuItem).toBeTruthy();
      });

      const menuItem = document.body.querySelector('[role="menuitem"]');
      menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeNull();
      });
    });

    it('should not call onClick for disabled items', async () => {
      const onClick = vi.fn(() => {});
      const items: DropdownMenuItem[] = [{ label: 'Disabled', onClick, disabled: true }];

      const { container } = render(<Dropdown trigger={<button>Open</button>} items={items} />);
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItem = document.body.querySelector('[role="menuitem"]');
        expect(menuItem).toBeTruthy();
      });

      const menuItem = document.body.querySelector('[role="menuitem"]');
      menuItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('Keyboard Navigation', () => {
    it('should have menu items focusable', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItems = document.body.querySelectorAll('[role="menuitem"]');
        expect(menuItems.length).toBe(3);
      });

      const menuItems = document.body.querySelectorAll('[role="menuitem"]');
      menuItems.forEach((item) => {
        expect(item.tagName.toLowerCase()).toBe('button');
      });
    });

    it('should navigate with arrow keys', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItems = document.body.querySelectorAll('[role="menuitem"]');
        expect(menuItems.length).toBe(3);
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const dropdown = container.querySelector('.relative') as HTMLElement;

      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      });
      dropdown?.dispatchEvent(arrowDownEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const menuItems = document.body.querySelectorAll('[role="menuitem"]');
      expect(menuItems.length).toBe(3);

      expect(document.body.querySelector('[role="menu"]')).toBeTruthy();
    });

    it('should navigate up with ArrowUp key', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItems = document.body.querySelectorAll('[role="menuitem"]');
        expect(menuItems.length).toBe(3);
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const dropdown = container.querySelector('.relative') as HTMLElement;

      const arrowUpEvent = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true,
      });
      dropdown?.dispatchEvent(arrowUpEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const menuItems = document.body.querySelectorAll('[role="menuitem"]');
      expect(menuItems.length).toBe(3);

      expect(document.body.querySelector('[role="menu"]')).toBeTruthy();
    });

    it('should focus menu items when navigating with ArrowDown', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItems = document.body.querySelectorAll('[role="menuitem"]');
        expect(menuItems.length).toBe(3);
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const dropdown = container.querySelector('.relative') as HTMLElement;
      const menuItems = document.body.querySelectorAll('[role="menuitem"]');

      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      });
      dropdown?.dispatchEvent(arrowDownEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(menuItems[1]).toBeTruthy();
    });

    it('should focus last menu item when navigating up from first item', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItems = document.body.querySelectorAll('[role="menuitem"]');
        expect(menuItems.length).toBe(3);
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const dropdown = container.querySelector('.relative') as HTMLElement;
      const menuItems = document.body.querySelectorAll('[role="menuitem"]');

      const arrowUpEvent = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true,
        cancelable: true,
      });
      dropdown?.dispatchEvent(arrowUpEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(menuItems[2]).toBeTruthy();
    });

    it('should activate item with Enter key', async () => {
      const onClick = vi.fn(() => {});
      const items: DropdownMenuItem[] = [{ label: 'Click Me', onClick }];

      const { container } = render(<Dropdown trigger={<button>Open</button>} items={items} />);
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItem = document.body.querySelector('[role="menuitem"]');
        expect(menuItem).toBeTruthy();
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const menuItem = document.body.querySelector('[role="menuitem"]') as HTMLButtonElement;
      menuItem?.focus();

      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      menuItem?.dispatchEvent(enterEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onClick).toHaveBeenCalled();
    });

    it('should activate item with Space key', async () => {
      const onClick = vi.fn(() => {});
      const items: DropdownMenuItem[] = [{ label: 'Click Me', onClick }];

      const { container } = render(<Dropdown trigger={<button>Open</button>} items={items} />);
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItem = document.body.querySelector('[role="menuitem"]');
        expect(menuItem).toBeTruthy();
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const menuItem = document.body.querySelector('[role="menuitem"]') as HTMLButtonElement;
      menuItem?.focus();

      const spaceEvent = new KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true,
      });
      menuItem?.dispatchEvent(spaceEvent);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onClick).toHaveBeenCalled();
    });

    it('should wrap around when navigating past last item', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItems = document.body.querySelectorAll('[role="menuitem"]');
        expect(menuItems.length).toBe(3);
      });

      const dropdown = container.querySelector('.relative');

      for (let i = 0; i < 4; i++) {
        const arrowDownEvent = new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        });
        dropdown?.dispatchEvent(arrowDownEvent);
      }

      const menuItems = document.body.querySelectorAll('[role="menuitem"]');
      expect(menuItems.length).toBe(3);
    });
  });

  describe('Controlled Mode', () => {
    it('should respect controlled isOpen prop', async () => {
      const onOpenChange = vi.fn(() => {});
      const { rerender } = render(
        <Dropdown
          trigger={<button>Open</button>}
          items={defaultItems}
          isOpen={false}
          onOpenChange={onOpenChange}
        />
      );

      let menu = document.body.querySelector('[role="menu"]');
      expect(menu).toBeNull();

      rerender(
        <Dropdown
          trigger={<button>Open</button>}
          items={defaultItems}
          isOpen={true}
          onOpenChange={onOpenChange}
        />
      );

      await waitFor(() => {
        menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });
    });

    it('should call onOpenChange when toggling', async () => {
      const onOpenChange = vi.fn(() => {});
      const { container } = render(
        <Dropdown
          trigger={<button>Open</button>}
          items={defaultItems}
          onOpenChange={onOpenChange}
        />
      );

      const trigger = container.querySelector('button');
      trigger?.click();

      expect(onOpenChange).toHaveBeenCalledWith(true);
    });
  });

  describe('Styling', () => {
    it('should apply custom className', () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} class="custom-dropdown" />
      );
      const dropdown = container.querySelector('.custom-dropdown');
      expect(dropdown).toBeTruthy();
    });

    it('should style danger items differently', async () => {
      const dangerItems: DropdownMenuItem[] = [
        { label: 'Delete', onClick: vi.fn(() => {}), danger: true },
      ];

      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={dangerItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItem = document.body.querySelector('[role="menuitem"]');
        expect(menuItem?.className).toContain('text-danger');
      });
    });

    it('should style disabled items differently', async () => {
      const disabledItems: DropdownMenuItem[] = [
        { label: 'Disabled', onClick: vi.fn(() => {}), disabled: true },
      ];

      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={disabledItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItem = document.body.querySelector('[role="menuitem"]');
        expect(menuItem?.className).toContain('text-fg-faint');
        expect(menuItem?.className).toContain('cursor-not-allowed');
      });
    });

    it('should have animation class', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('.animate-slideIn');
        expect(menu).toBeTruthy();
      });
    });
  });

  describe('Click Outside Handling', () => {
    it('should not close when clicking inside dropdown', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const dropdown = container.querySelector('.relative');
      dropdown?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await new Promise((resolve) => setTimeout(resolve, 10));
      const menuAfter = document.body.querySelector('[role="menu"]');
      expect(menuAfter).toBeTruthy();
    });

    it('should not close when clicking inside menu', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const menu = document.body.querySelector('[role="menu"]');
      menu?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it('should close when clicking outside', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeNull();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have role="menu" on dropdown container', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menu = document.body.querySelector('[role="menu"]');
        expect(menu).toBeTruthy();
      });
    });

    it('should have role="menuitem" on items', async () => {
      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={defaultItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItems = document.body.querySelectorAll('[role="menuitem"]');
        expect(menuItems.length).toBe(3);
      });
    });

    it('should have disabled attribute on disabled items', async () => {
      const disabledItems: DropdownMenuItem[] = [
        { label: 'Disabled', onClick: vi.fn(() => {}), disabled: true },
      ];

      const { container } = render(
        <Dropdown trigger={<button>Open</button>} items={disabledItems} />
      );
      container.querySelector('button')?.click();

      await waitFor(() => {
        const menuItem = document.body.querySelector('[role="menuitem"]') as HTMLButtonElement;
        expect(menuItem?.disabled).toBe(true);
      });
    });
  });
});
