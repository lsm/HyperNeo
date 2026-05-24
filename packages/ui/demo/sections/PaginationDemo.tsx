import { ChevronLeft, ChevronRight } from 'lucide-preact';

export function PaginationDemo() {
  return (
    <div class="flex flex-col gap-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Default</h3>
        <div class="flex items-center justify-between border-t border-surface-border bg-white px-4 py-3 sm:px-6 dark:border-white/10 dark:bg-transparent">
          <div class="flex flex-1 justify-between sm:hidden">
            <a
              href="#"
              class="relative inline-flex items-center rounded-md border border-surface-border bg-white px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-0 dark:border-white/10 dark:bg-white/5 dark:text-text-tertiary dark:hover:bg-white/10"
            >
              Previous
            </a>
            <a
              href="#"
              class="relative ml-3 inline-flex items-center rounded-md border border-surface-border bg-white px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-0 dark:border-white/10 dark:bg-white/5 dark:text-text-tertiary dark:hover:bg-white/10"
            >
              Next
            </a>
          </div>
          <div class="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
            <div>
              <p class="text-sm text-text-secondary dark:text-text-tertiary">
                Showing <span class="font-medium">1</span> to <span class="font-medium">10</span> of{' '}
                <span class="font-medium">97</span> results
              </p>
            </div>
            <div>
              <nav
                aria-label="Pagination"
                class="isolate inline-flex -space-x-px rounded-md shadow-xs dark:shadow-none"
              >
                <a
                  href="#"
                  class="relative inline-flex items-center rounded-l-md px-2 py-2 text-text-tertiary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  <span class="sr-only">Previous</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                    class="size-5"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </a>
                <a
                  href="#"
                  aria-current="page"
                  class="relative z-10 inline-flex items-center bg-accent-500 px-4 py-2 text-sm font-semibold text-white focus:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 dark:bg-accent-500 dark:focus-visible:outline-accent-500"
                >
                  1
                </a>
                <a
                  href="#"
                  class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  2
                </a>
                <a
                  href="#"
                  class="relative hidden items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 md:inline-flex dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  3
                </a>
                <span class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-secondary inset-ring inset-ring-surface-border focus:outline-offset-0 dark:text-text-tertiary dark:inset-ring-surface-2">
                  ...
                </span>
                <a
                  href="#"
                  class="relative hidden items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 md:inline-flex dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  8
                </a>
                <a
                  href="#"
                  class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  9
                </a>
                <a
                  href="#"
                  class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  10
                </a>
                <a
                  href="#"
                  class="relative inline-flex items-center rounded-r-md px-2 py-2 text-text-tertiary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  <span class="sr-only">Next</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                    class="size-5"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </a>
              </nav>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Card footer with page buttons</h3>
        <div class="flex items-center justify-between border-t border-surface-border bg-white px-4 py-3 sm:px-6 dark:border-white/10 dark:bg-transparent">
          <div class="flex flex-1 justify-between sm:hidden">
            <a
              href="#"
              class="relative inline-flex items-center rounded-md border border-surface-border bg-white px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-0 dark:border-white/10 dark:bg-white/5 dark:text-text-tertiary dark:hover:bg-white/10"
            >
              Previous
            </a>
            <a
              href="#"
              class="relative ml-3 inline-flex items-center rounded-md border border-surface-border bg-white px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-0 dark:border-white/10 dark:bg-white/5 dark:text-text-tertiary dark:hover:bg-white/10"
            >
              Next
            </a>
          </div>
          <div class="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
            <div>
              <p class="text-sm text-text-secondary dark:text-text-tertiary">
                Showing <span class="font-medium">1</span> to <span class="font-medium">10</span> of{' '}
                <span class="font-medium">97</span> results
              </p>
            </div>
            <div>
              <nav
                aria-label="Pagination"
                class="isolate inline-flex -space-x-px rounded-md shadow-xs dark:shadow-none"
              >
                <a
                  href="#"
                  class="relative inline-flex items-center rounded-l-md px-2 py-2 text-text-tertiary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  <span class="sr-only">Previous</span>
                  <ChevronLeft aria-hidden="true" class="size-5" />
                </a>
                <a
                  href="#"
                  aria-current="page"
                  class="relative z-10 inline-flex items-center bg-accent-500 px-4 py-2 text-sm font-semibold text-white focus:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 dark:bg-accent-500 dark:focus-visible:outline-accent-500"
                >
                  1
                </a>
                <a
                  href="#"
                  class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  2
                </a>
                <a
                  href="#"
                  class="relative hidden items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 md:inline-flex dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  3
                </a>
                <span class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-secondary inset-ring inset-ring-surface-border focus:outline-offset-0 dark:text-text-tertiary dark:inset-ring-surface-2">
                  ...
                </span>
                <a
                  href="#"
                  class="relative hidden items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 md:inline-flex dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  8
                </a>
                <a
                  href="#"
                  class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  9
                </a>
                <a
                  href="#"
                  class="relative inline-flex items-center px-4 py-2 text-sm font-semibold text-text-primary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:text-text-tertiary dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  10
                </a>
                <a
                  href="#"
                  class="relative inline-flex items-center rounded-r-md px-2 py-2 text-text-tertiary inset-ring inset-ring-surface-border hover:bg-surface-0 focus:z-20 focus:outline-offset-0 dark:inset-ring-surface-2 dark:hover:bg-white/5"
                >
                  <span class="sr-only">Next</span>
                  <ChevronRight aria-hidden="true" class="size-5" />
                </a>
              </nav>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Centered page numbers</h3>
        <div class="flex items-center justify-between border-t border-surface-border px-4 sm:px-0 dark:border-white/10">
          <div class="-mt-px flex w-0 flex-1">
            <a
              href="#"
              class="inline-flex items-center border-t-2 border-transparent pt-4 pr-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-secondary"
            >
              <svg
                aria-hidden="true"
                class="mr-3 size-5 text-text-tertiary dark:text-text-tertiary"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fill-rule="evenodd"
                  d="M18.78 6.22a.75.75 0 0 1 0 1.06L11.56 12l7.22 7.72a.75.75 0 1 1-1.06 1.06l-8-8.5a.75.75 0 0 1 0-1.06l8-8.5a.75.75 0 0 1 1.06 0z"
                  clip-rule="evenodd"
                />
              </svg>
              Previous
            </a>
          </div>
          <div class="hidden md:-mt-px md:flex">
            <a
              href="#"
              class="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-secondary"
            >
              1
            </a>
            <a
              href="#"
              aria-current="page"
              class="inline-flex items-center border-t-2 border-accent-500 px-4 pt-4 text-sm font-medium text-accent-400"
            >
              2
            </a>
            <a
              href="#"
              class="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-secondary"
            >
              3
            </a>
            <span class="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-sm font-medium text-text-secondary">
              ...
            </span>
            <a
              href="#"
              class="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-secondary"
            >
              8
            </a>
            <a
              href="#"
              class="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-secondary"
            >
              9
            </a>
            <a
              href="#"
              class="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-secondary"
            >
              10
            </a>
          </div>
          <div class="-mt-px flex w-0 flex-1 justify-end">
            <a
              href="#"
              class="inline-flex items-center border-t-2 border-transparent pt-4 pl-1 text-sm font-medium text-text-secondary hover:border-surface-border hover:text-text-primary dark:text-text-tertiary dark:hover:border-white/20 dark:hover:text-text-secondary"
            >
              Next
              <svg
                aria-hidden="true"
                class="ml-3 size-5 text-text-tertiary dark:text-text-tertiary"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fill-rule="evenodd"
                  d="M1.22 6.22a.75.75 0 0 1 1.06 0L10 11.56l7.72-7.72a.75.75 0 1 1 1.06 1.06l-8.5 8.5a.75.75 0 0 1-1.06 0l-8.5-8.5a.75.75 0 0 1 0-1.06z"
                  clip-rule="evenodd"
                />
              </svg>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
