import { Logger } from '../logger';
import { TRANSIENT_CONNECTION_ERROR_REGEXES } from './transient-error-patterns';
import { PROMPT_TOO_LONG_RE, matchPromptTooLong } from '@hyperneo/shared/provider/error-taxonomy';

interface ErrorOccurrence {
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

const DEFAULT_CONFIG: CircuitBreakerConfig = {
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

export class ApiErrorCircuitBreaker {
  private logger: Logger;
  private config: CircuitBreakerConfig;
  private recentErrors: ErrorOccurrence[] = [];
  private messageTimestampsByAgent: Map<string, number[]> = new Map();
  private state: CircuitBreakerState = {
    isTripped: false,
    tripReason: null,
    tripCount: 0,
    lastTripTime: null,
  };

  private onTrip?: (reason: string, errorCount: number) => Promise<void>;

  constructor(sessionId: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.logger = new Logger(`CircuitBreaker ${sessionId}`);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setOnTripCallback(callback: (reason: string, errorCount: number) => Promise<void>): void {
    this.onTrip = callback;
  }

  private extractErrorPattern(messageContent: string): string | null {
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

  async checkMessage(message: unknown): Promise<boolean> {
    const msg = message as {
      type?: string;
      message?: { content?: unknown };
      parent_tool_use_id?: string | null;
    };
    if (msg.type !== 'user') {
      return false;
    }

    const now = Date.now();

    const agentContext = msg.parent_tool_use_id ?? 'main';

    let agentTimestamps = this.messageTimestampsByAgent.get(agentContext);
    if (!agentTimestamps) {
      agentTimestamps = [];
      this.messageTimestampsByAgent.set(agentContext, agentTimestamps);
    }
    agentTimestamps.push(now);

    const rapidFireCutoff = now - this.config.rapidFireWindowMs;
    const filteredTimestamps = agentTimestamps.filter((t) => t > rapidFireCutoff);
    this.messageTimestampsByAgent.set(agentContext, filteredTimestamps);

    if (filteredTimestamps.length >= this.config.rapidFireThreshold) {
      await this.trip('rapid_fire', filteredTimestamps.length);
      return true;
    }

    const content = msg.message?.content;
    let messageText = '';

    if (typeof content === 'string') {
      messageText = content;
    } else if (Array.isArray(content)) {
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
    }

    if (!messageText) {
      return false;
    }

    const errorPattern = this.extractErrorPattern(messageText);

    if (!errorPattern) {
      for (const pattern of TRANSIENT_CONNECTION_PATTERNS) {
        if (pattern.test(messageText)) {
          return false;
        }
      }
    }

    if (!errorPattern) {
      return false;
    }

    this.recentErrors.push({
      pattern: errorPattern,
      timestamp: now,
      fullMessage: messageText.substring(0, 200),
    });

    const cutoff = now - this.config.timeWindowMs;
    this.recentErrors = this.recentErrors.filter((e) => e.timestamp > cutoff);

    const patternCount = this.recentErrors.filter((e) => e.pattern === errorPattern).length;

    if (patternCount >= this.config.errorThreshold) {
      await this.trip(errorPattern, patternCount);
      return true;
    }

    return false;
  }

  private async trip(reason: string, errorCount: number): Promise<void> {
    this.state.isTripped = true;
    this.state.tripReason = reason;
    this.state.tripCount++;
    this.state.lastTripTime = Date.now();

    this.recentErrors = [];

    if (this.onTrip) {
      try {
        await this.onTrip(reason, errorCount);
      } catch (error) {
        this.logger.error('Error executing onTrip callback:', error);
      }
    }
  }

  reset(): void {
    this.state.isTripped = false;
    this.state.tripReason = null;
    this.recentErrors = [];
    this.messageTimestampsByAgent.clear();
  }

  markSuccess(): void {
    this.recentErrors = [];
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  isTripped(): boolean {
    if (this.state.isTripped && this.state.lastTripTime) {
      const elapsed = Date.now() - this.state.lastTripTime;
      if (elapsed > this.config.cooldownMs) {
        this.reset();
      }
    }
    return this.state.isTripped;
  }

  getTripMessage(): string {
    if (!this.state.tripReason) {
      return 'Unknown error';
    }

    if (this.state.tripReason === 'rapid_fire') {
      return `Rapid message loop detected and stopped.

**What happened:**
- The system detected an abnormal message pattern (too many messages in a short time)
- This usually indicates an SDK error loop that was automatically stopped

**What to do:**
- The session has been paused to prevent resource waste
- Try your request again - if the issue persists, the underlying error needs to be addressed
- Consider starting a new session if the problem continues`;
    }

    if (this.state.tripReason.startsWith('prompt_too_long')) {
      const maxTokens = this.state.tripReason.split(':')[1];
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

    if (this.state.tripReason === 'invalid_request_error') {
      return 'The API rejected the request. This usually means the conversation context is too large or malformed.';
    }

    if (this.state.tripReason === 'image_size_error') {
      return `Image size exceeds API limit (5 MB for base64-encoded data).

**What happened:**
- The image you uploaded is too large after base64 encoding
- Base64 encoding increases file size by ~33%

**What to do:**
- Resize the image to under 3.75 MB before uploading
- Use image compression tools to reduce file size
- Consider using a lower resolution or cropping the image`;
    }

    if (this.state.tripReason === 'connection_error') {
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

    if (this.state.tripReason.startsWith('api_error:')) {
      const statusCode = this.state.tripReason.split(':')[1];
      if (statusCode === '429') {
        return 'Rate limit exceeded. Please wait a moment before continuing.';
      }
      return `API error (${statusCode}). The request could not be processed.`;
    }

    return `Error detected: ${this.state.tripReason}`;
  }
}
