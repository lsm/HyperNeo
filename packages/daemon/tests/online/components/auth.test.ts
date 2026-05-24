/**
 * Authentication Integration Tests (API-dependent)
 *
 * Tests for authentication functionality that requires API credentials.
 * These tests verify that authenticated sessions work correctly.
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODEL:
 * - Uses 'haiku-4.5' (faster and cheaper than Sonnet for tests)
 * - Note: Short alias 'haiku' doesn't work with Claude OAuth (SDK hangs)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Authentication Integration (API-dependent)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 15000);

  describe('Session Creation with Auth', () => {
    test('should create session only if authenticated', async () => {
      const result = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-auth`,
        title: 'Auth Test Session',
        config: { model: 'haiku-4.5' },
      })) as { sessionId: string };
      daemon.trackSession(result.sessionId);

      expect(result.sessionId).toBeString();

      // Verify session was created via RPC
      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId: result.sessionId,
      })) as { session: Record<string, unknown> };

      expect(sessionResult.session).toBeDefined();
      expect(sessionResult.session.id).toBe(result.sessionId);
      expect(sessionResult.session.title).toBe('Auth Test Session');
    });
  });
});
