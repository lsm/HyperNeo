import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { AcpMcpProxyBridge } from '../../../../src/lib/acp/mcp-proxy-bridge';
import { convertMcpServersForAcp } from '../../../../src/lib/acp/acp-query-runner';
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

  test('ordinary chat sessions create independent tasks through the shared MCP operation', async () => {
    db.createSession(createTestSession('creator'));
    const session = await restore('creator');
    const result = await session
      .getOperationMcpServer()
      .tools[0].handler({ name: 'task.create', input: { title: 'Work' } }, {});
    expect(result.isError).not.toBe(true);
    const content = result.content[0];
    if (content.type !== 'text') throw new Error('Expected task JSON');
    const task = JSON.parse(content.text);
    expect(task).toMatchObject({ title: 'Work', status: 'open' });
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(task);
    const listed = await session
      .getOperationMcpServer()
      .tools[0].handler({ name: 'task.list' }, {});
    expect(listed.isError).not.toBe(true);
    const page = listed.content[0];
    if (page.type !== 'text') throw new Error('Expected task page JSON');
    expect(JSON.parse(page.text)).toEqual({ tasks: [task], nextCursor: null });
    const updated = await session.getOperationMcpServer().tools[0].handler(
      {
        name: 'task.update',
        input: { taskId: task.id, description: 'Next steps', priority: 'high' },
      },
      {}
    );
    expect(updated.isError).not.toBe(true);
    const edited = updated.content[0];
    if (edited.type !== 'text') throw new Error('Expected updated task JSON');
    expect(JSON.parse(edited.text)).toEqual({
      ...task,
      description: 'Next steps',
      priority: 'high',
      updatedAt: expect.any(Number),
    });
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(JSON.parse(edited.text));
    const dependency = await session
      .getOperationMcpServer()
      .tools[0].handler({ name: 'task.create', input: { title: 'Prerequisite' } }, {});
    const dependencyContent = dependency.content[0];
    if (dependencyContent.type !== 'text') throw new Error('Expected dependency task JSON');
    const prerequisite = JSON.parse(dependencyContent.text);
    const linked = await session
      .getOperationMcpServer()
      .tools[0].handler(
        { name: 'task.dependencies.set', input: { taskId: task.id, dependsOn: [prerequisite.id] } },
        {}
      );
    expect(linked.isError).not.toBe(true);
    const linkedContent = linked.content[0];
    if (linkedContent.type !== 'text') throw new Error('Expected linked task JSON');
    expect(JSON.parse(linkedContent.text)).toMatchObject({
      id: task.id,
      dependsOn: [prerequisite.id],
    });
    expect(readTaskCore(db.getDatabase(), task.id)?.dependsOn).toEqual([prerequisite.id]);
    const transitioned = await session
      .getOperationMcpServer()
      .tools[0].handler(
        { name: 'task.transition', input: { taskId: task.id, status: 'done', result: 'Finished' } },
        {}
      );
    expect(transitioned.isError).not.toBe(true);
    const completed = transitioned.content[0];
    if (completed.type !== 'text') throw new Error('Expected completed task JSON');
    expect(JSON.parse(completed.text)).toMatchObject({
      id: task.id,
      status: 'done',
      result: 'Finished',
    });
    expect(readTaskCore(db.getDatabase(), task.id)).toEqual(JSON.parse(completed.text));
    const rejected = await session
      .getOperationMcpServer()
      .tools[0].handler(
        { name: 'task.transition', input: { taskId: task.id, status: 'open' } },
        {}
      );
    const rejection = rejected.content[0];
    if (rejection.type !== 'text') throw new Error('Expected transition rejection JSON');
    expect(JSON.parse(rejection.text)).toBe('invalid_transition');

    expect(
      db
        .getDatabase()
        .prepare('SELECT space_id, task_number, created_by_session FROM space_tasks WHERE id = ?')
        .get(task.id)
    ).toEqual({ space_id: null, task_number: null, created_by_session: 'creator' });
  });

  test('ordinary chat sessions can discover and read existing tasks through MCP', async () => {
    db.createSession(createTestSession('reader'));
    const session = await restore('reader');
    const space = new SpaceRepository(db.getDatabase()).createSpace({
      workspacePath: '/workspace/test',
      slug: 'test',
      name: 'Test',
    });
    const tasks = new SpaceTaskRepository(db.getDatabase());
    const stored = tasks.createTask({ spaceId: space.id, title: 'Read me', description: '' });
    const tool = session.getOperationMcpServer().tools[0];
    const result = await tool.handler({ name: 'task.get', input: { taskId: stored.id } }, {});
    expect(result.isError).not.toBe(true);
    const content = result.content[0];
    if (content.type !== 'text') throw new Error('Expected task JSON');
    expect(JSON.parse(content.text)).toEqual(readTaskCore(db.getDatabase(), stored.id));
    expect(tasks.getTask(stored.id)).toEqual(stored);
    const discovery = await tool.handler({ name: 'operations.list' }, {});
    const listed = discovery.content[0];
    if (listed.type !== 'text') throw new Error('Expected catalog JSON');
    expect(JSON.parse(listed.text)).toContainEqual(expect.objectContaining({ name: 'task.get' }));
  });

  test.each([undefined, 'lobby', 'worker', 'space_chat', 'space_task_agent'] as const)(
    'exposes canonical send for restored session type %s',
    async (type) => {
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
    }
  );

  test('preserves name collisions and proxies operations for ACP sessions', async () => {
    const source = createTestSession('acp-sender');
    source.config.provider = 'acp';
    source.config.mcpServers = {
      'hyperneo-operations': { command: 'user-server' },
      'hyperneo-operations-2': { command: 'another-user-server' },
    };
    db.createSession(source);
    const session = await restore(source.id);
    session.mergeRuntimeMcpServers(source.config.mcpServers);
    const effective = session.optionsBuilder.getEffectiveMcpServers();
    expect(effective).toMatchObject(source.config.mcpServers);
    expect(effective?.['hyperneo-operations-3']).toBe(session.getOperationMcpServer());
    const bridge = new AcpMcpProxyBridge(effective as never);
    expect(bridge.getToolsForServer('hyperneo-operations-3').map(({ name }) => name)).toEqual([
      'invoke',
    ]);
    expect(convertMcpServersForAcp(effective, () => {}, bridge)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'hyperneo-operations-3', type: 'stdio' }),
      ])
    );
  });

  test('rejects MCP attempts to claim human input provenance before persistence', async () => {
    db.createSession(createTestSession('sender'));
    const session = await restore('sender');
    const result = await session.getOperationMcpServer().tools[0].handler(
      {
        name: 'message.send',
        input: {
          sessionId: 'destination',
          message: {
            type: 'user',
            message: { content: 'hello' },
            parent_tool_use_id: null,
            inputKind: 'human',
          },
        },
      },
      {}
    );
    expect(JSON.stringify(result.content)).toContain('rejected');
    expect(db.getJobQueueRepo().listJobs({ queue: 'mailbox' })).toEqual([]);
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
