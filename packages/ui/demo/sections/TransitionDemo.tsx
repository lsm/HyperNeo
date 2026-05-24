import { useState } from 'preact/hooks';
import { Transition } from '../../src/mod.ts';

export function TransitionDemo() {
  const [showFade, setShowFade] = useState(false);
  const [showSlide, setShowSlide] = useState(false);
  const [showScale, setShowScale] = useState(false);

  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">Fade (opacity)</h3>
        <button
          onClick={() => setShowFade((v) => !v)}
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer mb-3"
        >
          {showFade ? 'Hide' : 'Show'} fade panel
        </button>
        <Transition show={showFade}>
          <div class="transition-opacity duration-300 data-[closed]:opacity-0 bg-surface-2 border border-surface-border rounded-lg p-4 max-w-sm">
            <p class="text-sm font-medium text-text-primary">Fade panel</p>
            <p class="text-sm text-text-tertiary mt-1">
              This panel fades in and out using{' '}
              <code class="text-accent-400 font-mono">opacity</code> via the{' '}
              <code class="text-accent-400 font-mono">data-[closed]:</code> variant.
            </p>
          </div>
        </Transition>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">
          Slide down (transform + opacity)
        </h3>
        <button
          onClick={() => setShowSlide((v) => !v)}
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer mb-3"
        >
          {showSlide ? 'Hide' : 'Show'} slide panel
        </button>
        <Transition show={showSlide}>
          <div class="transition-all duration-300 ease-out data-[closed]:opacity-0 data-[closed]:-translate-y-2 bg-surface-2 border border-surface-border rounded-lg p-4 max-w-sm">
            <p class="text-sm font-medium text-text-primary">Slide-down panel</p>
            <p class="text-sm text-text-tertiary mt-1">
              Combines <code class="text-accent-400 font-mono">opacity</code> and{' '}
              <code class="text-accent-400 font-mono">translateY</code> — slides in from above while
              fading in.
            </p>
          </div>
        </Transition>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">Scale (transform + opacity)</h3>
        <button
          onClick={() => setShowScale((v) => !v)}
          class="px-4 py-2 rounded-lg bg-surface-2 border border-surface-border text-sm text-text-primary hover:border-accent-500 transition-colors cursor-pointer mb-3"
        >
          {showScale ? 'Hide' : 'Show'} scale panel
        </button>
        <Transition show={showScale}>
          <div class="transition-all duration-200 ease-out origin-top data-[closed]:opacity-0 data-[closed]:scale-95 bg-surface-2 border border-surface-border rounded-lg p-4 max-w-sm">
            <p class="text-sm font-medium text-text-primary">Scale panel</p>
            <p class="text-sm text-text-tertiary mt-1">
              Scales from 95% to 100% while fading in. Useful for dropdown menus and popovers.
            </p>
          </div>
        </Transition>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-2">How it works</h3>
        <div class="bg-surface-2 rounded-lg border border-surface-border p-4 max-w-lg text-sm text-text-tertiary space-y-2">
          <p>
            The <code class="text-accent-400 font-mono">Transition</code> component sets data
            attributes on the wrapped element during enter/leave:
          </p>
          <ul class="list-disc list-inside space-y-1 ml-2">
            <li>
              <code class="text-accent-400 font-mono">data-enter</code> — present during the enter
              phase
            </li>
            <li>
              <code class="text-accent-400 font-mono">data-leave</code> — present during the leave
              phase
            </li>
            <li>
              <code class="text-accent-400 font-mono">data-closed</code> — present at the start of
              enter and at the end of leave
            </li>
          </ul>
          <p class="mt-2">
            Use Tailwind's <code class="text-accent-400 font-mono">data-[closed]:</code> variant to
            set the starting/ending state, and{' '}
            <code class="text-accent-400 font-mono">transition-*</code> classes for the CSS
            transition.
          </p>
        </div>
      </div>
    </div>
  );
}
