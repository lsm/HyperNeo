import { useState } from 'preact/hooks';
import {
  CloseButton,
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
  Transition,
} from '../../src/mod.ts';

export function DialogDemo() {
  const [simpleOpen, setSimpleOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmResult, setConfirmResult] = useState<string | null>(null);

  function handleConfirm() {
    setConfirmResult('confirmed');
    setConfirmOpen(false);
  }

  function handleCancel() {
    setConfirmResult('cancelled');
    setConfirmOpen(false);
  }

  return (
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Simple Dialog</h3>
        <button
          type="button"
          onClick={() => setSimpleOpen(true)}
          class="bg-accent-500 hover:bg-accent-600 text-white px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer"
        >
          Open dialog
        </button>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Confirm-style Dialog</h3>
        <div class="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            class="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors cursor-pointer"
          >
            Delete item
          </button>
          {confirmResult && (
            <span
              class={`text-sm ${confirmResult === 'confirmed' ? 'text-red-400' : 'text-text-tertiary'}`}
            >
              Action: <strong>{confirmResult}</strong>
            </span>
          )}
        </div>
      </div>

      <Dialog open={simpleOpen} onClose={setSimpleOpen} class="relative z-50">
        <Transition
          show={simpleOpen}
          class="fixed inset-0 flex items-center justify-center p-4"
          style="transition: opacity 200ms ease; opacity: 1;"
          data-closed="style: opacity: 0;"
        >
          <DialogBackdrop class="fixed inset-0 bg-black/60 backdrop-blur-sm" />

          <DialogPanel class="relative z-10 w-full max-w-md rounded-xl bg-surface-2 border border-surface-border shadow-2xl p-6">
            <div class="flex items-center justify-between mb-4">
              <DialogTitle class="text-lg font-semibold text-text-primary">
                Welcome to the demo
              </DialogTitle>
              <CloseButton class="rounded-lg p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface-3 transition-colors cursor-pointer">
                <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </CloseButton>
            </div>

            <DialogDescription class="text-sm text-text-secondary mb-6">
              This is a simple dialog showcasing{' '}
              <code class="bg-surface-3 px-1 py-0.5 rounded text-accent-400">DialogBackdrop</code>,{' '}
              <code class="bg-surface-3 px-1 py-0.5 rounded text-accent-400">DialogPanel</code>,{' '}
              <code class="bg-surface-3 px-1 py-0.5 rounded text-accent-400">DialogTitle</code>, and{' '}
              <code class="bg-surface-3 px-1 py-0.5 rounded text-accent-400">CloseButton</code>.
              Press Escape or click outside to close.
            </DialogDescription>

            <div class="flex justify-end">
              <CloseButton class="bg-accent-500 hover:bg-accent-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer">
                Got it
              </CloseButton>
            </div>
          </DialogPanel>
        </Transition>
      </Dialog>

      <Dialog open={confirmOpen} onClose={setConfirmOpen} role="alertdialog" class="relative z-50">
        <Transition show={confirmOpen} class="fixed inset-0 flex items-center justify-center p-4">
          <DialogBackdrop class="fixed inset-0 bg-black/70" />

          <DialogPanel class="relative z-10 w-full max-w-sm rounded-xl bg-surface-2 border border-surface-border shadow-2xl p-6">
            <div class="flex items-start gap-4 mb-4">
              <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/10">
                <svg class="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fill-rule="evenodd"
                    d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                    clip-rule="evenodd"
                  />
                </svg>
              </span>
              <div>
                <DialogTitle class="text-base font-semibold text-text-primary">
                  Delete item?
                </DialogTitle>
                <DialogDescription class="mt-1 text-sm text-text-secondary">
                  This action cannot be undone. The item will be permanently removed from your
                  account.
                </DialogDescription>
              </div>
            </div>

            <div class="flex justify-end gap-3 mt-6">
              <button
                type="button"
                onClick={handleCancel}
                class="px-4 py-2 rounded-lg text-sm font-medium border border-surface-border text-text-primary hover:bg-surface-3 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                class="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors cursor-pointer"
              >
                Delete
              </button>
            </div>
          </DialogPanel>
        </Transition>
      </Dialog>
    </div>
  );
}
