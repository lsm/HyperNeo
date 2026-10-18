import type { ThinkingLevel } from '@hyperneo/shared';
import { useId } from 'preact/hooks';

const LEVELS: ThinkingLevel[] = [
  'off',
  'think8k',
  'think16k',
  'think24k',
  'think32k',
  'think48k',
  'think64k',
];

const COLORS = ['', '#d97706', '#ea8a0a', '#f59e0b', '#fbbf24', '#fcd34d', '#fde68a'];

const LIT_FROM_Y = [24, 16.6, 4.5, 4.5, 4.5, 4.5, 4.5];

const BULB =
  'M8.464 15.536a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z';

const RAYS = [
  { d: 'M12 3v1', from: 4 },
  { d: 'M18.364 5.636l-.707.707', from: 6 },
  { d: 'M21 12h-1', from: 5 },
  { d: 'M4 12H3', from: 5 },
  { d: 'M6.343 6.343l-.707-.707', from: 6 },
];

const RING_RADIUS = 15;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function ThinkingLevelIcon({ level }: { level: ThinkingLevel }) {
  const clipId = useId();
  const step = LEVELS.indexOf(level);
  const color = COLORS[step];
  const arc = (RING_CIRCUMFERENCE * step) / 6;
  return (
    <span
      class="relative inline-flex h-[26px] w-[26px] items-center justify-center rounded-full border border-line"
      data-thinking-level={level}
    >
      {step > 0 && (
        <svg aria-hidden="true" class="pointer-events-none absolute -inset-px" viewBox="0 0 32 32">
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            stroke={color}
            stroke-width="2"
            stroke-dasharray={`${arc} ${RING_CIRCUMFERENCE - arc}`}
            stroke-dashoffset={RING_CIRCUMFERENCE * 0.25}
            stroke-linecap="round"
          />
        </svg>
      )}
      <svg
        aria-hidden="true"
        width="17"
        height="17"
        viewBox="2.5 2 19 19"
        class="thinking-bulb-unlit"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y={LIT_FROM_Y[step]} width="24" height={24 - LIT_FROM_Y[step]} />
          </clipPath>
        </defs>
        {step === 6 && <circle cx="12" cy="10" r="7.5" fill={color} opacity=".18" />}
        <g
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          stroke="currentColor"
        >
          {RAYS.map((ray) => (
            <path
              key={ray.d}
              d={ray.d}
              data-lit={step >= ray.from}
              stroke={step >= ray.from ? color : undefined}
            />
          ))}
          <path d={`M9.663 17h4.673${BULB}`} />
        </g>
        {step > 0 && (
          <g clip-path={`url(#${clipId})`} data-bulb-lit>
            <path d={BULB} fill={color} opacity={step >= 3 ? 0.75 : 0} />
            <path
              d={`M9.663 17h4.673${BULB}`}
              fill="none"
              stroke={color}
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </g>
        )}
      </svg>
    </span>
  );
}
