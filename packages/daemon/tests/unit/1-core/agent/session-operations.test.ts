import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MessageHub, type Session } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { Database } from '../../../../src/storage/database';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

describe('session operation MCP attachment', () => {
  let db: Database;
  let hub: MessageHub;
  let sessions: AgentSession[];

  beforeEach(async () => {
    db = await createTestDb();
    hub = new MessageHub();
    sessions = [];
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.cleanup()));
    hub.cleanup();
    db.close();
  });

  async function restore(id: string) {
    const session = AgentSession.restore(
      id,
      db,
      hub,
      await createTestInternalEventBus(),
      async () => null,
      undefined,
      undefined,
      { autoReplayPendingMessages: false }
    );
    if (!session) throw new Error('Session restore failed');
    sessions.push(session);
    return session;
  }

  test.each([
    undefined,
    'lobby',
    'worker',
    'space_chat',
    'space_task_agent',
  ] as const)('exposes canonical send for restored session type %s', async (type) => {
    const source: Session = { ...createTestSession('sender'), type };
    db.createSession(source);
    const session = await restore(source.id);
    const operationServer = session.getOperationMcpServer();
    expect(session.optionsBuilder.getEffectiveMcpServers()).toHaveProperty(
      'hyperneo-operations',
      operationServer
    );
    const result = await operationServer.tools[0].handler(
      {
        name: 'message.send',
        input: {
          sessionId: 'destination',
          message: { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null },
        },
      },
      {}
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('accepted');
    const jobs = db.getJobQueueRepo().listJobs({ queue: 'mailbox' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      to: { kind: 'session', sessionId: 'destination' },
      origin: 'session:sender',
    });
    expect(db.getSession(source.id)?.config.mcpServers).toBeUndefined();
  });

  test('retains the operation server across runtime MCP changes without persisting it', async () => {
    db.createSession(createTestSession('sender'));
    const session = await restore('sender');
    const operationServer = session.getOperationMcpServer();
    const peer = { command: 'peer-server' };
    session.mergeRuntimeMcpServers({ peer });
    expect(session.optionsBuilder.getEffectiveMcpServers()).toMatchObject({
      peer,
      'hyperneo-operations': operationServer,
    });
    session.replaceAllRuntimeMcpServers({});
    expect(session.optionsBuilder.getEffectiveMcpServers()).toEqual({
      'hyperneo-operations': operationServer,
    });
    expect(session.getSessionData().config.mcpServers).toEqual({});
    expect(db.getSession('sender')?.config.mcpServers).toBeUndefined();
    const restored = await restore('sender');
    expect(restored.getOperationMcpServer()).not.toBe(operationServer);
  });
});
