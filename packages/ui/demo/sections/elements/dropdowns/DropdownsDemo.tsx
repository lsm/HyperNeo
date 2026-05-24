import { useState } from 'preact/hooks';
import { Menu, MenuButton, MenuItem, MenuItems } from '../../../../src/mod.ts';
import {
  ChevronDown,
  MoreVertical,
  Pencil,
  Copy,
  Archive,
  ArrowRightCircle,
  UserPlus,
  Heart,
  Trash2,
} from 'lucide-preact';

export function DropdownsDemo() {
  const [lastAction, setLastAction] = useState<string | null>(null);

  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Simple dropdown with icon trigger
        </h3>
        <Menu class="relative inline-block">
          <MenuButton class="flex items-center rounded-full text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 cursor-pointer">
            <span class="sr-only">Open options</span>
            <MoreVertical class="size-5" />
          </MenuButton>
          <MenuItems class="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-surface-1 border border-surface-border shadow-lg outline-1 outline-black/5 transition-all duration-100 ease-out data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:outline-white/10">
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Account settings')}
                >
                  Account settings
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Support')}
                >
                  Support
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('License')}
                >
                  License
                </button>
              </MenuItem>
              <form method="POST">
                <MenuItem>
                  <button
                    type="submit"
                    class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                    onClick={() => setLastAction('Sign out')}
                  >
                    Sign out
                  </button>
                </MenuItem>
              </form>
            </div>
          </MenuItems>
        </Menu>
        {lastAction && (
          <p class="mt-2 text-sm text-text-tertiary">
            Last action: <span class="text-accent-400">{lastAction}</span>
          </p>
        )}
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Dropdown with dividers and icons
        </h3>
        <Menu class="relative inline-block">
          <MenuButton class="inline-flex w-full justify-center gap-x-1.5 rounded-md bg-surface-1 px-3 py-2 text-sm font-semibold text-text-primary border border-surface-border shadow-xs hover:bg-surface-2 dark:bg-white/10 dark:text-white dark:border-white/5 dark:hover:bg-white/20 cursor-pointer">
            Options
            <ChevronDown class="size-5 text-text-tertiary" />
          </MenuButton>
          <MenuItems class="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-surface-1 border border-surface-border shadow-lg divide-y divide-surface-border outline-1 outline-black/5 transition-all duration-100 ease-out data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:divide-white/10 dark:outline-white/10">
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer flex items-center gap-3"
                  onClick={() => setLastAction('Edit')}
                >
                  <Pencil class="size-5 text-text-tertiary" />
                  Edit
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer flex items-center gap-3"
                  onClick={() => setLastAction('Duplicate')}
                >
                  <Copy class="size-5 text-text-tertiary" />
                  Duplicate
                </button>
              </MenuItem>
            </div>
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer flex items-center gap-3"
                  onClick={() => setLastAction('Archive')}
                >
                  <Archive class="size-5 text-text-tertiary" />
                  Archive
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer flex items-center gap-3"
                  onClick={() => setLastAction('Move')}
                >
                  <ArrowRightCircle class="size-5 text-text-tertiary" />
                  Move
                </button>
              </MenuItem>
            </div>
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer flex items-center gap-3"
                  onClick={() => setLastAction('Share')}
                >
                  <UserPlus class="size-5 text-text-tertiary" />
                  Share
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer flex items-center gap-3"
                  onClick={() => setLastAction('Add to favorites')}
                >
                  <Heart class="size-5 text-text-tertiary" />
                  Add to favorites
                </button>
              </MenuItem>
            </div>
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-red-400 data-[focus]:bg-red-500 data-[focus]:text-white cursor-pointer flex items-center gap-3"
                  onClick={() => setLastAction('Delete')}
                >
                  <Trash2 class="size-5" />
                  Delete
                </button>
              </MenuItem>
            </div>
          </MenuItems>
        </Menu>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Dropdown with dividers only</h3>
        <Menu class="relative inline-block">
          <MenuButton class="inline-flex w-full justify-center gap-x-1.5 rounded-md bg-surface-1 px-3 py-2 text-sm font-semibold text-text-primary border border-surface-border shadow-xs hover:bg-surface-2 dark:bg-white/10 dark:text-white dark:border-white/5 dark:hover:bg-white/20 cursor-pointer">
            Options
            <ChevronDown class="size-5 text-text-tertiary" />
          </MenuButton>
          <MenuItems class="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-surface-1 border border-surface-border shadow-lg divide-y divide-surface-border outline-1 outline-black/5 transition-all duration-100 ease-out data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:divide-white/10 dark:outline-white/10">
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Edit')}
                >
                  Edit
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Duplicate')}
                >
                  Duplicate
                </button>
              </MenuItem>
            </div>
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Archive')}
                >
                  Archive
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Move')}
                >
                  Move
                </button>
              </MenuItem>
            </div>
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Share')}
                >
                  Share
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Add to favorites')}
                >
                  Add to favorites
                </button>
              </MenuItem>
            </div>
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-red-400 data-[focus]:bg-red-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Delete')}
                >
                  Delete
                </button>
              </MenuItem>
            </div>
          </MenuItems>
        </Menu>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Dropdown with user header</h3>
        <Menu class="relative inline-block">
          <MenuButton class="inline-flex w-full justify-center gap-x-1.5 rounded-md bg-surface-1 px-3 py-2 text-sm font-semibold text-text-primary border border-surface-border shadow-xs hover:bg-surface-2 dark:bg-white/10 dark:text-white dark:border-white/5 dark:hover:bg-white/20 cursor-pointer">
            Options
            <ChevronDown class="size-5 text-text-tertiary" />
          </MenuButton>
          <MenuItems class="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-surface-1 border border-surface-border shadow-lg divide-y divide-surface-border outline-1 outline-black/5 transition-all duration-100 ease-out data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:divide-white/10 dark:outline-white/10">
            <div class="px-4 py-3">
              <p class="text-sm text-text-secondary">Signed in as</p>
              <p class="truncate text-sm font-medium text-text-primary">tom@example.com</p>
            </div>
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Account settings')}
                >
                  Account settings
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Support')}
                >
                  Support
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('License')}
                >
                  License
                </button>
              </MenuItem>
            </div>
            <div class="py-1">
              <form method="POST">
                <MenuItem>
                  <button
                    type="submit"
                    class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                    onClick={() => setLastAction('Sign out')}
                  >
                    Sign out
                  </button>
                </MenuItem>
              </form>
            </div>
          </MenuItems>
        </Menu>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Minimal dropdown button</h3>
        <Menu class="relative inline-block">
          <MenuButton class="inline-flex w-full justify-center gap-x-1.5 rounded-md bg-surface-1 px-3 py-2 text-sm font-semibold text-text-primary border border-surface-border shadow-xs hover:bg-surface-2 dark:bg-white/10 dark:text-white dark:border-white/5 dark:hover:bg-white/20 cursor-pointer">
            Options
            <ChevronDown class="size-5 text-text-tertiary" />
          </MenuButton>
          <MenuItems class="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-surface-1 border border-surface-border shadow-lg outline-1 outline-black/5 transition-all duration-100 ease-out data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in dark:outline-white/10">
            <div class="py-1">
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Account settings')}
                >
                  Account settings
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('Support')}
                >
                  Support
                </button>
              </MenuItem>
              <MenuItem>
                <button
                  class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                  onClick={() => setLastAction('License')}
                >
                  License
                </button>
              </MenuItem>
              <form method="POST">
                <MenuItem>
                  <button
                    type="submit"
                    class="w-full text-left px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                    onClick={() => setLastAction('Sign out')}
                  >
                    Sign out
                  </button>
                </MenuItem>
              </form>
            </div>
          </MenuItems>
        </Menu>
      </div>
    </div>
  );
}
