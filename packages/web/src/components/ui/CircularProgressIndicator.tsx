interface CircularProgressIndicatorProps {
  progress: number;
  size?: number;
  showPercentage?: boolean;
  class?: string;
  title?: string;
}

export function CircularProgressIndicator({
  progress,
  size = 32,
  showPercentage = true,
  class: className,
  title,
}: CircularProgressIndicatorProps) {
  const viewBoxSize = 36;
  const center = viewBoxSize / 2;
  const radius = 15;
  const circumference = 2 * Math.PI * radius;

  const progressPercent = Math.min(Math.max(progress, 0), 100);
  const dashArray = (progressPercent / 100) * circumference;

  const getProgressColor = () => {
    if (progressPercent === 0) return 'text-dark-600';
    if (progressPercent >= 100) return 'text-green-500';
    return 'text-blue-500';
  };

  const bgColor = 'text-dark-700';

  return (
    <div class={className} title={title}>
      <svg width={size} height={size} viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}>
        <g class="transform rotate-[-90deg]" transform-origin={`${center} ${center}`}>
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            class={bgColor}
          />
          {progressPercent > 0 && (
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke="currentColor"
              stroke-width="4"
              stroke-dasharray={`${dashArray} ${circumference}`}
              class={`transition-all duration-300 ${getProgressColor()}`}
              stroke-linecap="round"
            />
          )}
        </g>
        {showPercentage && (
          <text
            x={center}
            y={center}
            text-anchor="middle"
            dominant-baseline="middle"
            font-size="10"
            class={`font-bold fill-current ${
              progressPercent === 0
                ? 'text-dark-500'
                : progressPercent >= 100
                  ? 'text-green-400'
                  : 'text-blue-400'
            }`}
          >
            {Math.round(progressPercent)}
          </text>
        )}
      </svg>
    </div>
  );
}
