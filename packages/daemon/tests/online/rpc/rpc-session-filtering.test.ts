import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Session Filtering', () => {
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

  async function archiveSession(sessionId: string): Promise<void> {
    await daemon.messageHub.request('session.archive', {
      sessionId,
      confirmed: true,
    });
  }

  async function listSessions(options?: {
    status?: string;
    includeArchived?: boolean;
  }): Promise<Array<{ id: string; status: string; [key: string]: unknown }>> {
    const result = (await daemon.messageHub.request('session.list', options ?? {})) as {
      sessions: Array<{ id: string; status: string }>;
    };
    return result.sessions;
  }

  describe('Server-side filtering', () => {
    test('excludes archived sessions by default', async () => {
      const session1Id = await createSession('/test/filter-1a');
      const session2Id = await createSession('/test/filter-1b');
      const session3Id = await createSession('/test/filter-1c');

      await archiveSession(session2Id);

      const sessions = await listSessions();
      const ids = sessions.map((s) => s.id);

      expect(ids).toContain(session1Id);
      expect(ids).toContain(session3Id);
      expect(ids).not.toContain(session2Id);
    });

    test('returns only archived sessions when status=archived', async () => {
      const session1Id = await createSession('/test/filter-2a');
      const session2Id = await createSession('/test/filter-2b');

      await archiveSession(session2Id);

      const archivedSessions = await listSessions({ status: 'archived' });
      const archivedIds = archivedSessions.map((s) => s.id);

      expect(archivedIds).toContain(session2Id);
      expect(archivedIds).not.toContain(session1Id);
    });

    test('includeArchived returns all sessions', async () => {
      const session1Id = await createSession('/test/filter-3a');
      const session2Id = await createSession('/test/filter-3b');

      await archiveSession(session2Id);

      const sessions = await listSessions({ includeArchived: true });
      const ids = sessions.map((s) => s.id);

      expect(ids).toContain(session1Id);
      expect(ids).toContain(session2Id);
    });

    test('filters work with multiple archived sessions', async () => {
      const s1 = await createSession('/test/filter-multi-a');
      const s2 = await createSession('/test/filter-multi-b');
      const s3 = await createSession('/test/filter-multi-c');

      await archiveSession(s2);
      await archiveSession(s3);

      let sessions = await listSessions();
      let ids = sessions.map((s) => s.id);
      expect(ids).toContain(s1);
      expect(ids).not.toContain(s2);
      expect(ids).not.toContain(s3);

      sessions = await listSessions({ includeArchived: true });
      ids = sessions.map((s) => s.id);
      expect(ids).toContain(s1);
      expect(ids).toContain(s2);
      expect(ids).toContain(s3);

      sessions = await listSessions({ status: 'archived' });
      ids = sessions.map((s) => s.id);
      expect(ids).toContain(s2);
      expect(ids).toContain(s3);
      expect(ids).not.toContain(s1);
    });
  });

  describe('Edge cases', () => {
    test('handles empty session list', async () => {
      const sessions = await listSessions();
      expect(sessions).toBeArray();
    });

    test('handles all sessions being archived', async () => {
      const session1Id = await createSession('/test/filter-edge-1a');
      const session2Id = await createSession('/test/filter-edge-1b');

      await archiveSession(session1Id);
      await archiveSession(session2Id);

      let sessions = await listSessions();
      let ids = sessions.map((s) => s.id);
      expect(ids).not.toContain(session1Id);
      expect(ids).not.toContain(session2Id);

      sessions = await listSessions({ includeArchived: true });
      ids = sessions.map((s) => s.id);
      expect(ids).toContain(session1Id);
      expect(ids).toContain(session2Id);
    });

    test('handles session status change from active to archived and back', async () => {
      const sessionId = await createSession('/test/filter-edge-2');

      let sessions = await listSessions();
      expect(sessions.map((s) => s.id)).toContain(sessionId);

      await archiveSession(sessionId);

      sessions = await listSessions();
      expect(sessions.map((s) => s.id)).not.toContain(sessionId);

      await daemon.messageHub.request('session.update', {
        sessionId,
        status: 'active',
      });

      sessions = await listSessions();
      expect(sessions.map((s) => s.id)).toContain(sessionId);
    });
  });
});
