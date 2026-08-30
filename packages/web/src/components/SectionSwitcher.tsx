import {
  commandPaletteModeSignal,
  commandPaletteOpenSignal,
  navSectionSignal,
} from '../lib/signals.ts';
import { navigateToSessions, navigateToSpaces } from '../lib/router.ts';
import { cn } from '../lib/utils.ts';

interface SectionSwitcherProps {
  onClose?: () => void;
  variant?: 'default' | 'titlebar';
  showDivider?: boolean;
  compact?: boolean;
}

const SECTIONS = [
  { id: 'chats', label: 'Chats', onClick: navigateToSessions },
  { id: 'spaces', label: 'Spaces', onClick: navigateToSpaces },
] as const;

export function SectionSwitcher({
  onClose,
  variant = 'default',
  showDivider = true,
  compact = false,
}: SectionSwitcherProps) {
  const navSection = navSectionSignal.value;
  const isTitlebar = variant === 'titlebar';
  const openQuickOpen = () => {
    commandPaletteModeSignal.value = 'quick-open';
    commandPaletteOpenSignal.value = true;
    onClose?.();
  };

  return (
    <div
      class={cn(
        'flex items-center gap-2',
        isTitlebar
          ? 'min-w-0 flex-1'
          : cn('h-[52px] px-3 md:h-[52px]', showDivider && 'border-b border-line')
      )}
      data-tauri-drag-region={isTitlebar ? true : undefined}
    >
      <div
        class={cn(
          'grid w-[136px] grid-cols-2 flex-none rounded-full bg-surface/70 p-0.5',
          isTitlebar || compact ? 'h-6 bg-bg/70' : 'h-7'
        )}
        role="tablist"
      >
        {SECTIONS.map((section) => {
          const isActive = navSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                section.onClick();
                onClose?.();
              }}
              class={cn(
                'rounded-full font-medium transition-colors',
                'px-2 text-[12px] leading-5',
                isActive ? 'bg-fill text-fg' : 'text-fg-faint hover:bg-fill-soft hover:text-fg-soft'
              )}
            >
              {section.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={openQuickOpen}
        class={cn(
          'ml-auto flex h-8 w-8 flex-none items-center justify-center rounded-full text-fg-muted transition-colors',
          compact && 'h-7 w-7',
          'hover:bg-fill-soft hover:text-fg'
        )}
        title="Quick Open"
        aria-label="Quick Open"
      >
        <svg class="h-[18px] w-[18px]" viewBox="0 0 20 20" fill="none" stroke="currentColor">
          <path
            d="M8.75 3.75a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM12.5 12.5l3.75 3.75"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          class={cn(
            'md:hidden flex p-1.5 rounded-full text-fg-muted transition-colors',
            'hover:bg-fill-soft hover:text-fg'
          )}
          title="Close panel"
          aria-label="Close panel"
        >
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
