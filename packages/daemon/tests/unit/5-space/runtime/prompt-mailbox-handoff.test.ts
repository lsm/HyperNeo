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
  applyHandoffMechanism,
  ensurePromptIntoMailbox,
  hasSettledHandoffRow,
  handoffPromptToMailbox,
  markQueuedIfIdle,
  planHandoffMechanism,
  publishEnqueuedIfChanged,
  resolveDeliverableHandoff,
  retryFailedPromptIntoMailbox,
  settleHandoffOutcome,
  verifyHandoffContent,
  type MailboxHandoffArgs,
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

function insertDuplicateRow(
  h: Harness,
  uuid: string,
  dbId: string,
  sendStatus: string,
  consumedSeq: number | null = null
): string {
  h.db
    .prepare(
      `INSERT INTO sdk_messages
        (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid,
         replacement_metadata_normalized, consumed_seq)
       VALUES (?, ?, 'user', ?, ?, ?, ?, 1, ?)`
    )
    .run(
      dbId,
      SESSION,
      JSON.stringify(userMessage(uuid)),
      new Date().toISOString(),
      sendStatus,
      uuid,
      consumedSeq
    );
  return dbId;
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

  it('settles when a duplicate sibling carries consumed status without evidence', () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-dup-settled', 'db-dup-oldest', 'failed', null);
    insertDuplicateRow(h, 'msg-dup-settled', 'db-dup-consumed-status', 'consumed', null);
    expect(hasSettledHandoffRow(h.deps, { sessionId: SESSION, messageId: 'msg-dup-settled' })).toBe(
      true
    );
  });

  it('settles a legacy row whose send_status is NULL', () => {
    const h = makeHarness();
    h.db
      .prepare(
        `INSERT INTO sdk_messages
          (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid,
           replacement_metadata_normalized, consumed_seq)
         VALUES (?, ?, 'user', ?, ?, NULL, ?, 1, NULL)`
      )
      .run(
        'db-legacy-null',
        SESSION,
        JSON.stringify(userMessage('msg-legacy-null')),
        new Date().toISOString(),
        'msg-legacy-null'
      );
    expect(hasSettledHandoffRow(h.deps, { sessionId: SESSION, messageId: 'msg-legacy-null' })).toBe(
      true
    );
    expect(resolveDeliverableHandoff(h.deps, targetFor(userMessage('msg-legacy-null')))).toEqual({
      dbId: 'db-legacy-null',
      changed: false,
    });
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

  it('resolves the evidenced sibling when duplicates share a uuid, consumed row inserted first', () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-dup-1', 'db-dup-consumed', 'failed', 7);
    insertDuplicateRow(h, 'msg-dup-1', 'db-dup-failed', 'failed', null);
    expect(resolveDeliverableHandoff(h.deps, targetFor(userMessage('msg-dup-1')))).toEqual({
      dbId: 'db-dup-consumed',
      changed: false,
    });
  });

  it('resolves the evidenced sibling when duplicates share a uuid, consumed row inserted last', () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-dup-2', 'db-dup-failed', 'failed', null);
    insertDuplicateRow(h, 'msg-dup-2', 'db-dup-consumed', 'failed', 9);
    expect(resolveDeliverableHandoff(h.deps, targetFor(userMessage('msg-dup-2')))).toEqual({
      dbId: 'db-dup-consumed',
      changed: false,
    });
  });

  it('resolves the consumed-status sibling when no row carries evidence', () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-dup-3', 'db-dup-enqueued', 'enqueued', null);
    insertDuplicateRow(h, 'msg-dup-3', 'db-dup-consumed-status', 'consumed', null);
    expect(resolveDeliverableHandoff(h.deps, targetFor(userMessage('msg-dup-3')))).toEqual({
      dbId: 'db-dup-consumed-status',
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
    h.db
      .prepare("UPDATE job_queue SET status = ? WHERE json_extract(payload, '$.messageUuid') = ?")
      .run('completed', 'msg-retry-2');
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

  it('settles on the evidenced sibling when duplicates share a uuid', async () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-retry-4', 'db-retry-plain', 'failed', null);
    insertDuplicateRow(h, 'msg-retry-4', 'db-retry-evidenced', 'failed', 5);
    const outcome = await retryFailedPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-retry-4'))
    );
    expect(outcome).toEqual({ dbId: 'db-retry-evidenced', changed: false });
    expect(deliveryJobCount(h, 'msg-retry-4')).toBe(0);
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

  it('settles as deliverable when the row was consumed after the plan', async () => {
    const h = makeHarness();
    const dbId = seedDeferredRow(h, 'msg-activate-2');
    markRowStatus(h, dbId, 'consumed');
    const outcome = await activateDeferredPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-activate-2'))
    );
    expect(outcome).toEqual({ dbId, changed: false });
  });

  it('refuses activation when a duplicate sibling carries consumption evidence', async () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-activate-3', 'db-activate-deferred', 'deferred', null);
    insertDuplicateRow(h, 'msg-activate-3', 'db-activate-evidenced', 'failed', 4);
    const outcome = await activateDeferredPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-activate-3'))
    );
    expect(outcome).toEqual({ dbId: 'db-activate-evidenced', changed: false });
    expect(
      h.db
        .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
        .get('db-activate-deferred') as { send_status: string }
    ).toEqual({ send_status: 'deferred' });
    expect(deliveryJobCount(h, 'msg-activate-3')).toBe(0);
  });

  it('reports a stale snapshot as null when the row is neither activatable nor settled', async () => {
    const h = makeHarness();
    const dbId = seedDeferredRow(h, 'msg-activate-4');
    markRowStatus(h, dbId, 'submitted');
    const outcome = await activateDeferredPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-activate-4'))
    );
    expect(outcome).toBeNull();
  });

  it('refuses activation when a sibling is legacy-consumed without evidence', async () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-activate-5', 'db-activate-deferred', 'deferred', null);
    insertDuplicateRow(h, 'msg-activate-5', 'db-activate-legacy', 'consumed', null);
    const outcome = await activateDeferredPromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-activate-5'))
    );
    expect(outcome).toEqual({ dbId: 'db-activate-legacy', changed: false });
    expect(deliveryJobCount(h, 'msg-activate-5')).toBe(0);
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

  it('does not re-arm an enqueued row when a sibling carries consumption evidence', () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-ensure-5', 'db-ensure-enqueued', 'enqueued', null);
    insertDuplicateRow(h, 'msg-ensure-5', 'db-ensure-evidenced', 'failed', 6);
    const outcome = ensurePromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-ensure-5', 'hello'))
    );
    expect(outcome).toEqual({ dbId: 'db-ensure-enqueued', changed: false, advanced: false });
    expect(deliveryJobCount(h, 'msg-ensure-5')).toBe(0);
  });

  it('does not re-arm an enqueued row when a sibling is legacy-consumed', () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-ensure-6', 'db-ensure-enqueued', 'enqueued', null);
    insertDuplicateRow(h, 'msg-ensure-6', 'db-ensure-legacy', 'consumed', null);
    const outcome = ensurePromptIntoMailbox(
      h.deps,
      targetFor(userMessage('msg-ensure-6', 'hello'))
    );
    expect(outcome).toEqual({ dbId: 'db-ensure-enqueued', changed: false, advanced: false });
    expect(deliveryJobCount(h, 'msg-ensure-6')).toBe(0);
  });
});

type HandoffCtx = Parameters<typeof applyHandoffMechanism>[0];

function ctxFor(h: Harness, message: SDKMessage, extra: Partial<HandoffCtx> = {}): HandoffCtx {
  return { deps: h.deps, target: targetFor(message), ...extra };
}

function portSpy() {
  const queued: string[] = [];
  const published: Array<{ sessionId: string; dbId: string; status: string }> = [];
  return {
    queued,
    published,
    stateManager: {
      setQueuedIfIdle: async (messageId: string) => {
        queued.push(messageId);
        return true;
      },
    },
    publishStatusChanged: async (sessionId: string, dbId: string, status: 'enqueued') => {
      published.push({ sessionId, dbId, status });
    },
  };
}

function argsFor(h: Harness, message: SDKMessage): MailboxHandoffArgs {
  return { deps: h.deps, target: targetFor(message) };
}

describe('verifyHandoffContent', () => {
  it('propagates a content conflict for the ensure mechanism too', () => {
    const h = makeHarness();
    seedEnqueuedRow(h, 'msg-verify-1', 'original');
    expect(() =>
      verifyHandoffContent(
        ctxFor(h, userMessage('msg-verify-1', 'conflicting'), { mechanism: 'ensure' })
      )
    ).toThrow(PromptContentConflictError);
  });

  it('propagates a content conflict for the retry mechanism', () => {
    const h = makeHarness();
    seedEnqueuedRow(h, 'msg-verify-2', 'original');
    expect(() =>
      verifyHandoffContent(
        ctxFor(h, userMessage('msg-verify-2', 'conflicting'), {
          mechanism: 'retry',
        })
      )
    ).toThrow(PromptContentConflictError);
  });
});

describe('applyHandoffMechanism', () => {
  it('applies the planned mechanism and normalizes the stage outcome', async () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-apply-1');
    markRowStatus(h, dbId, 'failed');
    const ctx = await applyHandoffMechanism(
      ctxFor(h, userMessage('msg-apply-1'), {
        mechanism: 'retry',
      })
    );
    expect(ctx.applied).toEqual({ dbId, changed: true, advanced: true });
    expect(sendStatus(h, 'msg-apply-1')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-apply-1')).toBe(1);
  });

  it('reconciles a stale plan by re-reading the row and re-dispatching', async () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-apply-2');
    const ctx = await applyHandoffMechanism(
      ctxFor(h, userMessage('msg-apply-2'), {
        mechanism: 'retry',
      })
    );
    expect(ctx.applied).toEqual({ dbId, changed: false, advanced: true });
  });

  it('reconciles onto activation when the row is deferred under a stale plan', async () => {
    const h = makeHarness();
    const dbId = seedDeferredRow(h, 'msg-apply-3');
    const ctx = await applyHandoffMechanism(
      ctxFor(h, userMessage('msg-apply-3'), {
        mechanism: 'retry',
      })
    );
    expect(ctx.applied).toEqual({ dbId, changed: true, advanced: true });
    expect(sendStatus(h, 'msg-apply-3')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-apply-3')).toBe(1);
  });

  it('reconciles an ensure plan when the row raced to failed', async () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-apply-4');
    markRowStatus(h, dbId, 'failed');
    const ctx = await applyHandoffMechanism(
      ctxFor(h, userMessage('msg-apply-4'), {
        mechanism: 'ensure',
      })
    );
    expect(ctx.applied).toEqual({ dbId, changed: true, advanced: true });
    expect(sendStatus(h, 'msg-apply-4')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-apply-4')).toBe(1);
  });

  it('reconciles an ensure plan when the row raced to deferred', async () => {
    const h = makeHarness();
    const dbId = seedDeferredRow(h, 'msg-apply-5');
    const ctx = await applyHandoffMechanism(
      ctxFor(h, userMessage('msg-apply-5'), {
        mechanism: 'ensure',
      })
    );
    expect(ctx.applied).toEqual({ dbId, changed: true, advanced: true });
    expect(sendStatus(h, 'msg-apply-5')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-apply-5')).toBe(1);
  });
});

describe('settleHandoffOutcome', () => {
  it('reports stale when no mechanism applied', () => {
    const h = makeHarness();
    const ctx = settleHandoffOutcome(ctxFor(h, userMessage('msg-settle-1'), { applied: null }));
    expect(ctx.outcome).toEqual({ state: 'stale' });
  });

  it('settles on consumption evidence even when no mechanism applied', () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-settle-6');
    markRowStatus(h, dbId, 'failed');
    setConsumedSeq(h, 'msg-settle-6');
    const ctx = settleHandoffOutcome(ctxFor(h, userMessage('msg-settle-6'), { applied: null }));
    expect(ctx.outcome).toEqual({ state: 'settled', dbId });
  });

  it('settles on consumption evidence even after an advanced apply', () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-settle-2');
    markRowStatus(h, dbId, 'failed');
    setConsumedSeq(h, 'msg-settle-2');
    const ctx = settleHandoffOutcome(
      ctxFor(h, userMessage('msg-settle-2'), { applied: { dbId, changed: true, advanced: true } })
    );
    expect(ctx.outcome).toEqual({ state: 'settled', dbId });
  });

  it('identifies the evidenced sibling in the settled outcome', () => {
    const h = makeHarness();
    insertDuplicateRow(h, 'msg-settle-5', 'db-settle-plain', 'enqueued', null);
    insertDuplicateRow(h, 'msg-settle-5', 'db-settle-evidenced', 'failed', 8);
    const ctx = settleHandoffOutcome(
      ctxFor(h, userMessage('msg-settle-5'), {
        applied: { dbId: 'db-settle-plain', changed: false, advanced: false },
      })
    );
    expect(ctx.outcome).toEqual({ state: 'settled', dbId: 'db-settle-evidenced' });
  });

  it('maps an applied handoff onto the enqueued outcome', () => {
    const h = makeHarness();
    const ctx = settleHandoffOutcome(
      ctxFor(h, userMessage('msg-settle-3'), {
        applied: { dbId: 'db-settle-3', changed: true, advanced: true },
      })
    );
    expect(ctx.outcome).toEqual({
      state: 'enqueued',
      dbId: 'db-settle-3',
      changed: true,
      advanced: true,
    });
  });

  it('leaves an unadvanced row without evidence enqueued', () => {
    const h = makeHarness();
    const ctx = settleHandoffOutcome(
      ctxFor(h, userMessage('msg-settle-4'), {
        applied: { dbId: 'db-settle-4', changed: false, advanced: false },
      })
    );
    expect(ctx.outcome).toEqual({
      state: 'enqueued',
      dbId: 'db-settle-4',
      changed: false,
      advanced: false,
    });
  });
});

describe('markQueuedIfIdle', () => {
  it('marks the session queued when the outcome advanced into the mailbox', async () => {
    const h = makeHarness();
    const spy = portSpy();
    await markQueuedIfIdle(
      ctxFor(h, userMessage('msg-queued-1'), {
        stateManager: spy.stateManager,
        outcome: { state: 'enqueued', dbId: 'db-queued-1', changed: true, advanced: true },
      })
    );
    expect(spy.queued).toEqual(['msg-queued-1']);
  });

  it('skips settled outcomes and unadvanced handoffs', async () => {
    const h = makeHarness();
    const spy = portSpy();
    await markQueuedIfIdle(
      ctxFor(h, userMessage('msg-queued-2'), {
        stateManager: spy.stateManager,
        outcome: { state: 'settled', dbId: 'db-queued-2' },
      })
    );
    await markQueuedIfIdle(
      ctxFor(h, userMessage('msg-queued-3'), {
        stateManager: spy.stateManager,
        outcome: { state: 'enqueued', dbId: 'db-queued-3', changed: false, advanced: false },
      })
    );
    expect(spy.queued).toEqual([]);
  });
});

describe('publishEnqueuedIfChanged', () => {
  it('publishes the enqueued status only when the row changed', async () => {
    const h = makeHarness();
    const spy = portSpy();
    await publishEnqueuedIfChanged(
      ctxFor(h, userMessage('msg-pub-1'), {
        publishStatusChanged: spy.publishStatusChanged,
        outcome: { state: 'enqueued', dbId: 'db-pub-1', changed: true, advanced: true },
      })
    );
    await publishEnqueuedIfChanged(
      ctxFor(h, userMessage('msg-pub-2'), {
        publishStatusChanged: spy.publishStatusChanged,
        outcome: { state: 'enqueued', dbId: 'db-pub-2', changed: false, advanced: true },
      })
    );
    expect(spy.published).toEqual([{ sessionId: SESSION, dbId: 'db-pub-1', status: 'enqueued' }]);
  });

  it('swallows publisher failures', async () => {
    const h = makeHarness();
    await publishEnqueuedIfChanged(
      ctxFor(h, userMessage('msg-pub-3'), {
        publishStatusChanged: async () => {
          throw new Error('hub gone');
        },
        outcome: { state: 'enqueued', dbId: 'db-pub-3', changed: true, advanced: true },
      })
    );
  });
});

describe('handoffPromptToMailbox', () => {
  it('retries a failed row into the mailbox and publishes the transition', async () => {
    const h = makeHarness();
    const spy = portSpy();
    const dbId = seedEnqueuedRow(h, 'msg-e2e-1');
    markRowStatus(h, dbId, 'failed');
    const outcome = await handoffPromptToMailbox({
      ...argsFor(h, userMessage('msg-e2e-1')),
      ...spy,
    });
    expect(outcome).toEqual({ state: 'enqueued', dbId, changed: true, advanced: true });
    expect(sendStatus(h, 'msg-e2e-1')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-e2e-1')).toBe(1);
    expect(spy.queued).toEqual(['msg-e2e-1']);
    expect(spy.published).toEqual([{ sessionId: SESSION, dbId, status: 'enqueued' }]);
  });

  it('activates a deferred row into the mailbox', async () => {
    const h = makeHarness();
    const dbId = seedDeferredRow(h, 'msg-e2e-2');
    const outcome = await handoffPromptToMailbox(argsFor(h, userMessage('msg-e2e-2')));
    expect(outcome).toEqual({ state: 'enqueued', dbId, changed: true, advanced: true });
    expect(sendStatus(h, 'msg-e2e-2')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-e2e-2')).toBe(1);
  });

  it('ensures a missing row into the mailbox', async () => {
    const h = makeHarness();
    const outcome = await handoffPromptToMailbox(argsFor(h, userMessage('msg-e2e-3', 'fresh')));
    expect(outcome).toMatchObject({ state: 'enqueued', changed: true, advanced: true });
    expect(sendStatus(h, 'msg-e2e-3')).toBe('enqueued');
    expect(deliveryJobCount(h, 'msg-e2e-3')).toBe(1);
  });

  it('lets consumption evidence win over a failed snapshot', async () => {
    const h = makeHarness();
    const spy = portSpy();
    const dbId = seedEnqueuedRow(h, 'msg-e2e-4');
    markRowStatus(h, dbId, 'failed');
    setConsumedSeq(h, 'msg-e2e-4');
    h.db
      .prepare("UPDATE job_queue SET status = ? WHERE json_extract(payload, '$.messageUuid') = ?")
      .run('completed', 'msg-e2e-4');
    const outcome = await handoffPromptToMailbox({
      ...argsFor(h, userMessage('msg-e2e-4')),
      ...spy,
    });
    expect(outcome).toEqual({ state: 'settled', dbId });
    expect(sendStatus(h, 'msg-e2e-4')).toBe('failed');
    expect(deliveryJobCount(h, 'msg-e2e-4')).toBe(0);
    expect(spy.queued).toEqual([]);
    expect(spy.published).toEqual([]);
  });

  it('settles a consumed row without republishing', async () => {
    const h = makeHarness();
    const spy = portSpy();
    const dbId = seedEnqueuedRow(h, 'msg-e2e-5');
    markRowStatus(h, dbId, 'consumed');
    const outcome = await handoffPromptToMailbox({
      ...argsFor(h, userMessage('msg-e2e-5')),
      ...spy,
    });
    expect(outcome).toEqual({ state: 'settled', dbId });
    expect(spy.queued).toEqual([]);
    expect(spy.published).toEqual([]);
  });

  it('propagates a content conflict without touching the row', async () => {
    const h = makeHarness();
    const dbId = seedEnqueuedRow(h, 'msg-e2e-6', 'original');
    markRowStatus(h, dbId, 'failed');
    h.db
      .prepare("UPDATE job_queue SET status = ? WHERE json_extract(payload, '$.messageUuid') = ?")
      .run('completed', 'msg-e2e-6');
    await expect(
      handoffPromptToMailbox(argsFor(h, userMessage('msg-e2e-6', 'conflicting')))
    ).rejects.toBeInstanceOf(PromptContentConflictError);
    expect(sendStatus(h, 'msg-e2e-6')).toBe('failed');
    expect(deliveryJobCount(h, 'msg-e2e-6')).toBe(0);
  });
});
