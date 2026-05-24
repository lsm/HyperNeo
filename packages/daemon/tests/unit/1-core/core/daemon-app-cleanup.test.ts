/**
 * Daemon App Cleanup Tests
 *
 * Tests for the daemon app cleanup logic, specifically:
 * - Pending RPC calls timeout behavior
 * - setInterval cleanup to prevent hangs on exit
 *
 * OFFLINE TESTS - No API calls required
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearStructuredLogSubscribers,
  installConsoleLogCapture,
  subscribeToStructuredLogs,
} from '@neokai/shared';
import { createDaemonApp } from '../../../../src/app';
import type { Config } from '../../../../src/config';

describe('Daemon App Cleanup', () => {
  let config: Config;
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;
  let originalAnthropicApiKey: string | undefined;
  let originalClaudeCodeOAuthToken: string | undefined;
  let originalAnthropicAuthToken: string | undefined;
  let originalGlmApiKey: string | undefined;
  let bunServeSpy: ReturnType<typeof spyOn> | null = null;
  const logs: string[] = [];

  beforeEach(() => {
    // Force unauthenticated startup for deterministic unit timing.
    // This avoids model initialization paths that can hit SDK/network timeouts in CI.
    originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    originalClaudeCodeOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    originalGlmApiKey = process.env.GLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.GLM_API_KEY;

    // Capture console output for verification
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));

    // Avoid real socket binding in unit tests.
    bunServeSpy = spyOn(Bun, 'serve').mockImplementation(
      (_opts: Parameters<typeof Bun.serve>[0]) =>
        ({
          stop() {},
        }) as never
    );
    clearStructuredLogSubscribers();

    // Use in-memory database for tests
    const tmpDir = process.env.TMPDIR || '/tmp';
    config = {
      host: 'localhost',
      port: 0, // Random port
      defaultModel: 'claude-sonnet-4-5-20250929',
      maxTokens: 8192,
      temperature: 1.0,
      dbPath: ':memory:',
      maxSessions: 10,
      nodeEnv: 'test',
      disableWorktrees: true,
    };
  });

  afterEach(() => {
    // Restore auth env vars
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

    // Restore console
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
    test('should complete cleanup immediately when no pending calls', async () => {
      const daemonContext = await createDaemonApp({
        config,
        verbose: true,
        standalone: false,
      });

      const messageHub = daemonContext.messageHub;

      // Verify no pending calls
      expect(messageHub.getPendingCallCount()).toBe(0);

      // Cleanup should complete quickly
      const cleanupStart = Date.now();
      await daemonContext.cleanup();
      const cleanupDuration = Date.now() - cleanupStart;

      // Session cleanup includes a 1s drain sleep per active session,
      // so the total is ~2s (Neo session + session pool drain).
      expect(cleanupDuration).toBeLessThan(3500);

      // Verify success message
      const successLog = logs.find((log) => log.includes('Graceful shutdown complete'));
      expect(successLog).toBeTruthy();
    });

    test('should timeout and complete cleanup when pending calls never resolve', {
      timeout: 10_000,
    }, async () => {
      // This test specifically verifies the bug fix:
      // The setInterval must be cleared when the timeout fires first
      // Otherwise the process will hang on exit

      const daemonContext = await createDaemonApp({
        config,
        verbose: true,
        standalone: false,
      });

      const messageHub = daemonContext.messageHub;

      // Manually inject a mock pending call count
      // We'll monkey-patch getPendingCallCount to simulate hanging calls
      const originalGetPendingCallCount = messageHub.getPendingCallCount.bind(messageHub);
      let callCount = 5; // Simulate 5 hanging calls
      let callCountReturns = 0;

      messageHub.getPendingCallCount = () => {
        callCountReturns++;
        // Always return > 0 to simulate hanging calls
        return callCount;
      };

      // Run cleanup - this should timeout after 3 seconds
      // The critical bug fix: the setInterval must be cleared
      const cleanupStart = Date.now();
      await daemonContext.cleanup();
      const cleanupDuration = Date.now() - cleanupStart;

      // Restore original method
      messageHub.getPendingCallCount = originalGetPendingCallCount;

      // Cleanup should complete within ~3.5 seconds (3s timeout + overhead)
      // The bug would cause this to hang forever because the setInterval never clears
      expect(cleanupDuration).toBeGreaterThan(2500); // At least 2.5s (timeout period)
      expect(cleanupDuration).toBeLessThan(7000); // 3s timeout + 2s session cleanup + overhead

      // Verify the timeout message was logged
      const timeoutLog = logs.find(
        (log) => log.includes('Timeout:') && log.includes('calls still pending')
      );
      expect(timeoutLog).toBeTruthy();

      // Verify cleanup completed despite timeout
      const completeLog = logs.find((log) => log.includes('Graceful shutdown complete'));
      expect(completeLog).toBeTruthy();

      // Verify the interval was checked multiple times before timeout
      // This proves the setInterval was running
      expect(callCountReturns).toBeGreaterThan(10);
    });

    test('should stop checking immediately when pending calls reach zero', async () => {
      const daemonContext = await createDaemonApp({
        config,
        verbose: true,
        standalone: false,
      });

      const messageHub = daemonContext.messageHub;

      // Monkey-patch to simulate calls that resolve quickly
      const originalGetPendingCallCount = messageHub.getPendingCallCount.bind(messageHub);
      let checkCount = 0;

      messageHub.getPendingCallCount = () => {
        checkCount++;
        // Return 5 for first few checks, then 0
        if (checkCount < 5) {
          return 5;
        }
        return 0; // Calls resolved
      };

      // Run cleanup
      const cleanupStart = Date.now();
      await daemonContext.cleanup();
      const cleanupDuration = Date.now() - cleanupStart;

      // Restore original method
      messageHub.getPendingCallCount = originalGetPendingCallCount;

      // Should complete quickly since calls "resolved", but session cleanup
      // adds ~2s (1s drain sleep per active session in QueryLifecycleManager).
      expect(cleanupDuration).toBeLessThan(4000);

      // Verify success message (all calls completed)
      const completeLog = logs.find((log) => log.includes('All pending calls completed'));
      expect(completeLog).toBeTruthy();

      // Verify we didn't check many times (stopped when count hit 0)
      expect(checkCount).toBeLessThan(10);
    });
  });

  describe('unauthenticated startup', () => {
    let savedApiKey: string | undefined;
    let savedOAuthToken: string | undefined;
    let savedAuthToken: string | undefined;
    let savedGlmKey: string | undefined;

    beforeEach(() => {
      // Save and clear all credential env vars
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
      savedGlmKey = process.env.GLM_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.GLM_API_KEY;
    });

    afterEach(() => {
      // Restore credential env vars
      if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
      if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
      if (savedAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
      if (savedGlmKey !== undefined) process.env.GLM_API_KEY = savedGlmKey;
    });

    test('should start without credentials and log guidance', async () => {
      // Create config without any API key
      const unauthConfig = { ...config };
      delete unauthConfig.anthropicApiKey;
      delete unauthConfig.claudeCodeOAuthToken;
      delete unauthConfig.anthropicAuthToken;

      const daemonContext = await createDaemonApp({
        config: unauthConfig,
        verbose: true,
        standalone: false,
      });

      // Verify guidance was logged
      const noCredsLog = logs.find((log) => log.includes('NO CREDENTIALS DETECTED'));
      expect(noCredsLog).toBeTruthy();

      const skipModelLog = logs.find((log) => log.includes('Model initialization skipped'));
      expect(skipModelLog).toBeTruthy();

      // Should still have basic components
      expect(daemonContext.server).toBeDefined();
      expect(daemonContext.authManager).toBeDefined();
      expect(daemonContext.messageHub).toBeDefined();

      // Cleanup
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

      // Core context components must be present
      expect(daemonContext.server).toBeDefined();
      expect(daemonContext.authManager).toBeDefined();
      expect(daemonContext.messageHub).toBeDefined();
      expect(daemonContext.sessionManager).toBeDefined();
      expect(daemonContext.settingsManager).toBeDefined();
      expect(daemonContext.fileIndex).toBeDefined();

      // FileIndex should be ready=false (no workspace path provided)
      expect(daemonContext.fileIndex.isReady()).toBe(false);

      // Cleanup
      await daemonContext.cleanup();
    });
  });

  describe('lock file cleanup on graceful shutdown', () => {
    let tmpDbDir: string;

    beforeEach(() => {
      tmpDbDir = join(
        tmpdir(),
        `neokai-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(tmpDbDir, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(tmpDbDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
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

      // Lock file must exist while the daemon is running
      expect(existsSync(lockPath)).toBe(true);

      // Graceful shutdown
      await daemonContext.cleanup();

      // Lock file must be removed after cleanup
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

      // At least one 'exit' listener should have been added by DatabaseLock
      expect(process.listenerCount('exit')).toBeGreaterThan(exitListenersBefore);

      // After cleanup the listener should be removed
      await daemonContext.cleanup();

      expect(process.listenerCount('exit')).toBe(exitListenersBefore);
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
