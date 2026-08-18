import { useState } from 'preact/hooks';

const sides = [
  { id: null, name: 'None' },
  { id: 1, name: 'Baked beans' },
  { id: 2, name: 'Coleslaw' },
  { id: 3, name: 'French fries' },
  { id: 4, name: 'Garden salad' },
  { id: 5, name: 'Mashed potatoes' },
];

export function RadioGroupsDemo() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Select with radio on right</h3>
        <fieldset>
          <legend class="text-sm/6 font-semibold text-text-primary">Select a side</legend>
          <div class="mt-4 divide-y divide-gray-200 border-t border-b border-gray-200 dark:divide-white/10 dark:border-white/10">
            {sides.map((side, sideIdx) => (
              <div key={sideIdx} class="relative flex items-start py-4">
                <div class="min-w-0 flex-1 text-sm/6">
                  <label for={`side-${side.id}`} class="font-medium text-text-primary select-none">
                    {side.name}
                  </label>
                </div>
                <div class="ml-3 flex h-6 items-center">
                  <input
                    checked={selected === side.name}
                    onChange={() => setSelected(side.name)}
                    id={`side-${side.id}`}
                    name="plan"
                    type="radio"
                    class="relative size-4 appearance-none rounded-full border border-gray-300 bg-white before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:border-gray-300 disabled:bg-gray-100 disabled:before:bg-gray-400 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500 dark:disabled:border-white/5 dark:disabled:bg-white/10 dark:disabled:before:bg-white/20"
                  />
                </div>
              </div>
            ))}
          </div>
        </fieldset>
        <p class="mt-2 text-sm text-text-secondary">
          Selected: <span class="font-medium text-text-primary">{selected || 'None'}</span>
        </p>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Icon-only radio options</h3>
        <fieldset>
          <legend class="text-sm/6 font-semibold text-text-primary mb-4">
            Select notification preference
          </legend>
          <div class="flex gap-4">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="notification"
                value="email"
                class="relative size-4 appearance-none rounded-full border border-gray-300 bg-white before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500"
              />
              <span class="text-sm text-text-primary">Email</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="notification"
                value="sms"
                class="relative size-4 appearance-none rounded-full border border-gray-300 bg-white before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500"
              />
              <span class="text-sm text-text-primary">SMS</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="notification"
                value="push"
                class="relative size-4 appearance-none rounded-full border border-gray-300 bg-white before:absolute before:inset-1 before:rounded-full before:bg-white not-checked:before:hidden checked:border-indigo-600 checked:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 dark:border-white/10 dark:bg-white/5 dark:checked:border-indigo-500 dark:checked:bg-indigo-500 dark:focus-visible:outline-indigo-500"
              />
              <span class="text-sm text-text-primary">Push</span>
            </label>
          </div>
        </fieldset>
      </div>
    </div>
  );
}
