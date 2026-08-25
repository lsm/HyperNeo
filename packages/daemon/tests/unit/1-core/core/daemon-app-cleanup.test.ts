import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonApp, releaseStartupFileLogCapture } from '../../../../src/app';
import type { Config } from '../../../../src/config';
import {
  clearProviderFailure,
  recordClassifiedProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';
import {
  clearStructuredLogSubscribers,
  emitStructuredLogEvent,
  installConsoleLogCapture,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger';

if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
  (globalThis as { Bun?: unknown }).Bun = {
    serve: () => ({ stop() {} }),
  };
}

describe('Daemon App Cleanup', () => {
  let config: Config;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalAnthropicApiKey: string | undefined;
  let originalClaudeCodeOAuthToken: string | undefined;
  let originalAnthropicAuthToken: string | undefined;
  let originalGlmApiKey: string | undefined;
  let originalTestUserSettingsDir: string | undefined;
  let originalAcpCommand: string | undefined;
  let bunServeSpy: ReturnType<typeof spyOn> | null = null;
  const logs: string[] = [];

  beforeEach(() => {
    originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    originalClaudeCodeOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    originalGlmApiKey = process.env.GLM_API_KEY;
    originalTestUserSettingsDir = process.env.TEST_USER_SETTINGS_DIR;
    originalAcpCommand = process.env.HYPERNEO_ACP_COMMAND;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.GLM_API_KEY;
    delete process.env.HYPERNEO_ACP_COMMAND;

    clearStructuredLogSubscribers();

    process.env.TEST_USER_SETTINGS_DIR = join(tmpdir(), `hyperneo-test-settings-${Date.now()}`);

    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));

    bunServeSpy = spyOn(Bun, 'serve').mockImplementation(
      (_opts: Parameters<typeof Bun.serve>[0]) =>
        ({
          stop() {},
        }) as never
    );

    config = {
      host: 'localhost',
      port: 0,
      defaultModel: 'claude-sonnet-4-5-20250929',
      maxTokens: 8192,
      temperature: 1.0,
      dbPath: ':memory:',
      maxSessions: 10,
      maxSubscriptionsPerClient: 128,
      nodeEnv: 'test',
      disableWorktrees: true,
      structuredLogMaxBytes: 10 * 1024 * 1024,
      structuredLogRetainedFiles: 5,
      structuredLogMaxPendingBytes: 2 * 1024 * 1024,
    };
  });

  afterEach(() => {
    if (originalAnthropicApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (originalClaudeCodeOAuthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeCodeOAuthToken;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (originalAnthropicAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
    if (originalGlmApiKey !== undefined) {
      process.env.GLM_API_KEY = originalGlmApiKey;
    } else {
      delete process.env.GLM_API_KEY;
    }
    if (originalTestUserSettingsDir !== undefined) {
      process.env.TEST_USER_SETTINGS_DIR = originalTestUserSettingsDir;
    } else {
      delete process.env.TEST_USER_SETTINGS_DIR;
    }
    if (originalAcpCommand !== undefined) {
      process.env.HYPERNEO_ACP_COMMAND = originalAcpCommand;
    } else {
      delete process.env.HYPERNEO_ACP_COMMAND;
    }

    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    if (bunServeSpy) {
      bunServeSpy.mockRestore();
      bunServeSpy = null;
    }
    clearStructuredLogSubscribers();
    logs.length = 0;
  });

  describe('pending RPC calls timeout', () => {
    test('should complete cleanup immediately when no pending calls', {
      timeout: 10_000,
    }, async () => {
      const daemonContext = await createDaemonApp({
        config,
        verbose: true,
        standalone: false,
      });

      const messageHub = daemonContext.messageHub;

      expect(messageHub.getPendingCallCount()).toBe(0);

      const cleanupStart = Date.now();
      await daemonContext.cleanup();
      const cleanupDuration = Date.now() - cleanupStart;

      expect(cleanupDuration).toBeLessThan(3500);

      const successLog = logs.find((log) => log.includes('Graceful shutdown complete'));
      expect(successLog).toBeTruthy();
    });

    test('starts and stops OAuth refresh scheduler', { timeout: 10_000 }, async () => {
      const daemonContext = await createDaemonApp({
        config,
        verbose: true,
        standalone: false,
      });

      const activeHandlesBeforeCleanup = process._getActiveHandles().length;
      await daemonContext.cleanup();
      const activeHandlesAfterCleanup = process._getActiveHandles().length;

      expect(activeHandlesAfterCleanup).toBeLessThanOrEqual(activeHandlesBeforeCleanup);
      expect(logs.some((log) => log.includes('OAuth refresh scheduler stopped'))).toBe(true);
    });

    test('should timeout and complete cleanup when pending calls never resolve', {
      timeout: 10_000,
    }, async () => {
      const daemonContext = await createDaemonApp({
        config,
        verbose: true,
        standalone: false,
      });

      const messageHub = daemonContext.messageHub;

      const originalGetPendingCallCount = messageHub.getPendingCallCount.bind(messageHub);
      const callCount = 5;
      let callCountReturns = 0;

      messageHub.getPendingCallCount = () => {
        callCountReturns++;
        return callCount;
      };

      const cleanupStart = Date.now();
      await daemonContext.cleanup();
      const cleanupDuration = Date.now() - cleanupStart;

      messageHub.getPendingCallCount = originalGetPendingCallCount;

      expect(cleanupDuration).toBeGreaterThan(2500);
      expect(cleanupDuration).toBeLessThan(7000);

      const timeoutLog = logs.find(
        (log) => log.includes('Timeout:') && log.includes('calls still pending')
      );
      expect(timeoutLog).toBeTruthy();

      const completeLog = logs.find((log) => log.includes('Graceful shutdown complete'));
      expect(completeLog).toBeTruthy();

      expect(callCountReturns).toBeGreaterThan(10);
    });

    test('should stop checking immediately when pending calls reach zero', async () => {
      const daemonContext = await createDaemonApp({
        config,
        verbose: true,
        standalone: false,
      });

      const messageHub = daemonContext.messageHub;

      const originalGetPendingCallCount = messageHub.getPendingCallCount.bind(messageHub);
      let checkCount = 0;

      messageHub.getPendingCallCount = () => {
        checkCount++;
        if (checkCount < 5) {
          return 5;
        }
        return 0;
      };

      const cleanupStart = Date.now();
      await daemonContext.cleanup();
      const cleanupDuration = Date.now() - cleanupStart;

      messageHub.getPendingCallCount = originalGetPendingCallCount;

      expect(cleanupDuration).toBeLessThan(4000);

      const completeLog = logs.find((log) => log.includes('All pending calls completed'));
      expect(completeLog).toBeTruthy();

      expect(checkCount).toBeLessThan(10);
    });
  });

  describe('unauthenticated startup', () => {
    let savedApiKey: string | undefined;
    let savedOAuthToken: string | undefined;
    let savedAuthToken: string | undefined;
    let savedGlmKey: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
      savedGlmKey = process.env.GLM_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.GLM_API_KEY;
      delete process.env.HYPERNEO_ACP_COMMAND;
    });

    afterEach(() => {
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
      if (savedAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
      if (savedGlmKey !== undefined) process.env.GLM_API_KEY = savedGlmKey;
    });

    test('should start without credentials and log guidance', async () => {
      const unauthConfig = { ...config };
      delete unauthConfig.anthropicApiKey;
      delete unauthConfig.claudeCodeOAuthToken;
      delete unauthConfig.anthropicAuthToken;

      const daemonContext = await createDaemonApp({
        config: unauthConfig,
        verbose: true,
        standalone: false,
      });

      const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');
      const hasAnthropicAuth = getProviderRegistry().get('anthropic')?.isAvailable() ?? false;

      if (hasAnthropicAuth) {
        expect(logs.some((log) => log.includes('NO CREDENTIALS DETECTED'))).toBe(false);
      } else {
        const noCredsLog = logs.find((log) => log.includes('NO CREDENTIALS DETECTED'));
        expect(noCredsLog).toBeTruthy();

        const skipModelLog = logs.find((log) => log.includes('Model initialization skipped'));
        expect(skipModelLog).toBeTruthy();
      }

      expect(daemonContext.server).toBeDefined();
      expect(daemonContext.authManager).toBeDefined();
      expect(daemonContext.messageHub).toBeDefined();

      await daemonContext.cleanup();
    });
  });

  describe('daemon startup (no workspace required)', () => {
    test('should restore structured log capture when startup fails', async () => {
      const originalError = console.error;
      const alreadyInstalledRestore = installConsoleLogCapture();
      alreadyInstalledRestore();
      bunServeSpy?.mockImplementationOnce(() => {
        throw new Error('bind failed');
      });

      await expect(
        createDaemonApp({
          config,
          verbose: true,
          standalone: false,
        })
      ).rejects.toThrow('bind failed');

      expect(console.error).toBe(originalError);
      expect(logs.some((log) => log.includes('OAuth refresh scheduler stopped'))).toBe(false);
    });

    test('a failed startup strands a reclaimable file-log capture, not a leak', async () => {
      const directory = join(tmpdir(), `hyperneo-file-log-${Date.now()}`);
      const path = join(directory, 'daemon.jsonl');
      try {
        bunServeSpy?.mockImplementationOnce(() => {
          throw new Error('bind failed');
        });
        await expect(
          createDaemonApp({
            config: { ...config, structuredLogFilePath: path },
            verbose: false,
            standalone: false,
          })
        ).rejects.toThrow('bind failed');

        emitStructuredLogEvent({
          level: 'error',
          args: ['stranded startup capture flush check'],
          source: 'process',
        });
        await releaseStartupFileLogCapture();
        const records = readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { message: string });
        expect(
          records.some((record) => record.message.includes('stranded startup capture flush check'))
        ).toBe(true);

        await releaseStartupFileLogCapture();
        bunServeSpy?.mockImplementationOnce(() => {
          throw new Error('bind failed again');
        });
        await expect(
          createDaemonApp({
            config: { ...config, structuredLogFilePath: path },
            verbose: false,
            standalone: false,
          })
        ).rejects.toThrow('bind failed again');
        await releaseStartupFileLogCapture();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test('persists startup and final shutdown logs to the configured file', async () => {
      const directory = join(tmpdir(), `hyperneo-file-log-${Date.now()}`);
      const path = join(directory, 'daemon.jsonl');
      try {
        const daemonContext = await createDaemonApp({
          config: { ...config, structuredLogFilePath: path },
          verbose: true,
          standalone: false,
        });

        await daemonContext.cleanup();
        const records = readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { message: string });

        expect(records.some((record) => record.message.includes('[startup 1]'))).toBe(true);
        expect(
          records.some((record) => record.message.includes('[Daemon] Graceful shutdown complete'))
        ).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test('should capture logError aliases created during startup', async () => {
      const events: unknown[] = [];
      const unsubscribe = subscribeToStructuredLogs((event) => events.push(event));
      try {
        const daemonContext = await createDaemonApp({
          config,
          verbose: true,
          standalone: false,
        });

        console.error('post-start error alias check');
        await daemonContext.cleanup();
      } finally {
        unsubscribe();
      }

      expect(events).toContainEqual(
        expect.objectContaining({
          message: 'post-start error alias check',
          source: 'console',
        })
      );
    });

    test('should start successfully with default config', async () => {
      const daemonContext = await createDaemonApp({
        config,
        verbose: true,
        standalone: false,
      });

      expect(daemonContext.server).toBeDefined();
      expect(daemonContext.authManager).toBeDefined();
      expect(daemonContext.messageHub).toBeDefined();
      expect(daemonContext.sessionManager).toBeDefined();
      expect(daemonContext.settingsManager).toBeDefined();
      expect(daemonContext.fileIndex).toBeDefined();

      expect(daemonContext.fileIndex.isReady()).toBe(false);

      await daemonContext.cleanup();
    });
  });

  describe('lock file cleanup on graceful shutdown', () => {
    let tmpDbDir: string;

    beforeEach(() => {
      tmpDbDir = join(
        tmpdir(),
        `hyperneo-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(tmpDbDir, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tmpDbDir, { recursive: true, force: true });
      } catch {}
    });

    test('should remove the lock file after cleanup() when using a file-based DB', async () => {
      const tmpDbPath = join(tmpDbDir, 'daemon.db');
      const lockPath = `${tmpDbPath}.lock`;

      const fileConfig: Config = {
        ...config,
        dbPath: tmpDbPath,
      };

      const daemonContext = await createDaemonApp({
        config: fileConfig,
        verbose: false,
        standalone: false,
      });

      expect(existsSync(lockPath)).toBe(true);

      await daemonContext.cleanup();

      expect(existsSync(lockPath)).toBe(false);
    });

    test('should have process.exit fallback handler registered after startup', async () => {
      const tmpDbPath = join(tmpDbDir, 'daemon-exit.db');
      const lockPath = `${tmpDbPath}.lock`;

      const fileConfig: Config = {
        ...config,
        dbPath: tmpDbPath,
      };

      const exitListenersBefore = process.listenerCount('exit');

      const daemonContext = await createDaemonApp({
        config: fileConfig,
        verbose: false,
        standalone: false,
      });

      expect(process.listenerCount('exit')).toBeGreaterThan(exitListenersBefore);

      await daemonContext.cleanup();

      expect(process.listenerCount('exit')).toBe(exitListenersBefore);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe('provider failure health propagation', () => {
    test('marks provider health unhealthy on a recorded failure and healthy when it clears', {
      timeout: 10_000,
    }, async () => {
      const daemonContext = await createDaemonApp({
        config,
        verbose: false,
        standalone: false,
      });
      try {
        const db = daemonContext.db.getDatabase();
        db.exec(
          `INSERT OR IGNORE INTO providers
             (id, provider_id, display_name, kind, auth_type, is_enabled, is_default, sort_order, health_status, created_at, updated_at)
           VALUES
             ('test-failure-provider', 'test-failure-provider', 'Test', 'built_in', 'api_key', 1, 0, 0, 'unknown', 0, 0)`
        );
        const readHealth = () =>
          (
            db
              .prepare(
                "SELECT health_status FROM providers WHERE provider_id = 'test-failure-provider'"
              )
              .get() as { health_status: string }
          )?.health_status;

        recordClassifiedProviderFailure('test-failure-provider', {
          errorKind: 'credential',
          message: 'Request failed (http 401)',
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(readHealth()).toBe('unhealthy');

        clearProviderFailure('test-failure-provider');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(readHealth()).toBe('healthy');
      } finally {
        resetProviderFailureStore();
        await daemonContext.cleanup();
      }
    });
  });
});
