import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import {
  QueryModeHandler,
  type QueryModeHandlerContext,
} from '../../../../src/lib/agent/query-mode-handler';
import type { RenderPendingDigestOutcome } from '../../../../src/lib/space/runtime/render-pending-digest-pipeline';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';

const SESSION_ID = 'session-digest';

function deferredRow(
  dbId: string,
  uuid: string,
  text: string
): SDKUserMessage & {
  dbId: string;
  timestamp: number;
} {
  return {
    type: 'user',
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    isSynthetic: true,
    inputKind: 'system',
    dbId,
    timestamp: 0,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as SDKUserMessage & { dbId: string; timestamp: number };
}

describe('QueryModeHandler deferred external-event digest flush', () => {
  let handler: QueryModeHandler;
  let handlerContext: QueryModeHandlerContext;
  let deferredRows: Array<SDKUserMessage & { dbId: string; timestamp: number }>;
  let savedRows: Array<{ message: SDKUserMessage; sendStatus: string }>;
  let statusUpdates: Array<{ dbIds: string[]; status: string }>;
  let enqueued: Array<{ uuid: string; content: unknown }>;
  let published: Array<{ messageIds: string[]; status: string }>;
  let warnMessages: unknown[];
  let v2Previous: string | undefined;

  beforeEach(() => {
    v2Previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
    deferredRows = [];
    savedRows = [];
    statusUpdates = [];
    enqueued = [];
    published = [];
    warnMessages = [];

    const session = {
      id: SESSION_ID,
      title: 'Digest',
      workspacePath: '/test',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1 },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    } as unknown as Session;

    const db = {
      getUserMessagesByStatus: mock((_sessionId: string, _status: string) => ({
        messages: deferredRows,
        total: deferredRows.length,
      })),
      updateMessageStatus: mock((dbIds: string[], status: string) => {
        statusUpdates.push({ dbIds, status });
      }),
      saveUserMessage: mock((_sessionId: string, message: SDKUserMessage, sendStatus: string) => {
        savedRows.push({ message, sendStatus });
        return `db-digest-${savedRows.length}`;
      }),
      getSDKMessageRepo: () => ({
        getMessageByStatusAndUuid: () => null,
      }),
      getJobQueueRepo: () => ({
        activeDeliveryMessageUuids: () => new Set<string>(),
        hasActiveTurnDeliveryJob: () => false,
      }),
    } as unknown as Database;

    const internalEventBus = {
      publish: mock(async (event: string, payload: { messageIds?: string[]; status?: string }) => {
        if (event === 'messages.statusChanged') {
          published.push({ messageIds: payload.messageIds ?? [], status: payload.status ?? '' });
        }
      }),
      publishAsync: mock(async () => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<any>;

    const messageQueue = {
      enqueueWithId: mock(async (uuid: string, content: unknown) => {
        enqueued.push({ uuid, content });
      }),
      hasPendingOrInFlight: mock(() => false),
      size: mock(() => 0),
    } as unknown as MessageQueue;

    const logger = {
      log: mock(() => {}),
      warn: mock((message: unknown) => {
        warnMessages.push(message);
      }),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    const context: QueryModeHandlerContext = {
      session,
      db,
      internalEventBus,
      messageQueue,
      logger,
      ensureQueryStarted: mock(async () => {}),
    };
    handlerContext = context;
    handler = new QueryModeHandler(context);
  });

  afterEach(() => {
    if (v2Previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
    else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = v2Previous;
  });

  it('delivers a subsequent normal deferred message individually without a digest', async () => {
    deferredRows = [deferredRow('db-human', 'uuid-human', 'a human follow-up')];

    const result = await handler.handleQueryTrigger({
      deliverIndividually: true,
      skipResetCoordination: true,
    });

    expect(result.success).toBe(true);
    expect(savedRows).toHaveLength(0);
    expect(statusUpdates).toEqual([{ dbIds: ['db-human'], status: 'enqueued' }]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.uuid).toBe('uuid-human');
  });

  describe('turn-end digest pull', () => {
    let pullCalls: string[];
    let pullError: Error | null;
    let pullImpl: () => Promise<RenderPendingDigestOutcome>;

    beforeEach(() => {
      pullCalls = [];
      pullError = null;
      pullImpl = async () => {
        deferredRows.push(
          deferredRow(
            'db-pulled-digest',
            'uuid-pulled-digest',
            'External events while you were working (2 events, PR #2828):'
          )
        );
        return {
          action: 'delivered',
          uuid: 'uuid-pulled-digest',
          dbId: 'db-pulled-digest',
          text: 'External events while you were working (2 events, PR #2828):',
          eventIds: [],
          deliveryKeys: [],
          replayed: false,
        };
      };
      handlerContext.renderPendingDigest = async (sessionId) => {
        pullCalls.push(sessionId);
        if (pullError) throw pullError;
        return pullImpl();
      };
    });

    it('appends the pulled digest to the flush batch without touching the task input', async () => {
      deferredRows = [deferredRow('db-task', 'uuid-task', '─── Message from coder ───')];

      const result = await handler.handleQueryTrigger({
        deliverIndividually: true,
        skipResetCoordination: true,
      });

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      expect(pullCalls).toEqual([SESSION_ID]);
      expect(savedRows).toHaveLength(0);
      expect(enqueued).toHaveLength(2);
      expect(enqueued[0]?.uuid).toBe('uuid-task');
      expect(enqueued[0]?.content).toBe('─── Message from coder ───');
      const digestDelivery = enqueued[1]!;
      expect(digestDelivery.uuid).toBe('uuid-pulled-digest');
      expect(String(digestDelivery.content)).toContain('(2 events, PR #2828):');
    });

    it('a failing digest pull logs and flushes without the digest', async () => {
      pullError = new Error('ledger unavailable');
      deferredRows = [deferredRow('db-task', 'uuid-task', '─── Message from coder ───')];

      const result = await handler.handleQueryTrigger({
        deliverIndividually: true,
        skipResetCoordination: true,
      });

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(warnMessages.some((message) => String(message).includes('turn-end digest pull'))).toBe(
        true
      );
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.uuid).toBe('uuid-task');
    });

    it('a failed digest-pull outcome logs and flushes without the digest', async () => {
      pullImpl = async () => ({
        action: 'failed',
        stage: 'markDeliveries',
        error: new Error('db locked'),
      });
      deferredRows = [deferredRow('db-task', 'uuid-task', '─── Message from coder ───')];

      const result = await handler.handleQueryTrigger({
        deliverIndividually: true,
        skipResetCoordination: true,
      });

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(warnMessages.some((message) => String(message).includes('did not deliver'))).toBe(
        true
      );
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.uuid).toBe('uuid-task');
    });
  });
});
