import type { AuthStatusCardProps } from './tool-types.ts';
import { cn } from '../../../lib/utils.ts';

export function AuthStatusCard({
  isAuthenticating,
  output,
  error,
  variant = 'default',
  className,
}: AuthStatusCardProps) {
  if (variant === 'compact') {
    return (
      <div
        class={cn(
          'flex items-center gap-2 py-1 px-2 bg-blue-50 dark:bg-blue-900/20 rounded',
          className
        )}
      >
        {isAuthenticating && (
          <div class="animate-spin">
            <svg
              class="w-3 h-3 text-blue-600 dark:text-blue-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </div>
        )}
        <span class="text-xs font-medium text-blue-900 dark:text-blue-100">
          {isAuthenticating ? 'Authenticating...' : 'Authenticated'}
        </span>
      </div>
    );
  }

  if (variant === 'inline') {
    return (
      <span
        class={cn(
          'inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 dark:bg-blue-900/20 rounded',
          className
        )}
      >
        <span class="text-xs font-medium text-blue-900 dark:text-blue-100">
          {isAuthenticating ? '🔐 Authenticating...' : '✓ Authenticated'}
        </span>
      </span>
    );
  }

  return (
    <div
      class={cn(
        'p-3 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-200 dark:border-blue-800 text-sm',
        className
      )}
    >
      <div class="font-medium text-blue-900 dark:text-blue-100 mb-1 flex items-center gap-2">
        {isAuthenticating && (
          <div class="animate-spin">
            <svg
              class="w-4 h-4 text-blue-600 dark:text-blue-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </div>
        )}
        {isAuthenticating ? 'Authenticating...' : 'Authentication Complete'}
      </div>

      {output && output.length > 0 && (
        <div class="text-blue-700 dark:text-blue-300 text-xs whitespace-pre-wrap mt-2">
          {output.join('\n')}
        </div>
      )}

      {error && <div class="text-red-600 dark:text-red-400 text-xs mt-2">Error: {error}</div>}
    </div>
  );
}
