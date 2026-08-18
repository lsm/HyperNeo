import { useState } from 'preact/hooks';

function Example1() {
  return (
    <label class="group relative inline-flex w-11 shrink-0 rounded-full bg-gray-200 p-0.5 inset-ring inset-ring-gray-900/5 outline-offset-2 outline-indigo-600 transition-colors duration-200 ease-in-out has-checked:bg-indigo-600 has-focus-visible:outline-2 dark:bg-white/5 dark:inset-ring-white/10 dark:outline-indigo-500 dark:has-checked:bg-indigo-500 cursor-pointer">
      <input
        type="checkbox"
        class="absolute inset-0 size-full appearance-none focus:outline-hidden"
      />
      <span class="size-5 rounded-full bg-white shadow-xs ring-1 ring-gray-900/5 transition-transform duration-200 ease-in-out group-has-checked:translate-x-5 dark:shadow-none" />
    </label>
  );
}

function Example2() {
  return (
    <label class="group relative inline-flex w-10 shrink-0 rounded-full bg-gray-200 p-0.5 inset-ring inset-ring-gray-900/5 outline-offset-2 outline-indigo-600 transition-colors duration-200 ease-in-out has-checked:bg-indigo-600 has-focus-visible:outline-2 dark:bg-white/5 dark:inset-ring-white/10 dark:outline-indigo-500 dark:has-checked:bg-indigo-500 cursor-pointer">
      <input
        type="checkbox"
        class="absolute inset-0 size-full appearance-none focus:outline-hidden"
      />
      <span class="size-5 rounded-full bg-white shadow-xs ring-1 ring-gray-900/5 transition-transform duration-200 ease-in-out group-has-checked:translate-x-4 dark:shadow-none" />
    </label>
  );
}

function Example3() {
  return (
    <label class="group relative inline-flex w-11 shrink-0 rounded-full bg-gray-200 p-0.5 inset-ring inset-ring-gray-900/5 outline-offset-2 outline-indigo-600 transition-colors duration-200 ease-in-out has-checked:bg-indigo-600 has-focus-visible:outline-2 dark:bg-white/5 dark:inset-ring-white/10 dark:outline-indigo-500 dark:has-checked:bg-indigo-500 cursor-pointer">
      <input
        type="checkbox"
        class="absolute inset-0 size-full appearance-none focus:outline-hidden"
      />
      <span class="size-5 rounded-full bg-white shadow-xs ring-1 ring-gray-900/5 transition-transform duration-200 ease-in-out group-has-checked:translate-x-5 dark:shadow-none flex items-center justify-center">
        <svg
          class="size-3.5 text-indigo-600 transition-opacity duration-200 ease-in-out opacity-0 group-has-checked:opacity-100"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="3"
          stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <svg
          class="absolute size-3.5 text-gray-400 transition-opacity duration-200 ease-in-out opacity-100 group-has-checked:opacity-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="3"
          stroke="currentColor"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </span>
    </label>
  );
}

function Example4() {
  const [checked, setChecked] = useState(false);

  return (
    <div class="flex items-start gap-3">
      <label class="group relative inline-flex w-11 shrink-0 rounded-full bg-gray-200 p-0.5 inset-ring inset-ring-gray-900/5 outline-offset-2 outline-indigo-600 transition-colors duration-200 ease-in-out has-checked:bg-indigo-600 has-focus-visible:outline-2 dark:bg-white/5 dark:inset-ring-white/10 dark:outline-indigo-500 dark:has-checked:bg-indigo-500 cursor-pointer mt-0.5">
        <input
          type="checkbox"
          class="absolute inset-0 size-full appearance-none focus:outline-hidden"
          checked={checked}
          onChange={(e) => setChecked((e.target as HTMLInputElement).checked)}
        />
        <span class="size-5 rounded-full bg-white shadow-xs ring-1 ring-gray-900/5 transition-transform duration-200 ease-in-out group-has-checked:translate-x-5 dark:shadow-none" />
      </label>
      <div class="flex flex-col">
        <span class="text-sm font-medium text-text-primary">Enable notifications</span>
        <span class="text-sm text-text-tertiary">
          Receive alerts when someone mentions you or replies to your message.
        </span>
      </div>
    </div>
  );
}

function Example5() {
  return (
    <div class="flex items-center justify-between gap-4">
      <span class="text-sm font-medium text-text-primary">Dark mode</span>
      <label class="group relative inline-flex w-11 shrink-0 rounded-full bg-gray-200 p-0.5 inset-ring inset-ring-gray-900/5 outline-offset-2 outline-indigo-600 transition-colors duration-200 ease-in-out has-checked:bg-indigo-600 has-focus-visible:outline-2 dark:bg-white/5 dark:inset-ring-white/10 dark:outline-indigo-500 dark:has-checked:bg-indigo-500 cursor-pointer">
        <input
          type="checkbox"
          class="absolute inset-0 size-full appearance-none focus:outline-hidden"
        />
        <span class="size-5 rounded-full bg-white shadow-xs ring-1 ring-gray-900/5 transition-transform duration-200 ease-in-out group-has-checked:translate-x-5 dark:shadow-none" />
      </label>
    </div>
  );
}

export function TogglesDemo() {
  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple toggle</h3>
        <Example1 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Short toggle</h3>
        <Example2 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Toggle with icon</h3>
        <Example3 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Toggle with left label and description
        </h3>
        <Example4 />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Toggle with right label</h3>
        <Example5 />
      </div>
    </div>
  );
}
