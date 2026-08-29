import { contextPanelOpenSignal } from '../../lib/signals.ts';

export function MobileMenuButton() {
  return (
    <button
      onClick={() => (contextPanelOpenSignal.value = true)}
      class="md:hidden p-2 bg-surface-overlay border border-line rounded-lg hover:bg-surface-raised transition-colors text-fg-muted hover:text-fg flex-shrink-0"
      title="Open menu"
      aria-label="Open navigation menu"
    >
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width={2}
          d="M4 6h16M4 12h16M4 18h16"
        />
      </svg>
    </button>
  );
}
