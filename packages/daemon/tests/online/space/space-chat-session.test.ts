import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { restartDaemon } from './helpers/space-test-helpers';
import type { Space } from '@hyperneo/shared';

const IS_MOCK = !!process.env.HYPERNEO_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 20_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 120_000;

async function createSpace(daemon: DaemonServerContext): Promise<Space> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return (await daemon.messageHub.request('space.create', {
    name: `Chat Session Test Space ${suffix}`,
    description: 'Online test space for space:chat provisioning',
    workspacePath: process.cwd(),
    autonomyLevel: 1,
  })) as Space;
}

describe('space:chat session provisioning', () => {
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

  test(
    'space.create provisions a space:chat session with type=space_chat',
    async () => {
      const space = await createSpace(daemon);
      const spaceChatSessionId = `space:chat:${space.id}`;

      const result = (await daemon.messageHub.request('session.get', {
        sessionId: spaceChatSessionId,
      })) as { session: Record<string, unknown> };

      const session = result.session;
      expect(session).toBeDefined();
      expect(session.id).toBe(spaceChatSessionId);
      expect(session.type).toBe('space_chat');
    },
    TEST_TIMEOUT
  );

  test(
    'space:chat session context contains the spaceId',
    async () => {
      const space = await createSpace(daemon);
      const spaceChatSessionId = `space:chat:${space.id}`;

      const result = (await daemon.messageHub.request('session.get', {
        sessionId: spaceChatSessionId,
      })) as { session: Record<string, unknown> };

      const sessionContext = result.session.context as { spaceId?: string } | undefined;
      expect(sessionContext?.spaceId).toBe(space.id);
    },
    TEST_TIMEOUT
  );

  test(
    'space:chat session appears in space.sessionIds',
    async () => {
      const space = await createSpace(daemon);
      const spaceChatSessionId = `space:chat:${space.id}`;

      const fetchedSpace = (await daemon.messageHub.request('space.get', {
        id: space.id,
      })) as Space;

      expect(fetchedSpace.sessionIds).toContain(spaceChatSessionId);
    },
    TEST_TIMEOUT
  );

  test(
    'space:chat session persists and is retrievable after daemon restart',
    async () => {
      const restartWorkspace = `/tmp/hyperneo-space-chat-restart-${Date.now()}`;
      mkdirSync(restartWorkspace, { recursive: true });

      try {
        daemon.kill('SIGTERM');
        await daemon.waitForExit();
        daemon = await createDaemonServer({ workspacePath: restartWorkspace });

        const space = await createSpace(daemon);
        const spaceChatSessionId = `space:chat:${space.id}`;

        const beforeRestart = (await daemon.messageHub.request('session.get', {
          sessionId: spaceChatSessionId,
        })) as { session: Record<string, unknown> };
        expect(beforeRestart.session.id).toBe(spaceChatSessionId);

        daemon = await restartDaemon(daemon);

        const afterRestart = (await daemon.messageHub.request('session.get', {
          sessionId: spaceChatSessionId,
        })) as { session: Record<string, unknown> };
        expect(afterRestart.session).toBeDefined();
        expect(afterRestart.session.id).toBe(spaceChatSessionId);
        expect(afterRestart.session.type).toBe('space_chat');
      } finally {
        rmSync(restartWorkspace, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT
  );
});
