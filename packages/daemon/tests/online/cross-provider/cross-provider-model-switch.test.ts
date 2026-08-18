import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import { waitForSystemInit } from '../../helpers/sdk-message-helpers';
import { MinimaxProvider } from '../../../src/lib/providers/minimax-provider';
import { GlmProvider } from '../../../src/lib/providers/glm-provider';

const TMP_DIR = process.env.TMPDIR || '/tmp';

function requireProvidersOrFail(): void {
  const hasMinimax = new MinimaxProvider().isAvailable();
  const hasGlm = new GlmProvider().isAvailable();

  if (!hasMinimax || !hasGlm) {
    const missing: string[] = [];
    if (!hasMinimax) missing.push('MINIMAX_API_KEY');
    if (!hasGlm) missing.push('GLM_API_KEY or ZHIPU_API_KEY');
    throw new Error(
      `Cross-provider tests require both MiniMax and GLM credentials. Missing: ${missing.join(', ')}`
    );
  }
}

describe('Cross-Provider Model Switching (MiniMax <-> GLM)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    requireProvidersOrFail();
    daemon = await createDaemonServer();
  }, 30000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 20000);

  describe('1. Room Chat Session Model Switching', () => {
    test('should switch from MiniMax to GLM and continue session', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-minimax-to-glm-${Date.now()}`,
        title: 'MiniMax to GLM Test',
        config: {
          model: 'MiniMax-M2.7',
          provider: 'minimax',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const initialModel = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(initialModel.currentModel).toBe('MiniMax-M2.7');
      expect(initialModel.modelInfo?.provider).toBe('minimax');

      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      })) as { success: boolean; model: string; error?: string };

      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe('glm-5');

      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config: { model: string; provider: string } } };

      expect(sessionResult.session.config.model).toBe('glm-5');
      expect(sessionResult.session.config.provider).toBe('glm');

      const afterSwitchModel = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(afterSwitchModel.currentModel).toBe('glm-5');
      expect(afterSwitchModel.modelInfo?.provider).toBe('glm');
    });

    test('should switch from GLM to MiniMax and continue session', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-glm-to-minimax-${Date.now()}`,
        title: 'GLM to MiniMax Test',
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const initialModel = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(initialModel.currentModel).toBe('glm-5');
      expect(initialModel.modelInfo?.provider).toBe('glm');

      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      })) as { success: boolean; model: string; error?: string };

      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe('MiniMax-M2.7');

      const afterSwitchModel = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(afterSwitchModel.currentModel).toBe('MiniMax-M2.7');
      expect(afterSwitchModel.modelInfo?.provider).toBe('minimax');
    });
  });

  describe.skip('2. Cross-Provider Message Delivery', () => {
    test('should send message after model switch to GLM', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-e2e-minimax-to-glm-${Date.now()}`,
        title: 'E2E MiniMax to GLM',
        config: {
          model: 'MiniMax-M2.7',
          provider: 'minimax',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const sendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
      expect(sendResult.messageId).toBeTruthy();

      await waitForIdle(daemon, sessionId);

      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      })) as { success: boolean; model: string };

      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe('glm-5');

      const modelAfter = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(modelAfter.currentModel).toBe('glm-5');
      expect(modelAfter.modelInfo?.provider).toBe('glm');

      const glmSendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
      expect(glmSendResult.messageId).toBeTruthy();

      await waitForIdle(daemon, sessionId);
    }, 210000);

    test('should send message after model switch to MiniMax', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-e2e-glm-to-minimax-${Date.now()}`,
        title: 'E2E GLM to MiniMax',
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const glmSendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
      expect(glmSendResult.messageId).toBeTruthy();

      await waitForIdle(daemon, sessionId);

      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      })) as { success: boolean; model: string };

      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe('MiniMax-M2.7');

      const modelAfter = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(modelAfter.currentModel).toBe('MiniMax-M2.7');
      expect(modelAfter.modelInfo?.provider).toBe('minimax');

      const minimaxSendResult = await sendMessage(
        daemon,
        sessionId,
        'Reply with just the word "ok"'
      );
      expect(minimaxSendResult.messageId).toBeTruthy();

      await waitForIdle(daemon, sessionId);
    }, 210000);
  });

  describe('3. Fallback Settings Configuration', () => {
    test('should store fallback chain configuration via settings.global.update', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-fallback-chain-${Date.now()}`,
        title: 'Fallback Chain Test',
        config: {
          model: 'MiniMax-M2.7',
          provider: 'minimax',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      await daemon.messageHub.request('settings.global.update', {
        updates: {
          fallbackModels: [
            { model: 'glm-5', provider: 'glm' },
            { model: 'glm-4.7', provider: 'glm' },
          ],
        },
      });

      const settings = (await daemon.messageHub.request('settings.global.get', {})) as {
        fallbackModels?: Array<{ model: string; provider: string }>;
      };

      expect(settings.fallbackModels).toBeDefined();
      expect(settings.fallbackModels!.length).toBeGreaterThan(0);

      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      expect(modelInfo.currentModel).toBe('MiniMax-M2.7');
    });

    test('should read current model correctly for fallback logic', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-fallback-read-${Date.now()}`,
        title: 'Fallback Read Test',
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(modelInfo.currentModel).toBe('glm-5');
      expect(modelInfo.modelInfo?.provider).toBe('glm');

      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      });

      const afterSwitch = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(afterSwitch.currentModel).toBe('MiniMax-M2.7');
      expect(afterSwitch.modelInfo?.provider).toBe('minimax');
    });
  });

  describe('4. SDK Session Continuity After Model Switch', () => {
    test('should restart SDK session correctly after model switch', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-sdk-restart-${Date.now()}`,
        title: 'SDK Restart Test',
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      })) as { success: boolean };

      expect(switchResult.success).toBe(true);

      const sessionAfter = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { id: string; status: string; config: { model: string } } };

      expect(sessionAfter.session.id).toBe(sessionId);
      expect(sessionAfter.session.status).toBeTruthy();
      expect(sessionAfter.session.config.model).toBe('MiniMax-M2.7');

      const modelAfter = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      expect(modelAfter.currentModel).toBe('MiniMax-M2.7');
    });

    test('should maintain session state after model switch', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-context-preservation-${Date.now()}`,
        title: 'Context Preservation Test',
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      });

      const sessionAfter = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { id: string; status: string } };

      expect(sessionAfter.session.id).toBe(sessionId);
      expect(['active', 'processing']).toContain(sessionAfter.session.status);
    });
  });

  describe('5. DB as Source of Truth', () => {
    test('should persist model/provider changes to DB session record', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-db-truth-${Date.now()}`,
        title: 'DB Truth Test',
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const initial = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config: { model: string; provider: string } } };

      expect(initial.session.config.model).toBe('glm-5');
      expect(initial.session.config.provider).toBe('glm');

      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      });

      const after = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config: { model: string; provider: string } } };

      expect(after.session.config.model).toBe('MiniMax-M2.7');
      expect(after.session.config.provider).toBe('minimax');

      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(modelInfo.currentModel).toBe('MiniMax-M2.7');
      expect(modelInfo.modelInfo?.provider).toBe('minimax');
    });

    test('should reflect model changes correctly across multiple queries', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-multi-query-${Date.now()}`,
        title: 'Multi Query Test',
        config: {
          model: 'MiniMax-M2.7',
          provider: 'minimax',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      });

      for (let i = 0; i < 3; i++) {
        const modelInfo = (await daemon.messageHub.request('session.model.get', {
          sessionId,
        })) as { currentModel: string };

        expect(modelInfo.currentModel).toBe('glm-5');
      }

      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      });

      for (let i = 0; i < 3; i++) {
        const modelInfo = (await daemon.messageHub.request('session.model.get', {
          sessionId,
        })) as { currentModel: string };

        expect(modelInfo.currentModel).toBe('MiniMax-M2.7');
      }
    });

    test('should handle provider-specific model aliases correctly', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-aliases-${Date.now()}`,
        title: 'Alias Test',
        config: {
          model: 'glm',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      expect(modelInfo.currentModel).toBe('glm-5');
    });
  });

  describe('Error Handling', () => {
    test('should fail gracefully when switching to non-existent model', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-invalid-model-${Date.now()}`,
        title: 'Invalid Model Test',
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      const result = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'non-existent-model-xyz',
        provider: 'minimax',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test('should throw error when switching without provider', async () => {
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-no-provider-${Date.now()}`,
        title: 'No Provider Test',
        config: {
          model: 'glm-5',
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      await expect(
        daemon.messageHub.request('session.model.switch', {
          sessionId,
          model: 'MiniMax-M2.7',
        })
      ).rejects.toThrow(/provider/i);
    });
  });

  describe.skip('6. SDK Session Model Observation (Bug 2 investigation)', () => {
    test('system:init model should differ after switch from MiniMax-M2.7 to glm-5', async () => {
      const INITIAL_MODEL = 'MiniMax-M2.7';
      const INITIAL_PROVIDER = 'minimax';
      const SWITCHED_MODEL = 'glm-5';
      const SWITCHED_PROVIDER = 'glm';

      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-sysinit-minimax-to-glm-${Date.now()}`,
        title: 'SysInit MiniMax→GLM',
        config: {
          model: INITIAL_MODEL,
          provider: INITIAL_PROVIDER,
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      const initialSystemInitPromise = waitForSystemInit(daemon, sessionId);
      await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
      const initialSystemInit = await initialSystemInitPromise;

      expect(initialSystemInit.type).toBe('system');
      expect(initialSystemInit.subtype).toBe('init');
      const initialModel = initialSystemInit.model as string | undefined;
      expect(initialModel).toBeDefined();

      await waitForIdle(daemon, sessionId);

      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: SWITCHED_MODEL,
        provider: SWITCHED_PROVIDER,
      })) as { success: boolean; model?: string };
      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe(SWITCHED_MODEL);

      const postSwitchSystemInitPromise = waitForSystemInit(daemon, sessionId);
      await sendMessage(daemon, sessionId, 'Say "world" in one word.');
      const postSwitchSystemInit = await postSwitchSystemInitPromise;

      const postSwitchModel = postSwitchSystemInit.model as string | undefined;
      await waitForIdle(daemon, sessionId);

      expect(postSwitchModel).toBeDefined();
      expect(postSwitchModel).not.toBe(initialModel);
      expect(initialModel).toBe('MiniMax-M2.7');
      expect(postSwitchModel).toBe('glm-5');
    }, 210000);

    test('system:init model should differ after switch from glm-5 to MiniMax-M2.7', async () => {
      const INITIAL_MODEL = 'glm-5';
      const INITIAL_PROVIDER = 'glm';
      const SWITCHED_MODEL = 'MiniMax-M2.7';
      const SWITCHED_PROVIDER = 'minimax';

      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-sysinit-glm-to-minimax-${Date.now()}`,
        title: 'SysInit GLM→MiniMax',
        config: {
          model: INITIAL_MODEL,
          provider: INITIAL_PROVIDER,
          permissionMode: 'acceptEdits',
        },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      const initialSystemInitPromise = waitForSystemInit(daemon, sessionId);
      await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
      const initialSystemInit = await initialSystemInitPromise;

      expect(initialSystemInit.type).toBe('system');
      expect(initialSystemInit.subtype).toBe('init');
      const initialModel = initialSystemInit.model as string | undefined;
      expect(initialModel).toBeDefined();

      await waitForIdle(daemon, sessionId);

      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: SWITCHED_MODEL,
        provider: SWITCHED_PROVIDER,
      })) as { success: boolean; model?: string };
      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe(SWITCHED_MODEL);

      const postSwitchSystemInitPromise = waitForSystemInit(daemon, sessionId);
      await sendMessage(daemon, sessionId, 'Say "world" in one word.');
      const postSwitchSystemInit = await postSwitchSystemInitPromise;

      const postSwitchModel = postSwitchSystemInit.model as string | undefined;
      await waitForIdle(daemon, sessionId);

      expect(postSwitchModel).toBeDefined();
      expect(postSwitchModel).not.toBe(initialModel);
      expect(initialModel).toBe('glm-5');
      expect(postSwitchModel).toBe('MiniMax-M2.7');
    }, 210000);
  });
});
