/**
 * ErrorManager - Centralized error handling and categorization
 *
 * Provides structured error handling with proper user-facing messages
 * and error categorization for better debugging and user experience.
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonInternalEventMap, InternalEventBus } from './internal-event-bus';
import { Logger } from './logger';

export enum ErrorCategory {
  AUTHENTICATION = 'authentication',
  CONNECTION = 'connection',
  SESSION = 'session',
  MESSAGE = 'message',
  MODEL = 'model',
  SYSTEM = 'system',
  VALIDATION = 'validation',
  TIMEOUT = 'timeout',
  PERMISSION = 'permission',
  RATE_LIMIT = 'rate_limit',
  /** Provider-specific authentication failure (expired token, OAuth revoked, etc.) */
  PROVIDER_AUTH_ERROR = 'provider_auth_error',
  /** Provider bridge/service is unreachable or temporarily unavailable */
  PROVIDER_UNAVAILABLE = 'provider_unavailable',
}

export interface StructuredError {
  category: ErrorCategory;
  code: string;
  message: string;
  userMessage: string;
  details?: unknown;
  recoverable: boolean;
  timestamp: string;
  // Rich error context for debugging and UI improvements
  stack?: string;
  sessionContext?: {
    sessionId: string;
    processingState?: {
      status: string;
      messageId?: string;
      phase?: string;
    };
    messageBeingProcessed?: string;
  };
  recoverySuggestions?: string[];
  metadata?: Record<string, unknown>;
}

export class ErrorManager {
  private logger = new Logger('ErrorManager');
  // Error throttling: track recent errors to prevent flooding client with duplicates
  private recentErrors: Map<string, { count: number; lastSeen: number; firstSeen: number }> =
    new Map();
  private readonly ERROR_THROTTLE_WINDOW_MS = 10000; // 10 second window
  private readonly MAX_ERRORS_PER_WINDOW = 3; // Max 3 identical errors per window

  // API connection state tracking
  private apiConnectionErrors = 0; // Consecutive connection errors
  private lastApiError: string | undefined;
  private lastSuccessfulApiCall = Date.now();
  private currentApiStatus: 'connected' | 'degraded' | 'disconnected' = 'connected';

  constructor(
    private messageHub: MessageHub,
    private internalEventBus?: InternalEventBus<DaemonInternalEventMap>
  ) {}

  /**
   * Create a structured error from various error types
   */
  createError(
    error: Error | string,
    category: ErrorCategory = ErrorCategory.SYSTEM,
    userMessage?: string,
    sessionContext?: StructuredError['sessionContext'],
    metadata?: Record<string, unknown>
  ): StructuredError {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = this.extractErrorCode(errorMessage);
    const stack = error instanceof Error ? error.stack : undefined;

    // Capture additional error properties (cause, code, etc.)
    const enhancedMetadata = { ...metadata };
    if (error instanceof Error) {
      // Capture error.cause if available (Node.js 16.9.0+)
      if ('cause' in error && error.cause) {
        enhancedMetadata.errorCause =
          error.cause instanceof Error
            ? {
                message: error.cause.message,
                stack: error.cause.stack,
                name: error.cause.name,
              }
            : String(error.cause);
      }

      // Capture any additional properties on the error object
      const errorObj = error as unknown as Record<string, unknown>;
      const standardProps = ['name', 'message', 'stack', 'cause'];
      for (const [key, value] of Object.entries(errorObj)) {
        if (!standardProps.includes(key) && value !== undefined) {
          enhancedMetadata[`error_${key}`] = value;
        }
      }
    }

    const structuredError: StructuredError = {
      category,
      code: errorCode,
      message: errorMessage,
      userMessage: userMessage || this.getUserFriendlyMessage(category, errorCode, errorMessage),
      recoverable: this.isRecoverable(category, errorCode),
      timestamp: new Date().toISOString(),
      stack,
      sessionContext,
      metadata: enhancedMetadata,
    };

    // Add recovery suggestions
    structuredError.recoverySuggestions = this.getRecoverySuggestions(category, errorCode);

    return structuredError;
  }

  /**
   * Extract error code from error message
   */
  private extractErrorCode(message: string): string {
    // Check for common error patterns
    if (message.includes('401') || message.includes('unauthorized')) {
      return 'UNAUTHORIZED';
    }
    if (message.includes('403') || message.includes('forbidden')) {
      return 'FORBIDDEN';
    }
    if (message.includes('404') || message.includes('not found')) {
      return 'NOT_FOUND';
    }
    if (message.includes('429') || message.includes('rate limit')) {
      return 'RATE_LIMITED';
    }
    if (message.includes('timeout')) {
      return 'TIMEOUT';
    }
    if (message.includes('ECONNREFUSED') || message.includes('connection refused')) {
      return 'CONNECTION_REFUSED';
    }
    if (message.includes('ENOTFOUND') || message.includes('EHOSTUNREACH')) {
      return 'HOST_UNREACHABLE';
    }
    if (
      message.includes('insufficient_quota') ||
      message.includes('quota exceeded') ||
      message.includes('no quota') ||
      message.includes('402')
    ) {
      return 'QUOTA_EXCEEDED';
    }
    if (message.includes('invalid_api_key')) {
      return 'INVALID_API_KEY';
    }
    if (message.includes('model_not_found')) {
      return 'MODEL_NOT_FOUND';
    }

    return 'UNKNOWN';
  }

  /**
   * Generate user-friendly error message
   */
  private getUserFriendlyMessage(
    category: ErrorCategory,
    code: string,
    originalMessage: string
  ): string {
    // Category-specific messages
    switch (category) {
      case ErrorCategory.AUTHENTICATION:
        switch (code) {
          case 'INVALID_API_KEY':
            return 'Invalid API key. Please check your configuration.';
          case 'UNAUTHORIZED':
            return 'Authentication failed. Please verify your credentials.';
          case 'FORBIDDEN':
            return "Access denied. You don't have permission to perform this action.";
          default:
            return 'Authentication error. Please check your credentials.';
        }

      case ErrorCategory.CONNECTION:
        switch (code) {
          case 'CONNECTION_REFUSED':
            return 'Unable to connect to the server. Please check if the service is running.';
          case 'HOST_UNREACHABLE':
            return 'Cannot reach the server. Please check your network connection.';
          case 'TIMEOUT':
            return 'Connection timed out. The server may be experiencing high load.';
          default:
            return 'Connection error. Please check your network and try again.';
        }

      case ErrorCategory.SESSION:
        switch (code) {
          case 'NOT_FOUND':
            return 'Session not found. It may have been deleted or expired.';
          default:
            return 'Session error. Please try creating a new session.';
        }

      case ErrorCategory.MESSAGE:
        if (originalMessage.includes('context length')) {
          return 'Message exceeds context limit. Consider starting a new conversation.';
        }
        return 'Failed to process message. Please try again.';

      case ErrorCategory.MODEL:
        switch (code) {
          case 'MODEL_NOT_FOUND':
            return 'The requested model is not available. Please choose a different model.';
          default:
            return 'Model error. Please try a different model.';
        }

      case ErrorCategory.RATE_LIMIT:
        switch (code) {
          case 'RATE_LIMITED':
            return 'Rate limit exceeded. Please wait a moment before trying again.';
          case 'QUOTA_EXCEEDED':
            return 'API quota exceeded. Please check your usage limits.';
          default:
            return 'Request limit reached. Please slow down and try again.';
        }

      case ErrorCategory.TIMEOUT:
        return 'Request timed out. Please try again.';

      case ErrorCategory.VALIDATION:
        return 'Invalid request. Please check your input and try again.';

      case ErrorCategory.PERMISSION:
        return "Permission denied. You don't have access to this resource.";

      case ErrorCategory.PROVIDER_AUTH_ERROR:
        return 'Authentication with the provider has expired. Please re-authenticate to continue.';

      case ErrorCategory.PROVIDER_UNAVAILABLE:
        return 'The provider is temporarily unavailable. You can switch to another provider or try again.';

      case ErrorCategory.SYSTEM:
      default:
        if (originalMessage.includes('ENOSPC')) {
          return 'Disk space full. Please free up some space and try again.';
        }
        if (originalMessage.includes('ENOMEM')) {
          return 'Out of memory. Please close some applications and try again.';
        }
        return 'An unexpected error occurred. Please try again or contact support if the issue persists.';
    }
  }

  /**
   * Determine if error is recoverable
   */
  private isRecoverable(category: ErrorCategory, code: string): boolean {
    // Non-recoverable errors
    if (category === ErrorCategory.AUTHENTICATION && code === 'INVALID_API_KEY') {
      return false;
    }
    if (category === ErrorCategory.PERMISSION) {
      return false;
    }
    if (code === 'QUOTA_EXCEEDED') {
      return false;
    }

    // Most other errors are recoverable (can retry)
    return true;
  }

  /**
   * Get recovery suggestions for error
   */
  private getRecoverySuggestions(category: ErrorCategory, code: string): string[] {
    const suggestions: string[] = [];

    switch (category) {
      case ErrorCategory.AUTHENTICATION:
        if (code === 'INVALID_API_KEY') {
          suggestions.push('Check your API key in environment variables');
          suggestions.push('Ensure ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set correctly');
        } else {
          suggestions.push('Verify your authentication credentials');
          suggestions.push('Try logging in again');
        }
        break;

      case ErrorCategory.CONNECTION:
        suggestions.push('Check your internet connection');
        suggestions.push('Verify the service is running and accessible');
        if (code === 'TIMEOUT') {
          suggestions.push('Try again in a moment - the server may be under load');
        }
        break;

      case ErrorCategory.RATE_LIMIT:
        if (code === 'QUOTA_EXCEEDED') {
          suggestions.push('Check your API usage limits');
          suggestions.push('Contact support to increase your quota');
        } else {
          suggestions.push('Wait a few moments before trying again');
          suggestions.push('Reduce the frequency of requests');
        }
        break;

      case ErrorCategory.MESSAGE:
        suggestions.push('Try sending your message again');
        suggestions.push('If the error persists, try starting a new session');
        break;

      case ErrorCategory.MODEL:
        suggestions.push('Try using a different model');
        suggestions.push('Check that the model ID is correct');
        break;

      case ErrorCategory.SESSION:
        suggestions.push('Create a new session');
        suggestions.push('Check that the session still exists');
        break;

      case ErrorCategory.PROVIDER_AUTH_ERROR:
        suggestions.push('Open Provider Settings to re-authenticate');
        suggestions.push('Check that your provider credentials have not expired');
        suggestions.push('Try switching to a different provider temporarily');
        break;

      case ErrorCategory.PROVIDER_UNAVAILABLE:
        suggestions.push('Switch to a different provider (e.g. Anthropic) from the model picker');
        suggestions.push('Check that the provider bridge server is running');
        suggestions.push('Wait a moment and try again');
        break;

      default:
        suggestions.push('Try the operation again');
        suggestions.push('If the issue persists, check the error details below');
    }

    return suggestions;
  }

  /**
   * Check if error should be throttled based on recent occurrences
   */
  private shouldThrottleError(sessionId: string, category: ErrorCategory, code: string): boolean {
    const key = `${sessionId}:${category}:${code}`;
    const now = Date.now();
    const existing = this.recentErrors.get(key);

    if (!existing) {
      // First occurrence - allow and track
      this.recentErrors.set(key, { count: 1, lastSeen: now, firstSeen: now });
      return false;
    }

    // Check if we're still in the throttle window
    const timeSinceFirst = now - existing.firstSeen;
    if (timeSinceFirst > this.ERROR_THROTTLE_WINDOW_MS) {
      // Window expired - reset and allow
      this.recentErrors.set(key, { count: 1, lastSeen: now, firstSeen: now });
      return false;
    }

    // Still in window - check count
    existing.count++;
    existing.lastSeen = now;
    this.recentErrors.set(key, existing);

    if (existing.count > this.MAX_ERRORS_PER_WINDOW) {
      // Throttle this error
      if (existing.count === this.MAX_ERRORS_PER_WINDOW + 1) {
        // Log once when throttling starts
        this.logger.error(
          `[ErrorManager] Throttling error ${category}:${code} for session ${sessionId} (${existing.count} occurrences in ${timeSinceFirst}ms)`
        );
      }
      return true;
    }

    return false;
  }

  /**
   * Cleanup old throttle entries (called periodically)
   */
  private cleanupThrottleMap(): void {
    const now = Date.now();
    for (const [key, value] of this.recentErrors.entries()) {
      if (now - value.lastSeen > this.ERROR_THROTTLE_WINDOW_MS * 2) {
        this.recentErrors.delete(key);
      }
    }
  }

  /**
   * Update API connection status and broadcast if changed
   */
  private async updateApiConnectionStatus(
    category: ErrorCategory,
    code: string,
    errorMessage?: string
  ): Promise<void> {
    let newStatus: 'connected' | 'degraded' | 'disconnected' = this.currentApiStatus;

    // Track connection-related errors
    if (
      category === ErrorCategory.CONNECTION ||
      category === ErrorCategory.TIMEOUT ||
      category === ErrorCategory.PROVIDER_UNAVAILABLE
    ) {
      this.apiConnectionErrors++;
      this.lastApiError = errorMessage;

      // Determine status based on consecutive errors
      if (this.apiConnectionErrors >= 5) {
        newStatus = 'disconnected';
      } else if (this.apiConnectionErrors >= 2) {
        newStatus = 'degraded';
      }
    }

    // Broadcast if status changed
    if (newStatus !== this.currentApiStatus) {
      this.currentApiStatus = newStatus;

      // Emit via InternalEventBus<DaemonInternalEventMap> for internal server-side listeners (StateManager)
      // API connection is a global event (not session-specific)
      if (this.internalEventBus) {
        this.internalEventBus.publishAsync('api.connection', {
          sessionId: 'global',
          status: newStatus,
          errorCount: this.apiConnectionErrors,
          lastError: this.lastApiError,
          lastSuccessfulCall: this.lastSuccessfulApiCall,
          timestamp: Date.now(),
        });
      }

      this.logger.error(
        `[ErrorManager] API connection status changed: ${this.currentApiStatus} → ${newStatus} (${this.apiConnectionErrors} errors)`
      );
    }
  }

  /**
   * Mark successful API call (resets error count)
   */
  async markApiSuccess(): Promise<void> {
    const hadErrors = this.apiConnectionErrors > 0;
    this.apiConnectionErrors = 0;
    this.lastApiError = undefined;
    this.lastSuccessfulApiCall = Date.now();

    // If we had errors, broadcast recovery
    if (hadErrors && this.currentApiStatus !== 'connected') {
      this.currentApiStatus = 'connected';

      // Emit via InternalEventBus<DaemonInternalEventMap> for internal server-side listeners (StateManager)
      // API connection is a global event (not session-specific)
      if (this.internalEventBus) {
        this.internalEventBus.publishAsync('api.connection', {
          sessionId: 'global',
          status: 'connected',
          errorCount: 0,
          lastSuccessfulCall: this.lastSuccessfulApiCall,
          timestamp: Date.now(),
        });
      }

      this.logger.error('[ErrorManager] API connection recovered');
    }
  }

  /**
   * Get current API connection state
   */
  getApiConnectionState() {
    return {
      status: this.currentApiStatus,
      errorCount: this.apiConnectionErrors,
      lastError: this.lastApiError,
      lastSuccessfulCall: this.lastSuccessfulApiCall,
      timestamp: Date.now(),
    };
  }

  /**
   * Broadcast error to clients (with throttling)
   * Emits via EventBus for StateManager to fold into state.session
   */
  async broadcastError(sessionId: string, error: StructuredError): Promise<void> {
    // Update API connection status (for connection/timeout errors)
    await this.updateApiConnectionStatus(error.category, error.code, error.message);

    // Check if this error should be throttled
    if (this.shouldThrottleError(sessionId, error.category, error.code)) {
      // Don't broadcast throttled errors
      return;
    }

    // Emit via InternalEventBus<DaemonInternalEventMap> for StateManager to fold into state.session
    if (this.internalEventBus) {
      this.internalEventBus.publishAsync('session.error', {
        sessionId,
        error: error.userMessage,
        details: error,
      });
    }

    // Periodically cleanup old entries (every 100 errors)
    if (this.recentErrors.size > 100) {
      this.cleanupThrottleMap();
    }
  }

  /**
   * Handle and broadcast error with rich context
   */
  async handleError(
    sessionId: string,
    error: Error | string,
    category: ErrorCategory = ErrorCategory.SYSTEM,
    userMessage?: string,
    processingState?: {
      status: string;
      messageId?: string;
      phase?: string;
    },
    metadata?: Record<string, unknown>
  ): Promise<StructuredError> {
    // Build session context
    const sessionContext: StructuredError['sessionContext'] = {
      sessionId,
      processingState,
    };

    const structuredError = this.createError(
      error,
      category,
      userMessage,
      sessionContext,
      metadata
    );

    // Log for debugging (include stack trace in dev mode)
    if (structuredError.stack) {
      this.logger.error(`[ErrorManager] ${category}:`, {
        code: structuredError.code,
        message: structuredError.message,
        sessionId,
        stack: structuredError.stack,
      });
    } else {
      this.logger.error(`[ErrorManager] ${category}:`, {
        code: structuredError.code,
        message: structuredError.message,
        sessionId,
      });
    }

    // Broadcast to client
    await this.broadcastError(sessionId, structuredError);

    return structuredError;
  }
}
