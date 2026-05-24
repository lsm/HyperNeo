import { IconButton } from '../../src/mod.ts';

export function IconButtonDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Basic icon button</h3>
        <div class="flex items-center gap-3">
          <IconButton
            label="Star"
            class="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 border border-surface-border text-text-secondary transition-colors cursor-pointer data-[hover]:border-accent-500 data-[hover]:text-accent-400 data-[active]:scale-95 data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500"
          >
            ★
          </IconButton>
          <IconButton
            label="Close"
            class="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 border border-surface-border text-text-secondary transition-colors cursor-pointer data-[hover]:border-red-500 data-[hover]:text-red-400 data-[active]:scale-95 data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-red-500"
          >
            ✕
          </IconButton>
          <IconButton
            label="Add"
            class="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 border border-surface-border text-text-secondary transition-colors cursor-pointer data-[hover]:border-green-500 data-[hover]:text-green-400 data-[active]:scale-95 data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-green-500"
          >
            +
          </IconButton>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Different sizes</h3>
        <div class="flex items-center gap-4">
          <div class="flex flex-col items-center gap-2">
            <IconButton
              label="Small star"
              class="w-6 h-6 flex items-center justify-center rounded bg-surface-2 border border-surface-border text-text-secondary text-xs transition-colors cursor-pointer data-[hover]:border-accent-500 data-[hover]:text-accent-400 data-[active]:scale-95 data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500"
            >
              ★
            </IconButton>
            <span class="text-xs text-text-muted">w-6 h-6</span>
          </div>
          <div class="flex flex-col items-center gap-2">
            <IconButton
              label="Medium star"
              class="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 border border-surface-border text-text-secondary text-base transition-colors cursor-pointer data-[hover]:border-accent-500 data-[hover]:text-accent-400 data-[active]:scale-95 data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500"
            >
              ★
            </IconButton>
            <span class="text-xs text-text-muted">w-9 h-9</span>
          </div>
          <div class="flex flex-col items-center gap-2">
            <IconButton
              label="Large star"
              class="w-12 h-12 flex items-center justify-center rounded-xl bg-surface-2 border border-surface-border text-text-secondary text-xl transition-colors cursor-pointer data-[hover]:border-accent-500 data-[hover]:text-accent-400 data-[active]:scale-95 data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500"
            >
              ★
            </IconButton>
            <span class="text-xs text-text-muted">w-12 h-12</span>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">With SVG icon</h3>
        <div class="flex items-center gap-3">
          <IconButton
            label="Settings"
            class="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 border border-surface-border text-text-secondary transition-colors cursor-pointer data-[hover]:border-accent-500 data-[hover]:text-accent-400 data-[active]:bg-surface-3 data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500"
          >
            <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clip-rule="evenodd"
              />
            </svg>
          </IconButton>
          <IconButton
            label="Search"
            class="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 border border-surface-border text-text-secondary transition-colors cursor-pointer data-[hover]:border-accent-500 data-[hover]:text-accent-400 data-[active]:bg-surface-3 data-[focus]:outline-none data-[focus]:ring-2 data-[focus]:ring-accent-500"
          >
            <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fill-rule="evenodd"
                d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                clip-rule="evenodd"
              />
            </svg>
          </IconButton>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Disabled state</h3>
        <div class="flex items-center gap-3">
          <IconButton
            label="Disabled star"
            disabled
            class="w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 border border-surface-border text-text-muted cursor-not-allowed opacity-40"
          >
            ★
          </IconButton>
          <span class="text-xs text-text-muted">
            disabled — no hover, focus, or active states fire
          </span>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          data-hover / data-focus / data-active
        </h3>
        <div class="bg-surface-2 border border-surface-border rounded-lg p-4 text-xs text-text-tertiary space-y-2 max-w-md">
          <p>
            <code class="text-accent-400 font-mono">IconButton</code> tracks interaction state via
            the <code class="text-accent-400 font-mono">useInteractionState</code> hook and exposes:
          </p>
          <ul class="list-disc list-inside space-y-1 ml-2">
            <li>
              <code class="text-accent-400 font-mono">data-hover</code> — mouse is over the button
            </li>
            <li>
              <code class="text-accent-400 font-mono">data-focus</code> — button is focused
              (keyboard)
            </li>
            <li>
              <code class="text-accent-400 font-mono">data-active</code> — button is being pressed
            </li>
            <li>
              <code class="text-accent-400 font-mono">data-disabled</code> — button is disabled
            </li>
          </ul>
          <p class="mt-2">Use Tailwind data variant selectors to style each state independently.</p>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Ghost / minimal variant</h3>
        <div class="flex items-center gap-1">
          <IconButton
            label="Bold"
            class="w-7 h-7 flex items-center justify-center rounded text-text-tertiary text-sm font-bold transition-colors cursor-pointer data-[hover]:bg-surface-3 data-[hover]:text-text-primary data-[active]:bg-surface-border data-[focus]:outline-none data-[focus]:ring-1 data-[focus]:ring-accent-500"
          >
            B
          </IconButton>
          <IconButton
            label="Italic"
            class="w-7 h-7 flex items-center justify-center rounded text-text-tertiary text-sm italic transition-colors cursor-pointer data-[hover]:bg-surface-3 data-[hover]:text-text-primary data-[active]:bg-surface-border data-[focus]:outline-none data-[focus]:ring-1 data-[focus]:ring-accent-500"
          >
            I
          </IconButton>
          <IconButton
            label="Underline"
            class="w-7 h-7 flex items-center justify-center rounded text-text-tertiary text-sm underline transition-colors cursor-pointer data-[hover]:bg-surface-3 data-[hover]:text-text-primary data-[active]:bg-surface-border data-[focus]:outline-none data-[focus]:ring-1 data-[focus]:ring-accent-500"
          >
            U
          </IconButton>
        </div>
      </div>
    </div>
  );
}
