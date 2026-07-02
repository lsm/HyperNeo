/**
 * Message RPC Handlers Tests
 *
 * Tests message-related RPC operations via WebSocket:
 * - session.export (markdown and JSON formats)
 * - message.sdkMessages (pagination)
 * - message.count
 * - message.send error handling
 *
 * MODES:
 * - Dev Proxy (default in CI): Set HYPERNEO_USE_DEV_PROXY=1 for mocked responses
 * - Real API: Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle, waitForSdkMessages } from '../../helpers/daemon-actions';

// Tests that send messages to mock SDK need longer timeout on CI
const TIMEOUT = 15000;
const IS_DEV_PROXY = process.env.HYPERNEO_USE_DEV_PROXY === '1';

describe('Message RPC Handlers', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30_000);

  afterEach(async () => {
    if (!daemon) return;
    await daemon.waitForExit();
  }, 15_000);

  async function createSessionWithMessages(title?: string): Promise<string> {
    const workspacePath = mkdtempSync(join(tmpdir(), 'hyperneo-rpc-message-'));
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      title,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    // Send a message — mock SDK will respond with assistant text + result
    await sendMessage(daemon, sessionId, 'Hello, world!');
    await waitForIdle(daemon, sessionId);

    // Wait for SDK messages to be persisted (handles race on slow CI)
    await waitForSdkMessages(daemon, sessionId, { minCount: 2 });

    return sessionId;
  }

  describe('message.sdkMessages', () => {
    test(
      'should get SDK messages for a session',
      async () => {
        const sessionId = await createSessionWithMessages();

        const result = (await daemon.messageHub.request('message.sdkMessages', {
          sessionId,
        })) as { sdkMessages: Array<Record<string, unknown>>; hasMore: boolean };

        expect(result.sdkMessages).toBeDefined();
        expect(Array.isArray(result.sdkMessages)).toBe(true);
        expect(result.sdkMessages.length).toBeGreaterThan(0);
      },
      TIMEOUT
    );

    test(
      'should support limit parameter',
      async () => {
        const sessionId = await createSessionWithMessages();

        const result = (await daemon.messageHub.request('message.sdkMessages', {
          sessionId,
          limit: 1,
        })) as { sdkMessages: Array<Record<string, unknown>>; hasMore: boolean };

        expect(result.sdkMessages).toBeDefined();
        expect(result.sdkMessages.length).toBeLessThanOrEqual(1);
      },
      TIMEOUT
    );

    test('should throw for invalid session', async () => {
      await expect(
        daemon.messageHub.request('message.sdkMessages', {
          sessionId: 'invalid-session',
        })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('message.count', () => {
    test(
      'should get message count',
      async () => {
        const sessionId = await createSessionWithMessages();

        const result = (await daemon.messageHub.request('message.count', {
          sessionId,
        })) as { count: number };

        expect(result.count).toBeDefined();
        expect(result.count).toBeGreaterThan(0);
      },
      TIMEOUT
    );

    test('should throw for invalid session', async () => {
      await expect(
        daemon.messageHub.request('message.count', {
          sessionId: 'invalid-session',
        })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('session.export', () => {
    test(
      'should export session as markdown by default',
      async () => {
        // Pass title at creation so auto-title generation is skipped,
        // avoiding a race where the async title job overwrites our title.
        const sessionId = await createSessionWithMessages('Test Export Session');

        const result = (await daemon.messageHub.request('session.export', {
          sessionId,
        })) as { markdown: string };

        expect(result.markdown).toBeDefined();
        expect(typeof result.markdown).toBe('string');
        expect(result.markdown).toContain('# Test Export Session');
        expect(result.markdown).toContain('**Session ID:**');
      },
      TIMEOUT
    );

    test(
      'should export session as markdown explicitly',
      async () => {
        const sessionId = await createSessionWithMessages();

        const result = (await daemon.messageHub.request('session.export', {
          sessionId,
          format: 'markdown',
        })) as { markdown: string };

        expect(result.markdown).toBeDefined();
        expect(typeof result.markdown).toBe('string');
      },
      TIMEOUT
    );

    test(
      'should export session as JSON',
      async () => {
        const sessionId = await createSessionWithMessages();

        const result = (await daemon.messageHub.request('session.export', {
          sessionId,
          format: 'json',
        })) as {
          session: Record<string, unknown>;
          messages: Array<Record<string, unknown>>;
        };

        expect(result.session).toBeDefined();
        expect(result.messages).toBeDefined();
        expect(Array.isArray(result.messages)).toBe(true);
      },
      TIMEOUT
    );

    (IS_DEV_PROXY ? test.skip : test)(
      'should include assistant response in markdown export',
      async () => {
        const sessionId = await createSessionWithMessages();

        const result = (await daemon.messageHub.request('session.export', {
          sessionId,
          format: 'markdown',
        })) as { markdown: string };

        // Should have assistant section with content
        expect(result.markdown).toContain('## Assistant');
      },
      TIMEOUT
    );

    test('should throw for invalid session', async () => {
      await expect(
        daemon.messageHub.request('session.export', {
          sessionId: 'invalid-session',
        })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('message.send error handling', () => {
    test('should return error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('message.send', {
          sessionId: 'non-existent',
          content: 'Hello',
        })
      ).rejects.toThrow();
    });
  });
});
