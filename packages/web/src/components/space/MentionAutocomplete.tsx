import { useEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';

export interface MentionAutocompleteProps {
  agents: Array<{ id: string; name: string }>;
  selectedIndex: number;
  onSelect: (name: string) => void;
  onClose: () => void;
}

export default function MentionAutocomplete({
  agents,
  selectedIndex,
  onSelect,
  onClose,
}: MentionAutocompleteProps) {
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

  if (agents.length === 0) {
    return null;
  }

  return (
    <div
      ref={listRef}
      data-testid="mention-autocomplete"
      class={cn(
        `absolute z-50 bg-surface-raised border border-line rounded-lg shadow-xl`,
        'overflow-hidden max-h-64 overflow-y-auto',
        'animate-slideIn'
      )}
      style={{
        bottom: '100%',
        left: 0,
        marginBottom: '8px',
        minWidth: isMobile ? '100%' : '200px',
        maxWidth: isMobile ? '100%' : '320px',
      }}
    >
      <div class={`px-3 py-2 border-b border-line bg-surface-overlay/50`}>
        <div class="flex items-center gap-2">
          <span class="text-accent font-mono text-sm font-semibold">@</span>
          <span class="text-xs font-medium text-fg-muted">Mention Agent</span>
        </div>
      </div>

      <div class="py-1">
        {agents.map((agent, index) => (
          <button
            key={agent.id}
            ref={index === selectedIndex ? selectedItemRef : null}
            type="button"
            data-testid="mention-item"
            onClick={() => onSelect(agent.name)}
            class={cn(
              'w-full px-3 text-left transition-colors flex items-center gap-2',
              isMobile ? 'py-3' : 'py-2',
              'hover:bg-fill-strong/50 active:bg-fill-strong/70',
              index === selectedIndex && 'bg-accent/20 border-l-2 border-accent'
            )}
          >
            <span class="text-accent font-mono text-sm">@{agent.name}</span>
          </button>
        ))}
      </div>

      <div class={`px-3 py-2 border-t border-line bg-surface-overlay/50`}>
        {isMobile ? (
          <p class="text-xs text-fg-muted">Tap to select</p>
        ) : (
          <p class="text-xs text-fg-muted">
            <kbd class="px-1.5 py-0.5 bg-fill-strong rounded text-fg-muted">↑↓</kbd> navigate{' '}
            <kbd class="px-1.5 py-0.5 bg-fill-strong rounded text-fg-muted">Enter</kbd> select{' '}
            <kbd class="px-1.5 py-0.5 bg-fill-strong rounded text-fg-muted">Esc</kbd> close
          </p>
        )}
      </div>
    </div>
  );
}
