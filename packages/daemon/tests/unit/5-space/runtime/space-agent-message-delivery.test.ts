import { describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  persistPrompt,
  PromptContentConflictError,
} from '../../../../src/lib/agent/message-delivery-outbox';
import { deliverSpaceAgentMessage } from '../../../../src/lib/space/runtime/space-agent-message-delivery';
import { createOutboxTestDb } from '../../../helpers/outbox-test-db';

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
  it('accepts the deterministic uuid into the durable mailbox', async () => {
    const h = makeHarness();

    const outcome = await deliverSpaceAgentMessage(h.deps, h.input('fresh escalation'));

    expect(outcome).toEqual({ state: 'accepted', messageId: MESSAGE_ID, sessionId: SESSION_ID });
    expect(h.userRowIdByUuid(SESSION_ID, MESSAGE_ID)).not.toBeNull();
    expect(h.pendingDeliveryJobCount(SESSION_ID, MESSAGE_ID)).toBe(1);
    expect(h.setQueuedIfIdle).toHaveBeenCalledWith(MESSAGE_ID);
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
});
