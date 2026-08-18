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

function isInternalMessage(msg: string): boolean {
  return INTERNAL_PATTERNS.some((p) => p.test(msg));
}

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

  if (!isInternalMessage(msg)) {
    return msg || 'Something went wrong.';
  }

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

  return 'Something went wrong. Please try again.';
}
