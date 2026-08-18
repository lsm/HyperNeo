import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Authentication Integration (API-dependent)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 15000);

  describe('Session Creation with Auth', () => {
    test('should create session only if authenticated', async () => {
      const result = (await daemon.messageHub.request('session.create', {
        workspacePath: `${TMP_DIR}/test-auth`,
        title: 'Auth Test Session',
        config: { model: 'haiku-4.5' },
      })) as { sessionId: string };
      daemon.trackSession(result.sessionId);

      expect(result.sessionId).toBeString();

      const sessionResult = (await daemon.messageHub.request('session.get', {
        sessionId: result.sessionId,
      })) as { session: Record<string, unknown> };

      expect(sessionResult.session).toBeDefined();
      expect(sessionResult.session.id).toBe(result.sessionId);
      expect(sessionResult.session.title).toBe('Auth Test Session');
    });
  });
});
