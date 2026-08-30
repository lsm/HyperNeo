import { useEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../lib/utils.ts';
import type { ReferenceSearchResult, ReferenceType } from '@hyperneo/shared';
import ReferenceTypeIcon from './ReferenceTypeIcon.tsx';

export interface ReferenceAutocompleteProps {
  results: ReferenceSearchResult[];
  selectedIndex: number;
  onSelect: (result: ReferenceSearchResult) => void;
  onClose: () => void;
  position?: { top: number; left: number };
}

const TYPE_ORDER: ReferenceType[] = ['task', 'goal', 'file', 'folder'];

const TYPE_LABELS: Record<ReferenceType, string> = {
  task: 'Tasks',
  goal: 'Goals',
  file: 'Files',
  folder: 'Folders',
};

const TYPE_ICON_CLASS: Record<ReferenceType, string> = {
  task: 'w-3.5 h-3.5 text-cat-indigo',
  goal: 'w-3.5 h-3.5 text-warning',
  file: 'w-3.5 h-3.5 text-accent',
  folder: 'w-3.5 h-3.5 text-warning',
};

function TypeIcon({ type }: { type: ReferenceType }) {
  return <ReferenceTypeIcon type={type} className={TYPE_ICON_CLASS[type]} />;
}

function resolveHeaderLabel(results: ReferenceSearchResult[]): string {
  const types = new Set(results.map((r) => r.type));
  const hasTaskOrGoal = types.has('task') || types.has('goal');
  if (!hasTaskOrGoal) return 'Files & Folders';
  return 'References';
}

export default function ReferenceAutocomplete({
  results,
  selectedIndex,
  onSelect,
  onClose,
  position,
}: ReferenceAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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

  if (results.length === 0) return null;

  const groups: Array<{
    type: ReferenceType;
    items: Array<{ result: ReferenceSearchResult; globalIndex: number }>;
  }> = [];
  const indexMap = new Map<ReferenceSearchResult, number>(results.map((r, i) => [r, i]));

  for (const type of TYPE_ORDER) {
    const items = results
      .filter((r) => r.type === type)
      .map((r) => ({ result: r, globalIndex: indexMap.get(r) ?? 0 }));
    if (items.length > 0) {
      groups.push({ type, items });
    }
  }

  const headerLabel = resolveHeaderLabel(results);

  return (
    <div
      ref={containerRef}
      data-testid="reference-autocomplete"
      role="listbox"
      aria-label={headerLabel}
      class={cn(
        'absolute z-50 bg-surface-raised border border-line rounded-lg shadow-xl',
        'overflow-hidden max-h-72 overflow-y-auto',
        'animate-slideIn'
      )}
      style={{
        bottom: position ? undefined : '100%',
        left: position?.left ?? 0,
        top: position?.top,
        marginBottom: position ? undefined : '8px',
        width: isMobile ? '100%' : undefined,
        minWidth: isMobile ? undefined : '280px',
        maxWidth: isMobile ? undefined : '420px',
      }}
    >
      <div class="px-3 py-2 border-b border-line bg-surface-overlay/50">
        <div class="flex items-center gap-2">
          <svg class="w-4 h-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
            />
          </svg>
          <span class="text-xs font-medium text-fg-muted">{headerLabel}</span>
        </div>
      </div>

      <div class="py-1">
        {groups.map(({ type, items }) => (
          <div key={type}>
            <div class="px-3 pt-2 pb-1">
              <span class="text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                {TYPE_LABELS[type]}
              </span>
            </div>

            {items.map(({ result, globalIndex }) => (
              <button
                key={`${result.type}:${result.id}`}
                ref={globalIndex === selectedIndex ? selectedItemRef : null}
                type="button"
                role="option"
                aria-selected={globalIndex === selectedIndex}
                data-result-type={result.type}
                onClick={() => onSelect(result)}
                class={cn(
                  'w-full px-3 text-left transition-colors flex items-start gap-2',
                  isMobile ? 'py-3' : 'py-2',
                  'hover:bg-fill-strong/50 active:bg-fill-strong/70',
                  globalIndex === selectedIndex && 'bg-accent/20 border-l-2 border-accent'
                )}
              >
                <span class="mt-0.5">
                  <TypeIcon type={result.type} />
                </span>
                <span class="flex flex-col min-w-0">
                  <span class="text-sm text-fg truncate">{result.displayText}</span>
                  {result.subtitle && (
                    <span class="text-xs text-fg-faint truncate">{result.subtitle}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
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
