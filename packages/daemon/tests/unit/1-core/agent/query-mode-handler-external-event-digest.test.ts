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
import { createTestDb } from '../../../helpers/database';

const SESSION_ID = 'session-digest';

function deferredRow(
  uuid: string,
  text: string,
  extra?: { externalEventTaskId?: string }
): SDKUserMessage {
  return {
    type: 'user',
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    isSynthetic: true,
    inputKind: 'system',
    externalEventTaskId: extra?.externalEventTaskId,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as SDKUserMessage;
}

interface EnqueuedJob {
  uuid: string;
  role: string;
}

describe('QueryModeHandler deferred external-event digest flush', () => {
  let handler: QueryModeHandler;
  let handlerContext: QueryModeHandlerContext;
  let db: Database;
  let published: Array<{ messageIds: string[]; status: string }>;
  let warnMessages: unknown[];

  function seedDeferred(row: SDKUserMessage): void {
    db.saveUserMessage(SESSION_ID, row, 'deferred');
  }

  function enqueued(): EnqueuedJob[] {
    return (
      db
        .getDatabase()
        .prepare(
          `SELECT json_extract(payload, '$.messageUuid') AS messageUuid,
                  json_extract(payload, '$.role') AS role
             FROM job_queue
            WHERE queue = 'message_delivery'
            ORDER BY created_at ASC, rowid ASC`
        )
        .all() as Array<{ messageUuid: string | null; role: string | null }>
    ).map((row) => ({ uuid: row.messageUuid ?? '', role: row.role ?? '' }));
  }

  function sendStatusByUuid(uuid: string): string | undefined {
    const row = db
      .getDatabase()
      .prepare(`SELECT send_status FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
      .get(SESSION_ID, uuid) as { send_status: string } | undefined;
    return row?.send_status;
  }

  beforeEach(async () => {
    published = [];
    warnMessages = [];
    db = await createTestDb();

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
    db.createSession(session);

    const messageQueue = {
      enqueueWithId: mock(async () => {}),
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
      internalEventBus: {
        publish: mock(
          async (event: string, payload: { messageIds?: string[]; status?: string }) => {
            if (event === 'messages.statusChanged') {
              published.push({
                messageIds: payload.messageIds ?? [],
                status: payload.status ?? '',
              });
            }
          }
        ),
        publishAsync: mock(async () => {}),
        subscribe: mock(() => () => {}),
      } as unknown as InternalEventBus<any>,
      messageQueue,
      logger,
      ensureQueryStarted: mock(async () => {}),
    };
    handlerContext = context;
    handler = new QueryModeHandler(context);
  });

  afterEach(() => {
    db.getDatabase().close();
  });

  it('delivers a subsequent normal deferred message without a digest', async () => {
    seedDeferred(deferredRow('uuid-human', 'a human follow-up'));

    const result = await handler.handleQueryTrigger();

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(1);
    expect(sendStatusByUuid('uuid-human')).toBe('enqueued');
    const jobs = enqueued();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.uuid).toBe('uuid-human');
    expect(jobs[0]?.role).toBe('turn');
    expect(published).toEqual([{ messageIds: [expect.any(String)], status: 'enqueued' }]);
  });

  describe('turn-end digest pull', () => {
    let pullCalls: string[];
    let pullError: Error | null;
    let pullImpl: () => Promise<RenderPendingDigestOutcome>;

    beforeEach(() => {
      pullCalls = [];
      pullError = null;
      pullImpl = async () => {
        seedDeferred(
          deferredRow(
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
          taskId: 'task-digest',
        };
      };
      handlerContext.renderPendingDigest = async (sessionId) => {
        pullCalls.push(sessionId);
        if (pullError) throw pullError;
        return pullImpl();
      };
    });

    it('appends the pulled digest to the flush without saving another row', async () => {
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      expect(pullCalls).toEqual([SESSION_ID]);
      const jobs = enqueued();
      expect(jobs).toHaveLength(2);
      expect(jobs[0]?.uuid).toBe('uuid-task');
      expect(jobs[0]?.role).toBe('turn');
      expect(jobs[1]?.uuid).toBe('uuid-pulled-digest');
      expect(jobs[1]?.role).toBe('steer');
      expect(sendStatusByUuid('uuid-pulled-digest')).toBe('enqueued');
    });

    it('a failing digest pull logs and flushes without the digest', async () => {
      pullError = new Error('ledger unavailable');
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(warnMessages.some((message) => String(message).includes('turn-end digest pull'))).toBe(
        true
      );
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
    });

    it('a failed digest-pull outcome logs and flushes without the digest', async () => {
      pullImpl = async () => ({
        action: 'failed',
        stage: 'markDeliveries',
        error: new Error('db locked'),
      });
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(warnMessages.some((message) => String(message).includes('did not deliver'))).toBe(
        true
      );
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
    });

    it('a null digest-pull result excludes deterministic digest rows from the flush', async () => {
      pullImpl = async () => null as unknown as RenderPendingDigestOutcome;
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));
      seedDeferred(deferredRow('digest-00000000-0000-0000-0000-000000000000', 'stale digest'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(warnMessages.some((message) => String(message).includes('unavailable'))).toBe(true);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
      expect(sendStatusByUuid('digest-00000000-0000-0000-0000-000000000000')).toBe('deferred');
    });

    it('a delivered outcome only flushes its certified digest row', async () => {
      pullImpl = async () => ({
        action: 'delivered',
        uuid: 'digest-certified-0001',
        dbId: 'db-certified',
        text: 'certified digest',
        eventIds: [],
        deliveryKeys: [],
        replayed: false,
        taskId: 'task-certified',
      });
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));
      seedDeferred(deferredRow('digest-certified-0001', 'certified digest'));
      seedDeferred(deferredRow('digest-stale-0002', 'stale digest'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      const jobs = enqueued();
      expect(jobs.map((job) => job.uuid)).toEqual(['uuid-task', 'digest-certified-0001']);
      expect(sendStatusByUuid('digest-stale-0002')).toBe('deferred');
    });

    it('a safe skip outcome flushes deferred digest rows', async () => {
      pullImpl = async () => ({ action: 'skip', reason: 'no_pending_events' });
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));
      seedDeferred(deferredRow('digest-owed-0003', 'owed digest'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      const jobs = enqueued();
      expect(jobs.map((job) => job.uuid)).toEqual(['uuid-task', 'digest-owed-0003']);
    });

    it('a safe skip scopes flushed digest rows to the admitted task', async () => {
      pullImpl = async () => ({ action: 'skip', reason: 'no_pending_events' });
      (handlerContext.session as { context?: { taskId?: string } }).context = {
        taskId: 'task-admitted',
      };
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));
      seedDeferred(
        deferredRow('digest-scoped-0005', 'scoped digest', { externalEventTaskId: 'task-admitted' })
      );
      seedDeferred(
        deferredRow('digest-other-0006', 'other task digest', { externalEventTaskId: 'task-other' })
      );
      seedDeferred(deferredRow('digest-legacy-0007', 'legacy digest'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      const jobs = enqueued();
      expect(jobs.map((job) => job.uuid)).toEqual(['uuid-task', 'digest-scoped-0005']);
    });

    it('an unsafe skip outcome excludes deterministic digest rows', async () => {
      pullImpl = async () => ({
        action: 'skip',
        reason: 'session_interrupted',
      });
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));
      seedDeferred(deferredRow('digest-00000000-0000-0000-0000-000000000000', 'stale digest'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
    });

    it('a held outcome excludes deterministic digest rows', async () => {
      pullImpl = async () => ({
        action: 'held',
        reason: 'append_error',
        uuid: 'digest-held-0004',
        dbId: 'db-held',
        error: new Error('mailbox full'),
      });
      seedDeferred(deferredRow('uuid-task', '─── Message from coder ───'));
      seedDeferred(deferredRow('digest-held-0004', 'held digest text'));

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
    });
  });
});
