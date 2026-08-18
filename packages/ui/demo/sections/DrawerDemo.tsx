import { useState } from 'preact/hooks';
import {
  CloseButton,
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogTitle,
  Transition,
  TransitionChild,
} from '../../src/mod.ts';

function DrawerDemo() {
  const [rightOpen, setRightOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [inlineOpen, setInlineOpen] = useState(false);

  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Drawer — Slide from right with overlay
        </h3>
        <button
          type="button"
          onClick={() => setRightOpen(true)}
          class="bg-accent-500 hover:bg-accent-600 text-white px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer"
        >
          Open right drawer
        </button>
        <p class="mt-2 text-xs text-text-muted">
          Uses <code class="text-accent-400 font-mono">Dialog</code> +{' '}
          <code class="text-accent-400 font-mono">TransitionChild</code> with{' '}
          <code class="text-accent-400 font-mono">data-[closed]:translate-x-full</code> transition.
        </p>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Drawer — Slide from left</h3>
        <button
          type="button"
          onClick={() => setLeftOpen(true)}
          class="bg-surface-2 hover:bg-surface-3 border border-surface-border text-text-primary px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer"
        >
          Open left drawer
        </button>
        <p class="mt-2 text-xs text-text-muted">
          Flip the slide direction with{' '}
          <code class="text-accent-400 font-mono">-translate-x-full</code> and{' '}
          <code class="text-accent-400 font-mono">-translate-x-0</code>.
        </p>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Drawer — Inline (no overlay, full height)
        </h3>
        <button
          type="button"
          onClick={() => setInlineOpen(true)}
          class="bg-surface-2 hover:bg-surface-3 border border-surface-border text-text-primary px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer"
        >
          Open inline drawer
        </button>
        <p class="mt-2 text-xs text-text-muted">
          Inline variant without backdrop for sidebar-style panels.
        </p>
      </div>

      <Dialog open={rightOpen} onClose={setRightOpen} class="relative z-50">
        <Transition show={rightOpen}>
          <DialogBackdrop class="fixed inset-0 bg-black/50 transition-opacity duration-300 ease-out data-[closed]:opacity-0 data-[enter]:duration-300 data-[enter]:ease-out data-[leave]:duration-200 data-[leave]:ease-in" />

          <div class="fixed inset-0 overflow-hidden">
            <div class="absolute inset-0 overflow-hidden">
              <div class="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10">
                <TransitionChild
                  transition
                  as="div"
                  class="pointer-events-auto w-screen max-w-md transform transition duration-300 ease-in-out data-[closed]:translate-x-full sm:duration-500"
                >
                  <div class="flex h-full flex-col overflow-y-scroll bg-surface-1 shadow-xl">
                    <div class="px-4 py-6 sm:px-6">
                      <div class="flex items-start justify-between">
                        <DialogTitle class="text-lg font-semibold text-text-primary">
                          Project Settings
                        </DialogTitle>
                        <div class="ml-3 flex h-7 items-center">
                          <CloseButton
                            onClick={() => setRightOpen(false)}
                            class="rounded-lg p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                          >
                            <span class="sr-only">Close panel</span>
                            <svg class="h-6 w-6" viewBox="0 0 20 20" fill="currentColor">
                              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                            </svg>
                          </CloseButton>
                        </div>
                      </div>
                    </div>

                    <div class="relative mt-6 flex-1 px-4 sm:px-6 space-y-6">
                      <DialogDescription class="text-sm text-text-secondary">
                        Configure your project settings and preferences.
                      </DialogDescription>

                      <div class="space-y-4">
                        <div>
                          <label class="block text-sm font-medium text-text-primary mb-1.5">
                            Project Name
                          </label>
                          <input
                            type="text"
                            defaultValue="Website Redesign"
                            class="w-full px-3 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent"
                          />
                        </div>

                        <div>
                          <label class="block text-sm font-medium text-text-primary mb-1.5">
                            Description
                          </label>
                          <textarea
                            rows={3}
                            defaultValue="Complete redesign of the marketing website"
                            class="w-full px-3 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent resize-none"
                          />
                        </div>

                        <div>
                          <label class="block text-sm font-medium text-text-primary mb-1.5">
                            Visibility
                          </label>
                          <select class="w-full px-3 py-2 rounded-lg bg-surface-2 border border-surface-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent">
                            <option>Private</option>
                            <option>Team</option>
                            <option>Public</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div class="flex shrink-0 justify-end gap-3 border-t border-surface-border px-4 py-4 sm:px-6">
                      <button
                        type="button"
                        onClick={() => setRightOpen(false)}
                        class="px-4 py-2 rounded-lg text-sm font-medium border border-surface-border text-text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => setRightOpen(false)}
                        class="px-4 py-2 rounded-lg text-sm font-medium bg-accent-500 hover:bg-accent-600 text-white transition-colors cursor-pointer"
                      >
                        Save changes
                      </button>
                    </div>
                  </div>
                </TransitionChild>
              </div>
            </div>
          </div>
        </Transition>
      </Dialog>

      <Dialog open={leftOpen} onClose={setLeftOpen} class="relative z-50">
        <Transition show={leftOpen}>
          <DialogBackdrop class="fixed inset-0 bg-black/50 transition-opacity duration-300 ease-out data-[closed]:opacity-0 data-[enter]:duration-300 data-[enter]:ease-out data-[leave]:duration-200 data-[leave]:ease-in" />

          <div class="fixed inset-0 overflow-hidden">
            <div class="absolute inset-0 overflow-hidden">
              <div class="pointer-events-none fixed inset-y-0 left-0 flex max-w-full pr-10">
                <TransitionChild
                  transition
                  as="div"
                  class="pointer-events-auto w-screen max-w-xs transform transition duration-300 ease-in-out data-[closed]:-translate-x-full sm:duration-500"
                >
                  <div class="flex h-full flex-col bg-surface-1 shadow-xl border-r border-surface-border">
                    <div class="px-4 py-6">
                      <div class="flex items-start justify-between">
                        <DialogTitle class="text-lg font-semibold text-text-primary">
                          Navigation
                        </DialogTitle>
                        <CloseButton
                          onClick={() => setLeftOpen(false)}
                          class="rounded-lg p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors cursor-pointer"
                        >
                          <span class="sr-only">Close panel</span>
                          <svg class="h-6 w-6" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                          </svg>
                        </CloseButton>
                      </div>
                    </div>

                    <nav class="flex-1 px-4 space-y-1">
                      <a
                        href="#"
                        class="flex items-center gap-3 px-3 py-2 rounded-lg bg-accent-500 text-white text-sm font-medium"
                      >
                        <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
                        </svg>
                        Home
                      </a>
                      <a
                        href="#"
                        class="flex items-center gap-3 px-3 py-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-2 text-sm font-medium transition-colors"
                      >
                        <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
                        </svg>
                        Projects
                      </a>
                      <a
                        href="#"
                        class="flex items-center gap-3 px-3 py-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-2 text-sm font-medium transition-colors"
                      >
                        <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                          <path
                            fill-rule="evenodd"
                            d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                            clip-rule="evenodd"
                          />
                        </svg>
                        Team
                      </a>
                      <a
                        href="#"
                        class="flex items-center gap-3 px-3 py-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-2 text-sm font-medium transition-colors"
                      >
                        <svg class="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                          <path
                            fill-rule="evenodd"
                            d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
                            clip-rule="evenodd"
                          />
                        </svg>
                        Settings
                      </a>
                    </nav>
                  </div>
                </TransitionChild>
              </div>
            </div>
          </div>
        </Transition>
      </Dialog>

      <div class="relative overflow-hidden border border-surface-border rounded-xl bg-surface-0">
        <Transition show={inlineOpen}>
          <TransitionChild
            transition
            as="div"
            class="absolute inset-y-0 left-0 w-64 bg-surface-1 shadow-xl border-r border-surface-border z-10 data-[closed]:-translate-x-full transition-transform duration-300 ease-out"
          >
            <div class="flex items-center justify-between p-4 border-b border-surface-border">
              <span class="font-semibold text-text-primary">Sidebar</span>
              <CloseButton
                onClick={() => setInlineOpen(false)}
                class="rounded-lg p-1 text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors cursor-pointer"
              >
                <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </CloseButton>
            </div>
            <div class="p-4 text-sm text-text-secondary">
              This is an inline drawer variant without backdrop overlay. Useful for persistent
              sidebars.
            </div>
          </TransitionChild>
        </Transition>
        <div class="p-8 text-center">
          <p class="text-text-secondary">
            Main content area — click "Open inline drawer" to see the sidebar
          </p>
        </div>
      </div>
    </div>
  );
}

export { DrawerDemo };
