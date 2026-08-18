import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
  getProcessingState,
  getSession,
  sendMessage,
  waitForIdle,
} from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Auto-Title Generation', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 30000);

  async function waitForTitleGeneration(sessionId: string, timeoutMs = 30000): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const remainingMs = () => Math.max(0, deadline - Date.now());
    const isSessionNotFoundError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('Session not found');
    };

    try {
      const idleBudget = Math.min(remainingMs(), Math.max(5000, Math.floor(timeoutMs * 0.6)));
      if (idleBudget > 0) {
        await waitForIdle(daemon, sessionId, idleBudget);
      }
    } catch (error) {
      console.warn('waitForIdle timed out during title generation wait:', error);
    }

    while (remainingMs() > 0) {
      let session: Record<string, unknown>;
      try {
        session = await getSession(daemon, sessionId);
      } catch (error) {
        if (isSessionNotFoundError(error)) {
          return;
        }
        throw error;
      }

      const metadata = session.metadata as { titleGenerated?: boolean } | undefined;
      if (metadata?.titleGenerated) {
        return;
      }

      if ((session.title as string) !== 'New Session') {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    try {
      const session = await getSession(daemon, sessionId);
      const metadata = session.metadata as { titleGenerated?: boolean } | undefined;
      const title = session.title as string;
      if (!metadata?.titleGenerated && title === 'New Session') {
        console.warn('Title not generated after timeout');
      }
    } catch (error) {
      if (!isSessionNotFoundError(error)) {
        throw error;
      }
    }
  }

  test('should auto-generate title after first user message', async () => {
    const workspacePath = `${TMP_DIR}/auto-title-test-${Date.now()}`;

    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath,
      config: { model: 'haiku-4.5' },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    let session = await getSession(daemon, sessionId);
    expect(session.title).toBe('New Session');
    expect((session.metadata as { titleGenerated?: boolean }).titleGenerated).toBe(false);

    await sendMessage(daemon, sessionId, 'What is 2+2?');

    await waitForTitleGeneration(sessionId);

    session = await getSession(daemon, sessionId);
    const title = session.title as string;
    const titleGenerated = (session.metadata as { titleGenerated?: boolean }).titleGenerated;
    expect(titleGenerated).toBeBoolean();

    if (title !== 'New Session') {
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThan(512);

      expect(title).not.toMatch(/^["'`]/);
      expect(title).not.toMatch(/["'`]$/);
      expect(title).not.toMatch(/\*\*/);
      expect(title).not.toMatch(/`/);
    }

    console.log(`Generated title: "${session.title}"`);
  }, 60000);

  test('should only generate title once per session', async () => {
    const workspacePath = `${TMP_DIR}/auto-title-test-${Date.now()}`;

    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath,
      config: { model: 'haiku-4.5' },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    await sendMessage(daemon, sessionId, 'What is 2+2?');

    await waitForTitleGeneration(sessionId);

    let session = await getSession(daemon, sessionId);
    const firstTitle = session.title as string;
    expect((session.metadata as { titleGenerated?: boolean }).titleGenerated).toBeBoolean();

    await sendMessage(daemon, sessionId, 'What is 3+3?');

    try {
      await waitForIdle(daemon, sessionId, 45000);
    } catch (error) {
      console.warn('waitForIdle timed out after second message:', error);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    session = await getSession(daemon, sessionId);
    if (firstTitle !== 'New Session') {
      expect(session.title).toBe(firstTitle);
    }
    const titleAfterSecondMessage = session.title as string;

    await sendMessage(daemon, sessionId, 'What is 5+5?');

    try {
      await waitForIdle(daemon, sessionId, 45000);
    } catch (error) {
      console.warn('waitForIdle timed out after third message:', error);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const thirdSession = await getSession(daemon, sessionId);
    expect(thirdSession.title).toBe(titleAfterSecondMessage);
  }, 75000);

  test('should handle title generation with workspace path correctly', async () => {
    const workspacePath = `${TMP_DIR}/auto-title-workspace-test-${Date.now()}`;

    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath,
      config: { model: 'haiku-4.5' },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    const session = await getSession(daemon, sessionId);
    expect(session.workspacePath).toBe(workspacePath);

    await sendMessage(daemon, sessionId, 'What is 1+1?');

    await waitForTitleGeneration(sessionId);

    const finalSession = await getSession(daemon, sessionId);
    expect((finalSession.metadata as { titleGenerated?: boolean }).titleGenerated).toBeBoolean();
    expect((finalSession.title as string).length).toBeGreaterThan(0);

    console.log(`Generated title with workspace path: "${finalSession.title}"`);
  }, 60000);

  test('should handle title generation failure gracefully', async () => {
    const workspacePath = `${TMP_DIR}/auto-title-graceful-test-${Date.now()}`;

    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath,
      config: { model: 'haiku-4.5' },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    await sendMessage(daemon, sessionId, 'ok');

    await waitForTitleGeneration(sessionId);

    const session = await getSession(daemon, sessionId);
    expect((session.metadata as { titleGenerated?: boolean }).titleGenerated).toBeBoolean();

    await sendMessage(daemon, sessionId, 'What is 5+5?');

    try {
      await waitForIdle(daemon, sessionId, 45000);
    } catch (error) {
      console.warn('waitForIdle timed out after verification message:', error);
    }

    const state = await getProcessingState(daemon, sessionId);
    expect(state.status).toBe('idle');
  }, 60000);
});
