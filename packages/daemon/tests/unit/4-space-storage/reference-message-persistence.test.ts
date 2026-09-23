import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { Database } from '../../../src/storage/database';
import type { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import type { InternalEventBus } from '../../../src/lib/internal-event-bus';
import { MessagePersistence } from '../../../src/lib/session/message-persistence';
import { ReferenceResolver } from '../../../src/lib/session/reference-resolver';
import type { SessionCache } from '../../../src/lib/session/session-cache';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ref-persistence-'));
  await writeFile(join(workspace, 'a.ts'), 'export const a = 1;\n');
  await mkdir(join(workspace, 'src'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

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

  it('ignores the retired task and goal reference types', () => {
    const result = ReferenceResolver.extractReferences('See @ref{task:t-42} and @ref{goal:g-7}');
    expect(result).toEqual([]);
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
    const text = 'See @ref{folder:src} and @ref{file:README.md}';
    const result = ReferenceResolver.extractReferences(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'folder', id: 'src' });
    expect(result[1]).toMatchObject({ type: 'file', id: 'README.md' });
  });

  it('skips malformed tokens that do not match the pattern', () => {
    const result = ReferenceResolver.extractReferences('Bad: @ref{fileonly} and @ref{} and text');
    expect(result).toEqual([]);
  });

  it('is not affected by stateful regex between multiple calls', () => {
    const text = '@ref{file:a.ts}';
    const r1 = ReferenceResolver.extractReferences(text);
    const r2 = ReferenceResolver.extractReferences(text);
    const r3 = ReferenceResolver.extractReferences(text);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r3).toHaveLength(1);
  });
});

describe('ReferenceResolver.resolveAllReferences', () => {
  const resolver = new ReferenceResolver();

  it('returns empty map when no mentions are provided', async () => {
    expect(await resolver.resolveAllReferences([], { workspacePath: workspace })).toEqual({});
  });

  it('resolves a file and a folder in the workspace', async () => {
    const mentions = ReferenceResolver.extractReferences('@ref{file:a.ts} @ref{folder:src}');
    const result = await resolver.resolveAllReferences(mentions, { workspacePath: workspace });
    expect(result['@ref{file:a.ts}']).toMatchObject({ type: 'file', id: 'a.ts' });
    expect(result['@ref{folder:src}']).toMatchObject({ type: 'folder', id: 'src' });
  });

  it('resolves nothing without a workspace', async () => {
    const mentions = ReferenceResolver.extractReferences('@ref{file:a.ts}');
    const result = await resolver.resolveAllReferences(mentions, { workspacePath: null });
    expect(result).toEqual({});
  });

  it('handles partial resolution — includes resolved refs, excludes unresolved', async () => {
    const mentions = ReferenceResolver.extractReferences('@ref{file:a.ts} and @ref{file:gone.ts}');
    const result = await resolver.resolveAllReferences(mentions, { workspacePath: workspace });
    expect(Object.keys(result)).toEqual(['@ref{file:a.ts}']);
  });

  it('deduplicates duplicate references before resolving', async () => {
    const mentions = ReferenceResolver.extractReferences('@ref{file:a.ts} and @ref{file:a.ts}');
    expect(mentions).toHaveLength(2);
    const result = await resolver.resolveAllReferences(mentions, { workspacePath: workspace });
    expect(Object.keys(result)).toEqual(['@ref{file:a.ts}']);
  });
});

describe('MessagePersistence with ReferenceResolver', () => {
  let mockSessionCache: SessionCache;
  let mockDb: Database;
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
    stateManager: { setQueuedIfIdle: ReturnType<typeof mock> };
  };
  let enqueueUniquePendingSpy: ReturnType<typeof mock>;
  let mockJobQueue: JobQueueRepository;

  beforeEach(() => {
    mockSession = makeSession({ workspacePath: workspace });

    mockAgentSession = {
      getSessionData: mock(() => mockSession),
      getProcessingState: mock(() => ({ status: 'idle' })),
      startQueryAndEnqueue: mock(async () => {}),
      stateManager: { setQueuedIfIdle: mock(async () => true) },
    };

    mockSessionCache = {
      getAsync: mock(async () => mockAgentSession),
    } as unknown as SessionCache;

    mockDb = {
      getSession: mock(() => ({ ...mockSession, status: 'active' })),
    } as unknown as Database;

    enqueueUniquePendingSpy = mock(() => 'mailbox-job-1');
    mockJobQueue = {
      enqueueUniquePending: enqueueUniquePendingSpy,
      activeMailboxMessageUuids: mock(() => new Set<string>()),
      activeDeliveryMessageUuids: mock(() => new Set<string>()),
    } as unknown as JobQueueRepository;
  });

  it('persists without referenceMetadata when no resolver is provided', async () => {
    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockInternalEventBus,
      mockJobQueue
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-1',
      content: 'hello @ref{file:a.ts}',
    });

    expect(enqueueUniquePendingSpy.mock.calls[0]?.[0]?.payload.message).toEqual(
      expect.not.objectContaining({ referenceMetadata: expect.anything() })
    );
  });

  it('persists without referenceMetadata when message has no @ references', async () => {
    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockInternalEventBus,
      mockJobQueue,
      new ReferenceResolver()
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-2',
      content: 'plain text, no references',
    });

    expect(enqueueUniquePendingSpy.mock.calls[0]?.[0]?.payload.message).toEqual(
      expect.not.objectContaining({ referenceMetadata: expect.anything() })
    );
  });

  it('drops retired goal and task tokens instead of recording them', async () => {
    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockInternalEventBus,
      mockJobQueue,
      new ReferenceResolver()
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-retired',
      content: 'See @ref{goal:g-1} and @ref{task:t-1}',
    });

    expect(enqueueUniquePendingSpy.mock.calls[0]?.[0]?.payload.message).toEqual(
      expect.not.objectContaining({ referenceMetadata: expect.anything() })
    );
  });

  it('embeds referenceMetadata in saved message when resolver resolves a reference', async () => {
    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockInternalEventBus,
      mockJobQueue,
      new ReferenceResolver()
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-3',
      content: 'Check @ref{file:a.ts} please',
    });

    expect(enqueueUniquePendingSpy.mock.calls[0]?.[0]?.payload.message).toEqual(
      expect.objectContaining({
        referenceMetadata: {
          '@ref{file:a.ts}': { type: 'file', id: 'a.ts', displayText: 'a.ts' },
        },
      })
    );
  });

  it('includes unresolved references in metadata with status: unresolved', async () => {
    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockInternalEventBus,
      mockJobQueue,
      new ReferenceResolver()
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-4',
      content: 'See @ref{file:missing.ts} which does not exist',
    });

    expect(enqueueUniquePendingSpy.mock.calls[0]?.[0]?.payload.message).toEqual(
      expect.objectContaining({
        referenceMetadata: {
          '@ref{file:missing.ts}': {
            type: 'file',
            id: 'missing.ts',
            displayText: 'missing.ts',
            status: 'unresolved',
          },
        },
      })
    );
  });

  it('still persists message when resolver throws an error', async () => {
    const badResolver = {
      resolveAllReferences: mock(async () => {
        throw new Error('resolver exploded');
      }),
    } as unknown as ReferenceResolver;

    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockInternalEventBus,
      mockJobQueue,
      badResolver
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-5',
      content: 'See @ref{file:a.ts}',
    });

    expect(enqueueUniquePendingSpy.mock.calls[0]?.[0]?.payload).toEqual(
      expect.objectContaining({ messageUuid: 'msg-5' })
    );
  });

  it('embeds partial metadata when only some references resolve', async () => {
    const persistence = new MessagePersistence(
      mockSessionCache,
      mockDb,
      mockInternalEventBus,
      mockJobQueue,
      new ReferenceResolver()
    );

    await persistence.persist({
      sessionId: 'test-session-id',
      messageId: 'msg-6',
      content: 'See @ref{file:a.ts} and @ref{file:gone.ts}',
    });

    expect(enqueueUniquePendingSpy.mock.calls[0]?.[0]?.payload.message).toEqual(
      expect.objectContaining({
        referenceMetadata: {
          '@ref{file:a.ts}': { type: 'file', id: 'a.ts', displayText: 'a.ts' },
          '@ref{file:gone.ts}': {
            type: 'file',
            id: 'gone.ts',
            displayText: 'gone.ts',
            status: 'unresolved',
          },
        },
      })
    );
  });
});
