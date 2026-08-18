import { useEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { borderColors } from '../../lib/design-tokens.ts';

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
        `absolute z-50 bg-dark-800 border ${borderColors.ui.default} rounded-lg shadow-xl`,
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
      <div class={`px-3 py-2 border-b ${borderColors.ui.default} bg-dark-850/50`}>
        <div class="flex items-center gap-2">
          <span class="text-blue-400 font-mono text-sm font-semibold">@</span>
          <span class="text-xs font-medium text-gray-400">Mention Agent</span>
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
              'hover:bg-dark-700/50 active:bg-dark-700/70',
              index === selectedIndex && 'bg-blue-500/20 border-l-2 border-blue-500'
            )}
          >
            <span class="text-blue-400 font-mono text-sm">@{agent.name}</span>
          </button>
        ))}
      </div>

      <div class={`px-3 py-2 border-t ${borderColors.ui.default} bg-dark-850/50`}>
        {isMobile ? (
          <p class="text-xs text-gray-400">Tap to select</p>
        ) : (
          <p class="text-xs text-gray-400">
            <kbd class="px-1.5 py-0.5 bg-dark-700 rounded text-gray-400">↑↓</kbd> navigate{' '}
            <kbd class="px-1.5 py-0.5 bg-dark-700 rounded text-gray-400">Enter</kbd> select{' '}
            <kbd class="px-1.5 py-0.5 bg-dark-700 rounded text-gray-400">Esc</kbd> close
          </p>
        )}
      </div>
    </div>
  );
}
