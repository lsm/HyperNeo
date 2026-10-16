import { ChevronDownGlyph } from './icons/common-glyphs.tsx';
export interface ScrollToBottomButtonProps {
  onClick: () => void;
  bottomClass?: string;
}

export function ScrollToBottomButton({
  onClick,
  bottomClass = 'bottom-36',
}: ScrollToBottomButtonProps) {
  return (
    <div
      class={`absolute ${bottomClass} left-1/2 -translate-x-1/2 z-20`}
      data-bottom-class={bottomClass}
    >
      <div class="relative w-10 h-10 animate-slideIn">
        <button
          onClick={onClick}
          class={`relative w-10 h-10 rounded-full bg-surface-raised hover:bg-fill-strong text-fg-soft hover:text-fg shadow-lg border border-line-strong flex items-center justify-center transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
        >
          <ChevronDownGlyph
            class="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
            pathProps={{ 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }}
          />
        </button>
      </div>
    </div>
  );
}
