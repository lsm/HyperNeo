/**
 * Logger Unit Tests
 *
 * Tests the unified logger system which provides:
 * - Log levels: SILENT, ERROR, WARN, INFO, DEBUG, TRACE
 * - Environment-based defaults (test=SILENT, prod=WARN, dev=INFO)
 * - Namespace-based filtering via LOG_FILTER environment variable
 */

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
    // Defensively reset the namespace filter first in case an earlier test left
    // it empty (filter: [] disables all namespaces), then capture the baseline
    // so afterEach restores a known-good filter rather than a contaminated one.
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
    // Restore original config
    configureLogger(originalConfig);
  });

  describe('in development mode (INFO level)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      // Configure for INFO level (development default)
      configureLogger({ level: LogLevel.INFO });
      // Clear any calls from module-level logging during setup
      consoleSpy.log.mockClear();
      consoleSpy.error.mockClear();
      consoleSpy.warn.mockClear();
      consoleSpy.info.mockClear();
      consoleSpy.debug.mockClear();
    });

    test('log should output to console.info', () => {
      const logger = new Logger('TestPrefix');
      logger.log('test message', { extra: 'data' });

      // Logger output: [timestamp, namespace prefix, message]
      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      const calls = consoleSpy.info.mock.calls[0];
      expect(calls[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp (default-on)
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

      // Debug is below INFO level, so should not be called
      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });
  });

  describe('in test mode (SILENT)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
      // Configure for SILENT level (test default)
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

      // In SILENT mode, even errors are suppressed
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
      // Configure for WARN level (production default)
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

      // log() uses INFO level, which is below WARN
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    test('error should output', () => {
      const logger = new Logger('TestPrefix');
      logger.error('error message');

      // ERROR is >= WARN level
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    test('warn should output', () => {
      const logger = new Logger('TestPrefix');
      logger.warn('warning message');

      // WARN is at WARN level
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
    });

    test('info should be silent', () => {
      const logger = new Logger('TestPrefix');
      logger.info('info message');

      // INFO is below WARN level
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
      const logger = new Logger('TestPrefix'); // becomes hyperneo:daemon:testprefix
      logger.info('info message');

      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
    });
  });
});
