import { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';

export interface DropdownItem {
  label: string;
  onClick: (e?: Event) => void;
  icon?: ComponentChildren;
  danger?: boolean;
  disabled?: boolean;
  /**
   * Native browser tooltip shown on hover. Useful for explaining why a
   * disabled item is disabled, or providing additional context for an action.
   */
  title?: string;
}

export interface DropdownDivider {
  type: 'divider';
}

export type DropdownMenuItem = DropdownItem | DropdownDivider;

export interface DropdownProps {
  trigger: ComponentChildren;
  items: DropdownMenuItem[];
  position?: 'left' | 'right';
  class?: string;
  customContent?: ComponentChildren; // Optional custom content instead of menu items
  isOpen?: boolean; // Controlled open state
  onOpenChange?: (open: boolean) => void; // Callback when open state changes
}

export function Dropdown({
  trigger,
  items,
  position = 'right',
  class: className,
  customContent,
  isOpen: controlledIsOpen,
  onOpenChange,
}: DropdownProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(false);

  // Use controlled state if provided, otherwise use internal state
  const isOpen = controlledIsOpen !== undefined ? controlledIsOpen : internalIsOpen;
  const setIsOpen = (open: boolean) => {
    if (controlledIsOpen === undefined) {
      setInternalIsOpen(open);
    }
    onOpenChange?.(open);
  };
  const [menuStyle, setMenuStyle] = useState<{
    top: string;
    bottom: string;
    left: string;
    right: string;
  }>({
    top: 'auto',
    bottom: 'auto',
    left: 'auto',
    right: 'auto',
  });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Calculate and update menu position when opened
  useEffect(() => {
    if (isOpen && triggerRef.current) {
      const updatePosition = () => {
        if (!triggerRef.current || !menuRef.current) return;

        const triggerRect = triggerRef.current.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Get actual menu dimensions - offsetHeight is more reliable
        const menuHeight = menuRef.current.offsetHeight || 200;
        const menuWidth = menuRef.current.offsetWidth || 220;

        // Calculate space above and below the trigger
        const spaceBelow = viewportHeight - triggerRect.bottom - 8;
        const spaceAbove = triggerRect.top - 8;

        // Decide whether to position above or below
        const shouldPositionAbove = spaceBelow < menuHeight && spaceAbove > spaceBelow;

        const newStyle: {
          top: string;
          bottom: string;
          left: string;
          right: string;
        } = {
          top: 'auto',
          bottom: 'auto',
          left: 'auto',
          right: 'auto',
        };

        if (shouldPositionAbove) {
          // Position above - use bottom anchor relative to viewport
          // bottom = viewport height - trigger top + gap
          newStyle.bottom = `${viewportHeight - triggerRect.top + 4}px`;
        } else {
          // Position below - use top anchor
          newStyle.top = `${triggerRect.bottom + 4}px`;
        }

        // Calculate horizontal position
        if (position === 'right') {
          // Align to right edge of trigger
          const right = viewportWidth - triggerRect.right;
          // Ensure menu doesn't go off-screen to the left
          const maxRight = viewportWidth - menuWidth - 8;
          newStyle.right = `${Math.max(8, Math.min(right, maxRight))}px`;
        } else {
          // Align to left edge of trigger
          let left = triggerRect.left;
          // Ensure menu doesn't go off-screen to the right
          if (left + menuWidth > viewportWidth - 8) {
            left = viewportWidth - menuWidth - 8;
          }
          newStyle.left = `${Math.max(8, left)}px`;
        }

        setMenuStyle(newStyle);
      };

      // Initial positioning
      updatePosition();

      // Update again after layout to get accurate dimensions
      const rafId = requestAnimationFrame(() => {
        updatePosition();
      });

      return () => {
        cancelAnimationFrame(rafId);
      };
    }
  }, [isOpen, position]);

  // Escape closes the menu whenever it is open. The listener registers in a
  // layout effect so it is attached in the same commit that exposes the menu —
  // a keydown arriving between commit and a deferred effect cannot be missed.
  // (An Escape keydown can never be the interaction that opened the menu, so
  // unlike the click-outside listener below it needs no deferred attach.)
  useLayoutEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Don't close if clicking inside the menu (which uses position:fixed)
      // Check both dropdownRef and menuRef since fixed positioning can affect contains()
      if (
        menuRef.current?.contains(event.target as Node) ||
        (dropdownRef.current && dropdownRef.current.contains(event.target as Node))
      ) {
        return;
      }

      setIsOpen(false);
    };

    if (isOpen) {
      // Delay adding the click listener to avoid closing immediately from the same click that opened it
      const timeoutId = setTimeout(() => {
        document.addEventListener('click', handleClickOutside);
      }, 0);

      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('click', handleClickOutside);
      };
    }

    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const menuItems = dropdownRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])');
    if (!menuItems || menuItems.length === 0) return;

    let currentIndex = 0;

    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          currentIndex = (currentIndex + 1) % menuItems.length;
          (menuItems[currentIndex] as HTMLElement).focus();
          break;
        case 'ArrowUp':
          event.preventDefault();
          currentIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
          (menuItems[currentIndex] as HTMLElement).focus();
          break;
        case 'Enter':
        case 'Space':
        case 'Spacebar':
        case ' ':
          event.preventDefault();
          (menuItems[currentIndex] as HTMLElement).click();
          break;
      }
    };

    dropdownRef.current?.addEventListener('keydown', handleKeyDown);

    return () => {
      dropdownRef.current?.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={dropdownRef} class={cn('relative', className)}>
      {/* Trigger */}
      <div ref={triggerRef} class="cursor-pointer" onClick={() => setIsOpen(!isOpen)}>
        {trigger}
      </div>

      {/* Menu - Using fixed positioning to avoid clipping by overflow containers */}
      {isOpen && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: menuStyle.top,
            bottom: menuStyle.bottom,
            left: menuStyle.left,
            right: menuStyle.right,
            maxHeight: 'calc(100vh - 32px)',
          }}
          class={cn(
            'shadow-xl z-[9999] animate-slideIn',
            customContent
              ? ''
              : `py-1 bg-dark-850 border ${borderColors.ui.default} rounded-lg min-w-[200px]`
          )}
          role="menu"
        >
          {customContent ? (
            customContent
          ) : (
            <>
              {items.map((item, index) => {
                if ('type' in item && item.type === 'divider') {
                  return <div key={`divider-${index}`} class="h-px bg-dark-700 my-1" />;
                }

                const menuItem = item as DropdownItem;

                return (
                  <button
                    key={index}
                    role="menuitem"
                    disabled={menuItem.disabled}
                    title={menuItem.title}
                    onKeyDown={(e) => {
                      if (menuItem.disabled) return;
                      if (
                        e.key === 'Enter' ||
                        e.key === ' ' ||
                        e.key === 'Space' ||
                        e.key === 'Spacebar'
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        (e.currentTarget as HTMLButtonElement).click();
                      }
                    }}
                    onClick={async (e) => {
                      if (!menuItem.disabled) {
                        // Stop propagation to prevent handleClickOutside from closing dropdown prematurely
                        e.stopPropagation();
                        menuItem.onClick(e);
                        // Small delay to ensure state updates propagate before closing dropdown
                        // This helps with modal/dialog triggers that depend on dropdown item clicks
                        await new Promise((resolve) => setTimeout(resolve, 0));
                        setIsOpen(false);
                      }
                    }}
                    class={cn(
                      'w-full px-4 py-2 text-left text-sm flex items-center gap-3 transition-colors',
                      menuItem.disabled
                        ? 'text-gray-600 cursor-not-allowed'
                        : menuItem.danger
                          ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
                          : 'text-gray-300 hover:bg-dark-800 hover:text-gray-100'
                    )}
                  >
                    {menuItem.icon && <span class="w-4 h-4 flex-shrink-0">{menuItem.icon}</span>}
                    <span>{menuItem.label}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
