/**
 * ScrollToBottomButton Component
 *
 * Floating button that appears when user scrolls up from bottom.
 * Clicking scrolls smoothly to the bottom of the container.
 * Extracted from ChatContainer.tsx for better separation of concerns.
 */

import { borderColors } from '../lib/design-tokens';

export interface ScrollToBottomButtonProps {
  onClick: () => void;
  /** Tailwind bottom-* class controlling vertical offset. Defaults to 'bottom-36'
   *  (sized for ChatContainer's large floating footer). Pass a smaller value like
   *  'bottom-4' when there is no large footer below the scroll container. */
  bottomClass?: string;
  /** When true, renders a cycling gradient border to indicate auto-scroll is active. */
  autoScroll?: boolean;
}

export function ScrollToBottomButton({
  onClick,
  bottomClass = 'bottom-36',
  autoScroll = false,
}: ScrollToBottomButtonProps) {
  return (
    <div
      class={`absolute ${bottomClass} left-1/2 -translate-x-1/2 z-20`}
      data-bottom-class={bottomClass}
    >
      {/* Spinning gradient ring when auto-scroll is active */}
      <div class="relative w-10 h-10 animate-slideIn">
        {autoScroll && (
          <div
            class="absolute -inset-[2px] rounded-full animate-spin"
            style="background: conic-gradient(from 0deg, #3b82f6, #8b5cf6, #06b6d4, #3b82f6); animation-duration: 2s;"
          />
        )}
        <button
          onClick={onClick}
          class={`relative w-10 h-10 rounded-full bg-dark-800 hover:bg-dark-700 text-gray-300 hover:text-gray-100 shadow-lg border ${autoScroll ? 'border-transparent' : borderColors.ui.secondary} flex items-center justify-center transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
        >
          <svg
            class="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
