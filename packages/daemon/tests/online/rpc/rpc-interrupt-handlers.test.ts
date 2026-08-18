import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Interrupt RPC Handlers', () => {
  let daemon: DaemonServerContext;

  beforeAll(async () => {
    daemon = await createDaemonServer();
  }, 15_000);

  afterAll(async () => {
    await daemon?.waitForExit();
  }, 15_000);

  describe('client.interrupt', () => {
    test('should return error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('client.interrupt', {
          sessionId: 'non-existent',
        })
      ).rejects.toThrow();
    });

    test('should successfully interrupt an existing session', async () => {
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: '/test/interrupt',
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      const result = (await daemon.messageHub.request('client.interrupt', {
        sessionId,
      })) as { accepted: boolean };

      expect(result.accepted).toBe(true);
    });
  });
});
