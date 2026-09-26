import type { ThinkingLevel } from '@hyperneo/shared';

export function ThinkingLevelIcon({ level }: { level: ThinkingLevel }) {
  const brightnessMap: Record<ThinkingLevel, number> = {
    off: 0,
    think8k: 1,
    think16k: 2,
    think24k: 3,
    think32k: 4,
  };
  const brightness = brightnessMap[level];

  const strokeColor =
    brightness === 0
      ? 'text-fg-muted'
      : brightness === 1
        ? 'text-warning'
        : brightness === 2
          ? 'text-warning'
          : brightness === 3
            ? 'text-warning'
            : 'text-warning';

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
    <svg class={`w-4 h-4 ${strokeColor}`} viewBox="0 0 24 24">
      {brightness > 0 && (
        <circle
          cx="12"
          cy="10"
          r={brightness === 1 ? 4 : brightness === 2 ? 5 : brightness === 3 ? 5.5 : 6}
          fill="currentColor"
          opacity={fillOpacity}
        />
      )}
      <path
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
      />
    </svg>
  );
}
