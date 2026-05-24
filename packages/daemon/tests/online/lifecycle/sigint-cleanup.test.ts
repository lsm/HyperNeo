/**
 * SDK SIGINT Cleanup Test (Online)
 *
 * Reproduces the bug where pressing Ctrl+C causes the server to hang
 * during "Stopping agent sessions..." phase.
 *
 * The bug occurs because:
 * 1. When SIGINT is received, the server initiates graceful shutdown
 * 2. AgentSession.cleanup() calls queryObject.interrupt()
 * 3. The SDK subprocess ALSO receives SIGINT (same process group)
 * 4. SDK subprocess's exitHandler rejects with "Claude Code process terminated by signal SIGINT"
 * 5. This causes cleanup to hang instead of completing
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available
 *
 * This test sends an actual SIGINT signal to reproduce the exact bug.
 * It runs the daemon app in a separate child process and communicates
 * via WebSocket for true process isolation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('SDK SIGINT Cleanup (Online)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    // Force spawned mode - this test requires a separate process to receive SIGINT
    process.env.DAEMON_TEST_SPAWN = 'true';
    daemon = await createDaemonServer();
  }, 30000);

  afterEach(async () => {
    // Always reset spawned mode flag (even if daemon is undefined)
    delete process.env.DAEMON_TEST_SPAWN;
    if (!daemon) return;
    // Kill the daemon server after each test
    // Spawned mode graceful shutdown may take longer than in-process
    daemon.kill('SIGTERM');
    await daemon.waitForExit();
  }, 30_000);

  describe('SIGINT during active SDK query', () => {
    test(
      'should complete cleanup when SIGINT received during active query',
      async () => {
        // Create a session via WebSocket RPC
        const sessionResult = (await daemon.messageHub.request('session.create', {
          workspacePath: `${TMP_DIR}/test-sigint-active-query`,
          title: 'SIGINT Cleanup Test',
        })) as { sessionId: string };

        const { sessionId } = sessionResult;
        daemon.trackSession(sessionId);

        // Send a message to start the SDK query
        // Use a long-running prompt to ensure the query is still active when we send SIGINT
        await daemon.messageHub.request('message.send', {
          sessionId,
          content: 'Please write a detailed 500-word essay about the history of computing.',
        });

        // Wait for the SDK query to start and begin processing
        // We need to wait long enough for the subprocess to be active
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Get the agent session to verify it's processing
        const sessionResult2 = (await daemon.messageHub.request('session.get', {
          sessionId,
        })) as { session: { processingState: { status: string } } };

        console.log('[TEST] Session object:', JSON.stringify(sessionResult2, null, 2));
        console.log(
          '[TEST] Processing state before SIGINT:',
          sessionResult2.session?.processingState?.status
        );

        if (!sessionResult2.session?.processingState) {
          console.log('[TEST] No processing state found, skipping status check');
        } else {
          expect(sessionResult2.session.processingState.status).toBe('processing');
        }

        // Track cleanup timing
        const cleanupStart = Date.now();

        // Send SIGINT to the daemon process (NOT the test runner)
        // This simulates pressing Ctrl+C in the terminal
        console.log(`[TEST] Sending SIGINT to daemon PID ${daemon.pid}...`);
        const killResult = daemon.kill('SIGINT');
        expect(killResult).toBe(true);

        // Wait a moment for the signal to be delivered and processed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Check that the daemon process has exited
        // The test passes if cleanup completes and the process exits
        console.log('[TEST] Checking daemon process has exited...');

        const startTime = Date.now();
        while (Date.now() - startTime < 20000) {
          // Check if process is still running
          try {
            process.kill(daemon.pid, 0); // Signal 0 checks if process exists
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch {
            // Process doesn't exist - it has exited
            console.log('[TEST] Daemon process has exited cleanly');
            const cleanupDuration = Date.now() - cleanupStart;
            console.log(`[TEST] Total cleanup time: ${cleanupDuration}ms`);

            // Should complete within 20 seconds
            expect(cleanupDuration).toBeLessThan(20000);
            return; // Test passes
          }
        }

        throw new Error('Daemon process did not exit within 20 seconds after SIGINT');
      },
      { timeout: 30000 }
    );
  });
});
