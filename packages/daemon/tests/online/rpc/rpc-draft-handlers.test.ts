/**
 * Draft RPC Handlers Tests
 *
 * Tests for input draft persistence via session metadata:
 * - session.get (includes inputDraft)
 * - session.update (accepts inputDraft in metadata)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Draft RPC Handlers', () => {
  let daemon: DaemonServerContext;

  beforeAll(async () => {
    daemon = await createDaemonServer();
  }, 15_000);

  afterAll(async () => {
    await daemon?.waitForExit();
  }, 15_000);

  async function createSession(workspacePath: string): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  describe('Draft persistence via RPC', () => {
    test('session.get should include inputDraft in response', async () => {
      const sessionId = await createSession('/test/draft-get');

      // Set inputDraft via RPC
      await daemon.messageHub.request('session.update', {
        sessionId,
        metadata: { inputDraft: 'test draft content' },
      });

      // Get session and verify inputDraft is included
      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { metadata: { inputDraft?: string } } };

      expect(session.metadata.inputDraft).toBe('test draft content');
    });

    test('session.update should accept inputDraft in metadata', async () => {
      const sessionId = await createSession('/test/draft-update');

      const result = (await daemon.messageHub.request('session.update', {
        sessionId,
        metadata: { inputDraft: 'new draft content' },
      })) as { success: boolean };

      expect(result.success).toBe(true);

      // Verify database updated correctly
      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { metadata: { inputDraft?: string } } };

      expect(session.metadata.inputDraft).toBe('new draft content');
    });

    test('session.update should merge partial metadata including inputDraft', async () => {
      const sessionId = await createSession('/test/draft-merge');

      // Set initial metadata
      await daemon.messageHub.request('session.update', {
        sessionId,
        metadata: { messageCount: 5, titleGenerated: true },
      });

      // Update only inputDraft
      await daemon.messageHub.request('session.update', {
        sessionId,
        metadata: { inputDraft: 'merged draft' },
      });

      // Verify merge behavior
      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as {
        session: {
          metadata: { inputDraft?: string; messageCount?: number; titleGenerated?: boolean };
        };
      };

      expect(session.metadata.inputDraft).toBe('merged draft');
      expect(session.metadata.messageCount).toBe(5);
      expect(session.metadata.titleGenerated).toBe(true);
    });

    test('should clear inputDraft via session.update', async () => {
      const sessionId = await createSession('/test/draft-clear');

      // Set inputDraft
      await daemon.messageHub.request('session.update', {
        sessionId,
        metadata: { inputDraft: 'draft to clear' },
      });

      // Clear inputDraft
      await daemon.messageHub.request('session.update', {
        sessionId,
        metadata: { inputDraft: null },
      });

      // Verify cleared
      const { session } = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { metadata: { inputDraft?: string } } };

      expect(session.metadata.inputDraft).toBeUndefined();
    });
  });
});
