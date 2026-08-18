import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Model RPC Handlers', () => {
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

  describe('session.model.get', () => {
    test('should return error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.model.get', {
          sessionId: 'non-existent',
        })
      ).rejects.toThrow();
    });

    test('should return current model for existing session', async () => {
      const sessionId = await createSession('/test/model-get');

      const result = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo: unknown };

      expect(result.currentModel).toBeString();
      expect(result.modelInfo).toBeDefined();
    });

    test('should return model info if available', async () => {
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: '/test/model-info',
        config: { model: 'default' },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      const result = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as {
        currentModel: string;
        modelInfo?: { id: string; name: string; family: string };
      };

      expect(result.currentModel).toBeOneOf(['default', 'sonnet']);
      if (result.modelInfo) {
        expect(result.modelInfo.id).toBeOneOf(['default', 'sonnet']);
        expect(result.modelInfo.name).toBeString();
        expect(result.modelInfo.family).toBeOneOf(['opus', 'sonnet', 'haiku']);
      }
    });
  });

  describe('session.model.switch', () => {
    test('should return error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.model.switch', {
          sessionId: 'non-existent',
          model: 'claude-opus-4-20250514',
          provider: 'anthropic',
        })
      ).rejects.toThrow();
    });

    test('should return failure for invalid model', async () => {
      const sessionId = await createSession('/test/model-switch');

      const result = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'invalid-model-name',
        provider: 'anthropic',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should accept same model switch', async () => {
      const sessionId = await createSession('/test/model-switch-same');

      const { currentModel } = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      const result = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: currentModel,
        provider: 'anthropic',
      })) as { success: boolean; model: string };

      expect(result.success).toBe(true);
      expect(result.model).toBe(currentModel);
    });
  });

  describe('models.clearCache', () => {
    test('should clear model cache successfully', async () => {
      const result = (await daemon.messageHub.request('models.clearCache', {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
    });
  });
});
