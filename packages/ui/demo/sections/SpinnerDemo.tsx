import { Spinner } from '../../src/mod.ts';

export function SpinnerDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Default spinner</h3>
        <Spinner class="inline-flex items-center justify-center w-6 h-6">
          <span class="block w-6 h-6 rounded-full border-2 border-surface-border border-t-accent-500 animate-spin" />
        </Spinner>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Different sizes</h3>
        <div class="flex items-center gap-6">
          <div class="flex flex-col items-center gap-2">
            <Spinner label="Loading small" class="inline-flex items-center justify-center w-4 h-4">
              <span class="block w-4 h-4 rounded-full border-2 border-surface-border border-t-accent-500 animate-spin" />
            </Spinner>
            <span class="text-xs text-text-muted">w-4 h-4</span>
          </div>
          <div class="flex flex-col items-center gap-2">
            <Spinner label="Loading medium" class="inline-flex items-center justify-center w-6 h-6">
              <span class="block w-6 h-6 rounded-full border-2 border-surface-border border-t-accent-500 animate-spin" />
            </Spinner>
            <span class="text-xs text-text-muted">w-6 h-6</span>
          </div>
          <div class="flex flex-col items-center gap-2">
            <Spinner label="Loading large" class="inline-flex items-center justify-center w-8 h-8">
              <span class="block w-8 h-8 rounded-full border-[3px] border-surface-border border-t-accent-500 animate-spin" />
            </Spinner>
            <span class="text-xs text-text-muted">w-8 h-8</span>
          </div>
          <div class="flex flex-col items-center gap-2">
            <Spinner
              label="Loading extra large"
              class="inline-flex items-center justify-center w-12 h-12"
            >
              <span class="block w-12 h-12 rounded-full border-4 border-surface-border border-t-accent-500 animate-spin" />
            </Spinner>
            <span class="text-xs text-text-muted">w-12 h-12</span>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Custom label (screen-reader text)
        </h3>
        <Spinner label="Fetching results…" class="inline-flex items-center justify-center w-6 h-6">
          <span class="block w-6 h-6 rounded-full border-2 border-surface-border border-t-accent-500 animate-spin" />
        </Spinner>
        <p class="mt-2 text-xs text-text-muted">
          Label is visually hidden but announced by screen readers (aria-label + sr-only span).
        </p>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Spinner inside a button</h3>
        <button
          disabled
          class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-500/50 text-white text-sm font-medium cursor-not-allowed opacity-70"
        >
          <Spinner label="Saving…" class="inline-flex items-center justify-center w-4 h-4">
            <span class="block w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          </Spinner>
          Saving…
        </button>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Color variants</h3>
        <div class="flex items-center gap-6">
          <div class="flex flex-col items-center gap-2">
            <Spinner label="Loading" class="inline-flex items-center justify-center w-6 h-6">
              <span class="block w-6 h-6 rounded-full border-2 border-surface-border border-t-accent-500 animate-spin" />
            </Spinner>
            <span class="text-xs text-text-muted">accent</span>
          </div>
          <div class="flex flex-col items-center gap-2">
            <Spinner label="Loading" class="inline-flex items-center justify-center w-6 h-6">
              <span class="block w-6 h-6 rounded-full border-2 border-surface-border border-t-green-400 animate-spin" />
            </Spinner>
            <span class="text-xs text-text-muted">green</span>
          </div>
          <div class="flex flex-col items-center gap-2">
            <Spinner label="Loading" class="inline-flex items-center justify-center w-6 h-6">
              <span class="block w-6 h-6 rounded-full border-2 border-surface-border border-t-yellow-400 animate-spin" />
            </Spinner>
            <span class="text-xs text-text-muted">yellow</span>
          </div>
          <div class="flex flex-col items-center gap-2">
            <Spinner label="Loading" class="inline-flex items-center justify-center w-6 h-6">
              <span class="block w-6 h-6 rounded-full border-2 border-surface-border border-t-red-400 animate-spin" />
            </Spinner>
            <span class="text-xs text-text-muted">red</span>
          </div>
        </div>
      </div>
    </div>
  );
}
