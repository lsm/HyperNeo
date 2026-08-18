import {
  Menu,
  MenuButton,
  MenuItems,
  MenuItem,
  Popover,
  PopoverButton,
  PopoverPanel,
} from '../../../../src/mod.ts';
import { EllipsisVertical, Plus } from 'lucide-preact';

export function CardHeadingsDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Simple</h3>
        <div class="border-b border-gray-200 px-4 py-5 sm:px-6 dark:border-white/10">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With action</h3>
        <div class="border-b border-gray-200 px-4 py-5 sm:px-6 dark:border-white/10">
          <div class="-mt-2 -ml-4 flex flex-wrap items-center justify-between sm:flex-nowrap">
            <div class="mt-2 ml-4">
              <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
            </div>
            <div class="mt-2 ml-4 shrink-0">
              <button
                type="button"
                class="relative inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
              >
                Create new job
              </button>
            </div>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With avatar and actions</h3>
        <div class="border-b border-gray-200 dark:border-white/10">
          <div class="sm:flex sm:items-baseline">
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">Issues</h3>
            <div class="mt-4 sm:mt-0 sm:ml-10">
              <nav class="-mb-px flex space-x-8">
                <a
                  href="#"
                  aria-current="page"
                  class="border-b-2 border-indigo-500 px-1 pb-4 text-sm font-medium whitespace-nowrap text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                >
                  Open
                </a>
                <a
                  href="#"
                  class="border-b-2 border-transparent px-1 pb-4 text-sm font-medium whitespace-nowrap text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:border-white/20 dark:hover:text-white"
                >
                  Closed
                </a>
              </nav>
            </div>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With description</h3>
        <div class="border-b border-gray-200 pb-5 dark:border-white/10">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
          <p class="mt-2 max-w-4xl text-sm text-gray-500 dark:text-gray-400">
            Workcation is a property rental website. Etiam ullamcorper massa viverra consequat,
            consectetur id nulla tempus. Fringilla egestas justo massa purus sagittis malesuada.
          </p>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With description and action</h3>
        <div class="border-b border-gray-200 pb-5 dark:border-white/10">
          <div class="sm:flex sm:items-center sm:justify-between">
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
            <div class="mt-3 sm:mt-0 sm:ml-4">
              <button
                type="button"
                class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
              >
                Create new job
              </button>
            </div>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With avatar, meta, and dropdown</h3>
        <div class="border-b border-gray-200 dark:border-white/10">
          <div class="sm:flex sm:items-baseline sm:justify-between">
            <div class="sm:w-0 sm:flex-1">
              <h1
                id="message-heading"
                class="text-base font-semibold text-gray-900 dark:text-white"
              >
                Full-Stack Developer
              </h1>
              <p class="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
                Checkout and Payments Team
              </p>
            </div>
            <div class="mt-4 flex items-center justify-between sm:mt-0 sm:ml-6 sm:shrink-0 sm:justify-start">
              <span class="inline-flex items-center rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700 inset-ring inset-ring-green-600/20 dark:bg-green-500/10 dark:text-green-400 dark:inset-ring-green-500/10">
                Open
              </span>
            </div>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon-only actions</h3>
        <div class="border-b border-gray-200 px-4 py-5 sm:px-6 dark:border-white/10">
          <div class="-mt-2 -ml-4 flex flex-wrap items-center justify-between sm:flex-nowrap">
            <div class="mt-2 ml-4">
              <h3 class="text-base font-semibold text-gray-900 dark:text-white">Team Members</h3>
            </div>
            <div class="mt-2 ml-4 shrink-0">
              <button
                type="button"
                class="rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
              >
                <span class="sr-only">More options</span>
                <EllipsisVertical class="size-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With badge and dropdown</h3>
        <div class="border-b border-gray-200 dark:border-white/10">
          <div class="sm:flex sm:items-baseline sm:justify-between">
            <div class="sm:w-0 sm:flex-1">
              <h1
                id="message-heading"
                class="text-base font-semibold text-gray-900 dark:text-white"
              >
                Full-Stack Developer
              </h1>
              <p class="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
                Checkout and Payments Team
              </p>
            </div>
            <div class="mt-4 flex items-center justify-between sm:mt-0 sm:ml-6 sm:shrink-0 sm:justify-start">
              <span class="inline-flex items-center rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20 dark:bg-green-500/10 dark:text-green-400 dark:ring-green-500/10">
                Open
              </span>
              <div class="-my-2 ml-3 inline-block text-left">
                <Menu as="div" class="relative">
                  <MenuButton class="relative flex items-center rounded-full p-2 text-gray-400 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-accent-500 dark:hover:text-gray-300 cursor-pointer">
                    <span class="sr-only">Open options</span>
                    <EllipsisVertical aria-hidden="true" class="size-5" />
                  </MenuButton>

                  <MenuItems
                    transition
                    class="absolute right-0 z-10 mt-2 w-56 origin-top-right rounded-md bg-surface-1 shadow-xl border border-surface-border transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in outline-none"
                  >
                    <div class="py-1">
                      <MenuItem>
                        <a
                          href="#"
                          class="flex justify-between px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                        >
                          <span>Edit</span>
                        </a>
                      </MenuItem>
                      <MenuItem>
                        <a
                          href="#"
                          class="flex justify-between px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                        >
                          <span>Duplicate</span>
                        </a>
                      </MenuItem>
                      <MenuItem>
                        <button
                          type="button"
                          class="flex w-full justify-between px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                        >
                          <span>Archive</span>
                        </button>
                      </MenuItem>
                    </div>
                  </MenuItems>
                </Menu>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With actions and popover</h3>
        <div class="border-b border-gray-200 px-4 py-5 sm:px-6 dark:border-white/10">
          <div class="-mt-2 -ml-4 flex flex-wrap items-center justify-between sm:flex-nowrap">
            <div class="mt-2 ml-4">
              <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
            </div>
            <div class="mt-2 ml-4 shrink-0 flex gap-2">
              <Popover class="relative">
                <PopoverButton class="inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 cursor-pointer">
                  <Plus class="size-4 mr-1" />
                  New job
                </PopoverButton>
                <PopoverPanel class="absolute left-0 mt-2 w-64 rounded-lg bg-surface-1 shadow-xl border border-surface-border p-4 z-10">
                  <div class="space-y-3">
                    <input
                      type="text"
                      placeholder="Job title"
                      class="block w-full rounded-md bg-surface-2 border border-surface-border px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-500"
                    />
                    <textarea
                      placeholder="Description"
                      rows={3}
                      class="block w-full rounded-md bg-surface-2 border border-surface-border px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-500"
                    />
                    <div class="flex justify-end gap-2">
                      <button class="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary cursor-pointer">
                        Cancel
                      </button>
                      <button class="px-3 py-1.5 text-sm bg-accent-500 text-white rounded-md hover:bg-accent-600 cursor-pointer">
                        Create
                      </button>
                    </div>
                  </div>
                </PopoverPanel>
              </Popover>
              <button
                type="button"
                class="rounded-full bg-white p-2 text-gray-400 shadow-xs ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20 cursor-pointer"
              >
                <span class="sr-only">More options</span>
                <EllipsisVertical class="size-5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
