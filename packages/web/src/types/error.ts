/**
 * Error types matching daemon's ErrorManager
 * These types should be kept in sync with packages/daemon/src/lib/error-manager.ts
 */

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
