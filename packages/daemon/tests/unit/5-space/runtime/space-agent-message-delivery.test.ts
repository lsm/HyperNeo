import { describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  PromptContentConflictError,
  persistPrompt,
} from '../../../../src/lib/agent/message-delivery-outbox';
import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { deliverSpaceAgentMessage } from '../../../../src/lib/space/runtime/space-agent-message-delivery';
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
});
