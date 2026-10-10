import { useLayoutEffect, useRef } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';

export interface VoiceDraftPreviewProps {
  text: string;
  start: number;
  end: number;
  transcribing: boolean;
  newLine?: boolean;
  hint?: string;
  heightPx?: number;
  class?: string;
}

export function VoiceDraftPreview({
  text,
  start,
  end,
  transcribing,
  newLine = false,
  hint,
  heightPx,
  class: className,
}: VoiceDraftPreviewProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const from = Math.min(Math.max(start, 0), text.length);
  const to = Math.min(Math.max(end, from), text.length);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const marker = markerRef.current;
    if (!box || !marker) return;
    const overflow = marker.offsetTop + marker.offsetHeight - box.clientHeight;
    const line = Number.parseFloat(getComputedStyle(box).lineHeight) || marker.offsetHeight || 1;
    box.scrollTop = overflow > 0 ? Math.ceil(overflow / line) * line : 0;
  }, [text, from, to, transcribing, heightPx]);

  return (
    <div
      ref={boxRef}
      role="textbox"
      tabIndex={0}
      aria-readonly="true"
      aria-label="Draft, read-only while recording"
      data-testid="voice-recording-draft"
      class={cn('relative overflow-y-auto whitespace-pre-wrap break-words', className)}
      style={heightPx ? { height: `${heightPx}px` } : undefined}
    >
      {text.slice(0, from)}
      {to > from && (
        <mark
          data-testid="voice-recording-selection"
          class="rounded-sm bg-warning/40 text-fg line-through decoration-danger decoration-2"
        >
          {text.slice(from, to)}
        </mark>
      )}
      {newLine && transcribing && from > 0 ? '\n' : null}
      {!text && hint && !transcribing && <span class="text-fg-faint">{hint}</span>}
      {transcribing ? (
        <span
          ref={markerRef}
          aria-hidden="true"
          data-testid="voice-transcribing-placeholder"
          class={cn(
            'inline-block h-[0.9em] translate-y-[0.1em] rounded-md bg-fg-muted/40 motion-safe:animate-pulse',
            newLine ? 'w-[45%] max-w-64' : 'mx-1 w-[4em]'
          )}
        />
      ) : (
        <span
          ref={markerRef}
          aria-hidden="true"
          class="inline-block h-[1.1em] w-0.5 translate-y-[0.15em] bg-danger motion-safe:animate-pulse"
        />
      )}
      {text.slice(to)}
    </div>
  );
}
