import { describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import {
  persistPrompt,
  PromptContentConflictError,
} from '../../../../src/lib/agent/message-delivery-outbox';
import type { InjectionDeliveryRowDeps } from '../../../../src/lib/space/runtime/injection-delivery-steps';
import {
  deliverInjectedMessage,
  flipDeliveryRowToDeferred,
  reopenFailedDeliveryRow,
  settleDeliveryRowStatus,
} from '../../../../src/lib/space/runtime/injection-delivery-steps';

const SESSION_ID = 'session-inject-steps';
const MESSAGE_ID = '11111111-2222-3333-4444-555555555555';

function makeRowDeps(
  opts: { savedDbId?: string; reopenDbId?: string | null; deferredDbId?: string | null } = {}
) {
  const publishStatusChanged = mock(async () => {});
  const saveUserMessage = mock(() => opts.savedDbId ?? 'db-id');
  const reopenDeliveryByUuid = mock(() => opts.reopenDbId ?? null);
  const markDeliveryDeferredByUuid = mock(() => opts.deferredDbId ?? null);
  const deps: InjectionDeliveryRowDeps = {
    publishStatusChanged,
    saveUserMessage,
    reopenDeliveryByUuid,
    markDeliveryDeferredByUuid,
  };
  return {
    deps,
    publishStatusChanged,
    saveUserMessage,
    reopenDeliveryByUuid,
    markDeliveryDeferredByUuid,
  };
}

function makeSdkUserMessage(text = 'shell step'): SDKUserMessage {
  return {
    type: 'user',
    uuid: MESSAGE_ID,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

describe('reopenFailedDeliveryRow', () => {
  it('publishes enqueued with the reopened db id when the reopen lands', async () => {
    const rows = makeRowDeps({ reopenDbId: 'reopened-db' });

    await reopenFailedDeliveryRow(rows.deps, SESSION_ID, MESSAGE_ID);

    expect(rows.reopenDeliveryByUuid).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID);
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, 'reopened-db', 'enqueued');
  });

  it('publishes nothing when no row reopened', async () => {
    const rows = makeRowDeps({ reopenDbId: null });

    await reopenFailedDeliveryRow(rows.deps, SESSION_ID, MESSAGE_ID);

    expect(rows.publishStatusChanged).not.toHaveBeenCalled();
  });
});

describe('flipDeliveryRowToDeferred', () => {
  it('marks deferred, publishes deferred, and returns the flipped db id', async () => {
    const rows = makeRowDeps({ deferredDbId: 'flipped-db' });

    const flippedDbId = await flipDeliveryRowToDeferred(rows.deps, SESSION_ID, MESSAGE_ID);

    expect(flippedDbId).toBe('flipped-db');
    expect(rows.markDeliveryDeferredByUuid).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID);
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, 'flipped-db', 'deferred');
  });

  it('returns null and publishes nothing when no row flips', async () => {
    const rows = makeRowDeps({ deferredDbId: null });

    const flippedDbId = await flipDeliveryRowToDeferred(rows.deps, SESSION_ID, MESSAGE_ID);

    expect(flippedDbId).toBeNull();
    expect(rows.publishStatusChanged).not.toHaveBeenCalled();
  });
});

describe('settleDeliveryRowStatus', () => {
  it('persists a fresh row with the status and publishes it', async () => {
    const rows = makeRowDeps({ savedDbId: 'saved-db' });

    const dbId = await settleDeliveryRowStatus(rows.deps, {
      sessionId: SESSION_ID,
      message: makeSdkUserMessage(),
      messageId: MESSAGE_ID,
      rowExists: false,
      status: 'deferred',
      origin: 'system',
    });

    expect(dbId).toBe('saved-db');
    expect(rows.saveUserMessage).toHaveBeenCalledTimes(1);
    const [sessionId, message, sendStatus, origin] = rows.saveUserMessage.mock.calls[0];
    expect(sessionId).toBe(SESSION_ID);
    expect(message.uuid).toBe(MESSAGE_ID);
    expect(sendStatus).toBe('deferred');
    expect(origin).toBe('system');
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, 'saved-db', 'deferred');
  });

  it('reuses the existing message id without persisting and publishes the status on it', async () => {
    const rows = makeRowDeps();

    const dbId = await settleDeliveryRowStatus(rows.deps, {
      sessionId: SESSION_ID,
      message: makeSdkUserMessage(),
      messageId: MESSAGE_ID,
      rowExists: true,
      status: 'enqueued',
    });

    expect(dbId).toBe(MESSAGE_ID);
    expect(rows.saveUserMessage).not.toHaveBeenCalled();
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID, 'enqueued');
  });
});

function setupOutbox() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      send_status TEXT,
      origin TEXT,
      is_renderable INTEGER NOT NULL DEFAULT 1,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      conversation_turn_index INTEGER,
      parent_tool_use_id TEXT,
      task_id TEXT,
      sdk_uuid TEXT,
      replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0,
      consumed_seq INTEGER
    );
    CREATE TABLE sdk_message_replacements (
      source_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      target_uuid TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (source_message_id, target_uuid, kind)
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, visible_message_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id);

    CREATE TABLE job_queue (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      heartbeat_at INTEGER,
      completed_at INTEGER
    );
  `);
  const sdkRepo = new SDKMessageRepository(db as never);
  const jobQueue = new JobQueueRepository(db as never);
  return { db, sdkRepo, jobQueue };
}

type OutboxHarness = ReturnType<typeof setupOutbox> & {
  publishStatusChanged: ReturnType<typeof mock>;
  setQueuedIfIdle: ReturnType<typeof mock>;
};

function makeOutboxHarness(): OutboxHarness {
  const base = setupOutbox();
  const publishStatusChanged = mock(async () => {});
  const setQueuedIfIdle = mock(async () => true);
  return { ...base, publishStatusChanged, setQueuedIfIdle };
}

function deliveryJobCount(h: OutboxHarness, uuid: string): number {
  const row = h.db
    .prepare(
      `SELECT COUNT(*) AS n FROM job_queue
        WHERE queue = ?
          AND json_extract(payload, '$.sessionId') = ?
          AND json_extract(payload, '$.messageUuid') = ?
          AND status IN ('pending', 'processing')`
    )
    .get(MESSAGE_DELIVERY, SESSION_ID, uuid) as { n: number };
  return row.n;
}

function seedRow(h: OutboxHarness, text: string, hold?: 'manual'): string {
  const { dbMessageId } = persistPrompt({
    db: h.db,
    sdkMessageRepo: h.sdkRepo,
    jobQueue: h.jobQueue,
    sessionId: SESSION_ID,
    message: makeSdkUserMessage(text),
    ...(hold ? { hold } : {}),
    delivery: { origin: 'space_inject' },
  });
  return dbMessageId;
}

function sendStatus(h: OutboxHarness, uuid: string): string | null | undefined {
  return h.sdkRepo.getDeliveryContent(SESSION_ID, uuid)?.sendStatus;
}

function branchDeps(h: OutboxHarness) {
  return {
    publishStatusChanged: h.publishStatusChanged,
    saveUserMessage: () => {
      throw new Error('saveUserMessage must not be called by the handoff path');
    },
    reopenDeliveryByUuid: () => null,
    markDeliveryDeferredByUuid: () => null,
    db: h.db,
    sdkMessageRepo: h.sdkRepo,
    jobQueue: h.jobQueue,
  };
}

function injectArgs(
  h: OutboxHarness,
  args: { text?: string; origin?: 'system'; boundaryOwner?: { release(): void } } = {}
) {
  return {
    session: { stateManager: { setQueuedIfIdle: h.setQueuedIfIdle } },
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    sdkUserMessage: makeSdkUserMessage(args.text),
    origin: args.origin,
    ...(args.boundaryOwner ? { boundaryOwner: args.boundaryOwner } : {}),
  };
}

describe('deliverInjectedMessage', () => {
  it('ensures a fresh row with the deterministic uuid, enqueues a space_inject job, and returns the db id', async () => {
    const h = makeOutboxHarness();

    const dbId = await deliverInjectedMessage(branchDeps(h), injectArgs(h, { origin: 'system' }));

    expect(typeof dbId).toBe('string');
    expect(sendStatus(h, MESSAGE_ID)).toBe('enqueued');
    expect(deliveryJobCount(h, MESSAGE_ID)).toBe(1);
    const row = h.db
      .prepare(`SELECT sdk_uuid AS uuid, origin FROM sdk_messages WHERE id = ?`)
      .get(dbId as string) as { uuid: string; origin: string };
    expect(row.uuid).toBe(MESSAGE_ID);
    expect(row.origin).toBe('system');
    const payload = h.db
      .prepare(
        `SELECT payload FROM job_queue
          WHERE queue = ? AND json_extract(payload, '$.messageUuid') = ?
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(MESSAGE_DELIVERY, MESSAGE_ID) as { payload: string };
    expect(JSON.parse(payload.payload)).toMatchObject({
      sessionId: SESSION_ID,
      messageUuid: MESSAGE_ID,
      origin: 'space_inject',
    });
    expect(h.setQueuedIfIdle).toHaveBeenCalledWith(MESSAGE_ID);
    expect(h.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, dbId, 'enqueued');
  });

  it('re-arms an existing enqueued row whose delivery job finished and keeps one row', async () => {
    const h = makeOutboxHarness();
    const dbId = seedRow(h, 'existing');
    h.db
      .prepare(
        "UPDATE job_queue SET status = 'completed' WHERE json_extract(payload, '$.messageUuid') = ?"
      )
      .run(MESSAGE_ID);

    const returned = await deliverInjectedMessage(
      branchDeps(h),
      injectArgs(h, { text: 'existing' })
    );

    expect(returned).toBe(dbId);
    expect(
      (
        h.db
          .prepare(`SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_uuid = ?`)
          .get(MESSAGE_ID) as { n: number }
      ).n
    ).toBe(1);
    expect(deliveryJobCount(h, MESSAGE_ID)).toBe(1);
  });

  it('retries a failed row into the mailbox', async () => {
    const h = makeOutboxHarness();
    const dbId = seedRow(h, 'recover me');
    h.sdkRepo.updateMessageStatus([dbId], 'failed');
    h.db
      .prepare(
        "UPDATE job_queue SET status = 'completed' WHERE json_extract(payload, '$.messageUuid') = ?"
      )
      .run(MESSAGE_ID);

    const returned = await deliverInjectedMessage(
      branchDeps(h),
      injectArgs(h, { text: 'recover me' })
    );

    expect(returned).toBe(dbId);
    expect(sendStatus(h, MESSAGE_ID)).toBe('enqueued');
    expect(deliveryJobCount(h, MESSAGE_ID)).toBe(1);
  });

  it('activates a deferred row into the mailbox', async () => {
    const h = makeOutboxHarness();
    const dbId = seedRow(h, 'held back', 'manual');
    expect(sendStatus(h, MESSAGE_ID)).toBe('deferred');

    const returned = await deliverInjectedMessage(
      branchDeps(h),
      injectArgs(h, { text: 'held back' })
    );

    expect(returned).toBe(dbId);
    expect(sendStatus(h, MESSAGE_ID)).toBe('enqueued');
    expect(deliveryJobCount(h, MESSAGE_ID)).toBe(1);
  });

  it('releases the context-clear boundary owner once the handoff settles', async () => {
    const h = makeOutboxHarness();
    const boundaryOwner = { release: mock(() => {}) };

    await deliverInjectedMessage(branchDeps(h), injectArgs(h, { boundaryOwner }));

    expect(boundaryOwner.release).toHaveBeenCalledTimes(1);
  });

  it('releases the context-clear boundary owner when the handoff throws', async () => {
    const h = makeOutboxHarness();
    seedRow(h, 'original');
    const boundaryOwner = { release: mock(() => {}) };

    await expect(
      deliverInjectedMessage(branchDeps(h), injectArgs(h, { text: 'conflicting', boundaryOwner }))
    ).rejects.toBeInstanceOf(PromptContentConflictError);

    expect(boundaryOwner.release).toHaveBeenCalledTimes(1);
  });

  it('propagates a content conflict without dead-lettering the row', async () => {
    const h = makeOutboxHarness();
    seedRow(h, 'original');

    await expect(
      deliverInjectedMessage(branchDeps(h), injectArgs(h, { text: 'conflicting' }))
    ).rejects.toBeInstanceOf(PromptContentConflictError);

    expect(sendStatus(h, MESSAGE_ID)).toBe('enqueued');
    expect(deliveryJobCount(h, MESSAGE_ID)).toBe(1);
    expect(h.publishStatusChanged).not.toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(String),
      'failed'
    );
  });
});
