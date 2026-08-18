import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

setDefaultTimeout(15000);
import { STATE_CHANNELS } from '@hyperneo/shared';

describe('End-to-End Session Workflow', () => {
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

  async function getSession(sessionId: string): Promise<Record<string, unknown>> {
    const { session } = (await daemon.messageHub.request('session.get', {
      sessionId,
    })) as { session: Record<string, unknown> };
    return session;
  }

  async function deleteSession(sessionId: string): Promise<void> {
    await daemon.messageHub.request('session.delete', { sessionId });
  }

  async function listSessions(): Promise<Array<Record<string, unknown>>> {
    const result = (await daemon.messageHub.request('session.list', {})) as {
      sessions: Array<Record<string, unknown>>;
    };
    return result.sessions;
  }

  describe('Complete Session Lifecycle', () => {
    test('should handle full session lifecycle via RPC', async () => {
      const sessionId = await createSession('/test/lifecycle');
      expect(sessionId).toBeString();

      const session = await getSession(sessionId);
      expect(session.id).toBe(sessionId);

      await daemon.messageHub.request('session.update', {
        sessionId,
        title: 'Test Lifecycle',
      });

      const updatedSession = await getSession(sessionId);
      expect(updatedSession.title).toBe('Test Lifecycle');

      await deleteSession(sessionId);

      await expect(daemon.messageHub.request('session.get', { sessionId })).rejects.toThrow(
        'Session not found'
      );
    });

    test('should handle multiple sessions independently', async () => {
      const sessionId1 = await createSession('/test/multi-1');
      const sessionId2 = await createSession('/test/multi-2');
      const sessionId3 = await createSession('/test/multi-3');

      await deleteSession(sessionId2);

      const sessions = await listSessions();
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(sessionId1);
      expect(ids).toContain(sessionId3);
      expect(ids).not.toContain(sessionId2);
    });
  });

  describe('Concurrent Operations', () => {
    test('should handle concurrent session creation', async () => {
      const promises = Array.from({ length: 5 }, (_, i) => createSession(`/test/concurrent-${i}`));

      const sessionIds = await Promise.all(promises);
      expect(sessionIds.length).toBe(5);

      const uniqueIds = new Set(sessionIds);
      expect(uniqueIds.size).toBe(5);

      const sessions = await listSessions();
      for (const id of sessionIds) {
        expect(sessions.map((s) => s.id)).toContain(id);
      }
    });

    test('should handle concurrent session operations', async () => {
      const sessionIds = await Promise.all([
        createSession('/test/concurrent-ops-1'),
        createSession('/test/concurrent-ops-2'),
        createSession('/test/concurrent-ops-3'),
      ]);

      await Promise.all(
        sessionIds.map((id, i) =>
          daemon.messageHub.request('session.update', {
            sessionId: id,
            title: `Updated ${i}`,
          })
        )
      );

      const sessions = await listSessions();
      const titles = sessions
        .filter((s) => sessionIds.includes(s.id as string))
        .map((s) => s.title)
        .sort();
      expect(titles).toEqual(['Updated 0', 'Updated 1', 'Updated 2']);

      await Promise.all(sessionIds.map((id) => deleteSession(id)));

      const finalSessions = await listSessions();
      for (const id of sessionIds) {
        expect(finalSessions.map((s) => s.id)).not.toContain(id);
      }
    }, 15000);
  });

  describe('State Snapshot Consistency', () => {
    test('should provide consistent global snapshot', async () => {
      await createSession('/test/snapshot-1');
      await createSession('/test/snapshot-2');

      const snapshot = (await daemon.messageHub.request(STATE_CHANNELS.GLOBAL_SNAPSHOT, {})) as {
        sessions: { sessions: unknown[] };
        system: { health: { sessions: { total: number; active: number } } };
      };

      expect(snapshot.sessions.sessions.length).toBeGreaterThanOrEqual(2);
    });

    test('should provide consistent session snapshot', async () => {
      const sessionId = await createSession('/test/session-snapshot');

      const snapshot = (await daemon.messageHub.request(STATE_CHANNELS.SESSION_SNAPSHOT, {
        sessionId,
      })) as {
        session: { sessionInfo: { id: string } };
      };

      expect(snapshot.session.sessionInfo.id).toBe(sessionId);
    });
  });

  describe('Error Recovery', () => {
    test('should recover from failed operations', async () => {
      await expect(
        daemon.messageHub.request('session.get', { sessionId: 'non-existent' })
      ).rejects.toThrow();

      const sessionId = await createSession('/test/error-recovery');
      expect(sessionId).toBeString();
    });

    test('should handle rapid create/delete cycles', async () => {
      for (let i = 0; i < 5; i++) {
        const sessionId = await createSession(`/test/cycle-${i}`);
        await deleteSession(sessionId);
      }

      const sessions = await listSessions();
      const cycleIds = sessions.filter(
        (s) => typeof s.workspacePath === 'string' && s.workspacePath.includes('/test/cycle-')
      );
      expect(cycleIds.length).toBe(0);
    }, 30000);
  });
});
