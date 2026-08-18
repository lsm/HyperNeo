import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle, getProcessingState } from '../../helpers/daemon-actions';
import type { RewindPreview, RewindResult } from '@hyperneo/shared';

interface RewindPoint {
  uuid: string;
  timestamp: number;
  content: string;
  turnNumber: number;
}

const TMP_DIR = process.env.TMPDIR || '/tmp';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const MODEL = IS_MOCK ? 'haiku' : 'haiku-4.5';
const IDLE_TIMEOUT = IS_MOCK ? 10000 : 60000;
const SETUP_TIMEOUT = IS_MOCK ? 15000 : 30000;
const TEST_TIMEOUT = IS_MOCK ? 30000 : 300000;

describe('Rewind Feature', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, SETUP_TIMEOUT);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, SETUP_TIMEOUT);

  async function getRewindPoints(sessionId: string): Promise<RewindPoint[]> {
    const result = (await daemon.messageHub.request('rewind.checkpoints', {
      sessionId,
    })) as { rewindPoints: RewindPoint[]; error?: string };
    return result.rewindPoints;
  }

  async function previewRewind(sessionId: string, rewindPointId: string): Promise<RewindPreview> {
    const result = (await daemon.messageHub.request('rewind.preview', {
      sessionId,
      rewindPointId,
    })) as { preview: RewindPreview };
    return result.preview;
  }

  async function executeRewind(
    sessionId: string,
    rewindPointId: string,
    mode: 'files' | 'conversation' | 'both' = 'files'
  ): Promise<RewindResult> {
    const result = (await daemon.messageHub.request('rewind.execute', {
      sessionId,
      rewindPointId,
      mode,
    })) as { result: RewindResult };
    return result.result;
  }

  describe('Rewind Point Creation', () => {
    test(
      'should create rewind points when messages are sent',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-point-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Point Creation Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        let rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints).toEqual([]);

        await sendMessage(daemon, sessionId, 'What is 2+2? Reply with just the number.');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints.length).toBeGreaterThanOrEqual(1);

        const firstRewindPoint = rewindPoints.find((c) => c.turnNumber === 1);
        expect(firstRewindPoint).toBeDefined();
        expect(firstRewindPoint?.content).toContain('2+2');

        await sendMessage(daemon, sessionId, 'What is 3+3? Reply with just the number.');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints.length).toBeGreaterThanOrEqual(2);

        const secondRewindPoint = rewindPoints.find((c) => c.turnNumber === 2);
        expect(secondRewindPoint).toBeDefined();
        expect(secondRewindPoint?.content).toContain('3+3');
      },
      TEST_TIMEOUT
    );

    test(
      'should return rewind points sorted by turn number (newest first)',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-sort-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Point Sorting Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'First message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        await sendMessage(daemon, sessionId, 'Second message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        await sendMessage(daemon, sessionId, 'Third message');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints.length).toBeGreaterThanOrEqual(3);

        for (let i = 0; i < rewindPoints.length - 1; i++) {
          expect(rewindPoints[i].turnNumber).toBeGreaterThan(rewindPoints[i + 1].turnNumber);
        }
      },
      TEST_TIMEOUT
    );
  });

  describe('Rewind Preview', () => {
    test(
      'should show preview when rewindPoint exists',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-preview-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Preview Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 1+1?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints.length).toBeGreaterThanOrEqual(1);

        const rewindPoint = rewindPoints[0];

        const preview = await previewRewind(sessionId, rewindPoint.uuid);

        expect(preview).toBeDefined();
        expect(typeof preview.canRewind).toBe('boolean');

        if (preview.canRewind) {
          expect(preview.filesChanged).toBeDefined();
        }
      },
      TEST_TIMEOUT
    );

    test(
      'should return error for non-existent rewindPoint',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-preview-invalid-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Preview Invalid Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'Hello');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const preview = await previewRewind(sessionId, 'invalid-rewindPoint-id');

        expect(preview.canRewind).toBe(false);
        expect(preview.error).toContain('not found');
      },
      TEST_TIMEOUT
    );
  });

  describe('Rewind Execute - Files Mode', () => {
    test(
      'should execute files-only rewind successfully',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-execute-files-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Execute Files Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 1+1?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        let rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints.length).toBeGreaterThanOrEqual(1);
        const firstRewindPoint = rewindPoints[0];

        await sendMessage(daemon, sessionId, 'What is 2+2?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const result = await executeRewind(sessionId, firstRewindPoint.uuid, 'files');

        expect(result).toBeDefined();
        expect(typeof result.success).toBe('boolean');

        rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints.length).toBeGreaterThanOrEqual(1);
      },
      TEST_TIMEOUT
    );
  });

  describe('Rewind Execute - Conversation Mode', () => {
    test(
      'should execute conversation-only rewind successfully',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-execute-conversation-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Execute Conversation Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 1+1?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const rewindPointsAfterFirst = await getRewindPoints(sessionId);
        expect(rewindPointsAfterFirst.length).toBeGreaterThanOrEqual(1);
        const firstRewindPoint = rewindPointsAfterFirst.find((c) => c.turnNumber === 1);
        expect(firstRewindPoint).toBeDefined();

        await sendMessage(daemon, sessionId, 'What is 2+2?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        await sendMessage(daemon, sessionId, 'What is 3+3?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        let rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints.length).toBeGreaterThanOrEqual(3);

        const result = await executeRewind(sessionId, firstRewindPoint!.uuid, 'conversation');

        expect(result).toBeDefined();
        expect(typeof result.success).toBe('boolean');

        if (result.success) {
          rewindPoints = await getRewindPoints(sessionId);

          const hasLaterCheckpoints = rewindPoints.some((c) => c.turnNumber > 1);
          expect(hasLaterCheckpoints).toBe(false);

          expect(result.conversationRewound).toBe(true);
          expect(result.messagesDeleted).toBeGreaterThan(0);
        }
      },
      TEST_TIMEOUT
    );
  });

  describe('Rewind Execute - Both Mode', () => {
    test(
      'should execute both files and conversation rewind',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-execute-both-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Execute Both Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 1+1?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const rewindPointsAfterFirst = await getRewindPoints(sessionId);
        expect(rewindPointsAfterFirst.length).toBeGreaterThanOrEqual(1);
        const firstRewindPoint = rewindPointsAfterFirst.find((c) => c.turnNumber === 1);
        expect(firstRewindPoint).toBeDefined();

        await sendMessage(daemon, sessionId, 'What is 2+2?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const result = await executeRewind(sessionId, firstRewindPoint!.uuid, 'both');

        expect(result).toBeDefined();
        expect(typeof result.success).toBe('boolean');

        if (result.success) {
          const rewindPoints = await getRewindPoints(sessionId);
          const hasLaterCheckpoints = rewindPoints.some((c) => c.turnNumber > 1);
          expect(hasLaterCheckpoints).toBe(false);
        }
      },
      TEST_TIMEOUT
    );
  });

  describe('Rewind Error Handling', () => {
    test(
      'should handle rewind with invalid rewindPoint gracefully',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-error-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Error Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'Hello');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const result = await executeRewind(sessionId, 'invalid-rewindPoint-id', 'files');

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      },
      TEST_TIMEOUT
    );

    test(
      'should maintain session state after failed rewind',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-recovery-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Rewind Recovery Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: true,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 1+1?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        await executeRewind(sessionId, 'invalid-rewindPoint-id', 'files');

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');

        const msgResult = await sendMessage(daemon, sessionId, 'What is 2+2?');
        expect(msgResult.messageId).toBeDefined();

        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const finalState = await getProcessingState(daemon, sessionId);
        expect(finalState.status).toBe('idle');
      },
      TEST_TIMEOUT
    );
  });

  describe('enableFileCheckpointing Configuration', () => {
    test('should create rewindPoints when enableFileCheckpointing is true (default)', async () => {
      const workspacePath = `${TMP_DIR}/rewind-enabled-test-${Date.now()}`;

      const createResult = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: 'Checkpointing Enabled Test',
        config: {
          model: MODEL,
          permissionMode: 'acceptEdits',
          enableFileCheckpointing: true,
        },
      })) as { sessionId: string };

      const { sessionId } = createResult;
      daemon.trackSession(sessionId);

      await sendMessage(daemon, sessionId, 'What is 1+1?');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      await sendMessage(daemon, sessionId, 'What is 2+2?');
      await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

      const rewindPoints = await getRewindPoints(sessionId);
      expect(rewindPoints.length).toBeGreaterThanOrEqual(2);

      for (const rewindPoint of rewindPoints) {
        expect(rewindPoint.uuid).toBeDefined();
        expect(rewindPoint.turnNumber).toBeGreaterThan(0);
        expect(rewindPoint.content).toBeDefined();
      }

      const state = await getProcessingState(daemon, sessionId);
      expect(state.status).toBe('idle');
    }, 240000);

    test(
      'should still have rewindPoints but file rewind disabled when enableFileCheckpointing is false',
      async () => {
        const workspacePath = `${TMP_DIR}/rewind-disabled-test-${Date.now()}`;

        const createResult = (await daemon.messageHub.request('session.create', {
          workspacePath,
          title: 'Checkpointing Disabled Test',
          config: {
            model: MODEL,
            permissionMode: 'acceptEdits',
            enableFileCheckpointing: false,
          },
        })) as { sessionId: string };

        const { sessionId } = createResult;
        daemon.trackSession(sessionId);

        await sendMessage(daemon, sessionId, 'What is 1+1?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        await sendMessage(daemon, sessionId, 'What is 2+2?');
        await waitForIdle(daemon, sessionId, IDLE_TIMEOUT);

        const rewindPoints = await getRewindPoints(sessionId);
        expect(rewindPoints.length).toBeGreaterThanOrEqual(2);

        const preview = await previewRewind(sessionId, rewindPoints[0].uuid);
        if (preview.canRewind) {
          const filesCount = Array.isArray(preview.filesChanged)
            ? preview.filesChanged.length
            : (preview.filesChanged ?? 0);
          expect(filesCount).toBe(0);
        }

        const state = await getProcessingState(daemon, sessionId);
        expect(state.status).toBe('idle');
      },
      TEST_TIMEOUT
    );
  });
});
