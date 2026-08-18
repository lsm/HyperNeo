import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Agent RPC Handlers', () => {
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

  describe('agent.getState', () => {
    test('should return error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('agent.getState', { sessionId: 'non-existent' })
      ).rejects.toThrow();
    });

    test('should return agent state for existing session', async () => {
      const sessionId = await createSession('/test/agent-state');

      const result = (await daemon.messageHub.request('agent.getState', {
        sessionId,
      })) as { state: { status: string } };

      expect(result.state).toBeDefined();
      expect(result.state.status).toBe('idle');
    });
  });

  describe('session.resetQuery', () => {
    test('should return error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.resetQuery', { sessionId: 'non-existent' })
      ).rejects.toThrow();
    });

    test('should accept reset query request for existing session', async () => {
      const sessionId = await createSession('/test/reset-query');

      const result = (await daemon.messageHub.request('session.resetQuery', {
        sessionId,
        restartQuery: true,
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should accept reset request without restarting query', async () => {
      const sessionId = await createSession('/test/reset-no-restart');

      const result = (await daemon.messageHub.request('session.resetQuery', {
        sessionId,
        restartQuery: false,
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reset agent state to idle after reset', async () => {
      const sessionId = await createSession('/test/reset-state');

      const resetResult = (await daemon.messageHub.request('session.resetQuery', {
        sessionId,
      })) as { success: boolean };

      expect(resetResult.success).toBe(true);

      const stateResult = (await daemon.messageHub.request('agent.getState', {
        sessionId,
      })) as { state: { status: string } };

      expect(stateResult.state.status).toBe('idle');
    });
  });
});
