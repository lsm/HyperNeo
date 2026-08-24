export enum LogLevel {
  SILENT = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  TRACE = 5,
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  silent: LogLevel.SILENT,
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
  trace: LogLevel.TRACE,
};

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.SILENT]: 'SILENT',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.TRACE]: 'TRACE',
};

export interface LoggerConfig {
  level: LogLevel;
  filter: string[];
  excludeFilter: string[];
  timestamps: boolean;
}

export interface LoggerOptions {
  consoleDeltas?: boolean;
}

export type StructuredLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type StructuredLogSource = 'logger' | 'console' | 'process';

export interface StructuredLogContext {
  spaceId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  [key: string]: unknown;
}

export interface StructuredLogProcessMetadata {
  pid?: number;
  memory?: NodeJS.MemoryUsage;
  uptime?: number;
}

export interface StructuredLogEvent {
  id: string;
  timestamp: number;
  level: StructuredLogLevel;
  message: string;
  module?: string;
  source: StructuredLogSource;
  stack?: string;
  context: StructuredLogContext;
  process: StructuredLogProcessMetadata;
  metadata: Record<string, unknown>;
}

export type StructuredLogSubscriber = (event: StructuredLogEvent) => void;

export interface EmitStructuredLogEventParams {
  level: StructuredLogLevel;
  args: unknown[];
  source: StructuredLogSource;
  module?: string;
  metadata?: Record<string, unknown>;
}

function getEnv(name: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }
  const globalEnv = (globalThis as unknown as Record<string, unknown>).ENV;
  if (globalEnv && typeof globalEnv === 'object') {
    return (globalEnv as Record<string, string>)[name];
  }
  return undefined;
}

function getDefaultLevel(): LogLevel {
  const nodeEnv = getEnv('NODE_ENV');

  const logLevelStr = getEnv('LOG_LEVEL')?.toLowerCase();
  if (logLevelStr && logLevelStr in LOG_LEVEL_MAP) {
    return LOG_LEVEL_MAP[logLevelStr];
  }

  switch (nodeEnv) {
    case 'test':
      return LogLevel.SILENT;
    case 'production':
      return LogLevel.WARN;
    case 'development':
    default:
      return LogLevel.INFO;
  }
}

function parseFilter(): { include: string[]; exclude: string[] } {
  const filterStr = getEnv('LOG_FILTER');
  const include: string[] = [];
  const exclude: string[] = [];

  if (!filterStr) {
    return { include: ['*'], exclude: [] };
  }

  for (const pattern of filterStr.split(',')) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('-')) {
      exclude.push(trimmed.slice(1));
    } else {
      include.push(trimmed);
    }
  }

  if (include.length === 0) {
    include.push('*');
  }

  return { include, exclude };
}

function matchesPattern(namespace: string, pattern: string): boolean {
  if (pattern === '*') return true;

  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return namespace === pattern.slice(0, -2) || namespace.startsWith(prefix);
  }

  return namespace === pattern;
}

function shouldLog(namespace: string, include: string[], exclude: string[]): boolean {
  for (const pattern of exclude) {
    if (matchesPattern(namespace, pattern)) {
      return false;
    }
  }

  for (const pattern of include) {
    if (matchesPattern(namespace, pattern)) {
      return true;
    }
  }

  return false;
}

let globalConfig: LoggerConfig = {
  level: getDefaultLevel(),
  ...parseFilter(),
  filter: parseFilter().include,
  excludeFilter: parseFilter().exclude,
  timestamps: true,
};

const structuredLogSubscribers = new Set<StructuredLogSubscriber>();
let previousLoggerConsoleTime: number | null = null;
let consoleCaptureRestore: (() => void) | null = null;
let consoleCaptureRefCount = 0;
let suppressConsoleCapture = false;

export function subscribeToStructuredLogs(subscriber: StructuredLogSubscriber): () => void {
  structuredLogSubscribers.add(subscriber);
  return () => structuredLogSubscribers.delete(subscriber);
}

export function clearStructuredLogSubscribers(): void {
  structuredLogSubscribers.clear();
}

export function resetConsoleLogCaptureForTesting(): void {
  if (process.env.NODE_ENV !== 'test') return;
  consoleCaptureRestore?.();
  consoleCaptureRestore = null;
  consoleCaptureRefCount = 0;
  suppressConsoleCapture = false;
}

export function emitStructuredLogEvent(params: EmitStructuredLogEventParams): StructuredLogEvent {
  const timestamp = Date.now();
  const event: StructuredLogEvent = {
    id: createLogEventId(timestamp),
    timestamp,
    level: params.level,
    message: formatStructuredLogMessage(params.args),
    module: params.module,
    source: params.source,
    stack: extractStack(params.args),
    context: extractLogContext(params.args),
    process: getProcessMetadata(),
    metadata: {
      argTypes: params.args.map((arg) => (arg instanceof Error ? 'Error' : typeof arg)),
      ...params.metadata,
    },
  };
  for (const subscriber of structuredLogSubscribers) {
    try {
      subscriber(event);
    } catch {}
  }
  return event;
}

export function withConsoleLogCaptureSuppressed<T>(callback: () => T): T {
  const wasSuppressed = suppressConsoleCapture;
  suppressConsoleCapture = true;
  try {
    return callback();
  } finally {
    suppressConsoleCapture = wasSuppressed;
  }
}

export function installConsoleLogCapture(): () => void {
  consoleCaptureRefCount += 1;
  let restored = false;
  if (!consoleCaptureRestore) {
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const wrap = (method: keyof typeof original, level: StructuredLogLevel) => {
      return (...args: unknown[]) => {
        if (!suppressConsoleCapture) {
          emitStructuredLogEvent({
            level,
            args,
            source: 'console',
            metadata: { consoleMethod: method },
          });
        }
        return original[method](...args);
      };
    };
    console.log = wrap('log', 'info');
    console.info = wrap('info', 'info');
    console.warn = wrap('warn', 'warn');
    console.error = wrap('error', 'error');
    console.debug = wrap('debug', 'debug');
    consoleCaptureRestore = () => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug;
      consoleCaptureRestore = null;
    };
  }
  return () => {
    if (restored) return;
    restored = true;
    consoleCaptureRefCount = Math.max(0, consoleCaptureRefCount - 1);
    if (consoleCaptureRefCount === 0) consoleCaptureRestore?.();
  };
}

function createLogEventId(timestamp: number): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `log_${timestamp}_${random}`;
}

function getProcessMetadata(): StructuredLogProcessMetadata {
  if (typeof process === 'undefined') return {};
  return {
    pid: process.pid,
    memory: typeof process.memoryUsage === 'function' ? process.memoryUsage() : undefined,
    uptime: typeof process.uptime === 'function' ? process.uptime() : undefined,
  };
}

function formatStructuredLogMessage(args: unknown[]): string {
  return args.map(formatLogArg).join(' ').slice(0, 1000);
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null) return String(arg);
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function extractStack(args: unknown[]): string | undefined {
  return args.find((arg): arg is Error => arg instanceof Error)?.stack;
}

function extractLogContext(args: unknown[]): StructuredLogContext {
  const context: StructuredLogContext = {};
  for (const arg of args) {
    if (!arg || typeof arg !== 'object' || arg instanceof Error) continue;
    const record = arg as Record<string, unknown>;
    copyString(record, context, 'spaceId');
    copyString(record, context, 'sessionId');
    copyString(record, context, 'taskId');
    copyString(record, context, 'runId');
    if (record.context && typeof record.context === 'object') {
      const nested = record.context as Record<string, unknown>;
      copyString(nested, context, 'spaceId');
      copyString(nested, context, 'sessionId');
      copyString(nested, context, 'taskId');
      copyString(nested, context, 'runId');
    }
  }
  return context;
}

function copyString(
  source: Record<string, unknown>,
  target: StructuredLogContext,
  key: 'spaceId' | 'sessionId' | 'taskId' | 'runId'
): void {
  if (typeof source[key] === 'string' && !target[key]) target[key] = source[key] as string;
}

export function configureLogger(config: Partial<LoggerConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

export function getLoggerConfig(): LoggerConfig {
  return { ...globalConfig };
}

export class Logger {
  private readonly namespace: string;
  private readonly prefix: string;
  private readonly consoleDeltas: boolean;
  private cachedEnabled: boolean | null = null;

  constructor(namespace: string = 'kai', options: LoggerOptions = {}) {
    this.namespace = namespace;
    this.prefix = namespace ? `[${namespace}]` : '';
    this.consoleDeltas = options.consoleDeltas ?? false;
  }

  private isEnabled(): boolean {
    if (this.cachedEnabled !== null) {
      return this.cachedEnabled;
    }

    this.cachedEnabled = shouldLog(this.namespace, globalConfig.filter, globalConfig.excludeFilter);
    return this.cachedEnabled;
  }

  clearCache(): void {
    this.cachedEnabled = null;
  }

  private shouldLogLevel(level: LogLevel): boolean {
    return level <= globalConfig.level && this.isEnabled();
  }

  private formatMessage(level: LogLevel, args: unknown[]): unknown[] {
    const parts: unknown[] = [];

    if (globalConfig.timestamps) {
      parts.push(new Date().toISOString());
    }

    if (this.prefix) {
      parts.push(this.prefix);
    }

    if (globalConfig.level >= LogLevel.DEBUG && level !== LogLevel.INFO) {
      parts.push(`[${LOG_LEVEL_NAMES[level]}]`);
    }

    return [...parts, ...args];
  }

  private emitAndWrite(
    logLevel: LogLevel,
    structuredLevel: StructuredLogLevel,
    consoleMethod: 'debug' | 'info' | 'warn' | 'error',
    args: unknown[]
  ): void {
    emitStructuredLogEvent({
      level: structuredLevel,
      args,
      source: 'logger',
      module: this.namespace,
      metadata: { loggerLevel: LOG_LEVEL_NAMES[logLevel] },
    });
    const formatted = this.formatMessage(logLevel, args);
    if (this.consoleDeltas) {
      const consoleTime = performance.now();
      const delta =
        previousLoggerConsoleTime === null ? 0 : consoleTime - previousLoggerConsoleTime;
      previousLoggerConsoleTime = consoleTime;
      formatted.push(`+${Math.round(delta)}ms`);
    }
    withConsoleLogCaptureSuppressed(() => {
      console[consoleMethod](...formatted);
    });
  }

  child(name: string): Logger {
    const childNamespace = this.namespace ? `${this.namespace}:${name}` : name;
    return new Logger(childNamespace, { consoleDeltas: this.consoleDeltas });
  }

  trace(...args: unknown[]): void {
    if (this.shouldLogLevel(LogLevel.TRACE)) {
      this.emitAndWrite(LogLevel.TRACE, 'trace', 'debug', args);
    }
  }

  debug(...args: unknown[]): void {
    if (this.shouldLogLevel(LogLevel.DEBUG)) {
      this.emitAndWrite(LogLevel.DEBUG, 'debug', 'debug', args);
    }
  }

  info(...args: unknown[]): void {
    if (this.shouldLogLevel(LogLevel.INFO)) {
      this.emitAndWrite(LogLevel.INFO, 'info', 'info', args);
    }
  }

  log(...args: unknown[]): void {
    this.info(...args);
  }

  warn(...args: unknown[]): void {
    if (this.shouldLogLevel(LogLevel.WARN)) {
      this.emitAndWrite(LogLevel.WARN, 'warn', 'warn', args);
    }
  }

  error(...args: unknown[]): void {
    if (this.shouldLogLevel(LogLevel.ERROR)) {
      this.emitAndWrite(LogLevel.ERROR, 'error', 'error', args);
    }
  }

  getNamespace(): string {
    return this.namespace;
  }
}

export function createLogger(namespace: string, options?: LoggerOptions): Logger {
  return new Logger(namespace, options);
}
