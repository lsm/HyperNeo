import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Logger, LogLevel, configureLogger, getLoggerConfig } from '../../../../src/lib/logger';

describe('Logger', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;
  let consoleSpy: {
    log: ReturnType<typeof spyOn>;
    error: ReturnType<typeof spyOn>;
    warn: ReturnType<typeof spyOn>;
    info: ReturnType<typeof spyOn>;
    debug: ReturnType<typeof spyOn>;
  };
  let originalConfig: ReturnType<typeof getLoggerConfig>;

  beforeEach(() => {
    configureLogger({ filter: ['*'] });
    originalConfig = getLoggerConfig();
    consoleSpy = {
      log: spyOn(console, 'log').mockImplementation(() => {}),
      error: spyOn(console, 'error').mockImplementation(() => {}),
      warn: spyOn(console, 'warn').mockImplementation(() => {}),
      info: spyOn(console, 'info').mockImplementation(() => {}),
      debug: spyOn(console, 'debug').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.LOG_LEVEL = originalLogLevel;
    consoleSpy.log.mockRestore();
    consoleSpy.error.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.info.mockRestore();
    consoleSpy.debug.mockRestore();
    configureLogger(originalConfig);
  });

  describe('in development mode (INFO level)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      configureLogger({ level: LogLevel.INFO });
      consoleSpy.log.mockClear();
      consoleSpy.error.mockClear();
      consoleSpy.warn.mockClear();
      consoleSpy.info.mockClear();
      consoleSpy.debug.mockClear();
    });

    test('log should output to console.info', () => {
      const logger = new Logger('TestPrefix');
      logger.log('test message', { extra: 'data' });

      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      const calls = consoleSpy.info.mock.calls[0];
      expect(calls[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(calls[1]).toContain('hyperneo:daemon:testprefix');
      expect(calls[2]).toBe('test message');
    });

    test('error should output to console.error', () => {
      const logger = new Logger('TestPrefix');
      logger.error('error message', new Error('test'));

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      const calls = consoleSpy.error.mock.calls[0];
      expect(calls[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(calls[1]).toContain('hyperneo:daemon:testprefix');
      expect(calls[2]).toBe('error message');
    });

    test('warn should output to console.warn', () => {
      const logger = new Logger('TestPrefix');
      logger.warn('warning message');

      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      const calls = consoleSpy.warn.mock.calls[0];
      expect(calls[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(calls[1]).toContain('hyperneo:daemon:testprefix');
      expect(calls[2]).toBe('warning message');
    });

    test('info should output to console.info', () => {
      const logger = new Logger('TestPrefix');
      logger.info('info message');

      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      const calls = consoleSpy.info.mock.calls[0];
      expect(calls[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(calls[1]).toContain('hyperneo:daemon:testprefix');
      expect(calls[2]).toBe('info message');
    });

    test('debug should NOT output at INFO level', () => {
      const logger = new Logger('TestPrefix');
      logger.debug('debug message');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });
  });

  describe('in test mode (SILENT)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
      configureLogger({ level: LogLevel.SILENT });
      consoleSpy.log.mockClear();
      consoleSpy.error.mockClear();
      consoleSpy.warn.mockClear();
      consoleSpy.info.mockClear();
      consoleSpy.debug.mockClear();
    });

    test('log should be silent', () => {
      const logger = new Logger('TestPrefix');
      logger.log('test message');

      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    test('error should be silent', () => {
      const logger = new Logger('TestPrefix');
      logger.error('error message');

      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    test('warn should be silent', () => {
      const logger = new Logger('TestPrefix');
      logger.warn('warning message');

      expect(consoleSpy.warn).not.toHaveBeenCalled();
    });

    test('info should be silent', () => {
      const logger = new Logger('TestPrefix');
      logger.info('info message');

      expect(consoleSpy.info).not.toHaveBeenCalled();
    });
  });

  describe('in production mode (WARN level)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      configureLogger({ level: LogLevel.WARN });
      consoleSpy.log.mockClear();
      consoleSpy.error.mockClear();
      consoleSpy.warn.mockClear();
      consoleSpy.info.mockClear();
      consoleSpy.debug.mockClear();
    });

    test('log should be silent', () => {
      const logger = new Logger('TestPrefix');
      logger.log('test message');

      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    test('error should output', () => {
      const logger = new Logger('TestPrefix');
      logger.error('error message');

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    test('warn should output', () => {
      const logger = new Logger('TestPrefix');
      logger.warn('warning message');

      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
    });

    test('info should be silent', () => {
      const logger = new Logger('TestPrefix');
      logger.info('info message');

      expect(consoleSpy.info).not.toHaveBeenCalled();
    });
  });

  describe('SILENT mode', () => {
    beforeEach(() => {
      configureLogger({ level: LogLevel.SILENT });
      consoleSpy.log.mockClear();
      consoleSpy.error.mockClear();
      consoleSpy.warn.mockClear();
      consoleSpy.info.mockClear();
      consoleSpy.debug.mockClear();
    });

    test('nothing should output', () => {
      const logger = new Logger('TestPrefix');
      logger.error('error');
      logger.warn('warn');
      logger.info('info');
      logger.log('log');
      logger.debug('debug');

      expect(consoleSpy.error).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });
  });

  describe('DEBUG mode', () => {
    beforeEach(() => {
      configureLogger({ level: LogLevel.DEBUG });
      consoleSpy.log.mockClear();
      consoleSpy.error.mockClear();
      consoleSpy.warn.mockClear();
      consoleSpy.info.mockClear();
      consoleSpy.debug.mockClear();
    });

    test('debug should output', () => {
      const logger = new Logger('TestPrefix');
      logger.debug('debug message');

      expect(consoleSpy.debug).toHaveBeenCalledTimes(1);
    });

    test('all levels should output', () => {
      const logger = new Logger('TestPrefix');
      logger.error('error');
      logger.warn('warn');
      logger.info('info');
      logger.debug('debug');

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      expect(consoleSpy.debug).toHaveBeenCalledTimes(1);
    });
  });

  describe('namespace filtering', () => {
    beforeEach(() => {
      configureLogger({
        level: LogLevel.DEBUG,
        filter: ['hyperneo:daemon:*'],
        excludeFilter: [],
      });
      consoleSpy.log.mockClear();
      consoleSpy.error.mockClear();
      consoleSpy.warn.mockClear();
      consoleSpy.info.mockClear();
      consoleSpy.debug.mockClear();
    });

    test('matching namespace should log', () => {
      const logger = new Logger('TestPrefix');
      logger.info('info message');

      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
    });
  });
});
