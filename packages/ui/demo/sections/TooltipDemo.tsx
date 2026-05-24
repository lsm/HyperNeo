import { Tooltip, TooltipPanel, TooltipTrigger, Transition } from '../../src/mod.ts';

export function TooltipDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Basic tooltip (hover or focus)</h3>
        <Tooltip class="relative inline-block">
          <TooltipTrigger class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer data-[open]:border-accent-500">
            Hover over me
          </TooltipTrigger>
          <TooltipPanel class="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-20 px-3 py-1.5 rounded bg-surface-3 border border-surface-border text-xs text-text-primary whitespace-nowrap shadow-lg">
            This is a tooltip
          </TooltipPanel>
        </Tooltip>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Custom showDelay (100ms)</h3>
        <Tooltip showDelay={100} class="relative inline-block">
          <TooltipTrigger class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer">
            Fast tooltip (100ms delay)
          </TooltipTrigger>
          <TooltipPanel class="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-20 px-3 py-1.5 rounded bg-surface-3 border border-surface-border text-xs text-text-primary whitespace-nowrap shadow-lg">
            Appears quickly
          </TooltipPanel>
        </Tooltip>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">
          Tooltip with Transition (fade-in)
        </h3>
        <Tooltip showDelay={200} class="relative inline-block">
          {({ open }: { open: boolean }) => (
            <>
              <TooltipTrigger class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer data-[open]:border-accent-500">
                <svg class="w-4 h-4 text-accent-400" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fill-rule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                    clip-rule="evenodd"
                  />
                </svg>
                Info icon
              </TooltipTrigger>
              <Transition show={open}>
                <TooltipPanel
                  static
                  class="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-20 w-48 px-3 py-2 rounded-lg bg-surface-3 border border-surface-border text-xs text-text-secondary shadow-lg leading-relaxed transition-all duration-150 data-[closed]:opacity-0 data-[closed]:scale-95 origin-top"
                >
                  Fades and scales in using the{' '}
                  <code class="text-accent-400 font-mono">Transition</code> component with{' '}
                  <code class="text-accent-400 font-mono">data-[closed]</code> variants.
                </TooltipPanel>
              </Transition>
            </>
          )}
        </Tooltip>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Tooltip positioned to the right</h3>
        <Tooltip class="relative inline-block">
          <TooltipTrigger class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer">
            Right-side tooltip
          </TooltipTrigger>
          <TooltipPanel class="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-20 px-3 py-1.5 rounded bg-surface-3 border border-surface-border text-xs text-text-primary whitespace-nowrap shadow-lg">
            Positioned to the right
          </TooltipPanel>
        </Tooltip>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-4">Disabled tooltip trigger</h3>
        <Tooltip class="relative inline-block">
          <TooltipTrigger
            disabled
            class="px-4 py-2 rounded-lg bg-surface-3 text-text-muted text-sm cursor-not-allowed opacity-50"
          >
            Disabled (no tooltip)
          </TooltipTrigger>
          <TooltipPanel class="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-20 px-3 py-1.5 rounded bg-surface-3 border border-surface-border text-xs text-text-primary whitespace-nowrap shadow-lg">
            You should not see this
          </TooltipPanel>
        </Tooltip>
      </div>
    </div>
  );
}
