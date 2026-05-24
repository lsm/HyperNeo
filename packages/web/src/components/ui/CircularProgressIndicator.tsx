/**
 * CircularProgressIndicator Component
 *
 * Shows task progress as a circular progress indicator:
 * - Circle with percentage and color coding (gray → blue → green)
 * - Compact size matching the context usage indicator
 * - Color coding: gray for 0%, blue for in-progress, green for completed
 */

interface CircularProgressIndicatorProps {
  /** Progress percentage (0-100) */
  progress: number;
  /** Size of the indicator in pixels (default: 32) */
  size?: number;
  /** Whether to show the percentage text in center (default: true) */
  showPercentage?: boolean;
  /** Additional class for the container */
  class?: string;
  /** Title/tooltip text */
  title?: string;
}

export function CircularProgressIndicator({
  progress,
  size = 32,
  showPercentage = true,
  class: className,
  title,
}: CircularProgressIndicatorProps) {
  // SVG viewBox dimensions
  const viewBoxSize = 36;
  const center = viewBoxSize / 2; // 18
  const radius = 15;
  const circumference = 2 * Math.PI * radius; // ~94.2

  // Progress arc length
  const progressPercent = Math.min(Math.max(progress, 0), 100);
  const dashArray = (progressPercent / 100) * circumference;

  // Color based on progress
  const getProgressColor = () => {
    if (progressPercent === 0) return 'text-dark-600';
    if (progressPercent >= 100) return 'text-green-500';
    return 'text-blue-500';
  };

  // Background color
  const bgColor = 'text-dark-700';

  return (
    <div class={className} title={title}>
      <svg width={size} height={size} viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}>
        <g class="transform rotate-[-90deg]" transform-origin={`${center} ${center}`}>
          {/* Background circle */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            class={bgColor}
          />
          {/* Progress arc */}
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
        {/* Percentage text in center */}
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
