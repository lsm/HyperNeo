/**
 * SyntheticMessageBlock — shared component for rendering synthetic
 * (system-generated) messages: compaction summaries, interrupts, and
 * agent→agent handoffs.
 *
 * Used by both `SDKUserMessage` (in the chat container) and
 * `MinimalThreadFeed`'s synthetic turn (in the task thread). One canonical
 * styling so the same kind of message looks the same everywhere.
 *
 * Design:
 * - Subtle gray panel (`bg-dark-800/60`) with amber chrome
 *   (`border-amber-700/50`) — clearly distinct from the assistant's
 *   `bg-dark-800` reply bubble without flooding the layout in color.
 * - Header: amber arrow icon + "Synthetic" label, plus an optional
 *   FROM→TO route badge when `fromAgent` and `toAgent` are provided
 *   (only the thread feed has agent metadata; the chat container omits it).
 * - Body: markdown-rendered text + JSON-ish previews for non-text blocks.
 *   Collapsed to ~12 lines with a gradient fade and a centered
 *   "Show more" / "Show less" toggle pinned to the bottom of the card.
 * - Actions row below the card via `SpaceTaskThreadMessageActions`:
 *   timestamp + copy + (optional) open-in-session.
 * - Right-aligned (synthetic is always "incoming to this session", same
 *   placement as the human bubble for visual consistency).
 */

import type { ActorMessageDeliveryState } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import MarkdownRenderer from '../chat/MarkdownRenderer.tsx';
import { SpaceTaskThreadMessageActions } from '../space/thread/SpaceTaskThreadMessageActions.tsx';
import { DeliveryStateBadge } from '../ui/DeliveryStateBadge.tsx';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

interface Props {
  /** Content to display - can be a simple string or an array of content blocks. */
  content: string | Array<Record<string, unknown>>;
  /** Optional timestamp in milliseconds. */
  timestamp?: number;
  /** Optional UUID for data attributes. */
  uuid?: string;
  /** Sending agent label — when both `fromAgent` and `toAgent` are
   *  provided, the header renders a FROM→TO route badge. */
  fromAgent?: string;
  /** Receiving agent label — see `fromAgent`. */
  toAgent?: string;
  /** Optional CSS color for the FROM badge text. */
  fromColor?: string;
  /** Optional CSS color for the TO badge text. */
  toColor?: string;
  /** Optional shorter label for the FROM badge (defaults to `fromAgent`). */
  fromShort?: string;
  /** Optional shorter label for the TO badge (defaults to `toAgent`). */
  toShort?: string;
  /** Optional delivery state for synthetic actor messages. */
  deliveryState?: ActorMessageDeliveryState | null;
  /** When provided, an "open in session" icon appears in the actions row. */
  onOpenSession?: () => void;
  /** When provided, a session-info dropdown appears in the actions row,
   *  surfacing the SDK system:init envelope (model, cwd, tools, mcp servers)
   *  for the agent exec this synthetic message triggered. */
  sessionInit?: SystemInitMessage;
  /** When `true`, render string content as plain pre-wrapped text instead
   *  of through `MarkdownRenderer`. Used for fallback bodies that aren't
   *  necessarily markdown. */
  renderAsPlainText?: boolean;
  /** Placeholder shown when `content` is empty (empty string or empty array). */
  emptyMessageLabel?: string;
  /** Optional width classes for the right-aligned card wrapper. */
  widthClass?: string;
  /** Whether to render this block's built-in timestamp/copy actions and wrappers. */
  showActions?: boolean;
}

// Default visible height before "Show more". Matches the per-line height
// of `text-sm` prose with `leading-relaxed` (~24px), capped at 12 lines.
const PREVIEW_LINE_COUNT = 12;
const LINE_HEIGHT_PX = 24;

/** Returns true when `content` carries no text/blocks worth showing. */
function isEmpty(content: string | Array<Record<string, unknown>>): boolean {
  if (typeof content === 'string') return content.length === 0;
  return content.length === 0;
}

/** Flattens content blocks into a single string for the copy button. */
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
  sessionInit,
  renderAsPlainText = false,
  emptyMessageLabel = '(empty message)',
  widthClass = 'max-w-[85%] md:max-w-[70%]',
  showActions = true,
}: Props) {
  // Normalize content to array of blocks for the renderer below.
  const contentBlocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;

  const [isExpanded, setIsExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const previewMaxHeight = PREVIEW_LINE_COUNT * LINE_HEIGHT_PX;

  // Initial measurement + retry after 100ms so async-rendered markdown
  // settles before we decide whether the body needs the "Show more" toggle.
  useLayoutEffect(() => {
    const measure = () => {
      if (!contentRef.current) return;
      setNeedsCollapse(contentRef.current.scrollHeight > previewMaxHeight);
    };
    measure();
    const handle = window.setTimeout(measure, 100);
    return () => window.clearTimeout(handle);
  }, [content, previewMaxHeight]);

  // Re-measure when the body resizes (handles late markdown renders).
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
      class="border border-amber-700/50 rounded-lg overflow-hidden bg-dark-800/60"
      data-testid="synthetic-card"
      data-message-role="synthetic"
      data-message-uuid={uuid}
      data-message-timestamp={timestamp || 0}
    >
      {/* Header — arrow icon + Synthetic label + optional FROM→TO route badge. */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-amber-700/50 flex-wrap">
        <svg
          class="w-4 h-4 flex-shrink-0 text-amber-400"
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
        <span class="text-sm font-semibold text-amber-400" data-testid="synthetic-label">
          Synthetic
        </span>
        {showRouteBadge && (
          <>
            <span class="text-gray-600 text-xs" aria-hidden="true">
              ·
            </span>
            <span
              class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-medium px-1.5 py-px rounded bg-dark-800"
              data-testid="synthetic-route-badge"
              aria-label={`From ${fromAgent} agent to ${toAgent} agent`}
            >
              <span style={fromColor ? { color: fromColor } : undefined}>
                {fromShort ?? fromAgent}
              </span>
              <span class="text-gray-600" aria-hidden="true">
                →
              </span>
              <span style={toColor ? { color: toColor } : undefined}>{toShort ?? toAgent}</span>
            </span>
          </>
        )}
        <DeliveryStateBadge state={deliveryState} test-id="synthetic-delivery-state" />
      </div>

      {/* Body — capped preview + gradient fade + show more / less. */}
      <div class="relative">
        <div
          class={`px-3 py-2${!isExpanded && needsCollapse ? ' overflow-hidden' : ''}`}
          style={!isExpanded && needsCollapse ? { maxHeight: `${previewMaxHeight}px` } : undefined}
        >
          <div ref={contentRef} class="space-y-2" data-testid="synthetic-body">
            {empty ? (
              <p class="text-xs text-gray-500 italic">{emptyMessageLabel}</p>
            ) : renderAsPlainText && typeof content === 'string' ? (
              <p class="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap break-words">
                {content}
              </p>
            ) : (
              contentBlocks.map((block, idx) => (
                <div key={idx} class="text-sm">
                  {block.type === 'text' && (
                    <MarkdownRenderer
                      content={block.text as string}
                      class="text-sm leading-relaxed text-gray-200 [&_h1]:!text-amber-400 [&_h2]:!text-amber-400 [&_h3]:!text-amber-400 [&_h4]:!text-amber-400 [&_h5]:!text-amber-400 [&_h6]:!text-amber-400"
                    />
                  )}
                  {block.type === 'image' && (
                    <div class="space-y-1">
                      <div class="text-xs text-amber-400">Image:</div>
                      <div class="font-mono text-xs text-gray-300 bg-gray-800/50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(block, null, 2)}
                      </div>
                    </div>
                  )}
                  {block.type === 'tool_use' && (
                    <div class="space-y-1">
                      <div class="text-xs text-amber-400">Tool Use: {block.name as string}</div>
                      <div class="font-mono text-xs text-gray-300 bg-gray-800/50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(block.input, null, 2)}
                      </div>
                    </div>
                  )}
                  {block.type === 'tool_result' && (
                    <div class="space-y-1">
                      <div class="text-xs text-amber-400">
                        Tool Result: {(block.tool_use_id as string).slice(0, 12)}
                        ...
                      </div>
                      <div class="font-mono text-xs text-gray-300 bg-gray-800/50 p-2 rounded max-h-48 overflow-auto">
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
                      <div class="text-xs text-amber-400">{block.type as string}:</div>
                      <div class="font-mono text-xs text-gray-300 bg-gray-800/50 p-2 rounded overflow-x-auto">
                        {JSON.stringify(block, null, 2)}
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Gradient fade hint — only when collapsed. Matches the
						    card's tinted backdrop so the fade composites cleanly
						    against the body bg. */}
        {needsCollapse && !isExpanded && (
          <div
            class="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-dark-800/60 to-transparent pointer-events-none"
            aria-hidden="true"
          />
        )}

        {/* Show more / Show less toggle — pinned to the bottom edge of the card. */}
        {needsCollapse && (
          <div class="flex justify-center py-2 border-t border-amber-700/50 bg-dark-800/60">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              class="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors hover:bg-amber-900/30 text-amber-300"
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

        {/* Action row — timestamp + (optional) session-init + copy
					    + (optional) open-in-session. */}
        <SpaceTaskThreadMessageActions
          timestamp={timestamp ?? Date.now()}
          copyText={copyText}
          align="right"
          onOpenSession={onOpenSession}
          sessionInit={sessionInit}
        />
      </div>
    </div>
  );
}
