import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('GLM Model Switching', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 20000);

  describe('Switch to GLM model', () => {
    test('should switch from Claude to GLM model', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-switch-to-glm`,
        title: 'Switch to GLM Test',
        config: {
          model: 'haiku',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const result = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      })) as { success: boolean; model: string; error?: string };

      expect(result.success).toBe(true);
      expect(result.model).toBe('glm-5');
      expect(result.error).toBeUndefined();

      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config: { model: string } } };

      expect(sessionResult.session.config.model).toBe('glm-5');
    });

    test('should preserve session state when switching to GLM', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-glm-state-preservation`,
        title: 'GLM State Preservation Test',
        config: {
          model: 'haiku',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const sessionBefore = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as {
        session: {
          id: string;
          title: string;
          workspacePath: string;
          status: string;
        };
      };

      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      });

      const sessionAfter = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as {
        session: {
          id: string;
          title: string;
          workspacePath: string;
          status: string;
          config: { model: string };
        };
      };

      expect(sessionAfter.session.id).toBe(sessionBefore.session.id);
      expect(sessionAfter.session.title).toBe(sessionBefore.session.title);
      expect(sessionAfter.session.workspacePath).toBe(sessionBefore.session.workspacePath);
      expect(sessionAfter.session.status).toBe(sessionBefore.session.status);

      expect(sessionAfter.session.config.model).toBe('glm-5');
    });
  });

  describe('GLM model switching edge cases', () => {
    test('should handle rapid switches involving GLM', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-rapid-glm-switches`,
        title: 'Rapid GLM Switches Test',
        config: {
          model: 'haiku',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const switches: Array<{ model: string; provider: string }> = [
        { model: 'glm-5', provider: 'glm' },
        { model: 'haiku', provider: 'anthropic' },
        { model: 'glm-5', provider: 'glm' },
        { model: 'sonnet', provider: 'anthropic' },
        { model: 'glm-5', provider: 'glm' },
      ];

      for (const { model, provider } of switches) {
        const result = (await daemon.messageHub.request('session.model.switch', {
          sessionId,
          model,
          provider,
        })) as { success: boolean };
        expect(result.success).toBe(true);
      }

      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };
      expect(modelInfo.currentModel).toBe('glm-5');
    });

    test('should switch to GLM before first message', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-glm-before-message`,
        title: 'GLM Before Message Test',
        config: {
          model: 'haiku',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const result = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      })) as { success: boolean; model: string };

      expect(result.success).toBe(true);
      expect(result.model).toBe('glm-5');

      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config: { model: string } } };
      expect(sessionResult.session.config.model).toBe('glm-5');
    });
  });
});
