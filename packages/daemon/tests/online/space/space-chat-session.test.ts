/**
 * Space Chat Session Provisioning — Online Tests
 *
 * Verifies that a space:chat:${spaceId} session is provisioned end-to-end:
 * 1. space.create creates a space:chat:${spaceId} session in the DB
 * 2. The session has type='space_chat' and the correct spaceId in its context
 * 3. The session appears in space.sessionIds (via spaceManager.addSession)
 * 4. On daemon restart, the existing space:chat session persists in the DB
 *    (provisionExistingSpaces re-attaches MCP tools and system prompt on startup)
 *
 * ## Running
 *
 *   cd packages/daemon && NEOKAI_USE_DEV_PROXY=1 bun test ./tests/online/space/space-chat-session.test.ts
 *
 * MODES:
 * - Dev Proxy (recommended): Set NEOKAI_USE_DEV_PROXY=1 for offline testing
 * - Real API (default): Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { restartDaemon } from './helpers/space-test-helpers';
import type { Space } from '@neokai/shared';

const IS_MOCK = !!process.env.NEOKAI_USE_DEV_PROXY;
const SETUP_TIMEOUT = IS_MOCK ? 20_000 : 60_000;
const TEST_TIMEOUT = IS_MOCK ? 30_000 : 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createSpace(daemon: DaemonServerContext): Promise<Space> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return (await daemon.messageHub.request('space.create', {
    name: `Chat Session Test Space ${suffix}`,
    description: 'Online test space for space:chat provisioning',
    workspacePath: process.cwd(),
    autonomyLevel: 1,
  })) as Space;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

      // session.get returns { session, activeTools, context }
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

      // session_context is stored as JSON in the session row
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
      // Use an externally-owned workspace so waitForExit() does NOT delete the DB.
      // Mirrors the pattern in space-edge-cases.test.ts restart tests.
      const restartWorkspace = `/tmp/neokai-space-chat-restart-${Date.now()}`;
      await Bun.$`mkdir -p ${restartWorkspace}`.quiet();

      try {
        // Replace the default daemon with one that owns an external workspace.
        daemon.kill('SIGTERM');
        await daemon.waitForExit();
        daemon = await createDaemonServer({ workspacePath: restartWorkspace });

        const space = await createSpace(daemon);
        const spaceChatSessionId = `space:chat:${space.id}`;

        // Verify session exists before restart
        const beforeRestart = (await daemon.messageHub.request('session.get', {
          sessionId: spaceChatSessionId,
        })) as { session: Record<string, unknown> };
        expect(beforeRestart.session.id).toBe(spaceChatSessionId);

        // Restart daemon — workspace is preserved, DB persists
        daemon = await restartDaemon(daemon);

        // Session must still be retrievable after restart
        const afterRestart = (await daemon.messageHub.request('session.get', {
          sessionId: spaceChatSessionId,
        })) as { session: Record<string, unknown> };
        expect(afterRestart.session).toBeDefined();
        expect(afterRestart.session.id).toBe(spaceChatSessionId);
        expect(afterRestart.session.type).toBe('space_chat');
      } finally {
        await Bun.$`rm -rf ${restartWorkspace}`.quiet();
      }
    },
    TEST_TIMEOUT
  );
});
