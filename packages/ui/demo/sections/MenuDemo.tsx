import { useState } from 'preact/hooks';
import {
  Menu,
  MenuButton,
  MenuHeading,
  MenuItem,
  MenuItems,
  MenuSection,
  MenuSeparator,
} from '../../src/mod.ts';

export function MenuDemo() {
  const [lastAction, setLastAction] = useState<string | null>(null);

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">Basic dropdown menu</h3>
        <Menu class="relative inline-block">
          <MenuButton class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary text-sm font-medium hover:border-accent-500 transition-colors cursor-pointer">
            Options
            <svg class="w-4 h-4 text-text-tertiary" viewBox="0 0 20 20" fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                clip-rule="evenodd"
              />
            </svg>
          </MenuButton>
          <MenuItems class="absolute left-0 mt-1 w-48 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none">
            <MenuItem>
              <button
                class="w-full text-left px-3 py-2 rounded text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                onClick={() => setLastAction('Edit')}
              >
                Edit
              </button>
            </MenuItem>
            <MenuItem>
              <button
                class="w-full text-left px-3 py-2 rounded text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                onClick={() => setLastAction('Duplicate')}
              >
                Duplicate
              </button>
            </MenuItem>
            <MenuItem>
              <button
                class="w-full text-left px-3 py-2 rounded text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                onClick={() => setLastAction('Archive')}
              >
                Archive
              </button>
            </MenuItem>
            <MenuSeparator class="my-1 border-t border-surface-border" />
            <MenuItem>
              <button
                class="w-full text-left px-3 py-2 rounded text-sm text-red-400 data-[focus]:bg-red-500 data-[focus]:text-white cursor-pointer"
                onClick={() => setLastAction('Delete')}
              >
                Delete
              </button>
            </MenuItem>
          </MenuItems>
        </Menu>
        {lastAction && (
          <p class="mt-2 text-sm text-text-tertiary">
            Last action: <span class="text-accent-400">{lastAction}</span>
          </p>
        )}
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          Menu with section heading and disabled item
        </h3>
        <Menu class="relative inline-block">
          <MenuButton class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary text-sm font-medium hover:border-accent-500 transition-colors cursor-pointer">
            Actions
            <svg class="w-4 h-4 text-text-tertiary" viewBox="0 0 20 20" fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                clip-rule="evenodd"
              />
            </svg>
          </MenuButton>
          <MenuItems class="absolute left-0 mt-1 w-56 bg-surface-1 rounded-lg border border-surface-border shadow-xl p-1 z-10 outline-none">
            <MenuSection>
              <MenuHeading class="px-3 py-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                File
              </MenuHeading>
              <MenuItem>
                <button class="w-full text-left px-3 py-2 rounded text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer">
                  New file
                </button>
              </MenuItem>
              <MenuItem>
                <button class="w-full text-left px-3 py-2 rounded text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer">
                  Open file
                </button>
              </MenuItem>
              <MenuItem disabled>
                <button
                  class="w-full text-left px-3 py-2 rounded text-sm text-text-muted cursor-not-allowed opacity-50"
                  disabled
                >
                  Save (disabled)
                </button>
              </MenuItem>
            </MenuSection>
            <MenuSeparator class="my-1 border-t border-surface-border" />
            <MenuSection>
              <MenuHeading class="px-3 py-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                Edit
              </MenuHeading>
              <MenuItem>
                <button class="w-full text-left px-3 py-2 rounded text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer">
                  Cut
                </button>
              </MenuItem>
              <MenuItem>
                <button class="w-full text-left px-3 py-2 rounded text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer">
                  Copy
                </button>
              </MenuItem>
              <MenuItem>
                <button class="w-full text-left px-3 py-2 rounded text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer">
                  Paste
                </button>
              </MenuItem>
            </MenuSection>
          </MenuItems>
        </Menu>
      </div>
    </div>
  );
}
