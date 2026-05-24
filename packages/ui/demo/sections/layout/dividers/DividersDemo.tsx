import { Ellipsis, Pencil, Plus, Trash } from 'lucide-preact';

export function DividersDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With label</h3>
        <div class="flex items-center">
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
          <div class="relative flex justify-center">
            <span class="bg-white px-2 text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              Continue
            </span>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon</h3>
        <div class="flex items-center">
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
          <div class="relative flex justify-center">
            <span class="bg-white px-2 text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <Plus class="size-5" />
            </span>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With label on left</h3>
        <div class="flex items-center">
          <div class="relative flex justify-start">
            <span class="bg-white pr-2 text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              Continue
            </span>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With title</h3>
        <div class="flex items-center">
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
          <div class="relative flex justify-center">
            <span class="bg-white px-3 text-base font-semibold text-gray-900 dark:bg-gray-900 dark:text-white">
              Projects
            </span>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With title on left</h3>
        <div class="flex items-center">
          <div class="relative flex justify-start">
            <span class="bg-white pr-3 text-base font-semibold text-gray-900 dark:bg-gray-900 dark:text-white">
              Projects
            </span>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With button</h3>
        <div class="flex items-center">
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
          <div class="relative flex justify-center">
            <button
              type="button"
              class="inline-flex items-center gap-x-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
            >
              <Plus class="size-5" />
              Button text
            </button>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/10"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With title and button</h3>
        <div class="relative flex items-center justify-between">
          <span class="bg-white pr-3 text-base font-semibold text-gray-900 dark:bg-gray-900 dark:text-white">
            Projects
          </span>
          <div class="flex w-full items-center">
            <div
              aria-hidden="true"
              class="w-full border-t border-gray-300 dark:border-white/15"
            ></div>
            <button
              type="button"
              class="inline-flex items-center gap-x-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-gray-900 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
            >
              <Plus class="size-5" />
              <span>Button text</span>
            </button>
          </div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With toolbar</h3>
        <div class="flex items-center">
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
          <div class="relative flex justify-center">
            <span class="isolate inline-flex -space-x-px rounded-md shadow-xs dark:shadow-none">
              <button
                type="button"
                class="relative inline-flex items-center rounded-l-md bg-white px-3 py-2 text-gray-400 inset-ring inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/5 dark:inset-ring-gray-700 dark:hover:bg-white/10"
              >
                <span class="sr-only">Edit</span>
                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-5">
                  <path d="m2.695 14.762-1.262 3.155a.5.5 0 0 0 .65.65l3.155-1.262a4 4 0 0 0 1.343-.886L17.5 5.501a2.121 2.121 0 0 0-3-3L3.58 13.419a4 4 0 0 0-.885 1.343Z" />
                </svg>
              </button>
              <button
                type="button"
                class="relative inline-flex items-center bg-white px-3 py-2 text-gray-400 inset-ring inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/5 dark:inset-ring-gray-700 dark:hover:bg-white/10"
              >
                <span class="sr-only">Delete</span>
                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" class="size-5">
                  <path
                    d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5Z"
                    clip-rule="evenodd"
                    fill-rule="evenodd"
                  />
                </svg>
              </button>
            </span>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon-only toolbar</h3>
        <div class="flex items-center">
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
          <div class="relative flex justify-center">
            <span class="isolate inline-flex -space-x-px rounded-md shadow-xs dark:shadow-none">
              <button
                type="button"
                class="relative inline-flex items-center rounded-l-md bg-white px-3 py-2 text-gray-400 inset-ring inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/5 dark:inset-ring-gray-700 dark:hover:bg-white/10"
              >
                <span class="sr-only">Edit</span>
                <Pencil class="size-5" />
              </button>
              <button
                type="button"
                class="relative inline-flex items-center bg-white px-3 py-2 text-gray-400 inset-ring inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/5 dark:inset-ring-gray-700 dark:hover:bg-white/10"
              >
                <span class="sr-only">Delete</span>
                <Trash class="size-5" />
              </button>
              <button
                type="button"
                class="relative inline-flex items-center rounded-r-md bg-white px-3 py-2 text-gray-400 inset-ring inset-ring-gray-300 hover:bg-gray-50 focus:z-10 dark:bg-white/5 dark:inset-ring-gray-700 dark:hover:bg-white/10"
              >
                <span class="sr-only">More</span>
                <Ellipsis class="size-5" />
              </button>
            </span>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon-only centered</h3>
        <div class="flex items-center">
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
          <div class="relative flex justify-center">
            <button
              type="button"
              class="rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
            >
              <span class="sr-only">Add</span>
              <Plus class="size-5" />
            </button>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon-only on left</h3>
        <div class="flex items-center">
          <div class="relative flex justify-start">
            <button
              type="button"
              class="rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
            >
              <span class="sr-only">Add</span>
              <Plus class="size-5" />
            </button>
          </div>
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">With icon-only on right</h3>
        <div class="flex items-center">
          <div
            aria-hidden="true"
            class="w-full border-t border-gray-300 dark:border-white/15"
          ></div>
          <div class="relative flex justify-end">
            <button
              type="button"
              class="rounded-full bg-white p-2 text-gray-400 shadow-xs inset-ring inset-ring-gray-300 hover:bg-gray-50 dark:bg-white/10 dark:text-white dark:shadow-none dark:inset-ring-white/5 dark:hover:bg-white/20"
            >
              <span class="sr-only">Add</span>
              <Plus class="size-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
