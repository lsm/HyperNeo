/**
 * ErrorOutput Component - Renders error output from <local-command-stderr> tags
 *
 * Handles:
 * - Parsing <local-command-stderr> content
 * - Formatting API error JSON for readability
 * - Rendering errors in a distinct red/error style
 */

import { cn } from '../../lib/utils.ts';

interface ErrorOutputProps {
  /** Raw content that may contain <local-command-stderr> tags */
  content: string;
  /** Optional CSS classes */
  className?: string;
}

/**
 * Parse <local-command-stderr> content from raw message
 */
export function parseErrorOutput(content: string): string | null {
  const match = content.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
  return match ? match[1].trim() : null;
}

/**
 * Check if content contains <local-command-stderr> tags
 */
export function hasErrorOutput(content: string): boolean {
  return /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/.test(content);
}

/**
 * Format API error for display
 * Attempts to parse JSON and extract meaningful error message
 */
function formatApiError(errorContent: string): {
  statusCode: string | null;
  message: string;
} {
  // Try to extract status code and JSON body
  // Format: "Error: 400 {...}" or just "{...}"
  const statusMatch = errorContent.match(/Error:\s*(\d{3})\s*(\{[\s\S]*\})/);

  if (statusMatch) {
    const [, statusCode, jsonBody] = statusMatch;
    try {
      const parsed = JSON.parse(jsonBody);
      const errorMessage =
        parsed.error?.message || parsed.message || JSON.stringify(parsed, null, 2);
      const errorType = parsed.error?.type || parsed.type || 'API Error';
      return {
        statusCode,
        message: `**${errorType}**\n\n${errorMessage}`,
      };
    } catch {
      // JSON parse failed, return as-is
      return { statusCode, message: jsonBody };
    }
  }

  // No status code format, try plain JSON
  if (errorContent.startsWith('{')) {
    try {
      const parsed = JSON.parse(errorContent);
      const errorMessage =
        parsed.error?.message || parsed.message || JSON.stringify(parsed, null, 2);
      const errorType = parsed.error?.type || parsed.type || 'Error';
      return {
        statusCode: null,
        message: `**${errorType}**\n\n${errorMessage}`,
      };
    } catch {
      // Not valid JSON
    }
  }

  // Return raw content
  return { statusCode: null, message: errorContent };
}

/**
 * Error icon
 */
function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg class={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  );
}

export function ErrorOutput({ content, className }: ErrorOutputProps) {
  const errorContent = parseErrorOutput(content);

  // No error output found
  if (!errorContent) {
    return null;
  }

  const { statusCode, message } = formatApiError(errorContent);

  return (
    <div class={cn('py-2', className)}>
      {/* Header */}
      <div class="flex items-center gap-2 mb-2">
        <ErrorIcon className="w-4 h-4 text-red-400" />
        <span class="text-xs font-medium text-red-400">
          {statusCode ? `API Error (${statusCode})` : 'Error'}
        </span>
      </div>

      {/* Error content */}
      <div
        class={cn(
          'bg-red-950/40 border border-red-700/50 rounded-lg p-4',
          'text-sm text-red-200 whitespace-pre-wrap break-words'
        )}
      >
        {message}
      </div>
    </div>
  );
}
