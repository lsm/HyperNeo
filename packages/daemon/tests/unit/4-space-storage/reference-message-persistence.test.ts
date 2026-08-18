import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import { MessagePersistence } from '../../../src/lib/session/message-persistence';
import { ReferenceResolver } from '../../../src/lib/session/reference-resolver';
import type { SessionCache } from '../../../src/lib/session/session-cache';
import type {
  TaskRepoForReference,
  GoalRepoForReference,
} from '../../../src/lib/rpc-handlers/reference-handlers';
import type { NeoTask, RoomGoal } from '@hyperneo/shared';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-id',
    title: 'Test Session',
    workspacePath: '/test/workspace',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
      queryMode: 'immediate',
    },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
      titleGenerated: true,
    },
    ...overrides,
  };
}

describe('ReferenceResolver.extractReferences', () => {
  it('returns empty array when text has no references', () => {
    const result = ReferenceResolver.extractReferences('hello world');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(ReferenceResolver.extractReferences('')).toEqual([]);
  });

  it('extracts a single task reference', () => {
    const result = ReferenceResolver.extractReferences('Please check @ref{task:t-42} for details');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'task', id: 't-42' });
  });

  it('extracts a single goal reference', () => {
    const result = ReferenceResolver.extractReferences('Goal @ref{goal:g-7} is relevant');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'goal', id: 'g-7' });
  });

  it('extracts a file reference', () => {
    const result = ReferenceResolver.extractReferences('See @ref{file:src/index.ts}');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'file', id: 'src/index.ts' });
  });

  it('extracts a folder reference', () => {
    const result = ReferenceResolver.extractReferences('Folder @ref{folder:src/lib}');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'folder', id: 'src/lib' });
  });

  it('extracts multiple references from a single message', () => {
    const text = 'See @ref{task:t-1} and @ref{goal:g-2} and @ref{file:README.md}';
    const result = ReferenceResolver.extractReferences(text);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: 'task', id: 't-1' });
    expect(result[1]).toMatchObject({ type: 'goal', id: 'g-2' });
    expect(result[2]).toMatchObject({ type: 'file', id: 'README.md' });
  });

  it('skips malformed tokens that do not match the pattern', () => {
    const result = ReferenceResolver.extractReferences('Bad: @ref{taskonly} and @ref{} and text');
    expect(result).toEqual([]);
  });

  it('is not affected by stateful regex between multiple calls', () => {
    const text = '@ref{task:t-10}';
    const r1 = ReferenceResolver.extractReferences(text);
    const r2 = ReferenceResolver.extractReferences(text);
    const r3 = ReferenceResolver.extractReferences(text);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r3).toHaveLength(1);
  });
});

describe('ReferenceResolver.resolveAllReferences', () => {
  let taskRepo: TaskRepoForReference;
  let goalRepo: GoalRepoForReference;
  let resolver: ReferenceResolver;

  const mockTask: NeoTask = {
    id: 'task-uuid-1',
    roomId: 'room-1',
    shortId: 't-1',
    title: 'Task one',
    description: '',
    status: 'open',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const mockGoal: RoomGoal = {
    id: 'goal-uuid-1',
    roomId: 'room-1',
    shortId: 'g-1',
    title: 'Goal one',
    description: '',
    status: 'active',
    missionType: 'one_shot',
    autonomyLevel: 'supervised',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    taskRepo = {
      getTask: mock((id: string) => (id === 'task-uuid-1' ? mockTask : null)),
      getTaskByShortId: mock((roomId: string, shortId: string) =>
        roomId === 'room-1' && shortId === 't-1' ? mockTask : null
      ),
    };

    goalRepo = {
      getGoal: mock((id: string) => (id === 'goal-uuid-1' ? mockGoal : null)),
      getGoalByShortId: mock((roomId: string, shortId: string) =>
        roomId === 'room-1' && shortId === 'g-1' ? mockGoal : null
      ),
    };

    resolver = new ReferenceResolver({ taskRepo, goalRepo });
  });

  it('returns empty map when no mentions are provided', async () => {
    const result = await resolver.resolveAllReferences([], {
      workspacePath: '/ws',
      roomId: 'room-1',
    });
    expect(result).toEqual({});
  });

  it('resolves a task mention by short ID', async () => {
    const mentions = ReferenceResolver.extractReferences('@ref{task:t-1}');
    const result = await resolver.resolveAllReferences(mentions, {
      workspacePath: '/ws',
      roomId: 'room-1',
    });
    expect(result['@ref{task:t-1}']).toMatchObject({ type: 'task', id: 't-1', data: mockTask });
  });

  it('resolves a goal mention by short ID', async () => {
    const mentions = ReferenceResolver.extractReferences('@ref{goal:g-1}');
    const result = await resolver.resolveAllReferences(mentions, {
      workspacePath: '/ws',
      roomId: 'room-1',
    });
    expect(result['@ref{goal:g-1}']).toMatchObject({ type: 'goal', id: 'g-1', data: mockGoal });
  });

  it('excludes null results (unresolved references)', async () => {
    const mentions = ReferenceResolver.extractReferences('@ref{task:t-999}');
    const result = await resolver.resolveAllReferences(mentions, {
      workspacePath: '/ws',
      roomId: 'room-1',
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns null for task when roomId is null', async () => {
    const mentions = ReferenceResolver.extractReferences('@ref{task:t-1}');
    const result = await resolver.resolveAllReferences(mentions, {
      workspacePath: '/ws',
      roomId: null,
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('handles partial resolution — includes resolved refs, excludes unresolved', async () => {
    const text = '@ref{task:t-1} and @ref{task:t-999}';
    const mentions = ReferenceResolver.extractReferences(text);
    const result = await resolver.resolveAllReferences(mentions, {
      workspacePath: '/ws',
      roomId: 'room-1',
    });
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['@ref{task:t-1}']).toBeDefined();
    expect(result['@ref{task:t-999}']).toBeUndefined();
  });

  it('deduplicates duplicate references before resolving', async () => {
    const text = '@ref{task:t-1} and again @ref{task:t-1}';
    const mentions = ReferenceResolver.extractReferences(text);
    expect(mentions).toHaveLength(2);

    const getTaskSpy = taskRepo.getTask as ReturnType<typeof mock>;
    const getByShortIdSpy = taskRepo.getTaskByShortId as ReturnType<typeof mock>;

    await resolver.resolveAllReferences(mentions, { workspacePath: '/ws', roomId: 'room-1' });

    const taskCallCount =
      (getTaskSpy.mock.calls.length as number) + (getByShortIdSpy.mock.calls.length as number);
    expect(taskCallCount).toBeLessThanOrEqual(2);
  });
});

describe('MessagePersistence with ReferenceResolver', () => {
  let mockSessionCache: SessionCache;
  let mockDb: Database;
  let mockMessageHub: MessageHub;
  let mockDaemonHub: DaemonHub;
  const mockInternalEventBus = {
    publish: mock(async () => {}),
    publishAsync: mock(() => {}),
    subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
  } as unknown as InternalEventBus<any>;
  let mockSession: Session;
  let mockAgentSession: {
    getSessionData: ReturnType<typeof mock>;
    getProcessingState: ReturnType<typeof mock>;
    startQueryAndEnqueue: ReturnType<typeof mock>;
  };
  let saveUserMessageSpy: ReturnType<typeof mock>;
  let daemonHubEmitSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSession = makeSession({
      context: { roomId: 'room-1' },
    });

    mockAgentSession = {
      getSessionData: mock(() => mockSession),
      getProcessingState: mock(() => ({ status: 'idle' })),
      startQueryAndEnqueue: mock(async () => {}),
    };

    mockSessionCache = {
      getAsync: mock(async () => mockAgentSession),
    } as unknown as SessionCache;

    saveUserMessageSpy = mock(() => 'db-msg-1');
    mockDb = {
      saveUserMessage: saveUserMessageSpy,
    } as unknown as Database;

    mockMessageHub = {
      event: mock(async () => {}),
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    daemonHubEmitSpy = mock(async () => {});
    mockDaemonHub = {
      emit: daemonHubEmitSpy,
    } as unknown as DaemonHub;
  });

  it('persists without referenceMetadata when no resolver is provided', async () => {
    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockMessageHub,
      mockInternalEventBus
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'hello @ref{task:t-1}',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.not.objectContaining({ referenceMetadata: expect.anything() }),
      'enqueued',
      undefined
    );
  });

  it('persists without referenceMetadata when message has no @ references', async () => {
    const resolver = new ReferenceResolver({
      taskRepo: {
        getTask: mock(() => null),
        getTaskByShortId: mock(() => null),
      },
      goalRepo: {
        getGoal: mock(() => null),
        getGoalByShortId: mock(() => null),
      },
    });

    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockMessageHub,
      mockInternalEventBus,
      resolver
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-2',
      content: 'plain text, no references',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.not.objectContaining({ referenceMetadata: expect.anything() }),
      'enqueued',
      undefined
    );
  });

  it('embeds referenceMetadata in saved message when resolver resolves a reference', async () => {
    const mockTask: NeoTask = {
      id: 'task-uuid-1',
      roomId: 'room-1',
      shortId: 't-1',
      title: 'Task one',
      description: '',
      status: 'open',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const resolver = new ReferenceResolver({
      taskRepo: {
        getTask: mock(() => null),
        getTaskByShortId: mock((roomId: string, shortId: string) =>
          roomId === 'room-1' && shortId === 't-1' ? mockTask : null
        ),
      },
      goalRepo: {
        getGoal: mock(() => null),
        getGoalByShortId: mock(() => null),
      },
    });

    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockMessageHub,
      mockInternalEventBus,
      resolver
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-3',
      content: 'Check @ref{task:t-1} please',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({
        referenceMetadata: {
          '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Task one' },
        },
      }),
      'enqueued',
      undefined
    );
  });

  it('includes unresolved references in metadata with status: unresolved', async () => {
    const resolver = new ReferenceResolver({
      taskRepo: {
        getTask: mock(() => null),
        getTaskByShortId: mock(() => null),
      },
      goalRepo: {
        getGoal: mock(() => null),
        getGoalByShortId: mock(() => null),
      },
    });

    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockMessageHub,
      mockInternalEventBus,
      resolver
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-4',
      content: 'See @ref{task:t-999} which does not exist',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({
        referenceMetadata: {
          '@ref{task:t-999}': {
            type: 'task',
            id: 't-999',
            displayText: 't-999',
            status: 'unresolved',
          },
        },
      }),
      'enqueued',
      undefined
    );
  });

  it('still persists message when resolver throws an error', async () => {
    const badResolver = new ReferenceResolver({
      taskRepo: {
        getTask: mock(() => {
          throw new Error('DB connection failed');
        }),
        getTaskByShortId: mock(() => {
          throw new Error('DB connection failed');
        }),
      },
      goalRepo: {
        getGoal: mock(() => null),
        getGoalByShortId: mock(() => null),
      },
    });

    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockMessageHub,
      mockInternalEventBus,
      badResolver
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-5',
      content: 'See @ref{task:t-1}',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({ uuid: 'msg-5', type: 'user' }),
      'enqueued',
      undefined
    );
  });

  it('embeds partial metadata when only some references resolve', async () => {
    const mockTask: NeoTask = {
      id: 'task-uuid-1',
      roomId: 'room-1',
      shortId: 't-1',
      title: 'Task one',
      description: '',
      status: 'open',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const resolver = new ReferenceResolver({
      taskRepo: {
        getTask: mock(() => null),
        getTaskByShortId: mock((roomId: string, shortId: string) =>
          roomId === 'room-1' && shortId === 't-1' ? mockTask : null
        ),
      },
      goalRepo: {
        getGoal: mock(() => null),
        getGoalByShortId: mock(() => null),
      },
    });

    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockMessageHub,
      mockInternalEventBus,
      resolver
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-6',
      content: 'See @ref{task:t-1} and @ref{task:t-999}',
    });

    expect(saveUserMessageSpy).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({
        referenceMetadata: {
          '@ref{task:t-1}': { type: 'task', id: 't-1', displayText: 'Task one' },
          '@ref{task:t-999}': {
            type: 'task',
            id: 't-999',
            displayText: 't-999',
            status: 'unresolved',
          },
        },
      }),
      'enqueued',
      undefined
    );
  });
});
