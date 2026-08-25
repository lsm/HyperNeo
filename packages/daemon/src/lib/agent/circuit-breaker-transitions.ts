import { matchPromptTooLong, PROMPT_TOO_LONG_RE } from '@hyperneo/shared/provider/error-taxonomy';
import { TRANSIENT_CONNECTION_ERROR_REGEXES } from './transient-error-patterns.ts';

export interface ErrorOccurrence {
  pattern: string;
  timestamp: number;
  fullMessage: string;
}

export interface CircuitBreakerState {
  isTripped: boolean;
  tripReason: string | null;
  tripCount: number;
  lastTripTime: number | null;
}

export interface CircuitBreakerConfig {
  errorThreshold: number;
  timeWindowMs: number;
  cooldownMs: number;
  rapidFireThreshold: number;
  rapidFireWindowMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  errorThreshold: 3,
  timeWindowMs: 30000,
  cooldownMs: 60000,
  rapidFireThreshold: 30,
  rapidFireWindowMs: 3000,
};

const FATAL_ERROR_PATTERNS = [
  PROMPT_TOO_LONG_RE,
  /invalid_request_error/i,
  /Error:\s*Connection\s+error/i,
  /Connection\s+error/i,
  /ImageSizeError/i,
  /Image.*size.*exceeds.*limit/i,
  /image.*base64.*size.*exceeds/i,
];

const TRANSIENT_CONNECTION_PATTERNS = TRANSIENT_CONNECTION_ERROR_REGEXES;

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  let messageText = '';
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as { type?: string; text?: string; content?: string };
      if (b.type === 'text' && b.text) {
        messageText += b.text;
      } else if (b.type === 'tool_result' && b.content) {
        messageText += b.content;
      }
    }
  }
  return messageText;
}

export function extractErrorPattern(messageContent: string): string | null {
  if (
    /ImageSizeError/i.test(messageContent) ||
    /image.*size.*exceeds.*limit/i.test(messageContent)
  ) {
    return 'image_size_error';
  }

  const stderrMatch = messageContent.match(
    /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/
  );
  if (stderrMatch) {
    const errorContent = stderrMatch[1];

    for (const pattern of FATAL_ERROR_PATTERNS) {
      if (pattern.test(errorContent)) {
        const promptTooLong = matchPromptTooLong(errorContent);
        if (promptTooLong) {
          return promptTooLong.maxTokens !== undefined
            ? `prompt_too_long:${promptTooLong.maxTokens}`
            : 'prompt_too_long';
        }

        if (/Connection\s+error/i.test(errorContent)) {
          return 'connection_error';
        }

        if (/ImageSizeError/i.test(errorContent) || /image.*size.*exceeds/i.test(errorContent)) {
          return 'image_size_error';
        }

        return 'invalid_request_error';
      }
    }

    const apiErrorMatch = errorContent.match(/Error:\s*(\d{3})\s*\{/);
    if (apiErrorMatch) {
      const statusCode = apiErrorMatch[1];
      if (statusCode === '400' || statusCode === '429') {
        return `api_error:${statusCode}`;
      }
    }
  }

  return null;
}

export function matchesTransientConnectionPattern(messageText: string): boolean {
  for (const pattern of TRANSIENT_CONNECTION_PATTERNS) {
    if (pattern.test(messageText)) {
      return true;
    }
  }
  return false;
}

export function advanceRapidFire(args: {
  timestamps: number[];
  now: number;
  windowMs: number;
  threshold: number;
}): { timestamps: number[]; shouldTrip: boolean } {
  const cutoff = args.now - args.windowMs;
  const timestamps = [...args.timestamps, args.now].filter((t) => t > cutoff);
  return { timestamps, shouldTrip: timestamps.length >= args.threshold };
}

export function recordError(args: {
  errors: ErrorOccurrence[];
  occurrence: ErrorOccurrence;
  timeWindowMs: number;
  errorThreshold: number;
}): { errors: ErrorOccurrence[]; shouldTrip: boolean; patternCount: number } {
  const cutoff = args.occurrence.timestamp - args.timeWindowMs;
  const errors = [...args.errors, args.occurrence].filter((e) => e.timestamp > cutoff);
  const patternCount = errors.filter((e) => e.pattern === args.occurrence.pattern).length;
  return { errors, shouldTrip: patternCount >= args.errorThreshold, patternCount };
}

export function applyTrip(
  state: CircuitBreakerState,
  reason: string,
  now: number
): CircuitBreakerState {
  return {
    isTripped: true,
    tripReason: reason,
    tripCount: state.tripCount + 1,
    lastTripTime: now,
  };
}

export function applyReset(state: CircuitBreakerState): CircuitBreakerState {
  return { ...state, isTripped: false, tripReason: null };
}

export function shouldReleaseCooldown(
  state: CircuitBreakerState,
  now: number,
  cooldownMs: number
): boolean {
  if (!state.isTripped || !state.lastTripTime) return false;
  return now - state.lastTripTime > cooldownMs;
}

export function buildTripMessage(tripReason: string | null): string {
  if (!tripReason) {
    return 'Unknown error';
  }

  if (tripReason === 'rapid_fire') {
    return `Rapid message loop detected and stopped.

**What happened:**
- The system detected an abnormal message pattern (too many messages in a short time)
- This usually indicates an SDK error loop that was automatically stopped

**What to do:**
- The session has been paused to prevent resource waste
- Try your request again - if the issue persists, the underlying error needs to be addressed
- Consider starting a new session if the problem continues`;
  }

  if (tripReason.startsWith('prompt_too_long')) {
    const maxTokens = tripReason.split(':')[1];
    const header = maxTokens
      ? `Context limit exceeded (${maxTokens} tokens maximum).`
      : 'Context limit exceeded.';
    return `${header}

**Possible causes:**
- A single tool output was extremely large (e.g., huge file, massive diff)
- The conversation context has grown too large

**What to do:**
- Output limiting is now **enabled by default** to prevent this
- If you still see this error, reduce the output limits in HyperNeo's global
  settings (outputLimiter section):
  - outputLimiter.bash.headLines (default: 100)
  - outputLimiter.bash.tailLines (default: 200)
  - outputLimiter.read.maxLines (default: 1000)
  - outputLimiter.grep.maxMatches (default: 250)
- Use filtering in tools (e.g., grep with patterns, head/tail for files)
- Start a new session if context is too large
- Use /compact to reduce conversation context`;
  }

  if (tripReason === 'invalid_request_error') {
    return 'The API rejected the request. This usually means the conversation context is too large or malformed.';
  }

  if (tripReason === 'image_size_error') {
    return `Image size exceeds API limit (5 MB for base64-encoded data).

**What happened:**
- The image you uploaded is too large after base64 encoding
- Base64 encoding increases file size by ~33%

**What to do:**
- Resize the image to under 3.75 MB before uploading
- Use image compression tools to reduce file size
- Consider using a lower resolution or cropping the image`;
  }

  if (tripReason === 'connection_error') {
    return `Connection error detected repeatedly.

**Possible causes:**
- Network connectivity issues
- API service temporarily unavailable
- Firewall or proxy blocking the connection

**What to do:**
- Check your internet connection
- Verify your API key is valid and has not expired
- Try again in a few moments
- If the problem persists, check the Anthropic API status page`;
  }

  if (tripReason.startsWith('api_error:')) {
    const statusCode = tripReason.split(':')[1];
    if (statusCode === '429') {
      return 'Rate limit exceeded. Please wait a moment before continuing.';
    }
    return `API error (${statusCode}). The request could not be processed.`;
  }

  return `Error detected: ${tripReason}`;
}
