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
  PROVIDER_AUTH_ERROR = 'provider_auth_error',
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
