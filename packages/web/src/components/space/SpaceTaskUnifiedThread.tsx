import { useEffect, useMemo, useRef } from 'preact/hooks';
import { useAutoScroll } from '../../hooks/useAutoScroll';
import { useSpaceTaskMessages } from '../../hooks/useSpaceTaskMessages';
import { MinimalThreadFeed } from './thread/minimal/MinimalThreadFeed';
import { parseThreadRow } from './thread/space-task-thread-events';

interface SpaceTaskUnifiedThreadProps {
  taskId: string;
  bottomInsetClass?: string;
  bottomScrollPaddingClass?: string;
  bottomInsetPx?: number;
  /**
   * Top padding applied to the scroll container so the first message clears
   * any floating overlay (e.g. SpaceTaskPane's tab pill) at scroll-top. Older
   * messages still scroll under the overlay's frosted-glass background; only
   * the resting position is adjusted.
   */
  topInsetClass?: string;
  /**
   * Labels of agents whose underlying sessions are currently active. Forwarded
   * to `MinimalThreadFeed` so the trailing non-terminal block of each
   * still-running agent renders its own active rail. Per-agent (rather than a
   * single boolean) so a Reviewer terminal `result` row landing after Coder's
   * last row can't suppress Coder's still-running rail.
   */
  activeAgentLabels?: ReadonlySet<string>;
  /** Task id forwarded to overlay open affordances for node-agent send routing. */
  overlayTaskId?: string;
  autoScrollEnabled?: boolean;
  onShowScrollButtonChange?: (showScrollButton: boolean) => void;
  onScrollToBottomChange?: (scrollToBottom: ((smooth?: boolean) => void) | null) => void;
  onScrollerChange?: (scroller: HTMLDivElement | null) => void;
}

export function SpaceTaskUnifiedThread({
  taskId,
  bottomInsetClass = 'pb-3',
  bottomScrollPaddingClass = 'scroll-pb-3',
  bottomInsetPx,
  topInsetClass = '',
  activeAgentLabels,
  overlayTaskId,
  autoScrollEnabled = true,
  onShowScrollButtonChange,
  onScrollToBottomChange,
  onScrollerChange,
}: SpaceTaskUnifiedThreadProps) {
  const { rows, activeTurnSummaries, isLoading, isReconnecting } = useSpaceTaskMessages(
    taskId,
    'compact'
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const parsedRows = useMemo(() => rows.map(parseThreadRow), [rows]);
  const { showScrollButton, scrollToBottom } = useAutoScroll({
    containerRef,
    endRef: messagesEndRef,
    enabled: autoScrollEnabled,
    messageCount: rows.length,
  });

  useEffect(() => {
    onShowScrollButtonChange?.(showScrollButton);
  }, [onShowScrollButtonChange, showScrollButton]);

  useEffect(() => {
    onScrollToBottomChange?.(scrollToBottom);
    return () => onScrollToBottomChange?.(null);
  }, [onScrollToBottomChange, scrollToBottom]);

  useEffect(() => {
    onScrollerChange?.(containerRef.current);
    return () => onScrollerChange?.(null);
  }, [onScrollerChange, parsedRows.length, isLoading, isReconnecting]);

  if (isReconnecting) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center text-sm text-gray-400">
          Reconnecting task thread…
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center text-sm text-gray-400">
          Loading task thread…
        </div>
      </div>
    );
  }

  if (parsedRows.length === 0) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center px-6 text-center">
          <p class="text-sm text-gray-400">No task-agent activity yet.</p>
        </div>
      </div>
    );
  }

  const dynamicBottomInsetStyle =
    bottomInsetPx === undefined
      ? undefined
      : {
          paddingBottom: `${bottomInsetPx}px`,
          scrollPaddingBottom: `${bottomInsetPx}px`,
        };
  const bottomInsetClasses =
    bottomInsetPx === undefined ? `${bottomInsetClass} ${bottomScrollPaddingClass}` : '';

  return (
    <div class="h-full min-h-0 flex flex-col relative" data-testid="space-task-unified-thread">
      <div
        ref={containerRef}
        class={`flex-1 overflow-y-auto ${topInsetClass} ${bottomInsetClasses}`}
        style={dynamicBottomInsetStyle}
      >
        <div class="min-h-[calc(100%+1px)]">
          <MinimalThreadFeed
            parsedRows={parsedRows}
            activeAgentLabels={activeAgentLabels}
            activeTurnSummaries={activeTurnSummaries}
            overlayTaskId={overlayTaskId}
          />
          <div ref={messagesEndRef} />
        </div>
      </div>
    </div>
  );
}
