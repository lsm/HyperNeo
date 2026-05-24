import { ChevronDown } from 'lucide-preact';

export function SelectMenusDemo() {
  return (
    <div class="space-y-12">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Simple native select</h3>
        <label for="location" class="block text-sm/6 font-medium text-text-primary">
          Location
        </label>
        <div class="mt-2 grid grid-cols-1">
          <select
            id="location"
            name="location"
            class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-2 py-1.5 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:outline-white/10"
          >
            <option>United States</option>
            <option selected>Canada</option>
            <option>Mexico</option>
          </select>
          <ChevronDown
            aria-hidden="true"
            class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-text-tertiary sm:size-4"
          />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Native select with dark styles</h3>
        <label for="timezone" class="block text-sm/6 font-medium text-text-primary">
          Timezone
        </label>
        <div class="mt-2 grid grid-cols-1">
          <select
            id="timezone"
            name="timezone"
            class="col-start-1 row-start-1 w-full appearance-none rounded-md bg-surface-2 py-1.5 pr-8 pl-3 text-base text-text-primary outline-1 -outline-offset-1 outline-surface-border focus:outline-2 focus:-outline-offset-2 focus:outline-accent-500 sm:text-sm/6 dark:bg-white/5 dark:outline-white/10"
          >
            <option>America/New_York</option>
            <option>America/Chicago</option>
            <option>America/Denver</option>
            <option selected>America/Los_Angeles</option>
          </select>
          <ChevronDown
            aria-hidden="true"
            class="pointer-events-none col-start-1 row-start-1 mr-2 size-5 self-center justify-self-end text-text-tertiary sm:size-4"
          />
        </div>
      </div>
    </div>
  );
}
