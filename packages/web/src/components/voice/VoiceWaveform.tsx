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

const BAR_COUNT_WIDE = 72;
const BAR_COUNT_NARROW = 40;
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
}: VoiceWaveformProps) {
  // Fewer columns on phone-width composers: with a fixed 2px gap, 72 columns
  // need ~142px of gaps alone and would overflow into the timer/controls.
  const [barCount] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches
      ? BAR_COUNT_NARROW
      : BAR_COUNT_WIDE
  );
  const barsRef = useRef<(HTMLDivElement | null)[]>([]);
  const histRef = useRef<number[]>([]);
  const valsRef = useRef<Float32Array>(new Float32Array(0));
  if (valsRef.current.length !== barCount) valsRef.current = new Float32Array(barCount);
  const [elapsed, setElapsed] = useState(0);
  const startTimestampRef = useRef(0);

  // Collapse columns before first paint so they don't flash full-height for a
  // frame before rAF takes over. No `style` prop on the columns in JSX, so later
  // re-renders never reset these transforms. The entrance (hello bounce) is a
  // CSS animation with a per-column stagger; it has NO fill-mode, so as each
  // column's animation ends it hands off seamlessly to the rAF-written inline
  // transform (the wave visibly "wakes up" left → right).
  useLayoutEffect(() => {
    barsRef.current.forEach((bar, i) => {
      if (!bar) return;
      bar.style.transform = `scaleY(${FLOOR})`;
      bar.style.animationDelay = `${i * 4}ms`;
    });
  }, []);

  // 1Hz countdown timer, only while actively recording. Derived from wall-clock
  // elapsed (not counted ticks) so background-tab interval throttling can't let
  // the display drift from the recorder's real deadline.
  useEffect(() => {
    if (!isRecording || isTranscribing) return;
    startTimestampRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(
        Math.min(MAX_SECONDS, Math.floor((Date.now() - startTimestampRef.current) / 1000))
      );
    }, 1000);
    return () => clearInterval(id);
  }, [isRecording, isTranscribing]);

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
    <div class="flex w-full items-center gap-3" data-testid="voice-recording-panel">
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
        class="flex h-8 min-w-0 flex-1 items-center gap-[2px] overflow-hidden"
        data-testid="voice-bars"
      >
        {Array.from({ length: barCount }, (_, i) => (
          <div
            key={i}
            class="voice-bar-enter h-8 min-w-0 flex-1 origin-center rounded-full bg-[#ff3b30]"
            ref={(el) => {
              barsRef.current[i] = el;
            }}
          />
        ))}
      </div>
      {isTranscribing ? (
        <span
          class="inline-flex items-center gap-1.5 text-xs text-red-400"
          data-testid="voice-transcribing"
        >
          <span class="h-2.5 w-2.5 animate-spin rounded-full border-2 border-red-400/40 border-t-red-400" />
          Transcribing…
        </span>
      ) : isStarting && !isRecording ? (
        // Mic startup can block on the browser permission prompt — frozen dots
        // alone read as "broken", so say what we're waiting for.
        <span
          class="inline-flex animate-pulse items-center gap-1.5 text-xs text-gray-400"
          data-testid="voice-starting"
        >
          Waiting for mic…
        </span>
      ) : (
        <span class="tabular-nums text-xs text-gray-100" data-testid="voice-timer">
          {formatElapsed(MAX_SECONDS - elapsed)}
        </span>
      )}
    </div>
  );
}
