import type { ThinkingLevel } from '@hyperneo/shared';
import { THINKING_LEVELS } from '@hyperneo/shared';
import { useId } from 'preact/hooks';

const COLORS = ['', '#d97706', '#ea8a0a', '#f59e0b', '#fbbf24', '#fcd34d', '#fde68a'];
const BULB =
  'M8.464 15.536a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z';

export function NeoThinkingIcon({ level }: { level: ThinkingLevel }) {
  const clipId = useId();
  const step = THINKING_LEVELS.indexOf(level);
  const height = (10 * step) / 6;
  return (
    <span
      class="inline-flex h-[26px] w-[26px] items-center justify-center"
      data-thinking-level={level}
    >
      <svg
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="2.5 4 19 19"
        class="text-fg-faint"
        style={step === 6 ? { filter: `drop-shadow(0 0 4px ${COLORS[step]})` } : undefined}
      >
        {step > 0 && (
          <>
            <defs>
              <clipPath id={clipId}>
                <rect x="0" y={17 - height} width="24" height={height} />
              </clipPath>
            </defs>
            <path d={BULB} fill={COLORS[step]} opacity=".75" clip-path={`url(#${clipId})`} />
          </>
        )}
        <path
          d={`M9.663 17h4.673${BULB}`}
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
  );
}
