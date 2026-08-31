import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import {
  persistPrompt,
  PromptContentConflictError,
} from '../../../../src/lib/agent/message-delivery-outbox';
import {
  activateDeferredPromptIntoMailbox,
  ensurePromptIntoMailbox,
  hasSettledHandoffRow,
  planHandoffMechanism,
  resolveDeliverableHandoff,
  retryFailedPromptIntoMailbox,
  type PromptHandoffDeps,
  type PromptHandoffTarget,
} from '../../../../src/lib/space/runtime/prompt-mailbox-handoff';
import type { MessageDeliveryOrigin } from '../../../../src/lib/agent/message-delivery';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const SESSION = 'sess-handoff';

function userMessage(uuid: string, text = 'hello'): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SDKMessage;
}

function setup() {
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

type Harness = ReturnType<typeof setup> & { deps: PromptHandoffDeps };

function makeHarness(): Harness {
  const base = setup();
  return { ...base, deps: { db: base.db, sdkMessageRepo: base.sdkRepo, jobQueue: base.jobQueue } };
}

function targetFor(
  message: SDKMessage,
  origin: MessageDeliveryOrigin = 'space_inject'
): PromptHandoffTarget {
  return {
    sessionId: SESSION,
    messageId: (message as { uuid: string }).uuid,
    message: message as never,
    origin,
  };
}

function seedEnqueuedRow(h: Harness, uuid: string, text = 'hello'): string {
  const { dbMessageId } = persistPrompt({
    db: h.deps.db,
    sdkMessageRepo: h.deps.sdkMessageRepo,
    jobQueue: h.deps.jobQueue,
    sessionId: SESSION,
    message: userMessage(uuid, text),
    delivery: { origin: 'space_inject' },
  });
  return dbMessageId;
}

function seedDeferredRow(h: Harness, uuid: string, text = 'hello'): string {
  const { dbMessageId } = persistPrompt({
    db: h.deps.db,
    sdkMessageRepo: h.deps.sdkMessageRepo,
    jobQueue: h.deps.jobQueue,
    sessionId: SESSION,
    message: userMessage(uuid, text),
    hold: 'manual',
    delivery: { origin: 'space_inject' },
  });
  return dbMessageId;
}

function sendStatus(h: Harness, uuid: string): string | null | undefined {
  return h.deps.sdkMessageRepo.getDeliveryContent(SESSION, uuid)?.sendStatus;
}

function deliveryJobCount(h: Harness, uuid: string): number {
  const row = h.db
    .prepare(
      `SELECT COUNT(*) AS n FROM job_queue
        WHERE queue = ?
          AND json_extract(payload, '$.sessionId') = ?
          AND json_extract(payload, '$.messageUuid') = ?
          AND status IN ('pending', 'processing')`
    )
    .get(MESSAGE_DELIVERY, SESSION, uuid) as { n: number };
  return row.n;
}

function markRowStatus(h: Harness, dbId: string, status: string): void {
  h.deps.sdkMessageRepo.updateMessageStatus([dbId], status as never);
}

function setConsumedSeq(h: Harness, uuid: string): void {
  h.db
    .prepare('UPDATE sdk_messages SET consumed_seq = 1 WHERE session_id = ? AND sdk_uuid = ?')
    .run(SESSION, uuid);
}

describe('planHandoffMechanism', () => {
  it('maps the existing row status onto the handoff mechanism', () => {
    expect(planHandoffMechanism({ sendStatus: 'failed' })).toBe('retry');
    expect(planHandoffMechanism({ sendStatus: 'deferred' })).toBe('activate');
    expect(planHandoffMechanism(null)).toBe('ensure');
    expect(planHandoffMechanism(undefined)).toBe('ensure');
    expect(planHandoffMechanism({ sendStatus: 'enqueued' })).toBe('ensure');
    expect(planHandoffMechanism({ sendStatus: 'submitted' })).toBe('ensure');
    expect(planHandoffMechanism({ sendStatus: 'consumed' })).toBe('ensure');
  });
});

describe('hasSettledHandoffRow', () => {
  it('treats consumption evidence as settled even when send_status says failed', () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-evidence-1');
    markRowStatus(h, dbId, 'failed');
    setConsumedSeq(h, 'msg-evidence-1');
    expect(hasSettledHandoffRow(h.deps, { sessionId: SESSION, messageId: 'msg-evidence-1' })).toBe(
      true
    );
  });

  it('treats a consumed send_status as settled', () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-consumed-1');
    markRowStatus(h, dbId, 'consumed');
    expect(hasSettledHandoffRow(h.deps, { sessionId: SESSION, messageId: 'msg-consumed-1' })).toBe(
      true
    );
  });

  it('leaves a failed row without evidence unsettled', () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-failed-1');
    markRowStatus(h, dbId, 'failed');
    expect(hasSettledHandoffRow(h.deps, { sessionId: SESSION, messageId: 'msg-failed-1' })).toBe(
      false
    );
  });

  it('leaves enqueued rows and missing rows unsettled', () => {
    const h = makeHarness();
    seedEnqueuedRow(h, 'msg-enqueued-1');
    expect(hasSettledHandoffRow(h.deps, { sessionId: SESSION, messageId: 'msg-enqueued-1' })).toBe(
      false
    );
    expect(hasSettledHandoffRow(h.deps, { sessionId: SESSION, messageId: 'msg-absent-1' })).toBe(
      false
    );
  });
});

describe('resolveDeliverableHandoff', () => {
  it('resolves the db id for the message uuid', () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-resolve-1');
    expect(resolveDeliverableHandoff(h.deps, targetFor(userMessage('msg-resolve-1')))).toEqual({
      dbId,
      changed: false,
    });
  });

  it('falls back to the message id when no row exists', () => {
    const h = makeHarness();
    expect(resolveDeliverableHandoff(h.deps, targetFor(userMessage('msg-absent-2')))).toEqual({
      dbId: 'msg-absent-2',
      changed: false,
    });
  });
});

describe('retryFailedPromptIntoMailbox', () => {
  it('retries a failed row without evidence and re-enqueues its job', async () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-retry-1');
    markRowStatus(h, dbId, 'failed');
    const outcome = await retryFailedPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-retry-1'))
    );
    expect(outcome).toEqual({ dbId, changed: true });
    expect(sendStatus(h, 'msg-retry-1')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-retry-1')).toBe(1);
  });

  it('settles as deliverable without a new job when consumption evidence exists', async () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-retry-2');
    markRowStatus(h, dbId, 'failed');
    setConsumedSeq(h, 'msg-retry-2');
    const outcome = await retryFailedPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-retry-2'))
    );
    expect(outcome).toEqual({ dbId, changed: false });
    expect(sendStatus(h, 'msg-retry-2')).toBe('failed');
    expect(deliveryJobCount(h, 'msg-retry-2')).toBe(0);
  });

  it('reports a stale snapshot as null when no failed row matches', async () => {
    const h = makeHarness();
    seedEnqueuedRow(h, 'msg-retry-3');
    const outcome = await retryFailedPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-retry-3'))
    );
    expect(outcome).toBeNull();
  });
});

describe('activateDeferredPromptIntoMailbox', () => {
  it('activates a deferred row and enqueues its job', async () => {
    const h = makeHarness();
    const dbId = seedDeferredRow(h, 'msg-activate-1');
    const outcome = await activateDeferredPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-activate-1'))
    );
    expect(outcome).toEqual({ dbId, changed: true });
    expect(sendStatus(h, 'msg-activate-1')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-activate-1')).toBe(1);
  });

  it('reports a stale snapshot as null when the row is no longer activatable', async () => {
    const h = makeHarness();
    const dbId = seedDeferredRow(h, 'msg-activate-2');
    markRowStatus(h, dbId, 'consumed');
    const outcome = await activateDeferredPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-activate-2'))
    );
    expect(outcome).toBeNull();
  });
});

describe('ensurePromptIntoMailbox', () => {
  it('creates a missing row and reports it advanced and changed', () => {
    const h = makeHarness();
    const outcome = ensurePromptIntoMailbox(h.deps, targetFor(userMessage('msg-ensure-1', 'a')));
    expect(outcome.advanced).toBe(true);
    expect(outcome.changed).toBe(true);
    expect(sendStatus(h, 'msg-ensure-1')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-ensure-1')).toBe(1);
  });

  it('re-arms an existing enqueued row whose job finished', () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-ensure-2', 'a');
    h.db
      .prepare("UPDATE job_queue SET status = ? WHERE json_extract(payload, '$.messageUuid') = ?")
      .run('completed', 'msg-ensure-2');
    const outcome = ensurePromptIntoMailbox(h.deps, targetFor(userMessage('msg-ensure-2', 'a')));
    expect(outcome).toEqual({ dbId, changed: false, advanced: true });
    expect(deliveryJobCount(h, 'msg-ensure-2')).toBe(1);
  });

  it('reports a consumed row as not advanced without throwing', () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-ensure-3', 'a');
    h.db
      .prepare("UPDATE job_queue SET status = ? WHERE json_extract(payload, '$.messageUuid') = ?")
      .run('completed', 'msg-ensure-3');
    markRowStatus(h, dbId, 'consumed');
    const outcome = ensurePromptIntoMailbox(h.deps, targetFor(userMessage('msg-ensure-3', 'a')));
    expect(outcome).toEqual({ dbId, changed: false, advanced: false });
    expect(deliveryJobCount(h, 'msg-ensure-3')).toBe(0);
  });

  it('throws PromptContentConflictError on conflicting content', () => {
    const h = makeHarness();
    seedEnqueuedRow(h, 'msg-ensure-4', 'original');
    expect(() =>
      ensurePromptIntoMailbox(h.deps, targetFor(userMessage('msg-ensure-4', 'conflicting')))
    ).toThrow(PromptContentConflictError);
  });
});
