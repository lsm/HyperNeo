import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useVisibleTick } from '../../hooks/useVisibleTick.ts';

const BAR_PITCH_WIDE = 5;
const BAR_PITCH_NARROW = 4;
const MAX_SECONDS = 300;
const FLOOR = 0.03;

interface VoiceWaveformProps {
  getLevel: () => number;
  isRecording: boolean;
  isTranscribing: boolean;
  isStarting?: boolean;
  onCancel: () => void;
  startedAt?: number | null;
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`;
}

export function VoiceWaveform({
  getLevel,
  isRecording,
  isTranscribing,
  isStarting = false,
  onCancel,
  startedAt,
}: VoiceWaveformProps) {
  const [isNarrow] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches === true
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const pitch = isNarrow ? BAR_PITCH_NARROW : BAR_PITCH_WIDE;
    const update = () => {
      const next = Math.max(1, Math.floor(row.clientWidth / pitch));
      if (histRef.current.length > next) histRef.current = histRef.current.slice(-next);
      setBarCount((n) => (n === next ? n : next));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(row);
    return () => ro.disconnect();
  }, [isNarrow]);
  const barsRef = useRef<(HTMLDivElement | null)[]>([]);
  const histRef = useRef<number[]>([]);
  const valsRef = useRef<Float32Array>(new Float32Array(0));
  if (valsRef.current.length !== barCount) valsRef.current = new Float32Array(barCount);
  const [elapsed, setElapsed] = useState(0);
  const startTimestampRef = useRef(0);

  useLayoutEffect(() => {
    for (const bar of barsRef.current) {
      if (bar && !bar.style.transform) bar.style.transform = `scaleY(${FLOOR})`;
    }
  }, [barCount]);

  useEffect(() => {
    if (!isRecording || isTranscribing) return;
    startTimestampRef.current = startedAt ?? Date.now();
    setElapsed(Math.min(MAX_SECONDS, Math.floor((Date.now() - startTimestampRef.current) / 1000)));
  }, [isRecording, isTranscribing, startedAt]);

  useVisibleTick(1000, isRecording && !isTranscribing, () =>
    setElapsed(Math.min(MAX_SECONDS, Math.floor((Date.now() - startTimestampRef.current) / 1000)))
  );

  useEffect(() => {
    let raf = 0;
    let active = true;
    let tick = 0;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      for (const bar of barsRef.current) {
        if (!bar) continue;
        bar.style.transform = 'scaleY(0.25)';
        bar.style.opacity = isTranscribing ? '0.45' : '1';
      }
      return () => {
        active = false;
      };
    }

    const paint = () => {
      const hist = histRef.current;
      const vals = valsRef.current;
      for (let i = 0; i < barCount; i++) {
        const bar = barsRef.current[i];
        if (!bar) continue;
        const target = hist[i] ?? 0;
        const cur = vals[i];
        vals[i] = cur + (target - cur) * (target > cur ? 0.85 : 0.16);
        const v = Math.min(1, Math.max(FLOOR, vals[i]));
        bar.style.transform = `scaleY(${v})`;
        bar.style.opacity = isTranscribing ? '0.45' : '1';
      }
    };

    const loop = () => {
      if (!active) return;
      if (!isRecording || isTranscribing) {
        paint();
        return;
      }
      tick = (tick + 1) % 3;
      if (tick === 0) {
        const level = getLevel();
        histRef.current.push(level);
        if (histRef.current.length > barCount) histRef.current.shift();
      }
      paint();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      active = false;
      cancelAnimationFrame(raf);
    };
  }, [getLevel, isRecording, isTranscribing, barCount]);

  return (
    <div
      class={`flex w-full items-center ${isNarrow ? 'gap-2' : 'gap-3'}`}
      data-testid="voice-recording-panel"
    >
      <button
        type="button"
        onClick={onCancel}
        disabled={isTranscribing}
        title="Discard recording"
        aria-label="Cancel recording"
        class="grid h-9 w-9 flex-none place-items-center rounded-full bg-fill-strong/80 text-fg-muted transition-colors hover:bg-line-strong hover:text-fg-soft disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg
          class="h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width={2.5}
        >
          <path stroke-linecap="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <div
        ref={rowRef}
        class={`flex h-8 min-w-0 flex-1 items-center overflow-hidden ${isNarrow ? 'gap-px' : 'gap-[2px]'}`}
        data-testid="voice-bars"
      >
        {Array.from({ length: barCount }, (_, i) => (
          <div
            key={i}
            class="h-8 min-w-0 flex-1 origin-center rounded-full bg-[#ff3b30]"
            ref={(el) => {
              barsRef.current[i] = el;
            }}
          />
        ))}
      </div>
      {isTranscribing ? (
        <span
          class="inline-flex flex-none items-center gap-1.5 text-xs text-danger"
          data-testid="voice-transcribing"
          aria-label="Transcribing"
        >
          <span class="h-2.5 w-2.5 animate-spin rounded-full border-2 border-danger/40 border-t-danger" />
          {!isNarrow && 'Transcribing…'}
        </span>
      ) : isStarting && !isRecording ? (
        <span
          class={`inline-flex flex-none animate-pulse items-center gap-1.5 text-fg-muted motion-reduce:animate-none ${isNarrow ? 'text-[11px]' : 'text-xs'}`}
          data-testid="voice-starting"
        >
          {isNarrow ? 'Mic…' : 'Waiting for mic…'}
        </span>
      ) : (
        <span
          class={`flex-none tabular-nums text-fg ${isNarrow ? 'text-[11px]' : 'text-xs'}`}
          data-testid="voice-timer"
        >
          {formatElapsed(MAX_SECONDS - elapsed)}
        </span>
      )}
    </div>
  );
}
