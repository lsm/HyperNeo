import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Model Switching', () => {
  let daemon: DaemonServerContext;

  beforeAll(async () => {
    daemon = await createDaemonServer();
  }, 15_000);

  afterAll(async () => {
    await daemon?.waitForExit();
  }, 15_000);

  async function createSession(
    workspacePath: string,
    config?: Record<string, unknown>
  ): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      config,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  describe('session.model.get', () => {
    test('should return current model for new session', async () => {
      const sessionId = await createSession('/test/model-get');

      const result = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      expect(result).toBeDefined();
      expect(result.currentModel).toBeString();
      expect(result.currentModel.length).toBeGreaterThan(0);
    });

    test('should return model info if available', async () => {
      const sessionId = await createSession('/test/model-info', { model: 'default' });

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

    test('should throw error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.model.get', {
          sessionId: 'non-existent-session',
        })
      ).rejects.toThrow();
    });
  });

  describe('session.model.switch error handling', () => {
    test('should throw error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.model.switch', {
          sessionId: 'non-existent-session',
          model: 'sonnet',
          provider: 'anthropic',
        })
      ).rejects.toThrow();
    });
  });
});
