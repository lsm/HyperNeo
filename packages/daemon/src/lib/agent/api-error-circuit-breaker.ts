import { Logger } from '../logger.ts';
import type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  ErrorOccurrence,
} from './circuit-breaker-transitions.ts';
import {
  advanceRapidFire,
  applyReset,
  applyTrip,
  buildTripMessage,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  extractErrorPattern,
  extractMessageText,
  matchesTransientConnectionPattern,
  recordError,
  shouldReleaseCooldown,
} from './circuit-breaker-transitions.ts';

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
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  setOnTripCallback(callback: (reason: string, errorCount: number) => Promise<void>): void {
    this.onTrip = callback;
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

    const rapidFire = advanceRapidFire({
      timestamps: this.messageTimestampsByAgent.get(agentContext) ?? [],
      now,
      windowMs: this.config.rapidFireWindowMs,
      threshold: this.config.rapidFireThreshold,
    });
    this.messageTimestampsByAgent.set(agentContext, rapidFire.timestamps);

    if (rapidFire.shouldTrip) {
      await this.trip('rapid_fire', rapidFire.timestamps.length);
      return true;
    }

    const messageText = extractMessageText(msg.message?.content);

    if (!messageText) {
      return false;
    }

    const errorPattern = extractErrorPattern(messageText);

    if (!errorPattern) {
      if (matchesTransientConnectionPattern(messageText)) {
        return false;
      }
      return false;
    }

    const evaluation = recordError({
      errors: this.recentErrors,
      occurrence: {
        pattern: errorPattern,
        timestamp: now,
        fullMessage: messageText.substring(0, 200),
      },
      timeWindowMs: this.config.timeWindowMs,
      errorThreshold: this.config.errorThreshold,
    });
    this.recentErrors = evaluation.errors;

    if (evaluation.shouldTrip) {
      await this.trip(errorPattern, evaluation.patternCount);
      return true;
    }

    return false;
  }

  private async trip(reason: string, errorCount: number): Promise<void> {
    this.state = applyTrip(this.state, reason, Date.now());

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
    this.state = applyReset(this.state);
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
    if (shouldReleaseCooldown(this.state, Date.now(), this.config.cooldownMs)) {
      this.reset();
    }
    return this.state.isTripped;
  }

  getTripMessage(): string {
    return buildTripMessage(this.state.tripReason);
  }
}
