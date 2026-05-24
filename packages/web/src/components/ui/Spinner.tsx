/**
 * Spinner Component
 *
 * A reusable loading spinner with configurable size and color.
 * Replaces the duplicated inline spinner pattern throughout the codebase.
 *
 * @example
 * ```tsx
 * <Spinner size="sm" />
 * <Spinner size="md" color="text-blue-400" />
 * <Button disabled={loading}>
 *   {loading && <Spinner size="xs" className="mr-2" />}
 *   Submit
 * </Button>
 * ```
 */

import { cn } from '../../lib/utils';

export interface SpinnerProps {
  /** Size of the spinner */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Tailwind color class for the spinner border */
  color?: string;
  /** Additional CSS classes */
  className?: string;
}

const sizeClasses = {
  xs: 'w-3 h-3 border',
  sm: 'w-4 h-4 border-2',
  md: 'w-5 h-5 border-2',
  lg: 'w-6 h-6 border-2',
} as const;

/**
 * Animated loading spinner
 */
export function Spinner({ size = 'sm', color = 'border-gray-500', className }: SpinnerProps) {
  return (
    <div
      class={cn(
        'rounded-full animate-spin border-t-transparent',
        sizeClasses[size],
        color,
        className
      )}
      role="status"
      aria-label="Loading"
    />
  );
}
