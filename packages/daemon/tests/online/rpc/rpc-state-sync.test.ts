import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import { STATE_CHANNELS } from '@hyperneo/shared';

describe('State Sync', () => {
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

  describe('Global State Snapshot', () => {
    test('should return global state with all sections', async () => {
      const snapshot = (await daemon.messageHub.request(
        STATE_CHANNELS.GLOBAL_SNAPSHOT,
        {}
      )) as Record<string, unknown>;

      expect(snapshot.sessions).toBeDefined();
      expect(snapshot.system).toBeDefined();
      expect(snapshot.meta).toBeDefined();

      const system = snapshot.system as Record<string, unknown>;
      expect(system.auth).toBeDefined();
      expect(system.health).toBeDefined();
      expect(system.version).toBeDefined();

      const meta = snapshot.meta as Record<string, unknown>;
      expect(meta.channel).toBe('global');
    });

    test('should include created sessions in snapshot', async () => {
      const sessionId = await createSession('/test/state-sync-1');

      const snapshot = (await daemon.messageHub.request(
        STATE_CHANNELS.GLOBAL_SNAPSHOT,
        {}
      )) as Record<string, unknown>;

      const sessions = snapshot.sessions as {
        sessions: Array<{ id: string }>;
      };
      expect(sessions.sessions).toBeArray();
      expect(sessions.sessions.some((s) => s.id === sessionId)).toBe(true);
    });
  });

  describe('Session State Snapshot', () => {
    test('should return session state with all sections', async () => {
      const sessionId = await createSession('/test/state-sync-2');

      const snapshot = (await daemon.messageHub.request(STATE_CHANNELS.SESSION_SNAPSHOT, {
        sessionId,
      })) as Record<string, unknown>;

      expect(snapshot.session).toBeDefined();
      expect(snapshot.sdkMessages).toBeDefined();
      expect(snapshot.meta).toBeDefined();

      const session = snapshot.session as Record<string, unknown>;
      expect(session.sessionInfo).toBeDefined();
      expect(session.agentState).toBeDefined();
      expect(session.commandsData).toBeDefined();

      const meta = snapshot.meta as Record<string, unknown>;
      expect(meta.sessionId).toBe(sessionId);
    });

    test('should throw error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request(STATE_CHANNELS.SESSION_SNAPSHOT, {
          sessionId: 'non-existent',
        })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('System State', () => {
    test('should report system health', async () => {
      const system = (await daemon.messageHub.request(STATE_CHANNELS.GLOBAL_SYSTEM, {})) as Record<
        string,
        unknown
      >;

      const health = system.health as Record<string, unknown>;
      expect(health.status).toBe('ok');
      expect(health.version).toBeString();
      expect(health.uptime).toBeNumber();
      expect(health.uptime as number).toBeGreaterThanOrEqual(0);
      expect(health.sessions).toBeDefined();

      const sessions = health.sessions as Record<string, number>;
      expect(sessions.active).toBe(0);
      expect(sessions.total).toBe(0);
    });

    test('should track active and total sessions in health', async () => {
      await createSession('/test/state-sync-3a');
      await createSession('/test/state-sync-3b');

      const system = (await daemon.messageHub.request(STATE_CHANNELS.GLOBAL_SYSTEM, {})) as Record<
        string,
        unknown
      >;

      const health = system.health as Record<string, unknown>;
      const sessions = health.sessions as Record<string, number>;
      expect(sessions.active).toBe(2);
      expect(sessions.total).toBe(2);
    });

    test('should expose config information', async () => {
      const system = (await daemon.messageHub.request(STATE_CHANNELS.GLOBAL_SYSTEM, {})) as Record<
        string,
        unknown
      >;

      expect(system.version).toBeString();
      expect(system.claudeSDKVersion).toBeString();
      expect(system.defaultModel).toBeString();
      expect(system.maxSessions).toBeNumber();
      expect(system.storageLocation).toBeString();
    });

    test('should expose auth status', async () => {
      const system = (await daemon.messageHub.request(STATE_CHANNELS.GLOBAL_SYSTEM, {})) as Record<
        string,
        unknown
      >;

      const auth = system.auth as Record<string, unknown>;
      expect(auth).toBeDefined();
      expect(typeof auth.isAuthenticated).toBe('boolean');
      expect(auth.method).toBeString();
      expect(auth.source).toBeString();
    });
  });

  describe('Per-Channel Versioning', () => {
    test('should have version numbers in snapshots', async () => {
      const snapshot = (await daemon.messageHub.request(
        STATE_CHANNELS.GLOBAL_SNAPSHOT,
        {}
      )) as Record<string, unknown>;

      const meta = snapshot.meta as Record<string, unknown>;
      expect(meta.version).toBeNumber();
    });

    test('should have independent versions for different channels', async () => {
      const sessionId = await createSession('/test/state-sync-4');

      const sessionSnapshot = (await daemon.messageHub.request(STATE_CHANNELS.SESSION_SNAPSHOT, {
        sessionId,
      })) as Record<string, unknown>;

      const globalSnapshot = (await daemon.messageHub.request(
        STATE_CHANNELS.GLOBAL_SNAPSHOT,
        {}
      )) as Record<string, unknown>;

      const sessionMeta = sessionSnapshot.meta as Record<string, unknown>;
      const globalMeta = globalSnapshot.meta as Record<string, unknown>;

      expect(sessionMeta.version).toBeNumber();
      expect(globalMeta.version).toBeNumber();
    });
  });
});
