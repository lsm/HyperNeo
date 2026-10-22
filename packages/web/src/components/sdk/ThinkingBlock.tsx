import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';
import { ContentDisclosureControl } from '../ui/ContentDisclosureControl.tsx';
import { useFoldedActivity } from './chat-display-mode.ts';

interface ThinkingBlockProps {
  content: string;
  className?: string;
  compact?: boolean;
  isRunning?: boolean;
  estimatedTokens?: number;
  thinnedChars?: number;
  onOpen?: () => void;
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
  thinnedChars = 0,
  onOpen,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);
  const folded = useFoldedActivity();

  const previewMaxHeight = PREVIEW_LINE_COUNT * LINE_HEIGHT_PX;

  useLayoutEffect(() => {
    if (contentRef.current) {
      const scrollHeight = Math.max(
        contentRef.current.scrollHeight,
        contentRef.current.getBoundingClientRect().height
      );
      setNeedsTruncation(scrollHeight > previewMaxHeight);
    }
  }, [content, previewMaxHeight, folded, expanded]);

  const hasText = typeof content === 'string' && content.trim().length > 0;
  if (!hasText && thinnedChars <= 0) {
    return null;
  }

  const charCount = hasText ? content.length : thinnedChars;
  const toggleOpen = () => {
    if (folded && !expanded) onOpen?.();
    setExpanded(!expanded);
  };

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
      <div class="flow-root px-3 py-2">
        <div class={cn('inline-flex items-center gap-2', colors.bg)}>
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

        {(!folded || expanded) && (
          <>
            <div class={cn('my-2 border-t', colors.border)} />
            <div
              class={cn(
                'relative',
                expanded ? 'contents' : 'block bg-surface',
                !compact && !expanded && needsTruncation && 'overflow-hidden'
              )}
              style={
                !compact && !expanded && needsTruncation
                  ? { maxHeight: `${previewMaxHeight}px` }
                  : undefined
              }
            >
              <pre
                ref={contentRef}
                class={cn(
                  expanded ? 'inline' : 'block',
                  'text-sm font-mono',
                  colors.text,
                  compact
                    ? 'whitespace-normal break-words line-clamp-1'
                    : 'whitespace-pre-wrap break-words'
                )}
              >
                {hasText ? content : 'Loading…'}
              </pre>
              {!compact && needsTruncation && !expanded && (
                <div
                  class="absolute bottom-0 inset-x-0 h-12 bg-gradient-to-t from-surface to-transparent pointer-events-none"
                  aria-hidden="true"
                />
              )}
            </div>
          </>
        )}
        {(folded || (!compact && needsTruncation)) && (
          <ContentDisclosureControl
            expanded={expanded}
            onToggle={toggleOpen}
            aria-label="Thinking"
          />
        )}
      </div>

      {isRunning && <div class="running-shimmer" aria-hidden="true" />}
    </div>
  );

  return inner;
}
