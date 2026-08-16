/**
 * VoiceWaveform — the iMessage-style recording body that renders IN PLACE OF the
 * textarea inside the existing InputTextarea pill (it has no chrome of its own).
 *
 * Thin fully-rounded columns in iOS system red grow from the left as you speak
 * (scroll once full), with a white countdown timer on the right. Columns use a
 * fast-attack / slow-release envelope so speech reads as the organic "spike"
 * pattern of the native iMessage waveform; silence collapses to small dots.
 * While transcribing, the waveform freezes/dims and the timer becomes a red
 * "Transcribing…" spinner.
 *
 * PERF: level updates are written directly to column DOM nodes via
 * transform: scaleY() inside a requestAnimationFrame loop — never through Preact
 * state. The loop only schedules frames while actually recording; a frozen pass
 * is applied once when transcription begins. The column <div>s carry no `style`
 * prop, so re-renders (1Hz timer ticks) never clobber the rAF-written transforms.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

// Columns are sized by PITCH, not count: the row measures itself and renders
// floor(width / pitch) columns, so each stays ~2-3px thin at ANY composer
// width instead of stretching into blocks (columns keep flex-1 only to absorb
// the sub-pixel rounding remainder, so the row always fills exactly). The
// count sets granularity and history length (~20 columns/sec) — never layout
// fit: the bars row stays min-w-0 flex-1 and collapses first in the worst
// case (320px viewport, agent running), with all controls flex-none.
const BAR_PITCH_WIDE = 5; // ~3px column + 2px gap
const BAR_PITCH_NARROW = 4; // ~3px column + 1px gap
const MAX_SECONDS = 300; // matches useVoiceRecorder MAX_RECORDING_MS (5 min)
const FLOOR = 0.03; // silence renders as small dots, like iMessage

interface VoiceWaveformProps {
  getLevel: () => number;
  isRecording: boolean;
  isTranscribing: boolean;
  /** Mic permission/hardware startup is in flight (may be waiting on the browser prompt). */
  isStarting?: boolean;
  /** Discard the recording (the X button at the left end of the row). */
  onCancel: () => void;
  /**
   * Wall-clock start of the recording. An ADOPTED recording (orphaned by a
   * previous composer, picked up on remount) started before this waveform
   * mounted — without this the countdown restarts from the adoption and the
   * cap fires "early" from the user's perspective.
   */
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
  // Phone-width composers get tighter gaps/smaller labels; also selects pitch.
  const [isNarrow] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches === true
  );
  const rowRef = useRef<HTMLDivElement>(null);
  // Column count derives from the row's real width and re-derives on resize
  // (the composer flexes with window/panel size). Runs in useLayoutEffect so
  // the first paint already has columns.
  const [barCount, setBarCount] = useState(0);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const pitch = isNarrow ? BAR_PITCH_NARROW : BAR_PITCH_WIDE;
    const update = () => {
      // No lower clamp beyond 1: pitch-sized columns always fit their gaps
      // (bar ≈ pitch - gap ≥ 1px), whereas a minimum count would force the
      // gaps alone to overflow a near-zero row and collapse every bar to 0.
      const next = Math.max(1, Math.floor(row.clientWidth / pitch));
      // Shrinking: histRef still holds the longer history, but paint() reads
      // indices 0..count-1 — the OLDEST samples — so the waveform would lag
      // the mic by the count delta. Trim to the newest `next` entries.
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

  // Collapse columns before first paint so they don't flash full-height for a
  // frame before rAF takes over. No `style` prop on the columns in JSX, so later
  // re-renders never reset these transforms. Only seed columns that have no
  // transform yet — resetting live levels on a resize-derived count change
  // would flash the waveform to dots. No entrance animation: the columns show
  // live mic levels from the very first frame.
  useLayoutEffect(() => {
    for (const bar of barsRef.current) {
      if (bar && !bar.style.transform) bar.style.transform = `scaleY(${FLOOR})`;
    }
  }, [barCount]);

  // 1Hz countdown timer, only while actively recording. Derived from wall-clock
  // elapsed (not counted ticks) so background-tab interval throttling can't let
  // the display drift from the recorder's real deadline.
  useEffect(() => {
    if (!isRecording || isTranscribing) return;
    // Seed from the recording's true start when known (adopted recordings),
    // falling back to this mount for recordings started here.
    startTimestampRef.current = startedAt ?? Date.now();
    setElapsed(Math.min(MAX_SECONDS, Math.floor((Date.now() - startTimestampRef.current) / 1000)));
    const id = setInterval(() => {
      setElapsed(
        Math.min(MAX_SECONDS, Math.floor((Date.now() - startTimestampRef.current) / 1000))
      );
    }, 1000);
    return () => clearInterval(id);
  }, [isRecording, isTranscribing, startedAt]);

  // Level meter. Runs at ~60fps ONLY while recording; when frozen (transcribing
  // or startup) it applies the frozen styles once and stops scheduling frames.
  useEffect(() => {
    let raf = 0;
    let active = true;
    let tick = 0;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Reduced motion: a truly static waveform — one fixed paint, no per-frame
    // updates and no animation at all for motion-sensitive users.
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
        // Fast attack, slow release — the iMessage spike character.
        vals[i] = cur + (target - cur) * (target > cur ? 0.85 : 0.16);
        const v = Math.min(1, Math.max(FLOOR, vals[i]));
        bar.style.transform = `scaleY(${v})`;
        bar.style.opacity = isTranscribing ? '0.45' : '1';
      }
    };

    const loop = () => {
      if (!active) return;
      // Frozen (transcribing or startup): one paint, no further frames — the
      // effect re-runs when isRecording/isTranscribing flips again.
      if (!isRecording || isTranscribing) {
        paint();
        return;
      }
      tick = (tick + 1) % 3; // push a new column ~20x/sec
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
        class="grid h-9 w-9 flex-none place-items-center rounded-full bg-dark-700/80 text-gray-400 transition-colors hover:bg-dark-600 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
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
          class="inline-flex flex-none items-center gap-1.5 text-xs text-red-400"
          data-testid="voice-transcribing"
          aria-label="Transcribing"
        >
          <span class="h-2.5 w-2.5 animate-spin rounded-full border-2 border-red-400/40 border-t-red-400" />
          {/* Narrow composers don't have room for the label next to the cancel
              button and recording controls — the spinner alone carries it. */}
          {!isNarrow && 'Transcribing…'}
        </span>
      ) : isStarting && !isRecording ? (
        // Mic startup can block on the browser permission prompt — frozen dots
        // alone read as "broken", so say what we're waiting for.
        <span
          class={`inline-flex flex-none animate-pulse items-center gap-1.5 text-gray-400 motion-reduce:animate-none ${isNarrow ? 'text-[11px]' : 'text-xs'}`}
          data-testid="voice-starting"
        >
          {isNarrow ? 'Mic…' : 'Waiting for mic…'}
        </span>
      ) : (
        <span
          class={`flex-none tabular-nums text-gray-100 ${isNarrow ? 'text-[11px]' : 'text-xs'}`}
          data-testid="voice-timer"
        >
          {formatElapsed(MAX_SECONDS - elapsed)}
        </span>
      )}
    </div>
  );
}
