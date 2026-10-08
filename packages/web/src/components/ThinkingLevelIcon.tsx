import type { ThinkingLevel } from '@hyperneo/shared';

const LEVEL_TONE: Record<ThinkingLevel, string> = {
  off: 'text-fg-muted',
  think8k: 'thinking-tone-8k',
  think16k: 'thinking-tone-16k',
  think24k: 'thinking-tone-24k',
  think32k: 'thinking-tone-32k',
};

const RAYS = [
  'M12 3v1',
  'M18.364 5.636l-.707.707',
  'M21 12h-1',
  'M4 12H3',
  'M6.343 6.343l-.707-.707',
];

const LIT_RAYS: Record<ThinkingLevel, number> = {
  off: RAYS.length,
  think8k: 2,
  think16k: 3,
  think24k: 4,
  think32k: RAYS.length,
};

export function ThinkingLevelIcon({
  level,
  ring = false,
  size = 'w-4 h-4',
}: {
  level: ThinkingLevel;
  ring?: boolean;
  size?: string;
}) {
  if (ring)
    return (
      <span
        class={`relative inline-flex h-5 w-5 items-center justify-center rounded-full ${
          level === 'off' ? 'border border-line-strong/80' : ''
        }`}
        data-thinking-level={level}
      >
        <ThinkingBorderRing level={level} />
        <ThinkingLevelIcon level={level} size="h-3 w-3" />
      </span>
    );

  const brightnessMap: Record<ThinkingLevel, number> = {
    off: 0,
    think8k: 1,
    think16k: 2,
    think24k: 3,
    think32k: 4,
  };
  const brightness = brightnessMap[level];

  const fillOpacity =
    brightness === 0
      ? 0
      : brightness === 1
        ? 0.15
        : brightness === 2
          ? 0.3
          : brightness === 3
            ? 0.4
            : 0.5;

  return (
    <svg class={`${size} ${LEVEL_TONE[level]}`} viewBox="0 0 24 24">
      {brightness > 0 && (
        <circle
          cx="12"
          cy="10"
          r={brightness === 1 ? 4 : brightness === 2 ? 5 : brightness === 3 ? 5.5 : 6}
          fill="currentColor"
          opacity={fillOpacity}
        />
      )}
      <g
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
      >
        {RAYS.map((ray, index) => (
          <path
            key={ray}
            d={ray}
            data-lit={index < LIT_RAYS[level]}
            opacity={index < LIT_RAYS[level] ? 1 : 0.25}
          />
        ))}
        <path d="M9.663 17h4.673M8.464 15.536a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </g>
    </svg>
  );
}

export function ThinkingBorderRing({ level }: { level: ThinkingLevel }) {
  if (level === 'off') return null;

  const size = 32;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  const dashPercentMap: Record<ThinkingLevel, number> = {
    off: 0,
    think8k: 0.25,
    think16k: 0.5,
    think24k: 0.75,
    think32k: 1,
  };
  const dashPercent = dashPercentMap[level];
  const dashLength = circumference * dashPercent;

  return (
    <svg
      class={`absolute inset-0 w-full h-full pointer-events-none ${LEVEL_TONE[level]}`}
      viewBox={`0 0 ${size} ${size}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        stroke-width={strokeWidth}
        stroke-dasharray={`${dashLength} ${circumference - dashLength}`}
        stroke-dashoffset={circumference * 0.25}
        stroke-linecap="round"
      />
    </svg>
  );
}
