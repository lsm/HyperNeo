import { contextPanelOpenSignal } from '../../lib/signals.ts';
import { borderColors } from '../../lib/design-tokens.ts';

export function MobileMenuButton() {
  return (
    <button
      onClick={() => (contextPanelOpenSignal.value = true)}
      class={`md:hidden p-2 bg-dark-850 border ${borderColors.ui.default} rounded-lg hover:bg-dark-800 transition-colors text-gray-400 hover:text-gray-100 flex-shrink-0`}
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
