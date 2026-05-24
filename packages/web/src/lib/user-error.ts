/**
 * User-Facing Error Sanitization
 *
 * Maps raw internal error messages to human-readable strings that are
 * safe to display to end users. Prevents developer-facing hints like
 * "verbose: true", stack traces, or transport internals from leaking.
 */

/** Patterns that indicate developer/internal error content */
const INTERNAL_PATTERNS = [
  /verbose:\s*true/i,
  /set VERBOSE=true/i,
  /fetch\(/i,
  /stack trace/i,
  /at\s+[\w.<>]+\s*\(/,
  /node_modules\//,
  /ERR_[A-Z_]+/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /socket hang up/i,
  /WebSocket not connected/i,
  /Failed to send message:/i,
  /timed?\s*out\s+(after|waiting)/i,
  /\d{4,}ms/i,
];

/** Check if an error message contains internal/developer content */
function isInternalMessage(msg: string): boolean {
  return INTERNAL_PATTERNS.some((p) => p.test(msg));
}

/** Check if an error is an authentication/session-expiry error */
export function isAuthError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes('unauthorized') ||
    lower.includes('authentication') ||
    lower.includes('session expired') ||
    lower.includes('token expired') ||
    lower.includes('not authenticated') ||
    (lower.includes('auth') && lower.includes('fail')) ||
    lower.includes('401')
  );
}

/** Check if error is a network/transient issue (should retry) */
export function isTransientError(error: unknown): boolean {
  if (!error) return true;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('socket') ||
    lower.includes('fetch') ||
    lower.includes('disconnected') ||
    lower.includes('not connected')
  );
}

/**
 * Sanitize any error into a user-friendly message.
 *
 * Strips developer-facing content and maps common error types
 * to readable strings.
 */
export function sanitizeUserError(error: unknown): string {
  if (error == null) return 'Something went wrong.';

  let msg: string;

  if (error instanceof Error) {
    msg = error.message;
  } else if (typeof error === 'string') {
    msg = error;
  } else {
    try {
      msg = JSON.stringify(error);
    } catch {
      msg = String(error);
    }
  }

  // If already human-friendly, pass through
  if (!isInternalMessage(msg)) {
    return msg || 'Something went wrong.';
  }

  // Map common internal messages to user-friendly ones
  const lower = msg.toLowerCase();

  if (lower.includes('websocket') || lower.includes('not connected')) {
    return 'Connection lost. Your message will be sent when reconnected.';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'The request timed out. Please try again.';
  }
  if (lower.includes('econnrefused') || lower.includes('econnreset')) {
    return 'Could not reach the server. Please check your connection.';
  }
  if (lower.includes('fetch')) {
    return 'Network error. Please check your connection.';
  }
  if (lower.includes('failed to send')) {
    return 'Could not send. Please try again.';
  }

  // Generic fallback for any other internal message
  return 'Something went wrong. Please try again.';
}
