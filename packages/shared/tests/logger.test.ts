import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  Logger,
  createLogger,
  configureLogger,
  getLoggerConfig,
  LogLevel,
  clearStructuredLogSubscribers,
  installConsoleLogCapture,
  subscribeToStructuredLogs,
  withConsoleLogCaptureSuppressed,
} from '../src/logger.ts';

describe('Logger', () => {
  let originalEnv: Record<string, string | undefined>;
  let consoleErrorMock: ReturnType<typeof mock>;
  let consoleWarnMock: ReturnType<typeof mock>;
  let consoleInfoMock: ReturnType<typeof mock>;
  let consoleLogMock: ReturnType<typeof mock>;
  let consoleDebugMock: ReturnType<typeof mock>;

  beforeEach(() => {
    originalEnv = { ...process.env };

    consoleErrorMock = mock(() => {});
    consoleWarnMock = mock(() => {});
    consoleInfoMock = mock(() => {});
    consoleLogMock = mock(() => {});
    consoleDebugMock = mock(() => {});

    console.error = consoleErrorMock;
    console.warn = consoleWarnMock;
    console.info = consoleInfoMock;
    console.log = consoleLogMock;
    console.debug = consoleDebugMock;

    configureLogger({
      level: LogLevel.INFO,
      filter: ['*'],
      excludeFilter: [],
      timestamps: false,
    });
  });

  afterEach(() => {
    clearStructuredLogSubscribers();
    process.env = originalEnv;

    configureLogger({
      level: LogLevel.INFO,
      filter: ['*'],
      excludeFilter: [],
      timestamps: false,
    });
  });

  describe('structured log events', () => {
    test('emits structured events for logger output', () => {
      const events: unknown[] = [];
      subscribeToStructuredLogs((event) => events.push(event));
      const logger = createLogger('test:structured');

      logger.warn('warning happened', { spaceId: 'space-1' });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: 'warn',
        message: 'warning happened {"spaceId":"space-1"}',
        module: 'test:structured',
        source: 'logger',
        context: { spaceId: 'space-1' },
      });
    });

    test('does not emit for filtered logger output', () => {
      configureLogger({ level: LogLevel.ERROR });
      const events: unknown[] = [];
      subscribeToStructuredLogs((event) => events.push(event));

      createLogger('test:structured').warn('hidden warning');

      expect(events).toHaveLength(0);
    });

    test('captures direct console calls without double-capturing logger calls', () => {
      const events: unknown[] = [];
      subscribeToStructuredLogs((event) => events.push(event));
      const restore = installConsoleLogCapture();
      try {
        console.error('raw console failure');
        createLogger('test:structured').error('logger failure');
      } finally {
        restore();
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ source: 'console', level: 'error' });
      expect(events[1]).toMatchObject({ source: 'logger', level: 'error' });
    });

    test('can suppress console capture around already-structured output', () => {
      const events: unknown[] = [];
      subscribeToStructuredLogs((event) => events.push(event));
      const restore = installConsoleLogCapture();
      try {
        withConsoleLogCaptureSuppressed(() => console.error('already captured'));
      } finally {
        restore();
      }

      expect(events).toHaveLength(0);
    });

    test('keeps console capture installed until every owner restores it', () => {
      const events: unknown[] = [];
      subscribeToStructuredLogs((event) => events.push(event));
      const restoreFirst = installConsoleLogCapture();
      const restoreSecond = installConsoleLogCapture();

      restoreFirst();
      console.warn('still captured');
      restoreSecond();
      console.warn('not captured');
      restoreSecond();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        source: 'console',
        level: 'warn',
        message: 'still captured',
      });
    });
  });

  describe('configureLogger', () => {
    test('should update global logger configuration', () => {
      const config = getLoggerConfig();
      expect(config.level).toBe(LogLevel.INFO);
      expect(config.filter).toEqual(['*']);
      expect(config.excludeFilter).toEqual([]);
      expect(config.timestamps).toBe(false);

      configureLogger({
        level: LogLevel.DEBUG,
        timestamps: true,
      });

      const newConfig = getLoggerConfig();
      expect(newConfig.level).toBe(LogLevel.DEBUG);
      expect(newConfig.timestamps).toBe(true);
      expect(newConfig.filter).toEqual(['*']);
      expect(newConfig.excludeFilter).toEqual([]);
    });

    test('should merge partial config with existing config', () => {
      configureLogger({
        level: LogLevel.WARN,
        filter: ['test:*'],
        excludeFilter: ['test:internal'],
      });

      const config = getLoggerConfig();
      expect(config.level).toBe(LogLevel.WARN);
      expect(config.filter).toEqual(['test:*']);
      expect(config.excludeFilter).toEqual(['test:internal']);
      expect(config.timestamps).toBe(false);
    });

    test('should update filter patterns', () => {
      configureLogger({
        filter: ['app:*', 'lib:*'],
        excludeFilter: ['app:verbose'],
      });

      const config = getLoggerConfig();
      expect(config.filter).toEqual(['app:*', 'lib:*']);
      expect(config.excludeFilter).toEqual(['app:verbose']);
    });
  });

  describe('getLoggerConfig', () => {
    test('should return a copy of the config', () => {
      const config1 = getLoggerConfig();
      config1.level = LogLevel.SILENT;

      const config2 = getLoggerConfig();
      expect(config2.level).not.toBe(LogLevel.SILENT);
    });

    test('should return current configuration', () => {
      configureLogger({
        level: LogLevel.TRACE,
        filter: ['foo:*'],
        excludeFilter: ['foo:bar'],
        timestamps: true,
      });

      const config = getLoggerConfig();
      expect(config.level).toBe(LogLevel.TRACE);
      expect(config.filter).toEqual(['foo:*']);
      expect(config.excludeFilter).toEqual(['foo:bar']);
      expect(config.timestamps).toBe(true);
    });
  });

  describe('createLogger', () => {
    test('should create logger with namespace', () => {
      const logger = createLogger('test:namespace');
      expect(logger.getNamespace()).toBe('test:namespace');
    });

    test('should create default logger without namespace', () => {
      const logger = new Logger();
      expect(logger.getNamespace()).toBe('kai');
    });

    test('should create logger with empty namespace', () => {
      const logger = new Logger('');
      expect(logger.getNamespace()).toBe('');
    });
  });

  describe('log levels', () => {
    test('should respect SILENT level', () => {
      configureLogger({ level: LogLevel.SILENT });

      const logger = createLogger('test');
      consoleInfoMock.mockClear();

      logger.info('should not log');
      logger.error('should not log');
      logger.warn('should not log');
      logger.debug('should not log');
      logger.trace('should not log');
      logger.log('should not log');

      expect(consoleInfoMock).not.toHaveBeenCalled();
    });

    test('should respect ERROR level', () => {
      configureLogger({ level: LogLevel.ERROR });

      const logger = createLogger('test');
      consoleErrorMock.mockClear();
      consoleWarnMock.mockClear();

      logger.error('error message');
      logger.warn('warn message');
      logger.info('info message');

      expect(consoleErrorMock).toHaveBeenCalled();
      expect(consoleWarnMock).not.toHaveBeenCalled();
    });

    test('should respect WARN level', () => {
      configureLogger({ level: LogLevel.WARN });

      const logger = createLogger('test');
      consoleWarnMock.mockClear();
      consoleInfoMock.mockClear();

      logger.warn('warn message');
      logger.info('info message');

      expect(consoleWarnMock).toHaveBeenCalled();
      expect(consoleInfoMock).not.toHaveBeenCalled();
    });

    test('should respect INFO level', () => {
      configureLogger({ level: LogLevel.INFO });

      const logger = createLogger('test');
      consoleInfoMock.mockClear();
      consoleDebugMock.mockClear();

      logger.info('info message');
      logger.debug('debug message');

      expect(consoleInfoMock).toHaveBeenCalled();
      expect(consoleDebugMock).not.toHaveBeenCalled();
    });

    test('should respect DEBUG level', () => {
      configureLogger({ level: LogLevel.DEBUG });

      const logger = createLogger('test');
      consoleDebugMock.mockClear();

      logger.debug('debug message');
      expect(consoleDebugMock).toHaveBeenCalled();
    });

    test('should respect TRACE level', () => {
      configureLogger({ level: LogLevel.TRACE });

      const logger = createLogger('test');
      consoleDebugMock.mockClear();

      logger.trace('trace message');
      expect(consoleDebugMock).toHaveBeenCalled();
    });

    test('should show level indicator in DEBUG mode for non-INFO levels', () => {
      configureLogger({ level: LogLevel.DEBUG });

      const logger = createLogger('test');
      consoleDebugMock.mockClear();

      logger.debug('debug message');
      expect(consoleDebugMock).toHaveBeenCalled();
      const callArgs = consoleDebugMock.mock.calls[0];
      expect(callArgs).toContainEqual('[DEBUG]');
    });
  });

  describe('namespace filtering', () => {
    test('should filter by exact namespace match', () => {
      configureLogger({ filter: ['test:allowed'] });

      const allowedLogger = createLogger('test:allowed');
      const blockedLogger = createLogger('test:blocked');

      consoleInfoMock.mockClear();

      allowedLogger.info('allowed message');
      blockedLogger.info('blocked message');

      expect(consoleInfoMock).toHaveBeenCalledTimes(1);
    });

    test('should filter by wildcard namespace prefix', () => {
      configureLogger({ filter: ['test:*'] });

      const logger1 = createLogger('test:foo');
      const logger2 = createLogger('test:bar');
      const logger3 = createLogger('other:baz');

      consoleInfoMock.mockClear();

      logger1.info('message 1');
      logger2.info('message 2');
      logger3.info('message 3');

      expect(consoleInfoMock).toHaveBeenCalledTimes(2);
    });

    test('should allow all with wildcard', () => {
      configureLogger({ filter: ['*'] });

      const logger1 = createLogger('foo:bar');
      const logger2 = createLogger('baz:qux');

      consoleInfoMock.mockClear();

      logger1.info('message 1');
      logger2.info('message 2');

      expect(consoleInfoMock).toHaveBeenCalledTimes(2);
    });

    test('should exclude specific namespaces', () => {
      configureLogger({
        filter: ['*'],
        excludeFilter: ['test:verbose'],
      });

      const normalLogger = createLogger('test:normal');
      const verboseLogger = createLogger('test:verbose');

      consoleInfoMock.mockClear();

      normalLogger.info('normal message');
      verboseLogger.info('verbose message');

      expect(consoleInfoMock).toHaveBeenCalledTimes(1);
    });

    test('should exclude wildcard namespace prefixes', () => {
      configureLogger({
        filter: ['*'],
        excludeFilter: ['test:internal:*'],
      });

      const normalLogger = createLogger('test:normal');
      const internalLogger = createLogger('test:internal:debug');

      consoleInfoMock.mockClear();

      normalLogger.info('normal message');
      internalLogger.info('internal message');

      expect(consoleInfoMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('child logger', () => {
    test('should create child logger with extended namespace', () => {
      const parent = createLogger('parent');
      const child = parent.child('child');

      expect(parent.getNamespace()).toBe('parent');
      expect(child.getNamespace()).toBe('parent:child');
    });

    test('should create child from child logger', () => {
      const parent = createLogger('parent');
      const child = parent.child('child');
      const grandchild = child.child('grandchild');

      expect(grandchild.getNamespace()).toBe('parent:child:grandchild');
    });

    test('should create child from empty namespace logger', () => {
      const parent = new Logger('');
      const child = parent.child('child');

      expect(child.getNamespace()).toBe('child');
    });

    test('child should respect parent filter settings', () => {
      configureLogger({
        filter: ['parent:*'],
      });

      const parent = createLogger('parent');
      const child = parent.child('child');

      consoleInfoMock.mockClear();

      child.info('child message');
      expect(consoleInfoMock).toHaveBeenCalledTimes(1);
    });

    test('child should be filtered out when namespace does not match', () => {
      configureLogger({
        filter: ['parent:*'],
        excludeFilter: ['parent:child:*'],
      });

      const parent = createLogger('parent');
      const child = parent.child('child');

      consoleInfoMock.mockClear();

      parent.info('parent message');
      child.info('child message');

      expect(consoleInfoMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearCache', () => {
    test('should clear cached enabled state', () => {
      configureLogger({
        filter: ['test:*'],
      });

      const logger = createLogger('test:namespace');

      consoleInfoMock.mockClear();
      logger.info('first message');

      configureLogger({
        filter: ['other:*'],
      });

      logger.info('second message');

      logger.clearCache();
      logger.info('third message');

      expect(consoleInfoMock).toHaveBeenCalledTimes(2);
    });

    test('should re-evaluate enabled state after cache clear', () => {
      configureLogger({
        filter: ['test:*'],
      });

      const logger = createLogger('test:namespace');

      let enabled = logger['isEnabled']();
      expect(enabled).toBe(true);

      configureLogger({
        filter: ['other:*'],
      });

      enabled = logger['isEnabled']();
      expect(enabled).toBe(true);

      logger.clearCache();

      enabled = logger['isEnabled']();
      expect(enabled).toBe(false);
    });
  });

  describe('log method (alias for info)', () => {
    test('should be an alias for info', () => {
      configureLogger({ level: LogLevel.INFO });

      const logger = createLogger('test');
      consoleInfoMock.mockClear();

      logger.log('log method message');
      logger.info('info method message');

      expect(consoleInfoMock).toHaveBeenCalledTimes(2);
    });

    test('should respect log level', () => {
      configureLogger({ level: LogLevel.WARN });

      const logger = createLogger('test');
      consoleInfoMock.mockClear();

      logger.log('should not log');
      expect(consoleInfoMock).not.toHaveBeenCalled();
    });
  });

  describe('trace method', () => {
    test('should log at TRACE level', () => {
      configureLogger({ level: LogLevel.TRACE });

      const logger = createLogger('test');
      consoleDebugMock.mockClear();

      logger.trace('trace message');
      expect(consoleDebugMock).toHaveBeenCalled();
    });

    test('should not log when level is above TRACE', () => {
      configureLogger({ level: LogLevel.DEBUG });

      const logger = createLogger('test');
      consoleDebugMock.mockClear();

      logger.trace('trace message');
      expect(consoleDebugMock).not.toHaveBeenCalled();
    });

    test('should show level indicator in DEBUG mode', () => {
      configureLogger({ level: LogLevel.TRACE });

      const logger = createLogger('test');
      consoleDebugMock.mockClear();

      logger.trace('trace message');
      const callArgs = consoleDebugMock.mock.calls[0];
      expect(callArgs).toContainEqual('[TRACE]');
    });
  });

  describe('timestamps', () => {
    test('should include timestamps when enabled', () => {
      configureLogger({ timestamps: true });

      const logger = createLogger('test');
      consoleInfoMock.mockClear();

      logger.info('message with timestamp');

      const callArgs = consoleInfoMock.mock.calls[0];
      expect(callArgs[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('should not include timestamps when disabled', () => {
      configureLogger({ timestamps: false });

      const logger = createLogger('test');
      consoleInfoMock.mockClear();

      logger.info('message without timestamp');

      const callArgs = consoleInfoMock.mock.calls[0];
      if (callArgs.length > 0) {
        expect(callArgs[0]).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });
  });

  describe('namespace prefix', () => {
    test('should include namespace in output', () => {
      configureLogger({ level: LogLevel.INFO });

      const logger = createLogger('test:namespace');
      consoleInfoMock.mockClear();

      logger.info('message');

      const callArgs = consoleInfoMock.mock.calls[0];
      expect(callArgs).toContainEqual('[test:namespace]');
    });

    test('should not include prefix for empty namespace', () => {
      configureLogger({ level: LogLevel.INFO });

      const logger = new Logger('');
      consoleInfoMock.mockClear();

      logger.info('message');

      const callArgs = consoleInfoMock.mock.calls[0];
      const hasPrefix = callArgs.some(
        (arg) => typeof arg === 'string' && arg.startsWith('[') && arg.endsWith(']')
      );
      expect(hasPrefix).toBe(false);
    });
  });

  describe('getNamespace', () => {
    test('should return the logger namespace', () => {
      const logger = createLogger('my:app:module');
      expect(logger.getNamespace()).toBe('my:app:module');
    });
  });
});
