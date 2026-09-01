import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { signalDeliveryConsumed } from '../../../../src/lib/agent/message-delivery';
import {
  persistPrompt,
  PromptContentConflictError,
} from '../../../../src/lib/agent/message-delivery-outbox';
import {
  deliverSpaceAgentMessage,
  SpaceAgentLateSettlements,
} from '../../../../src/lib/space/runtime/space-agent-message-delivery';

const SESSION_ID = 'sess-space-agent-delivery';
const MESSAGE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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

type Harness = ReturnType<typeof setup> & {
  deliverJobQueue: JobQueueRepository;
  deliverSdkRepo: SDKMessageRepository;
  publishStatusChanged: ReturnType<typeof mock>;
  setQueuedIfIdle: ReturnType<typeof mock>;
  lateSettlements: SpaceAgentLateSettlements;
};

const harnesses: Harness[] = [];

function makeHarness(
  overrides: {
    deliverJobQueue?: (queue: JobQueueRepository) => unknown;
    deliverSdkRepo?: (repo: SDKMessageRepository) => unknown;
  } = {}
): Harness {
  const base = setup();
  const publishStatusChanged = mock(async () => {});
  const setQueuedIfIdle = mock(async () => true);
  const lateSettlements = new SpaceAgentLateSettlements();
  const harness: Harness = {
    ...base,
    deliverJobQueue:
      (overrides.deliverJobQueue?.(base.jobQueue) as JobQueueRepository | undefined) ??
      base.jobQueue,
    deliverSdkRepo:
      (overrides.deliverSdkRepo?.(base.sdkRepo) as SDKMessageRepository | undefined) ??
      base.sdkRepo,
    publishStatusChanged,
    setQueuedIfIdle,
    lateSettlements,
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.lateSettlements.dispose();
    harness.db.close();
  }
});

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    uuid: MESSAGE_ID,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function deliveryDeps(
  h: Harness,
  depsOverride: {
    onConsumed?: (settledSessionId: string) => void;
    onLateFailure?: () => void;
    armLateSettlement?: boolean;
  } = {}
) {
  return {
    db: h.db,
    sdkMessageRepo: h.deliverSdkRepo,
    jobQueue: h.deliverJobQueue,
    publishStatusChanged: h.publishStatusChanged,
    stateManager: { setQueuedIfIdle: h.setQueuedIfIdle },
    ...(depsOverride.onConsumed ? { onConsumed: depsOverride.onConsumed } : {}),
    ...(depsOverride.onLateFailure ? { onLateFailure: depsOverride.onLateFailure } : {}),
    ...(depsOverride.armLateSettlement ? { lateSettlement: h.lateSettlements } : {}),
  };
}

function deliveryInput(text: string) {
  return { sessionId: SESSION_ID, messageId: MESSAGE_ID, sdkUserMessage: userMessage(text) };
}

function seedRow(h: Harness, text: string, hold?: 'manual'): string {
  const { dbMessageId } = persistPrompt({
    db: h.db,
    sdkMessageRepo: h.sdkRepo,
    jobQueue: h.jobQueue,
    sessionId: SESSION_ID,
    message: userMessage(text),
    ...(hold ? { hold } : {}),
    delivery: { origin: 'space_agent' },
  });
  return dbMessageId;
}

function sendStatus(h: Harness): string | null | undefined {
  return h.sdkRepo.getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus;
}

function deliveryJobCount(h: Harness): number {
  const row = h.db
    .prepare(
      `SELECT COUNT(*) AS n FROM job_queue
        WHERE queue = ?
          AND json_extract(payload, '$.sessionId') = ?
          AND json_extract(payload, '$.messageUuid') = ?
          AND status IN ('pending', 'processing')`
    )
    .get(MESSAGE_DELIVERY, SESSION_ID, MESSAGE_ID) as { n: number };
  return row.n;
}

function completeJobs(h: Harness): void {
  h.db
    .prepare(
      "UPDATE job_queue SET status = 'completed' WHERE json_extract(payload, '$.messageUuid') = ?"
    )
    .run(MESSAGE_ID);
}

describe('deliverSpaceAgentMessage', () => {
  it('short-circuits a consumed row to accepted without touching the mailbox', async () => {
    const h = makeHarness();
    const dbId = seedRow(h, 'already consumed');
    completeJobs(h);
    h.sdkRepo.updateMessageStatus([dbId], 'consumed');
    const onConsumed = mock(() => {});

    const outcome = await deliverSpaceAgentMessage(
      deliveryDeps(h, { onConsumed, armLateSettlement: true }),
      deliveryInput('already consumed')
    );

    expect(outcome).toEqual({ state: 'accepted', messageId: MESSAGE_ID, sessionId: SESSION_ID });
    expect(onConsumed).toHaveBeenCalledWith(SESSION_ID);
    expect(deliveryJobCount(h)).toBe(0);
    expect(h.setQueuedIfIdle).not.toHaveBeenCalled();
    expect(h.publishStatusChanged).not.toHaveBeenCalled();
  });

  it('ensures a fresh row with the deterministic uuid and a space_agent job', async () => {
    const h = makeHarness();

    const outcome = await deliverSpaceAgentMessage(
      deliveryDeps(h),
      deliveryInput('fresh escalation')
    );

    expect(outcome).toEqual({ state: 'accepted', messageId: MESSAGE_ID, sessionId: SESSION_ID });
    expect(sendStatus(h)).toBe('enqueued');
    expect(deliveryJobCount(h)).toBe(1);
    const row = h.db
      .prepare(`SELECT sdk_uuid AS uuid, session_id AS sid FROM sdk_messages WHERE sdk_uuid = ?`)
      .get(MESSAGE_ID) as { uuid: string; sid: string };
    expect(row.uuid).toBe(MESSAGE_ID);
    expect(row.sid).toBe(SESSION_ID);
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
      origin: 'space_agent',
    });
    expect(h.setQueuedIfIdle).toHaveBeenCalledWith(MESSAGE_ID);
    expect(h.publishStatusChanged).toHaveBeenCalledTimes(1);
    expect(h.publishStatusChanged.mock.calls[0][2]).toBe('enqueued');
  });

  it('retries a failed row into the mailbox', async () => {
    const h = makeHarness();
    const dbId = seedRow(h, 'failed escalation');
    h.sdkRepo.updateMessageStatus([dbId], 'failed');
    completeJobs(h);

    const outcome = await deliverSpaceAgentMessage(
      deliveryDeps(h),
      deliveryInput('failed escalation')
    );

    expect(outcome.state).toBe('accepted');
    expect(sendStatus(h)).toBe('enqueued');
    expect(deliveryJobCount(h)).toBe(1);
  });

  it('activates a deferred row into the mailbox', async () => {
    const h = makeHarness();
    const dbId = seedRow(h, 'held escalation', 'manual');
    expect(sendStatus(h)).toBe('deferred');

    const outcome = await deliverSpaceAgentMessage(
      deliveryDeps(h),
      deliveryInput('held escalation')
    );

    expect(outcome.state).toBe('accepted');
    expect(sendStatus(h)).toBe('enqueued');
    expect(deliveryJobCount(h)).toBe(1);
    expect(h.db.prepare(`SELECT id FROM sdk_messages WHERE id = ?`).get(dbId)).toBeTruthy();
  });

  it('reports failed when the handoff goes stale', async () => {
    const h = makeHarness({
      deliverSdkRepo: (repo) =>
        new Proxy(repo, {
          get(target, prop, receiver) {
            if (prop === 'getDeliveryContent') {
              return () => ({ content: 'x', sendStatus: 'failed' });
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
    });
    const dbId = seedRow(h, 'raced row');
    h.sdkRepo.updateMessageStatus([dbId], 'submitted');
    completeJobs(h);

    const outcome = await deliverSpaceAgentMessage(deliveryDeps(h), deliveryInput('raced row'));

    expect(outcome).toEqual({
      state: 'failed',
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      error: 'prompt handoff went stale before reaching the mailbox',
    });
    expect(sendStatus(h)).toBe('submitted');
  });

  it('arms late settlement for an enqueued handoff and settles on consumption', async () => {
    const h = makeHarness();
    const onConsumed = mock(() => {});

    const outcome = await deliverSpaceAgentMessage(
      deliveryDeps(h, { onConsumed, armLateSettlement: true }),
      deliveryInput('queued escalation')
    );

    expect(outcome.state).toBe('accepted');
    expect(onConsumed).not.toHaveBeenCalled();

    signalDeliveryConsumed(SESSION_ID, MESSAGE_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onConsumed).toHaveBeenCalledWith(SESSION_ID);
  });

  it('does not dead-letter a consumed row whose content conflicts', async () => {
    const h = makeHarness();
    const dbId = seedRow(h, 'original');
    completeJobs(h);
    h.sdkRepo.updateMessageStatus([dbId], 'consumed');

    await expect(
      deliverSpaceAgentMessage(deliveryDeps(h), deliveryInput('conflicting'))
    ).rejects.toBeInstanceOf(PromptContentConflictError);

    expect(sendStatus(h)).toBe('consumed');
    expect(deliveryJobCount(h)).toBe(0);
    expect(h.publishStatusChanged).not.toHaveBeenCalled();
  });

  it('does not dead-letter an enqueued row whose content conflicts', async () => {
    const h = makeHarness();
    seedRow(h, 'original');
    completeJobs(h);

    await expect(
      deliverSpaceAgentMessage(deliveryDeps(h), deliveryInput('conflicting'))
    ).rejects.toBeInstanceOf(PromptContentConflictError);

    expect(sendStatus(h)).toBe('enqueued');
    expect(deliveryJobCount(h)).toBe(0);
    expect(h.publishStatusChanged).not.toHaveBeenCalled();
  });

  it('dead-letters the row when a non-conflict error escapes the handoff', async () => {
    const h = makeHarness({
      deliverJobQueue: (queue) =>
        new Proxy(queue, {
          get(target, prop, receiver) {
            if (prop === 'enqueue') {
              return () => {
                throw new Error('job queue unavailable');
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }),
    });
    seedRow(h, 'doomed escalation');
    completeJobs(h);

    await expect(
      deliverSpaceAgentMessage(deliveryDeps(h), deliveryInput('doomed escalation'))
    ).rejects.toThrow('job queue unavailable');

    expect(sendStatus(h)).toBe('failed');
    expect(h.publishStatusChanged.mock.calls.at(-1)?.[2]).toBe('failed');
  });
});
