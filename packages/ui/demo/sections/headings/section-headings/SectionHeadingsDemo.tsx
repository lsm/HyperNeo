import {
  Menu,
  MenuButton,
  MenuItems,
  MenuItem,
  Popover,
  PopoverButton,
  PopoverPanel,
} from '../../../../src/mod.ts';
import { EllipsisVertical, Plus, Pencil, Filter } from 'lucide-preact';

export function SectionHeadingsDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Simple</h3>
        <div class="border-b border-gray-200 pb-5 dark:border-white/10">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
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
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With actions</h3>
        <div class="border-b border-gray-200 pb-5 sm:flex sm:items-center sm:justify-between dark:border-white/10">
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
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With action</h3>
        <div class="border-b border-gray-200 pb-5 sm:flex sm:items-center sm:justify-between dark:border-white/10">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
          <div class="mt-3 flex sm:mt-0 sm:ml-4">
            <button
              type="button"
              class="inline-flex items-center rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
            >
              Share
            </button>
            <button
              type="button"
              class="ml-3 inline-flex items-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400 dark:focus-visible:outline-indigo-500"
            >
              Create
            </button>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With input group</h3>
        <div class="border-b border-gray-200 pb-5 sm:flex sm:items-center sm:justify-between dark:border-white/10">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
          <div class="mt-3 flex sm:mt-0 sm:ml-4">
            <div class="-mr-px grid grow grid-cols-1 focus-within:relative">
              <input
                id="query"
                type="text"
                name="query"
                placeholder="Search candidates"
                aria-label="Search candidates"
                class="col-start-1 row-start-1 block w-full rounded-l-md bg-white py-1.5 pr-3 pl-10 text-base text-gray-900 outline-1 -outline-offset-1 outline-gray-300 placeholder:text-gray-400 focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 sm:pl-9 sm:text-sm/6 dark:bg-gray-800/50 dark:text-white dark:outline-gray-700 dark:placeholder:text-gray-500 dark:focus:outline-indigo-500"
              />
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                class="pointer-events-none col-start-1 row-start-1 ml-3 size-5 self-center text-gray-400 sm:size-4"
              >
                <path
                  d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"
                  clip-rule="evenodd"
                  fill-rule="evenodd"
                />
              </svg>
            </div>
            <button
              type="button"
              class="flex shrink-0 items-center gap-x-1.5 rounded-r-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 outline-1 -outline-offset-1 outline-gray-300 hover:bg-gray-50 focus:relative focus:outline-2 focus:-outline-offset-2 focus:outline-indigo-600 dark:bg-white/10 dark:text-white dark:outline-gray-700 dark:hover:bg-white/20 dark:focus:outline-indigo-500"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                class="-ml-0.5 size-4 text-gray-400"
              >
                <path
                  d="M2 2.75A.75.75 0 0 1 2.75 2h9.5a.75.75 0 0 1 0 1.5h-9.5A.75.75 0 0 1 2 2.75ZM2 6.25a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5A.75.75 0 0 1 2 6.25Zm0 3.5A.75.75 0 0 1 2.75 9h3.5a.75.75 0 0 1 0 1.5h-3.5A.75.75 0 0 1 2 9.75ZM9.22 9.53a.75.75 0 0 1 0-1.06l2.25-2.25a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1-1.06 1.06l-.97-.97v5.69a.75.75 0 0 1-1.5 0V8.56l-.97.97a.75.75 0 0 1-1.06 0Z"
                  clip-rule="evenodd"
                  fill-rule="evenodd"
                />
              </svg>
              Sort
            </button>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With tabs</h3>
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
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With actions and tabs</h3>
        <div class="border-b border-gray-200 dark:border-white/10">
          <div class="sm:flex sm:items-baseline sm:justify-between">
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
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With label</h3>
        <div class="border-b border-gray-200 pb-5 dark:border-white/10">
          <div class="-mt-2 -ml-2 flex flex-wrap items-baseline">
            <h3 class="mt-2 ml-2 text-base font-semibold text-gray-900 dark:text-white">
              Job Postings
            </h3>
            <p class="mt-1 ml-2 truncate text-sm text-gray-500 dark:text-gray-400">
              in Engineering
            </p>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With badge and dropdown</h3>
        <div class="border-b border-gray-200 pb-5 dark:border-white/10">
          <div class="sm:flex sm:items-baseline sm:justify-between">
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
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
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon-only actions</h3>
        <div class="border-b border-gray-200 pb-5 sm:flex sm:items-center sm:justify-between dark:border-white/10">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">Team Members</h3>
          <div class="mt-3 flex gap-2 sm:mt-0 sm:ml-4">
            <button
              type="button"
              class="rounded-full bg-indigo-600 p-2 text-white shadow-xs hover:bg-indigo-500 dark:bg-indigo-500 dark:shadow-none dark:hover:bg-indigo-400"
            >
              <span class="sr-only">Add member</span>
              <Plus class="size-5" />
            </button>
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
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon-only edit and more</h3>
        <div class="border-b border-gray-200 pb-5 sm:flex sm:items-center sm:justify-between dark:border-white/10">
          <h3 class="text-base font-semibold text-gray-900 dark:text-white">Projects</h3>
          <div class="mt-3 flex gap-2 sm:mt-0 sm:ml-4">
            <button
              type="button"
              class="rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
            >
              <span class="sr-only">Edit</span>
              <Pencil class="size-5" />
            </button>
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

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With actions and popover</h3>
        <div class="border-b border-gray-200 pb-5 dark:border-white/10">
          <div class="sm:flex sm:items-center sm:justify-between">
            <h3 class="text-base font-semibold text-gray-900 dark:text-white">Job Postings</h3>
            <div class="mt-3 flex sm:mt-0 sm:ml-4 gap-2">
              <Popover class="relative">
                <PopoverButton class="rounded-full bg-white p-2 text-gray-400 shadow-xs ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20 cursor-pointer">
                  <span class="sr-only">Filter</span>
                  <Filter class="size-5" />
                </PopoverButton>
                <PopoverPanel class="absolute right-0 mt-2 w-48 rounded-lg bg-surface-1 shadow-xl border border-surface-border p-4 z-10">
                  <div class="space-y-3">
                    <p class="text-xs font-semibold text-text-secondary uppercase tracking-wider">
                      Status
                    </p>
                    <label class="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                      <input type="checkbox" class="rounded border-surface-border" />
                      Open
                    </label>
                    <label class="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                      <input type="checkbox" class="rounded border-surface-border" />
                      Closed
                    </label>
                    <label class="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                      <input type="checkbox" class="rounded border-surface-border" />
                      Draft
                    </label>
                  </div>
                </PopoverPanel>
              </Popover>
              <Menu as="div" class="relative">
                <MenuButton class="rounded-full bg-white p-2 text-gray-400 shadow-xs ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:ring-white/5 dark:hover:bg-white/20 cursor-pointer">
                  <span class="sr-only">More options</span>
                  <EllipsisVertical class="size-5" />
                </MenuButton>
                <MenuItems
                  transition
                  class="absolute right-0 z-10 mt-2 w-48 origin-top-right rounded-md bg-surface-1 shadow-xl border border-surface-border transition data-closed:scale-95 data-closed:transform data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in outline-none"
                >
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                    >
                      Export
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                    >
                      Share
                    </a>
                  </MenuItem>
                  <MenuItem>
                    <a
                      href="#"
                      class="block px-4 py-2 text-sm text-text-primary data-[focus]:bg-accent-500 data-[focus]:text-white cursor-pointer"
                    >
                      Settings
                    </a>
                  </MenuItem>
                </MenuItems>
              </Menu>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
