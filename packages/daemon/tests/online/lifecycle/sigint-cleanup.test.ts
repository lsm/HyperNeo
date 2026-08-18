import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('SDK SIGINT Cleanup (Online)', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    process.env.DAEMON_TEST_SPAWN = 'true';
    daemon = await createDaemonServer();
  }, 30000);

  afterEach(async () => {
    delete process.env.DAEMON_TEST_SPAWN;
    if (!daemon) return;
    daemon.kill('SIGTERM');
    await daemon.waitForExit();
  }, 30_000);

  describe('SIGINT during active SDK query', () => {
    test(
      'should complete cleanup when SIGINT received during active query',
      async () => {
        const sessionResult = (await daemon.messageHub.request('session.create', {
          workspacePath: `${TMP_DIR}/test-sigint-active-query`,
          title: 'SIGINT Cleanup Test',
        })) as { sessionId: string };

        const { sessionId } = sessionResult;
        daemon.trackSession(sessionId);

        await daemon.messageHub.request('message.send', {
          sessionId,
          content: 'Please write a detailed 500-word essay about the history of computing.',
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        const sessionResult2 = (await daemon.messageHub.request('session.get', {
          sessionId,
        })) as { session: { processingState: { status: string } } };

        console.log('[TEST] Session object:', JSON.stringify(sessionResult2, null, 2));
        console.log(
          '[TEST] Processing state before SIGINT:',
          sessionResult2.session?.processingState?.status
        );

        if (!sessionResult2.session?.processingState) {
          console.log('[TEST] No processing state found, skipping status check');
        } else {
          expect(sessionResult2.session.processingState.status).toBe('processing');
        }

        const cleanupStart = Date.now();

        console.log(`[TEST] Sending SIGINT to daemon PID ${daemon.pid}...`);
        const killResult = daemon.kill('SIGINT');
        expect(killResult).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 2000));

        console.log('[TEST] Checking daemon process has exited...');

        const startTime = Date.now();
        while (Date.now() - startTime < 20000) {
          try {
            process.kill(daemon.pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch {
            console.log('[TEST] Daemon process has exited cleanly');
            const cleanupDuration = Date.now() - cleanupStart;
            console.log(`[TEST] Total cleanup time: ${cleanupDuration}ms`);

            expect(cleanupDuration).toBeLessThan(20000);
            return;
          }
        }

        throw new Error('Daemon process did not exit within 20 seconds after SIGINT');
      },
      { timeout: 30000 }
    );
  });
});
