import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import { SpaceTaskThreadMessageActions } from '../space/thread/SpaceTaskThreadMessageActions.tsx';
import { DeliveryStateBadge, type DeliveryBadgeState } from '../ui/DeliveryStateBadge.tsx';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

interface Props {
  content: string | Array<Record<string, unknown>>;
  timestamp?: number;
  uuid?: string;
  fromAgent?: string;
  toAgent?: string;
  fromColor?: string;
  toColor?: string;
  fromShort?: string;
  toShort?: string;
  deliveryState?: DeliveryBadgeState | null;
  onOpenSession?: () => void;
  openSessionTitle?: string;
  sessionInit?: SystemInitMessage;
  renderAsPlainText?: boolean;
  emptyMessageLabel?: string;
  widthClass?: string;
  showActions?: boolean;
}

const PREVIEW_LINE_COUNT = 12;
const LINE_HEIGHT_PX = 24;

function isEmpty(content: string | Array<Record<string, unknown>>): boolean {
  if (typeof content === 'string') return content.length === 0;
  return content.length === 0;
}

function extractCopyText(content: string | Array<Record<string, unknown>>): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? (block.text as string) : ''))
    .filter(Boolean)
    .join('\n');
}

export function SyntheticMessageBlock({
  content,
  timestamp,
  uuid,
  fromAgent,
  toAgent,
  fromColor,
  toColor,
  fromShort,
  toShort,
  deliveryState,
  onOpenSession,
  openSessionTitle,
  sessionInit,
  renderAsPlainText = false,
  emptyMessageLabel = '(empty message)',
  widthClass = 'max-w-[85%] md:max-w-[70%]',
  showActions = true,
}: Props) {
  const contentBlocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;

  const [isExpanded, setIsExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const previewMaxHeight = PREVIEW_LINE_COUNT * LINE_HEIGHT_PX;

  useLayoutEffect(() => {
    const measure = () => {
      if (!contentRef.current) return;
      setNeedsCollapse(contentRef.current.scrollHeight > previewMaxHeight);
    };
    measure();
    const handle = window.setTimeout(measure, 100);
    return () => window.clearTimeout(handle);
  }, [content, previewMaxHeight]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setNeedsCollapse(el.scrollHeight > previewMaxHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [previewMaxHeight]);

  const showRouteBadge = Boolean(fromAgent && toAgent);
  const empty = isEmpty(content);
  const copyText = extractCopyText(content);

  const card = (
    <div
      class="border border-warning/50 rounded-lg overflow-hidden bg-surface-raised/60"
      data-testid="synthetic-card"
    >
      <div class="flex items-center gap-2 px-3 py-2 border-b border-warning/50 flex-wrap">
        <svg
          class="w-4 h-4 flex-shrink-0 text-warning"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
          data-testid="synthetic-icon"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
          />
        </svg>
        <span class="text-sm font-semibold text-warning" data-testid="synthetic-label">
          Synthetic
        </span>
        {showRouteBadge && (
          <>
            <span class="text-fg-faint text-xs" aria-hidden="true">
              ·
            </span>
            <span
              class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-medium px-1.5 py-px rounded bg-surface-raised"
              data-testid="synthetic-route-badge"
              aria-label={`From ${fromAgent} agent to ${toAgent} agent`}
            >
              <span style={fromColor ? { color: fromColor } : undefined}>
                {fromShort ?? fromAgent}
              </span>
              <span class="text-fg-faint" aria-hidden="true">
                →
              </span>
              <span style={toColor ? { color: toColor } : undefined}>{toShort ?? toAgent}</span>
            </span>
          </>
        )}
        <DeliveryStateBadge state={deliveryState} test-id="synthetic-delivery-state" />
      </div>

      <div class="relative">
        <div
          class={`px-3 py-2${!isExpanded && needsCollapse ? ' overflow-hidden' : ''}`}
          style={!isExpanded && needsCollapse ? { maxHeight: `${previewMaxHeight}px` } : undefined}
        >
          <div ref={contentRef} class="space-y-2" data-testid="synthetic-body">
            {empty ? (
              <p class="text-xs text-fg-faint italic">{emptyMessageLabel}</p>
            ) : renderAsPlainText && typeof content === 'string' ? (
              <p class="text-sm text-fg-soft leading-relaxed whitespace-pre-wrap break-words">
                {content}
              </p>
            ) : (
              contentBlocks.map((block, idx) => (
                <div key={idx} class="text-sm">
                  {block.type === 'text' && (
                    <MarkdownRenderer
                      content={block.text as string}
                      class="text-sm leading-relaxed text-fg-soft [&_h1]:!text-warning-soft [&_h2]:!text-warning-soft [&_h3]:!text-warning-soft [&_h4]:!text-warning-soft [&_h5]:!text-warning-soft [&_h6]:!text-warning-soft"
                    />
                  )}
                  {block.type === 'image' && (
                    <div class="space-y-1">
                      <div class="text-xs text-warning">Image:</div>
                      <div class="font-mono text-xs text-fg-soft bg-surface-raised/50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(block, null, 2)}
                      </div>
                    </div>
                  )}
                  {block.type === 'tool_use' && (
                    <div class="space-y-1">
                      <div class="text-xs text-warning">Tool Use: {block.name as string}</div>
                      <div class="font-mono text-xs text-fg-soft bg-surface-raised/50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(block.input, null, 2)}
                      </div>
                    </div>
                  )}
                  {block.type === 'tool_result' && (
                    <div class="space-y-1">
                      <div class="text-xs text-warning">
                        Tool Result: {(block.tool_use_id as string).slice(0, 12)}
                        ...
                      </div>
                      <div class="font-mono text-xs text-fg-soft bg-surface-raised/50 p-2 rounded max-h-48 overflow-auto">
                        {block.content !== undefined && block.content !== null
                          ? typeof block.content === 'string'
                            ? block.content
                            : JSON.stringify(block.content, null, 2)
                          : '(empty)'}
                      </div>
                    </div>
                  )}
                  {!['text', 'image', 'tool_use', 'tool_result'].includes(block.type as string) && (
                    <div class="space-y-1">
                      <div class="text-xs text-warning">{block.type as string}:</div>
                      <div class="font-mono text-xs text-fg-soft bg-surface-raised/50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(block, null, 2)}
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {needsCollapse && !isExpanded && (
          <div
            class="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-dark-800/60 to-transparent pointer-events-none"
            aria-hidden="true"
          />
        )}

        {needsCollapse && (
          <div class="flex justify-center py-2 border-t border-warning/50 bg-surface-raised/60">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors hover:bg-warning/30 text-warning"
              data-testid="synthetic-toggle"
            >
              {isExpanded ? (
                <>
                  <svg
                    class="w-3.5 h-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
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
                  <svg
                    class="w-3.5 h-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
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
    </div>
  );

  if (!showActions) {
    return card;
  }

  return (
    <div
      class="flex justify-end"
      data-testid="synthetic-message"
      data-message-role="synthetic"
      data-message-uuid={uuid}
      data-message-timestamp={timestamp || 0}
    >
      <div class={`${widthClass} w-auto`}>
        {card}

        <SpaceTaskThreadMessageActions
          timestamp={timestamp ?? Date.now()}
          copyText={copyText}
          align="right"
          onOpenSession={onOpenSession}
          openSessionTitle={openSessionTitle}
          sessionInit={sessionInit}
        />
      </div>
    </div>
  );
}
