import { describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { signalDeliveryConsumed } from '../../../../src/lib/agent/message-delivery';
import {
  PromptContentConflictError,
  persistPrompt,
} from '../../../../src/lib/agent/message-delivery-outbox';
import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import {
  deliverSpaceAgentMessage,
  SpaceAgentLateSettlements,
} from '../../../../src/lib/space/runtime/space-agent-message-delivery';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import { createOutboxTestDb, type OutboxTestDb } from '../../../helpers/outbox-test-db';

const SESSION_ID = 'sess-space-agent-delivery';
const MESSAGE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    uuid: MESSAGE_ID,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function pendingMailboxJobCount(harness: OutboxTestDb, uuid: string): number {
  return (
    harness.db
      .prepare(
        `SELECT COUNT(*) AS n FROM job_queue
          WHERE queue = ?
            AND json_extract(payload, '$.messageUuid') = ?
            AND json_extract(payload, '$.to.sessionId') = ?
            AND status IN ('pending', 'processing')`
      )
      .get(MAILBOX_LANE, uuid, SESSION_ID) as { n: number }
  ).n;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeHarness() {
  const outbox = createOutboxTestDb();
  const publishStatusChanged = mock(async () => {});
  const setQueuedIfIdle = mock(async () => true);
  const deps = {
    db: outbox.db,
    sdkMessageRepo: outbox.sdkRepo,
    jobQueue: outbox.jobQueue,
    publishStatusChanged,
    stateManager: { setQueuedIfIdle },
  };
  const input = (text: string) => ({
    sessionId: SESSION_ID,
    messageId: MESSAGE_ID,
    sdkUserMessage: userMessage(text),
  });
  return { ...outbox, deps, input, publishStatusChanged, setQueuedIfIdle };
}

describe('deliverSpaceAgentMessage', () => {
  it('accepts the deterministic uuid into the mailbox lane without materializing a row', async () => {
    const h = makeHarness();

    const outcome = await deliverSpaceAgentMessage(h.deps, h.input('fresh escalation'));

    expect(outcome).toEqual({ state: 'accepted', messageId: MESSAGE_ID, sessionId: SESSION_ID });
    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(1);
    expect(h.userRowIdByUuid(SESSION_ID, MESSAGE_ID)).toBeNull();
    expect(h.setQueuedIfIdle).toHaveBeenCalledWith(MESSAGE_ID);
    expect(h.publishStatusChanged).not.toHaveBeenCalled();
    h.db.close();
  });

  it('materializes the delivery row through the mailbox lane and publishes its row id', async () => {
    const h = makeHarness();
    const publishes: Array<[string, string, string]> = [];
    const processor = new JobQueueProcessor(h.jobQueue, {
      pollIntervalMs: 5,
      maxConcurrent: 2,
      staleThresholdMs: 5 * 60 * 1000,
    });
    processor.register(
      MAILBOX_LANE,
      createMailboxDeliveryHandler({
        jobQueue: h.jobQueue,
        db: h.db,
        sdkMessageRepo: h.sdkRepo,
        getSession: async () => ({}),
        isSessionArchived: () => false,
        publishStatusChanged: (sessionId, dbId, status) => {
          publishes.push([sessionId, dbId, status]);
        },
      })
    );
    processor.start();

    const outcome = await deliverSpaceAgentMessage(h.deps, h.input('escalated judgment call'));
    await waitFor(() => h.sendStatus(SESSION_ID, MESSAGE_ID) === 'enqueued');
    await processor.stop();

    expect(outcome).toEqual({ state: 'accepted', messageId: MESSAGE_ID, sessionId: SESSION_ID });
    const dbId = h.userRowIdByUuid(SESSION_ID, MESSAGE_ID);
    expect(dbId).not.toBeNull();
    expect(h.sendStatus(SESSION_ID, MESSAGE_ID)).toBe('enqueued');
    expect(publishes).toEqual([[SESSION_ID, dbId as string, 'enqueued']]);
    expect(h.pendingDeliveryJobCount(SESSION_ID, MESSAGE_ID)).toBe(1);
    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(0);
    h.db.close();
  });

  it('short-circuits matching consumed content without touching the mailbox', async () => {
    const h = makeHarness();
    const persisted = persistPrompt({
      db: h.db,
      sdkMessageRepo: h.sdkRepo,
      jobQueue: h.jobQueue,
      sessionId: SESSION_ID,
      message: userMessage('already consumed'),
      delivery: { origin: 'space_agent' },
    });
    h.completeDeliveryJobs(SESSION_ID, MESSAGE_ID);
    h.sdkRepo.updateMessageStatus([persisted.dbMessageId], 'consumed');
    const onConsumed = mock(() => {});

    const outcome = await deliverSpaceAgentMessage(
      { ...h.deps, onConsumed },
      h.input('already consumed')
    );

    expect(outcome.state).toBe('accepted');
    expect(onConsumed).toHaveBeenCalledWith(SESSION_ID);
    expect(h.pendingDeliveryJobCount(SESSION_ID, MESSAGE_ID)).toBe(0);
    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(0);
    expect(h.setQueuedIfIdle).not.toHaveBeenCalled();
    h.db.close();
  });

  it('does not dead-letter a conflicting consumed row', async () => {
    const h = makeHarness();
    const persisted = persistPrompt({
      db: h.db,
      sdkMessageRepo: h.sdkRepo,
      jobQueue: h.jobQueue,
      sessionId: SESSION_ID,
      message: userMessage('original'),
      delivery: { origin: 'space_agent' },
    });
    h.completeDeliveryJobs(SESSION_ID, MESSAGE_ID);
    h.sdkRepo.updateMessageStatus([persisted.dbMessageId], 'consumed');

    await expect(deliverSpaceAgentMessage(h.deps, h.input('conflict'))).rejects.toBeInstanceOf(
      PromptContentConflictError
    );

    expect(h.sendStatus(SESSION_ID, MESSAGE_ID)).toBe('consumed');
    expect(h.publishStatusChanged).not.toHaveBeenCalled();
    h.db.close();
  });

  it('rejects conflicting content against an unconsumed row before the mailbox handoff', async () => {
    const h = makeHarness();
    persistPrompt({
      db: h.db,
      sdkMessageRepo: h.sdkRepo,
      jobQueue: h.jobQueue,
      sessionId: SESSION_ID,
      message: userMessage('original'),
      delivery: { origin: 'space_agent' },
    });

    await expect(deliverSpaceAgentMessage(h.deps, h.input('conflict'))).rejects.toBeInstanceOf(
      PromptContentConflictError
    );

    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(0);
    expect(h.publishStatusChanged).not.toHaveBeenCalled();
    h.db.close();
  });

  it('reports a rejected mailbox projection as a failed outcome without waking the session', async () => {
    const h = makeHarness();
    const emptyText = {
      ...userMessage('discarded'),
      message: { role: 'user' as const, content: [{ type: 'text' as const, text: '' }] },
    };

    const outcome = await deliverSpaceAgentMessage(h.deps, {
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      sdkUserMessage: emptyText,
    });

    expect(outcome.state).toBe('failed');
    if (outcome.state === 'failed') {
      expect(outcome.error).toContain('content');
    }
    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(0);
    expect(h.setQueuedIfIdle).not.toHaveBeenCalled();
    expect(h.publishStatusChanged).not.toHaveBeenCalled();
    h.db.close();
  });

  it('rejects a conflicting pending admission before the mailbox processor runs', async () => {
    const h = makeHarness();

    const first = await deliverSpaceAgentMessage(h.deps, h.input('first payload'));
    expect(first.state).toBe('accepted');

    await expect(
      deliverSpaceAgentMessage(h.deps, h.input('second payload'))
    ).rejects.toBeInstanceOf(PromptContentConflictError);
    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(1);
    h.db.close();
  });

  it('accepts an idempotent same-content retry while the first admission is pending', async () => {
    const h = makeHarness();

    await deliverSpaceAgentMessage(h.deps, h.input('same payload'));
    const retry = await deliverSpaceAgentMessage(h.deps, h.input('same payload'));

    expect(retry).toEqual({ state: 'accepted', messageId: MESSAGE_ID, sessionId: SESSION_ID });
    h.db.close();
  });

  it('rejects a pending retry whose priority differs', async () => {
    const h = makeHarness();
    const withPriority = (priority: 'now' | 'next') => ({
      sessionId: SESSION_ID,
      messageId: MESSAGE_ID,
      sdkUserMessage: { ...userMessage('same payload'), priority },
    });

    await deliverSpaceAgentMessage(h.deps, withPriority('now'));

    await expect(deliverSpaceAgentMessage(h.deps, withPriority('next'))).rejects.toBeInstanceOf(
      PromptContentConflictError
    );
    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(1);
    h.db.close();
  });

  it('serializes concurrent same-uuid admissions so only one prompt is accepted', async () => {
    const h = makeHarness();

    const results = await Promise.allSettled([
      deliverSpaceAgentMessage(h.deps, h.input('concurrent one')),
      deliverSpaceAgentMessage(h.deps, h.input('concurrent two')),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      PromptContentConflictError
    );
    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(1);
    h.db.close();
  });

  it('short-circuits consumption evidence on a failed row without waking the session', async () => {
    const h = makeHarness();
    const persisted = persistPrompt({
      db: h.db,
      sdkMessageRepo: h.sdkRepo,
      jobQueue: h.jobQueue,
      sessionId: SESSION_ID,
      message: userMessage('evidence backed'),
      delivery: { origin: 'space_agent' },
    });
    h.completeDeliveryJobs(SESSION_ID, MESSAGE_ID);
    h.sdkRepo.updateMessageStatus([persisted.dbMessageId], 'failed');
    h.db
      .prepare('UPDATE sdk_messages SET consumed_seq = 1 WHERE session_id = ? AND sdk_uuid = ?')
      .run(SESSION_ID, MESSAGE_ID);
    const onConsumed = mock(() => {});

    const outcome = await deliverSpaceAgentMessage(
      { ...h.deps, onConsumed },
      h.input('evidence backed')
    );

    expect(outcome.state).toBe('accepted');
    expect(onConsumed).toHaveBeenCalledWith(SESSION_ID);
    expect(pendingMailboxJobCount(h, MESSAGE_ID)).toBe(0);
    expect(h.setQueuedIfIdle).not.toHaveBeenCalled();
    h.db.close();
  });

  it('does not fire late failure while a failed row awaits mailbox retry admission', async () => {
    const h = makeHarness();
    const persisted = persistPrompt({
      db: h.db,
      sdkMessageRepo: h.sdkRepo,
      jobQueue: h.jobQueue,
      sessionId: SESSION_ID,
      message: userMessage('retry me'),
      delivery: { origin: 'space_agent' },
    });
    h.completeDeliveryJobs(SESSION_ID, MESSAGE_ID);
    h.sdkRepo.updateMessageStatus([persisted.dbMessageId], 'failed');
    const lateSettlements = new SpaceAgentLateSettlements();
    let consumed = false;
    const onLateFailure = mock(() => {});

    const outcome = await deliverSpaceAgentMessage(
      {
        ...h.deps,
        onConsumed: () => {
          consumed = true;
        },
        onLateFailure,
        lateSettlement: lateSettlements,
      },
      h.input('retry me')
    );

    expect(outcome.state).toBe('accepted');
    expect(onLateFailure).not.toHaveBeenCalled();

    signalDeliveryConsumed(SESSION_ID, MESSAGE_ID);
    await waitFor(() => consumed);
    expect(onLateFailure).not.toHaveBeenCalled();
    lateSettlements.dispose();
    h.db.close();
  });
});
