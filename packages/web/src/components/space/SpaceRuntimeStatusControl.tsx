/**
 * SpaceRuntimeStatusControl — compact runtime status + kebab menu for the
 * Overview header.
 *
 * Replaces the full-width RuntimeControlBar. Pause/Stop/Resume/Start are rare
 * (roughly once a quarter), so they live behind a kebab; a small pill shows the
 * live runtime state (Running/Paused/Stopped) and stays out of the way in the
 * header's action row. Self-contained: reads `spaceStore.runtimeState` and calls
 * the runtime mutators directly, owning its own loading + Stop-confirmation UX.
 */
import type { RuntimeState } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { ConfirmModal } from '../ui/ConfirmModal';
import { FLAT_SURFACE } from './glass-workspace';

const RUNTIME_STYLE: Record<RuntimeState, { dot: string; label: string; tone: string }> = {
  running: { dot: 'bg-emerald-400', label: 'Running', tone: 'text-emerald-200' },
  paused: { dot: 'bg-amber-400', label: 'Paused', tone: 'text-amber-200' },
  stopped: { dot: 'bg-gray-500', label: 'Stopped', tone: 'text-gray-300' },
};

export function SpaceRuntimeStatusControl() {
  const runtimeState = spaceStore.runtimeState.value;
  const [isOpen, setIsOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside click while open.
  useEffect(() => {
    if (!isOpen) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [isOpen]);

  // Nothing to show until the daemon reports a runtime state.
  if (!runtimeState) return null;
  const style = RUNTIME_STYLE[runtimeState];

  const run = async (fn: () => Promise<unknown>) => {
    if (actionLoading) return;
    setActionLoading(true);
    try {
      await fn();
    } finally {
      setActionLoading(false);
      setIsOpen(false);
    }
  };

  const openStopConfirm = () => {
    setIsOpen(false);
    setShowStopConfirm(true);
  };

  const menuItemClass =
    'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-gray-300 transition-colors hover:bg-white/[0.07] hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/55 disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div ref={rootRef} class="relative flex self-end items-center text-sm sm:self-center">
      {/* Status readout — display only (colored dot + label). Reads as status
          metadata, not a button, so it sits quietly in the intro composition. */}
      <span class={`flex items-center gap-2 pr-3 font-medium ${style.tone}`}>
        <span class={`h-2 w-2 rounded-full ${style.dot}`} aria-hidden="true" />
        {style.label}
        {actionLoading && <span class="italic text-gray-400">…</span>}
      </span>
      {/* Rare controls live behind a kebab, set off by the hairline divider. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={`Open runtime controls (space ${style.label.toLowerCase()})`}
        class="border-l border-white/10 px-3 py-1 text-lg leading-none text-gray-400 transition hover:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/55 focus-visible:rounded-md"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {isOpen && (
        <div
          class={`absolute right-0 top-full z-50 mt-2 min-w-[160px] rounded-xl border p-1.5 ${FLAT_SURFACE}`}
          role="menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setIsOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          {runtimeState === 'running' && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={actionLoading}
                onClick={() => void run(() => spaceStore.pauseSpace())}
                class={menuItemClass}
              >
                Pause
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={actionLoading}
                onClick={openStopConfirm}
                class={menuItemClass}
              >
                Stop…
              </button>
            </>
          )}
          {runtimeState === 'paused' && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={actionLoading}
                onClick={() => void run(() => spaceStore.resumeSpace())}
                class={menuItemClass}
              >
                Resume
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={actionLoading}
                onClick={openStopConfirm}
                class={menuItemClass}
              >
                Stop…
              </button>
            </>
          )}
          {runtimeState === 'stopped' && (
            <button
              type="button"
              role="menuitem"
              disabled={actionLoading}
              onClick={() => void run(() => spaceStore.startSpace())}
              class={menuItemClass}
            >
              Start
            </button>
          )}
        </div>
      )}
      <ConfirmModal
        isOpen={showStopConfirm}
        onClose={() => setShowStopConfirm(false)}
        onConfirm={() =>
          void run(async () => {
            await spaceStore.stopSpace();
            setShowStopConfirm(false);
          })
        }
        title="Stop Space"
        message="Stopping will immediately terminate all active sessions and cancel in-progress work. The space will not restart automatically. You can start it again at any time."
        confirmText="Stop Space"
        isLoading={actionLoading}
      />
    </div>
  );
}
