import { useEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';

export interface CommandAutocompleteProps {
  commands: string[];
  selectedIndex: number;
  onSelect: (command: string) => void;
  onClose: () => void;
  position?: { top: number; left: number };
}

export default function CommandAutocomplete({
  commands,
  selectedIndex,
  onSelect,
  onClose,
  position,
}: CommandAutocompleteProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setIsMobile(window.matchMedia('(pointer: coarse)').matches);
  }, []);

  useEffect(() => {
    if (selectedItemRef.current) {
      selectedItemRef.current.scrollIntoView({
        block: 'nearest',
        behavior: isMobile ? 'auto' : 'smooth',
      });
    }
  }, [selectedIndex, isMobile]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchend', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchend', handleOutside);
    };
  }, [onClose]);

  if (commands.length === 0) {
    return null;
  }

  return (
    <div
      ref={listRef}
      class={cn(
        'absolute z-50 bg-surface-raised border border-line rounded-lg shadow-xl',
        'overflow-hidden max-h-64 overflow-y-auto',
        'animate-slideIn'
      )}
      style={{
        bottom: position ? undefined : '100%',
        left: position?.left ?? 0,
        top: position?.top,
        marginBottom: position ? undefined : '8px',
        width: isMobile ? '100%' : undefined,
        minWidth: isMobile ? undefined : '250px',
        maxWidth: isMobile ? undefined : '400px',
      }}
    >
      <div class="px-3 py-2 border-b border-line bg-surface-overlay/50">
        <div class="flex items-center gap-2">
          <svg class="w-4 h-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <span class="text-xs font-medium text-fg-muted">Slash Commands</span>
        </div>
      </div>

      <div class="py-1">
        {commands.map((command, index) => (
          <button
            key={command}
            ref={index === selectedIndex ? selectedItemRef : null}
            type="button"
            onClick={() => onSelect(command)}
            class={cn(
              'w-full px-3 text-left transition-colors flex items-center gap-2',
              isMobile ? 'py-3' : 'py-2',
              'hover:bg-fill-strong/50 active:bg-fill-strong/70',
              index === selectedIndex && 'bg-accent/20 border-l-2 border-accent'
            )}
          >
            <span class="text-accent font-mono text-sm">{command}</span>
          </button>
        ))}
      </div>

      <div class="px-3 py-2 border-t border-line bg-surface-overlay/50">
        {isMobile ? (
          <p class="text-xs text-fg-faint">Tap to select</p>
        ) : (
          <p class="text-xs text-fg-faint">
            <kbd class="px-1.5 py-0.5 bg-fill-strong rounded text-fg-muted">↑↓</kbd> navigate{' '}
            <kbd class="px-1.5 py-0.5 bg-fill-strong rounded text-fg-muted">Enter</kbd> select{' '}
            <kbd class="px-1.5 py-0.5 bg-fill-strong rounded text-fg-muted">Esc</kbd> close
          </p>
        )}
      </div>
    </div>
  );
}
