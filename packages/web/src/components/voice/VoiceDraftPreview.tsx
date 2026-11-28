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

const LAG_S = 0.45;
const EASE_S = 0.35;
const FLOOR_CPS = 8;
const FADE_S = 0.3;
const graphemes = new Intl.Segmenter();

interface Pace {
  chars: string[];
  position: number;
  speed: number;
  now?: number;
  revealedAt: number[];
}

function advance(pace: Pace, time: number) {
  const count = pace.chars.length;
  const last = pace.now ?? time;
  pace.now = time;
  const dt = Math.min(0.1, Math.max(0, time - last));
  const backlog = count - pace.position;
  pace.speed += (backlog / LAG_S - pace.speed) * (1 - Math.exp(-dt / EASE_S));
  const step = Math.min(backlog, Math.max(pace.speed, backlog > 0 ? FLOOR_CPS : 0) * dt);
  const from = pace.position;
  pace.position += step;
  while (pace.revealedAt.length < Math.floor(pace.position + 1e-9)) {
    const i = pace.revealedAt.length + 1;
    pace.revealedAt.push(time - dt + (dt * (i - from)) / Math.max(step, 1e-9));
  }
}

function settled(pace: Pace) {
  const last = pace.revealedAt.at(-1);
  return (
    pace.revealedAt.length === pace.chars.length &&
    (last === undefined || pace.now === undefined || pace.now - last >= FADE_S)
  );
}

function opacity(pace: Pace, index: number) {
  const at = pace.revealedAt[index];
  if (at === undefined) return 0;
  if (pace.now === undefined) return 1;
  return Math.min(1, Math.max(0, (pace.now - at) / FADE_S));
}

function useTypingReveal(target: string, flush: boolean) {
  const pace = useRef<Pace>({ chars: [], position: 0, speed: 0, revealedAt: [] }).current;
  const [, setFrame] = useState(0);
  const chars = [...graphemes.segment(target)].map((part) => part.segment);
  if (chars.join('') !== pace.chars.join('')) {
    let same = 0;
    while (same < chars.length && chars[same] === pace.chars[same]) same++;
    pace.chars = chars;
    pace.revealedAt.length = Math.min(pace.revealedAt.length, same);
    pace.position = Math.min(pace.position, same);
  }
  const still =
    flush ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (still) {
    pace.position = chars.length;
    pace.revealedAt = chars.map(() => Number.NEGATIVE_INFINITY);
  }
  if (still || !chars.length) {
    pace.speed = 0;
    pace.now = undefined;
  }
  useEffect(() => {
    if (settled(pace)) return;
    let id = requestAnimationFrame(function tick(time) {
      advance(pace, time / 1000);
      setFrame(time);
      if (settled(pace)) pace.now = undefined;
      else id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [target, still]);
  return pace;
}

function TypingText({ pace }: { pace: Pace }) {
  let solid = 0;
  while (solid < pace.chars.length && opacity(pace, solid) >= 1) solid++;
  let fading = solid;
  while (fading < pace.chars.length && opacity(pace, fading) > 0) fading++;
  return (
    <>
      {pace.chars.slice(0, solid).join('')}
      {pace.chars.slice(solid, fading).map((char, offset) => (
        <span
          key={solid + offset}
          data-testid="voice-interim-fresh"
          style={{ opacity: opacity(pace, solid + offset) }}
        >
          {char}
        </span>
      ))}
      {fading < pace.chars.length && (
        <span aria-hidden="true" data-testid="voice-interim-pending" style={{ opacity: 0 }}>
          {pace.chars.slice(fading).join('')}
        </span>
      )}
    </>
  );
}

export function VoiceDraftPreview({
  text,
  start,
  end,
  transcribing,
  interim = '',
  newLine = false,
  hint,
  heightPx,
  minHeightPx,
  class: className,
}: VoiceDraftPreviewProps) {
  const pace = useTypingReveal(interim, transcribing);
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
          <TypingText pace={pace} />
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
