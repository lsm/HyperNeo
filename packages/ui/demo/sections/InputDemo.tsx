import { Input, Select, Textarea } from '../../src/mod.ts';

const inputClass =
  'bg-surface-2 border border-surface-border rounded-lg px-3 py-2 text-text-primary placeholder-text-muted transition-colors w-full focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 disabled:opacity-50 disabled:cursor-not-allowed';

const selectClass =
  'bg-surface-2 border border-surface-border rounded-lg px-3 py-2 text-text-primary transition-colors w-full focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 disabled:opacity-50 disabled:cursor-not-allowed appearance-none cursor-pointer';

export function InputDemo() {
  return (
    <div class="space-y-6 max-w-md">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input</h3>
        <Input type="text" placeholder="Enter text..." class={inputClass} />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input — disabled</h3>
        <Input type="text" placeholder="Disabled input" disabled class={inputClass} />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Input — invalid</h3>
        <Input
          type="email"
          placeholder="bad@email"
          invalid
          value="not-an-email"
          class={`${inputClass} border-red-500 focus:ring-red-500`}
        />
        <p class="mt-1 text-xs text-red-400">Enter a valid email address.</p>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Textarea</h3>
        <Textarea placeholder="Write something..." rows={4} class={inputClass} />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Textarea — disabled</h3>
        <Textarea placeholder="Disabled textarea" rows={3} disabled class={inputClass} />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Select</h3>
        <div class="relative">
          <Select class={selectClass}>
            <option value="">Choose an option</option>
            <option value="alpha">Alpha</option>
            <option value="beta">Beta</option>
            <option value="gamma">Gamma</option>
          </Select>
          <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-tertiary">
            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                clip-rule="evenodd"
              />
            </svg>
          </span>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Select — disabled</h3>
        <div class="relative">
          <Select disabled class={selectClass}>
            <option value="">Disabled select</option>
            <option value="a">Option A</option>
          </Select>
          <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-text-muted">
            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fill-rule="evenodd"
                d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                clip-rule="evenodd"
              />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
