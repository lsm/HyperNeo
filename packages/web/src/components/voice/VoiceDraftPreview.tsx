import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { cn } from '../../lib/utils.ts';

export interface VoiceDraftPreviewProps {
  text: string;
  start: number;
  end: number;
  transcribing: boolean;
  interim?: string;
  newLine?: boolean;
  hint?: string;
  heightPx?: number;
  minHeightPx?: number;
  class?: string;
}

const TYPE_STEP_MS = 25;
const CATCH_UP_MS = 600;
const FADE_STEPS = 13;

function useTypewriter(target: string, flush: boolean): [string, number] {
  const [shown, setShown] = useState('');
  const steps = useRef<number[]>([]);
  let kept = shown;
  if (flush) kept = target;
  else if (!target.startsWith(shown)) {
    let same = 0;
    while (same < shown.length && shown[same] === target[same]) same++;
    kept = target.slice(0, same);
  }
  useEffect(() => {
    if (!kept) steps.current = [];
    if (kept.length >= target.length) return;
    const timer = setTimeout(() => {
      const backlog = target.length - kept.length;
      const step = Math.max(1, Math.ceil((backlog * TYPE_STEP_MS) / CATCH_UP_MS));
      steps.current = [...steps.current, kept.length].slice(-FADE_STEPS);
      setShown(target.slice(0, kept.length + step));
    }, TYPE_STEP_MS);
    return () => clearTimeout(timer);
  }, [kept, target]);
  const settled = steps.current.length < FADE_STEPS ? 0 : (steps.current[0] ?? 0);
  return [kept, Math.min(settled, kept.length)];
}

export function VoiceDraftPreview({
  text,
  start,
  end,
  transcribing,
  interim: heard = '',
  newLine = false,
  hint,
  heightPx,
  minHeightPx,
  class: className,
}: VoiceDraftPreviewProps) {
  const [interim, settled] = useTypewriter(heard, transcribing);
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
  }, [text, from, to, transcribing, interim, heightPx, minHeightPx]);

  return (
    <div
      ref={boxRef}
      role="textbox"
      tabIndex={0}
      aria-readonly="true"
      aria-label="Draft, read-only while recording"
      data-testid="voice-recording-draft"
      class={cn('relative overflow-y-auto whitespace-pre-wrap break-words', className)}
      style={{
        height: heightPx ? `${heightPx}px` : undefined,
        minHeight: minHeightPx ? `${minHeightPx}px` : undefined,
      }}
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
      {newLine && (transcribing || interim) && from > 0 ? '\n' : null}
      {interim && (
        <span
          data-testid="voice-interim-text"
          class={newLine ? 'italic text-fg-muted' : 'text-fg-faint'}
        >
          {interim.slice(0, settled)}
          {[...interim.slice(settled)].map((char, index) => (
            <span
              key={settled + index}
              class="motion-safe:animate-[voiceTypeIn_320ms_ease-out]"
              data-testid="voice-interim-fresh"
            >
              {char}
            </span>
          ))}
        </span>
      )}
      {!text && !interim && hint && !transcribing && <span class="text-fg-faint">{hint}</span>}
      {transcribing ? (
        <span
          ref={markerRef}
          aria-hidden="true"
          data-testid="voice-transcribing-placeholder"
          class={cn(
            'inline-block h-[0.9em] translate-y-[0.1em] rounded-md bg-fg-muted/40 motion-safe:animate-pulse',
            newLine && !interim ? 'w-[45%] max-w-64' : 'mx-1 w-[4em]'
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
