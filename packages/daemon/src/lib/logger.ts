/**
 * Logger utility for daemon package
 *
 * This is a re-export of the shared logger with daemon-specific defaults.
 * Modules should use this Logger class for consistent logging across the daemon.
 *
 * The shared logger provides:
 * - Log levels: SILENT, ERROR, WARN, INFO, DEBUG, TRACE
 * - Environment-based defaults (test=SILENT, prod=WARN, dev=INFO)
 * - Namespace filtering via LOG_FILTER environment variable
 */

import {
  Logger as SharedLogger,
  createLogger,
  LogLevel,
  configureLogger,
  getLoggerConfig,
  subscribeToStructuredLogs,
  clearStructuredLogSubscribers,
  emitStructuredLogEvent,
  installConsoleLogCapture,
  withConsoleLogCaptureSuppressed,
} from '@hyperneo/shared';

/**
 * Logger class - wraps the shared logger for daemon compatibility
 *
 * Usage:
 *   const logger = new Logger('SessionManager');
 *   logger.info('Session created');
 */
export class Logger {
  private sharedLogger: SharedLogger;

  constructor(prefix: string) {
    // Create a shared logger with the daemon namespace prefix
    this.sharedLogger = createLogger(`hyperneo:daemon:${prefix.toLowerCase()}`);
  }

  log(...args: unknown[]): void {
    this.sharedLogger.info(...args);
  }

  error(...args: unknown[]): void {
    this.sharedLogger.error(...args);
  }

  warn(...args: unknown[]): void {
    this.sharedLogger.warn(...args);
  }

  info(...args: unknown[]): void {
    this.sharedLogger.info(...args);
  }

  debug(...args: unknown[]): void {
    this.sharedLogger.debug(...args);
  }

  trace(...args: unknown[]): void {
    this.sharedLogger.trace(...args);
  }
}

// Re-export shared logger utilities for direct usage
export {
  LogLevel,
  configureLogger,
  getLoggerConfig,
  subscribeToStructuredLogs,
  clearStructuredLogSubscribers,
  emitStructuredLogEvent,
  installConsoleLogCapture,
  withConsoleLogCaptureSuppressed,
};
export type {
  StructuredLogContext,
  StructuredLogEvent,
  StructuredLogLevel,
  StructuredLogProcessMetadata,
  StructuredLogSource,
  StructuredLogSubscriber,
} from '@hyperneo/shared';
