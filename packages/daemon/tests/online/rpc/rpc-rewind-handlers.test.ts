import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Rewind RPC Handlers', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30_000);

  afterEach(async () => {
    if (!daemon) return;
    await daemon.waitForExit();
  }, 15_000);

  async function createSession(workspacePath: string): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  describe('rewind.checkpoints', () => {
    test('should return empty checkpoints for new session', async () => {
      const sessionId = await createSession('/test/rewind-checkpoints-empty');

      const result = (await daemon.messageHub.request('rewind.checkpoints', {
        sessionId,
      })) as { rewindPoints: unknown[]; error?: string };

      expect(result.rewindPoints).toEqual([]);
      expect(result.error).toBeUndefined();
    });

    test('should return error for non-existent session', async () => {
      const result = (await daemon.messageHub.request('rewind.checkpoints', {
        sessionId: 'non-existent-session-id',
      })) as { rewindPoints: unknown[]; error?: string };

      expect(result.rewindPoints).toEqual([]);
      expect(result.error).toBe('Session not found');
    });

    test('should handle missing sessionId parameter', async () => {
      const result = (await daemon.messageHub.request('rewind.checkpoints', {})) as {
        rewindPoints: unknown[];
      };

      expect(result.rewindPoints).toEqual([]);
    });
  });

  describe('rewind.preview', () => {
    test('should return error for non-existent session', async () => {
      const result = (await daemon.messageHub.request('rewind.preview', {
        sessionId: 'non-existent-session-id',
        checkpointId: 'some-checkpoint-id',
      })) as { preview: { canRewind: boolean; error?: string } };

      expect(result.preview.canRewind).toBe(false);
      expect(result.preview.error).toBe('Session not found');
    });

    test('should return error when SDK query not active', async () => {
      const sessionId = await createSession('/test/rewind-preview-no-query');

      const result = (await daemon.messageHub.request('rewind.preview', {
        sessionId,
        checkpointId: 'some-checkpoint-id',
      })) as { preview: { canRewind: boolean; error?: string } };

      expect(result.preview.canRewind).toBe(false);
      expect(result.preview.error).toBeDefined();
    });

    test('should return error for non-existent checkpoint', async () => {
      const sessionId = await createSession('/test/rewind-preview-no-checkpoint');

      const result = (await daemon.messageHub.request('rewind.preview', {
        sessionId,
        checkpointId: 'non-existent-checkpoint',
      })) as { preview: { canRewind: boolean; error?: string } };

      expect(result.preview.canRewind).toBe(false);
      expect(result.preview.error).toContain('not found');
    });
  });

  describe('rewind.execute', () => {
    test('should return error for non-existent session', async () => {
      const result = (await daemon.messageHub.request('rewind.execute', {
        sessionId: 'non-existent-session-id',
        checkpointId: 'some-checkpoint-id',
        mode: 'files',
      })) as { result: { success: boolean; error?: string } };

      expect(result.result.success).toBe(false);
      expect(result.result.error).toBe('Session not found');
    });

    test('should return error when SDK query not active', async () => {
      const sessionId = await createSession('/test/rewind-execute-no-query');

      const result = (await daemon.messageHub.request('rewind.execute', {
        sessionId,
        checkpointId: 'some-checkpoint-id',
        mode: 'files',
      })) as { result: { success: boolean; error?: string } };

      expect(result.result.success).toBe(false);
      expect(result.result.error).toBeDefined();
    });

    test('should return error for non-existent checkpoint', async () => {
      const sessionId = await createSession('/test/rewind-execute-no-checkpoint');

      const result = (await daemon.messageHub.request('rewind.execute', {
        sessionId,
        checkpointId: 'non-existent-checkpoint',
        mode: 'files',
      })) as { result: { success: boolean; error?: string } };

      expect(result.result.success).toBe(false);
      expect(result.result.error).toContain('not found');
    });

    test('should default to files mode when mode not specified', async () => {
      const sessionId = await createSession('/test/rewind-execute-default-mode');

      const result = (await daemon.messageHub.request('rewind.execute', {
        sessionId,
        checkpointId: 'some-checkpoint-id',
      })) as { result: { success: boolean; error?: string } };

      expect(result.result.success).toBe(false);
      expect(result.result.error).toContain('not found');
    });

    test('should accept conversation mode', async () => {
      const sessionId = await createSession('/test/rewind-execute-conversation-mode');

      const result = (await daemon.messageHub.request('rewind.execute', {
        sessionId,
        checkpointId: 'some-checkpoint-id',
        mode: 'conversation',
      })) as { result: { success: boolean } };

      expect(result.result.success).toBe(false);
    });

    test('should accept both mode', async () => {
      const sessionId = await createSession('/test/rewind-execute-both-mode');

      const result = (await daemon.messageHub.request('rewind.execute', {
        sessionId,
        checkpointId: 'some-checkpoint-id',
        mode: 'both',
      })) as { result: { success: boolean } };

      expect(result.result.success).toBe(false);
    });
  });

  describe('rewind handler registration', () => {
    test('should have all rewind handlers registered', async () => {
      const checkpoints = (await daemon.messageHub.request('rewind.checkpoints', {
        sessionId: 'test',
      })) as { rewindPoints: unknown[] };
      expect(checkpoints.rewindPoints).toBeDefined();

      const preview = (await daemon.messageHub.request('rewind.preview', {
        sessionId: 'test',
        checkpointId: 'test',
      })) as { preview: unknown };
      expect(preview.preview).toBeDefined();

      const execute = (await daemon.messageHub.request('rewind.execute', {
        sessionId: 'test',
        checkpointId: 'test',
      })) as { result: unknown };
      expect(execute.result).toBeDefined();
    });
  });
});
