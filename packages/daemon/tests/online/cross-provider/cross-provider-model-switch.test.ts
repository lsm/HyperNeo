/**
 * Cross-Provider Model Switching Tests (MiniMax <-> GLM)
 *
 * Tests end-to-end cross-provider model switching between MiniMax and GLM providers.
 *
 * REQUIREMENTS:
 * - Requires BOTH MINIMAX_API_KEY AND (GLM_API_KEY or ZHIPU_API_KEY)
 * - Makes real API calls to both providers (costs money, uses rate limits)
 * - Tests FAIL (not skip) when credentials are absent — by design per CLAUDE.md
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import { waitForSystemInit } from '../../helpers/sdk-message-helpers';
import { MinimaxProvider } from '../../../src/lib/providers/minimax-provider';
import { GlmProvider } from '../../../src/lib/providers/glm-provider';

// Temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

/**
 * Hard-fail if credentials are absent — per CLAUDE.md policy.
 * Tests must fail with clear messages when secrets are missing, not silently skip.
 */
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
      // Create session with MiniMax model
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

      // Verify initial model is MiniMax
      const initialModel = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(initialModel.currentModel).toBe('MiniMax-M2.7');
      expect(initialModel.modelInfo?.provider).toBe('minimax');

      // Switch to GLM
      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      })) as { success: boolean; model: string; error?: string };

      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe('glm-5');

      // Verify model switched in session config
      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config: { model: string; provider: string } } };

      expect(sessionResult.session.config.model).toBe('glm-5');
      expect(sessionResult.session.config.provider).toBe('glm');

      // Verify model.get RPC also returns new model
      const afterSwitchModel = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(afterSwitchModel.currentModel).toBe('glm-5');
      expect(afterSwitchModel.modelInfo?.provider).toBe('glm');
    });

    test('should switch from GLM to MiniMax and continue session', async () => {
      // Create session with GLM model
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

      // Verify initial model is GLM
      const initialModel = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(initialModel.currentModel).toBe('glm-5');
      expect(initialModel.modelInfo?.provider).toBe('glm');

      // Switch to MiniMax
      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      })) as { success: boolean; model: string; error?: string };

      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe('MiniMax-M2.7');

      // Verify model switched
      const afterSwitchModel = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(afterSwitchModel.currentModel).toBe('MiniMax-M2.7');
      expect(afterSwitchModel.modelInfo?.provider).toBe('minimax');
    });
  });

  // Skipped: sends real messages to MiniMax/GLM — too slow and flaky in CI
  describe.skip('2. Cross-Provider Message Delivery', () => {
    test('should send message after model switch to GLM', async () => {
      // Create session with MiniMax
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

      // Send message using message.send via helper
      const sendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
      expect(sendResult.messageId).toBeTruthy();

      // Wait for first message to complete before switching model
      await waitForIdle(daemon, sessionId);

      // Switch to GLM
      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      })) as { success: boolean; model: string };

      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe('glm-5');

      // Verify model switched
      const modelAfter = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(modelAfter.currentModel).toBe('glm-5');
      expect(modelAfter.modelInfo?.provider).toBe('glm');

      // Send message to GLM - verify it doesn't crash
      const glmSendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
      expect(glmSendResult.messageId).toBeTruthy();

      // Verify message completes on new provider
      await waitForIdle(daemon, sessionId);
    }, 210000);

    test('should send message after model switch to MiniMax', async () => {
      // Create session with GLM
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

      // Send message to GLM
      const glmSendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
      expect(glmSendResult.messageId).toBeTruthy();

      // Wait for first message to complete before switching model
      await waitForIdle(daemon, sessionId);

      // Switch to MiniMax
      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      })) as { success: boolean; model: string };

      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe('MiniMax-M2.7');

      // Verify model switched
      const modelAfter = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(modelAfter.currentModel).toBe('MiniMax-M2.7');
      expect(modelAfter.modelInfo?.provider).toBe('minimax');

      // Send message to MiniMax - verify it doesn't crash
      const minimaxSendResult = await sendMessage(
        daemon,
        sessionId,
        'Reply with just the word "ok"'
      );
      expect(minimaxSendResult.messageId).toBeTruthy();

      // Verify message completes on new provider
      await waitForIdle(daemon, sessionId);
    }, 210000);
  });

  describe('3. Fallback Settings Configuration', () => {
    test('should store fallback chain configuration via settings.global.update', async () => {
      // NOTE: This verifies fallback settings can be stored, but does NOT test
      // actual trySwitchToFallbackModel behavior (which requires triggering a rate
      // limit error). Testing actual fallback switching would require SDK mocking.

      // Create session with MiniMax
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

      // Update settings with fallback chain using correct RPC name
      await daemon.messageHub.request('settings.global.update', {
        updates: {
          fallbackModels: [
            { model: 'glm-5', provider: 'glm' },
            { model: 'glm-4.7', provider: 'glm' },
          ],
        },
      });

      // Verify fallback chain is stored using correct RPC name
      const settings = (await daemon.messageHub.request('settings.global.get', {})) as {
        fallbackModels?: Array<{ model: string; provider: string }>;
      };

      expect(settings.fallbackModels).toBeDefined();
      expect(settings.fallbackModels!.length).toBeGreaterThan(0);

      // Verify model still reports correctly after config change
      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      expect(modelInfo.currentModel).toBe('MiniMax-M2.7');
    });

    test('should read current model correctly for fallback logic', async () => {
      // NOTE: This tests session.model.get RPC works correctly, which is a
      // prerequisite for trySwitchToFallbackModel to work.

      // Create session with GLM
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

      // Get current model - this is what trySwitchToFallbackModel calls
      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(modelInfo.currentModel).toBe('glm-5');
      expect(modelInfo.modelInfo?.provider).toBe('glm');

      // Switch model
      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      });

      // Verify model changed
      const afterSwitch = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(afterSwitch.currentModel).toBe('MiniMax-M2.7');
      expect(afterSwitch.modelInfo?.provider).toBe('minimax');
    });
  });

  describe('4. SDK Session Continuity After Model Switch', () => {
    test('should restart SDK session correctly after model switch', async () => {
      // Create session with GLM
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

      // Switch to MiniMax
      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      })) as { success: boolean };

      expect(switchResult.success).toBe(true);

      // Verify session still exists and is accessible
      const sessionAfter = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { id: string; status: string; config: { model: string } } };

      expect(sessionAfter.session.id).toBe(sessionId);
      expect(sessionAfter.session.status).toBeTruthy();
      expect(sessionAfter.session.config.model).toBe('MiniMax-M2.7');

      // Verify model.get returns the new model immediately
      const modelAfter = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      expect(modelAfter.currentModel).toBe('MiniMax-M2.7');
    });

    test('should maintain session state after model switch', async () => {
      // Create session
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

      // Switch model
      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      });

      // Verify session is still active and accessible
      const sessionAfter = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { id: string; status: string } };

      expect(sessionAfter.session.id).toBe(sessionId);
      // Session should remain in active/processing state
      expect(['active', 'processing']).toContain(sessionAfter.session.status);
    });
  });

  describe('5. DB as Source of Truth', () => {
    test('should persist model/provider changes to DB session record', async () => {
      // Create session with GLM
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

      // Verify initial state
      const initial = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config: { model: string; provider: string } } };

      expect(initial.session.config.model).toBe('glm-5');
      expect(initial.session.config.provider).toBe('glm');

      // Switch to MiniMax
      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      });

      // Verify persisted state via session.get
      const after = (await daemon.messageHub.request('session.get', {
        sessionId,
      })) as { session: { config: { model: string; provider: string } } };

      expect(after.session.config.model).toBe('MiniMax-M2.7');
      expect(after.session.config.provider).toBe('minimax');

      // Verify model.get also returns the new model
      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string; modelInfo?: { provider: string } };

      expect(modelInfo.currentModel).toBe('MiniMax-M2.7');
      expect(modelInfo.modelInfo?.provider).toBe('minimax');
    });

    test('should reflect model changes correctly across multiple queries', async () => {
      // Create session
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

      // Switch to GLM
      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'glm-5',
        provider: 'glm',
      });

      // Query model multiple times to verify consistency
      for (let i = 0; i < 3; i++) {
        const modelInfo = (await daemon.messageHub.request('session.model.get', {
          sessionId,
        })) as { currentModel: string };

        expect(modelInfo.currentModel).toBe('glm-5');
      }

      // Switch back to MiniMax
      await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'MiniMax-M2.7',
        provider: 'minimax',
      });

      // Query again
      for (let i = 0; i < 3; i++) {
        const modelInfo = (await daemon.messageHub.request('session.model.get', {
          sessionId,
        })) as { currentModel: string };

        expect(modelInfo.currentModel).toBe('MiniMax-M2.7');
      }
    });

    test('should handle provider-specific model aliases correctly', async () => {
      // Test that provider-specific model aliases resolve to canonical IDs

      // Create session with GLM using alias 'glm' (which maps to glm-5)
      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-aliases-${Date.now()}`,
        title: 'Alias Test',
        config: {
          model: 'glm', // alias for glm-5
          provider: 'glm',
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      // Verify model is resolved to full ID
      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      // Should resolve to glm-5 (the canonical model for 'glm' alias)
      expect(modelInfo.currentModel).toBe('glm-5');
    });
  });

  describe('Error Handling', () => {
    test('should fail gracefully when switching to non-existent model', async () => {
      // Create session
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

      // Try to switch to non-existent model
      const result = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'non-existent-model-xyz',
        provider: 'minimax',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    test('should throw error when switching without provider', async () => {
      // Create session
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

      // Try to switch without provider - handler throws, not returns error
      await expect(
        daemon.messageHub.request('session.model.switch', {
          sessionId,
          model: 'MiniMax-M2.7',
        })
      ).rejects.toThrow(/provider/i);
    });
  });

  /**
   * Bug 2 investigation: observe system:init.model before and after session.model.switch.
   *
   * Uses REAL credentials (not dev proxy) so we can observe actual system:init.model
   * values from live SDK subprocesses with real session files.
   *
   * The SDK's `system:init` message is emitted BEFORE any API request, so its
   * `model` field reflects the `--model` CLI flag used when the query started.
   * Comparing it before and after a switch shows whether the new model takes effect.
   *
   * The test uses CROSS-PROVIDER switching (MiniMax ↔ GLM) so the CLI model
   * strings genuinely differ:
   * - MiniMax provider: routingModelId = 'MiniMax-M2.7' (or the MiniMax model if owned)
   * - GLM provider: routingModelId = 'glm-5' (or the GLM model if owned)
   *
   * These produce different ANTHROPIC_DEFAULT_H[SO]NET_MODEL env vars, so
   * system:init.model will be 'MiniMax-M2.7' vs 'glm-5' — a definitive,
   * observable difference that proves whether the switch took effect.
   *
   * REQUIREMENT: Both MINIMAX_API_KEY and (GLM_API_KEY or ZHIPU_API_KEY) must be set.
   * (This is enforced by requireProvidersOrFail() in beforeEach).
   */
  // Skipped: sends real messages to MiniMax/GLM — too slow and flaky in CI
  describe.skip('6. SDK Session Model Observation (Bug 2 investigation)', () => {
    /**
     * Cross-provider test: MiniMax-M2.7 → glm-5
     *
     * Initial: MiniMax-M2.7 (minimax provider):
     *   ownsModel('MiniMax-M2.7') = true → routingModelId = 'MiniMax-M2.7'
     *   → ANTHROPIC_DEFAULT_H[SO]NET_MODEL = 'MiniMax-M2.7'
     *   → system:init.model = 'MiniMax-M2.7'
     *
     * Switched: glm-5 (glm provider):
     *   ownsModel('glm-5') = true → routingModelId = 'glm-5'
     *   → ANTHROPIC_DEFAULT_H[SO]NET_MODEL = 'glm-5'
     *   → system:init.model = 'glm-5'
     *
     * If SDK honors --model during resume: system:init.model changes (test passes)
     * If SDK ignores --model during resume: system:init.model stays same (test fails)
     */
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

      // --- Phase 1: Capture system:init model BEFORE the switch ---
      const initialSystemInitPromise = waitForSystemInit(daemon, sessionId);
      await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
      const initialSystemInit = await initialSystemInitPromise;

      expect(initialSystemInit.type).toBe('system');
      expect(initialSystemInit.subtype).toBe('init');
      const initialModel = initialSystemInit.model as string | undefined;
      expect(initialModel).toBeDefined();

      await waitForIdle(daemon, sessionId);

      // --- Phase 2: Switch model (cross-provider MiniMax → GLM) ---
      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: SWITCHED_MODEL,
        provider: SWITCHED_PROVIDER,
      })) as { success: boolean; model?: string };
      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe(SWITCHED_MODEL);

      // --- Phase 3: Capture system:init model AFTER the switch ---
      // Subscribe AFTER the RPC returns to avoid racing with restart() teardown.
      const postSwitchSystemInitPromise = waitForSystemInit(daemon, sessionId);
      await sendMessage(daemon, sessionId, 'Say "world" in one word.');
      const postSwitchSystemInit = await postSwitchSystemInitPromise;

      const postSwitchModel = postSwitchSystemInit.model as string | undefined;
      await waitForIdle(daemon, sessionId);

      // Verify models are different — this proves the SDK used the new model
      expect(postSwitchModel).toBeDefined();
      expect(postSwitchModel).not.toBe(initialModel);
      // Initial: MiniMax-M2.7, Post-switch: glm-5
      expect(initialModel).toBe('MiniMax-M2.7');
      expect(postSwitchModel).toBe('glm-5');
    }, 210000);

    /**
     * Cross-provider test: GLM → MiniMax
     *
     * Verifies the model switch works in both directions (GLM → MiniMax).
     *
     * Initial: glm-5 (glm provider):
     *   ownsModel('glm-5') = true → routingModelId = 'glm-5'
     *   → ANTHROPIC_DEFAULT_H[SO]NET_MODEL = 'glm-5'
     *   → system:init.model = 'glm-5'
     *
     * Switched: MiniMax-M2.7 (minimax provider):
     *   ownsModel('MiniMax-M2.7') = true → routingModelId = 'MiniMax-M2.7'
     *   → ANTHROPIC_DEFAULT_H[SO]NET_MODEL = 'MiniMax-M2.7'
     *   → system:init.model = 'MiniMax-M2.7'
     */
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

      // --- Phase 1: Capture system:init model BEFORE the switch ---
      const initialSystemInitPromise = waitForSystemInit(daemon, sessionId);
      await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
      const initialSystemInit = await initialSystemInitPromise;

      expect(initialSystemInit.type).toBe('system');
      expect(initialSystemInit.subtype).toBe('init');
      const initialModel = initialSystemInit.model as string | undefined;
      expect(initialModel).toBeDefined();

      await waitForIdle(daemon, sessionId);

      // --- Phase 2: Switch model (cross-provider GLM → MiniMax) ---
      const switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: SWITCHED_MODEL,
        provider: SWITCHED_PROVIDER,
      })) as { success: boolean; model?: string };
      expect(switchResult.success).toBe(true);
      expect(switchResult.model).toBe(SWITCHED_MODEL);

      // --- Phase 3: Capture system:init model AFTER the switch ---
      const postSwitchSystemInitPromise = waitForSystemInit(daemon, sessionId);
      await sendMessage(daemon, sessionId, 'Say "world" in one word.');
      const postSwitchSystemInit = await postSwitchSystemInitPromise;

      const postSwitchModel = postSwitchSystemInit.model as string | undefined;
      await waitForIdle(daemon, sessionId);

      expect(postSwitchModel).toBeDefined();
      expect(postSwitchModel).not.toBe(initialModel);
      // Initial: glm-5, Post-switch: MiniMax-M2.7
      expect(initialModel).toBe('glm-5');
      expect(postSwitchModel).toBe('MiniMax-M2.7');
    }, 210000);
  });
});
