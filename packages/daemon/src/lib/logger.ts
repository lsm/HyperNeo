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

export class Logger {
  private sharedLogger: SharedLogger;

  constructor(prefix: string) {
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
