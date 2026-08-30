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
import { Database as DatabaseImpl } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';

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

interface EnqueuedJob {
  uuid: string;
  role: string;
  batchUuids?: string[];
}

describe('QueryModeHandler deferred external-event digest flush', () => {
  let handler: QueryModeHandler;
  let handlerContext: QueryModeHandlerContext;
  let deferredRows: Array<SDKUserMessage & { dbId: string; timestamp: number }>;
  let savedRows: Array<{ message: SDKUserMessage; sendStatus: string }>;
  let statusUpdates: Array<{ dbIds: string[]; status: string }>;
  let published: Array<{ messageIds: string[]; status: string }>;
  let warnMessages: unknown[];
  let jobsDb: DatabaseImpl;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    deferredRows = [];
    savedRows = [];
    statusUpdates = [];
    published = [];
    warnMessages = [];

    jobsDb = new DatabaseImpl(':memory:');
    jobsDb.exec(`
      CREATE TABLE job_queue (
        id TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload TEXT NOT NULL DEFAULT '{}',
        result TEXT, error TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        retry_count INTEGER NOT NULL DEFAULT 0,
        run_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        heartbeat_at INTEGER, completed_at INTEGER
      );
      CREATE UNIQUE INDEX uq_message_delivery_active_turn
        ON job_queue (queue, json_extract(payload, '$.sessionId'))
        WHERE queue = 'message_delivery'
          AND json_extract(payload, '$.role') = 'turn'
          AND status IN ('pending', 'processing');
    `);
    jobQueue = new JobQueueRepository(jobsDb as never);

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
      getJobQueueRepo: () => jobQueue,
    } as unknown as Database;

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
    jobsDb.close();
  });

  function enqueued(): EnqueuedJob[] {
    return (
      jobsDb
        .prepare(
          `SELECT json_extract(payload, '$.messageUuid') AS messageUuid,
                  json_extract(payload, '$.batchUuids') AS batchUuids,
                  json_extract(payload, '$.role') AS role
             FROM job_queue
            WHERE queue = 'message_delivery'
            ORDER BY created_at ASC`
        )
        .all() as Array<{
        messageUuid: string | null;
        batchUuids: string | null;
        role: string | null;
      }>
    ).map((row) => ({
      uuid: row.messageUuid ?? '',
      role: row.role ?? '',
      batchUuids: row.batchUuids ? (JSON.parse(row.batchUuids) as string[]) : undefined,
    }));
  }

  it('delivers a subsequent normal deferred message without a digest', async () => {
    deferredRows = [deferredRow('db-human', 'uuid-human', 'a human follow-up')];

    const result = await handler.handleQueryTrigger();

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(1);
    expect(statusUpdates).toEqual([{ dbIds: ['db-human'], status: 'enqueued' }]);
    const jobs = enqueued();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.uuid).toBe('uuid-human');
    expect(jobs[0]?.batchUuids).toBeUndefined();
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

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      expect(pullCalls).toEqual([SESSION_ID]);
      expect(savedRows).toHaveLength(0);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
      expect(jobs[0]?.batchUuids).toEqual(['uuid-task', 'uuid-pulled-digest']);
    });

    it('a failing digest pull logs and flushes without the digest', async () => {
      pullError = new Error('ledger unavailable');
      deferredRows = [deferredRow('db-task', 'uuid-task', '─── Message from coder ───')];

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
      deferredRows = [deferredRow('db-task', 'uuid-task', '─── Message from coder ───')];

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
      deferredRows = [
        deferredRow('db-task', 'uuid-task', '─── Message from coder ───'),
        deferredRow('db-digest', 'digest-00000000-0000-0000-0000-000000000000', 'stale digest'),
      ];

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(warnMessages.some((message) => String(message).includes('unavailable'))).toBe(true);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
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
      deferredRows = [
        deferredRow('db-task', 'uuid-task', '─── Message from coder ───'),
        deferredRow('db-certified', 'digest-certified-0001', 'certified digest'),
        deferredRow('db-stale', 'digest-stale-0002', 'stale digest'),
      ];

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
      expect(jobs[0]?.batchUuids).toEqual(['uuid-task', 'digest-certified-0001']);
    });

    it('a safe skip outcome flushes deferred digest rows', async () => {
      pullImpl = async () => ({ action: 'skip', reason: 'no_pending_events' });
      deferredRows = [
        deferredRow('db-task', 'uuid-task', '─── Message from coder ───'),
        deferredRow('db-digest', 'digest-owed-0003', 'owed digest'),
      ];

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
      expect(jobs[0]?.batchUuids).toEqual(['uuid-task', 'digest-owed-0003']);
    });

    it('a safe skip scopes flushed digest rows to the admitted task', async () => {
      pullImpl = async () => ({ action: 'skip', reason: 'no_pending_events' });
      (handlerContext.session as { context?: { taskId?: string } }).context = {
        taskId: 'task-admitted',
      };
      const scoped = deferredRow('db-scoped', 'digest-scoped-0005', 'scoped digest');
      (scoped as { externalEventTaskId?: string }).externalEventTaskId = 'task-admitted';
      const otherTask = deferredRow('db-other', 'digest-other-0006', 'other task digest');
      (otherTask as { externalEventTaskId?: string }).externalEventTaskId = 'task-other';
      const legacy = deferredRow('db-legacy', 'digest-legacy-0007', 'legacy digest');
      deferredRows = [
        deferredRow('db-task', 'uuid-task', '─── Message from coder ───'),
        scoped,
        otherTask,
        legacy,
      ];

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(2);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
      expect(jobs[0]?.batchUuids).toEqual(['uuid-task', 'digest-scoped-0005']);
    });

    it('an unsafe skip outcome excludes deterministic digest rows', async () => {
      pullImpl = async () => ({
        action: 'skip',
        reason: 'session_interrupted',
      });
      deferredRows = [
        deferredRow('db-task', 'uuid-task', '─── Message from coder ───'),
        deferredRow('db-digest', 'digest-00000000-0000-0000-0000-000000000000', 'stale digest'),
      ];

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
      deferredRows = [
        deferredRow('db-task', 'uuid-task', '─── Message from coder ───'),
        deferredRow('db-digest', 'digest-held-0004', 'held digest text'),
      ];

      const result = await handler.handleQueryTrigger();

      expect(result.success).toBe(true);
      expect(result.messageCount).toBe(1);
      const jobs = enqueued();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.uuid).toBe('uuid-task');
    });
  });
});
