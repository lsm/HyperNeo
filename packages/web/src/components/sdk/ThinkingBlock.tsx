import { useState, useRef, useLayoutEffect } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';

interface ThinkingBlockProps {
  content: string;
  className?: string;
  compact?: boolean;
  isRunning?: boolean;
  estimatedTokens?: number;
}

const PREVIEW_LINE_COUNT = 6;
const LINE_HEIGHT_PX = 20;

const colors = {
  bg: 'bg-warning/10',
  text: 'text-warning-soft',
  border: 'border-warning/40',
  iconColor: 'text-warning',
  lightText: 'text-warning',
};

export function ThinkingBlock({
  content,
  className,
  compact = false,
  isRunning = false,
  estimatedTokens,
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);

  const previewMaxHeight = PREVIEW_LINE_COUNT * LINE_HEIGHT_PX;

  if (typeof content !== 'string' || content.trim().length === 0) {
    return null;
  }

  useLayoutEffect(() => {
    if (contentRef.current) {
      const scrollHeight = contentRef.current.scrollHeight;
      setNeedsTruncation(scrollHeight > previewMaxHeight);
    }
  }, [content, previewMaxHeight]);

  const charCount = content.length;

  const statsText =
    estimatedTokens !== undefined
      ? `• ~${estimatedTokens.toLocaleString()} token${estimatedTokens !== 1 ? 's' : ''}${charCount > 0 ? ` • ${charCount.toLocaleString()} character${charCount !== 1 ? 's' : ''}` : ''}`
      : `• ${charCount.toLocaleString()} character${charCount !== 1 ? 's' : ''}`;

  const inner = (
    <div
      class={cn(
        'border rounded-lg overflow-hidden',
        isRunning && 'relative',
        colors.bg,
        colors.border,
        className
      )}
      data-testid="thinking-block"
    >
      <div class={cn('flex items-center gap-2 px-3 py-2', colors.bg)}>
        <svg
          class={cn('w-4 h-4 flex-shrink-0', colors.iconColor)}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>
        <span class={cn('text-sm font-semibold', colors.text)}>Thinking</span>
        <span class={cn('text-xs', colors.lightText)}>{statsText}</span>
      </div>

      <div class={cn('relative border-t', colors.border)}>
        <div
          class={cn(
            'p-3 bg-surface',
            !compact && !isExpanded && needsTruncation && 'overflow-hidden'
          )}
          style={
            !compact && !isExpanded && needsTruncation
              ? { maxHeight: `${previewMaxHeight + 24}px` }
              : {}
          }
        >
          <pre
            ref={contentRef}
            class={cn(
              'text-sm font-mono',
              colors.text,
              compact ? 'whitespace-normal break-words line-clamp-1' : 'whitespace-pre-wrap'
            )}
          >
            {content}
          </pre>
        </div>

        {!compact && needsTruncation && !isExpanded && (
          <div
            class="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white dark:from-gray-900 to-transparent pointer-events-none"
            aria-hidden="true"
          />
        )}

        {!compact && needsTruncation && (
          <div class={cn('flex justify-center py-2 border-t bg-surface', colors.border)}>
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              class={cn(
                'flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors',
                'hover:bg-warning/15 dark:hover:bg-amber-900/40',
                colors.text
              )}
            >
              {isExpanded ? (
                <>
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 15l7-7 7 7"
                    />
                  </svg>
                  Show less
                </>
              ) : (
                <>
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                  Show more
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {isRunning && <div class="running-shimmer" aria-hidden="true" />}
    </div>
  );

  return inner;
}
