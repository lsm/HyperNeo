import { describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { signalDeliveryConsumed } from '../../../../src/lib/agent/message-delivery';
import type { InjectionDeliveryRowDeps } from '../../../../src/lib/space/runtime/injection-delivery-steps';
import {
  deliverInjectedMessage,
  failDeliveryRowInBackground,
  flipDeliveryRowToDeferred,
  reopenFailedDeliveryRow,
  settleDeliveryRowStatus,
} from '../../../../src/lib/space/runtime/injection-delivery-steps';

const SESSION_ID = 'session-inject-steps';
const MESSAGE_ID = '11111111-2222-3333-4444-555555555555';

function makeRowDeps(
  opts: {
    savedDbId?: string;
    reopenDbId?: string | null;
    deferredDbId?: string | null;
    failedDbId?: string | null;
  } = {}
) {
  const publishStatusChanged = mock(async () => {});
  const saveUserMessage = mock(() => opts.savedDbId ?? 'db-id');
  const getDeliverySendStatus = mock((): string | null => null);
  const reopenDeliveryByUuid = mock(() => opts.reopenDbId ?? null);
  const markDeliveryDeferredByUuid = mock(() => opts.deferredDbId ?? null);
  const markDeliveryFailedByUuid = mock(() => opts.failedDbId ?? null);
  const deps: InjectionDeliveryRowDeps = {
    publishStatusChanged,
    saveUserMessage,
    getDeliverySendStatus,
    reopenDeliveryByUuid,
    markDeliveryDeferredByUuid,
    markDeliveryFailedByUuid,
  };
  return {
    deps,
    publishStatusChanged,
    saveUserMessage,
    getDeliverySendStatus,
    reopenDeliveryByUuid,
    markDeliveryDeferredByUuid,
    markDeliveryFailedByUuid,
  };
}

function makeSdkUserMessage(): SDKUserMessage {
  return {
    type: 'user',
    uuid: MESSAGE_ID,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'shell step' }] },
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

describe('failDeliveryRowInBackground', () => {
  it('marks failed and fire-and-forget publishes failed when the mark lands', async () => {
    const rows = makeRowDeps({ failedDbId: 'failed-db' });

    failDeliveryRowInBackground(rows.deps, SESSION_ID, MESSAGE_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rows.markDeliveryFailedByUuid).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID);
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, 'failed-db', 'failed');
  });

  it('publishes nothing when the mark misses', () => {
    const rows = makeRowDeps({ failedDbId: null });

    failDeliveryRowInBackground(rows.deps, SESSION_ID, MESSAGE_ID);

    expect(rows.publishStatusChanged).not.toHaveBeenCalled();
  });

  it('propagates a synchronous mark failure to the caller instead of a detached rejection', () => {
    const rows = makeRowDeps();
    rows.markDeliveryFailedByUuid.mockImplementation(() => {
      throw new Error('db locked');
    });

    expect(() => failDeliveryRowInBackground(rows.deps, SESSION_ID, MESSAGE_ID)).toThrow(
      'db locked'
    );
  });

  it('swallows a rejecting status publish so the fire-and-forget path never rejects', async () => {
    const rows = makeRowDeps({ failedDbId: 'failed-db' });
    rows.publishStatusChanged.mockRejectedValue(new Error('bus down'));

    failDeliveryRowInBackground(rows.deps, SESSION_ID, MESSAGE_ID);
    await new Promise((resolve) => setTimeout(resolve, 0));
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

describe('deliverInjectedMessage', () => {
  function makeJobQueue(throwOnEnqueue = false, signalOnEnqueue = true) {
    const jobQueueEnqueue = mock(
      (args: { payload?: { sessionId?: string; messageUuid?: string; origin?: string } }) => {
        if (throwOnEnqueue) throw new Error('job queue unavailable');
        const uuid = args?.payload?.messageUuid;
        if (uuid && signalOnEnqueue) signalDeliveryConsumed(args!.payload!.sessionId!, uuid);
        return { id: 'job-1' };
      }
    );
    return {
      jobQueue: {
        enqueue: jobQueueEnqueue,
        getActiveDeliveryRole: mock(() => null),
      },
      jobQueueEnqueue,
    };
  }

  function makeTargetSession(provider = 'anthropic') {
    const ensureQueryStarted = mock(async () => {});
    const enqueueWithId = mock(async () => {});
    const setQueuedIfIdle = mock(async () => true);
    const session = {
      stateManager: { setQueuedIfIdle, getState: () => ({ status: 'idle' }) },
      getSessionData: () => ({ config: { provider } }),
      ensureQueryStarted,
      messageQueue: { enqueueWithId },
    };
    return { session, ensureQueryStarted, enqueueWithId, setQueuedIfIdle };
  }

  it('v2 fresh row persists enqueued, enqueues a space_inject job, and returns the db id', async () => {
    const rows = makeRowDeps({ savedDbId: 'saved-db' });
    const { jobQueue, jobQueueEnqueue } = makeJobQueue();
    const target = makeTargetSession();

    const dbId = await deliverInjectedMessage(
      { ...rows.deps, jobQueue: jobQueue as never },
      {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        enqueuePayload: 'shell step',
        deliveryV2Enabled: true,
        rowExists: false,
      }
    );

    expect(dbId).toBe('saved-db');
    expect(rows.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(rows.saveUserMessage.mock.calls[0][2]).toBe('enqueued');
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, 'saved-db', 'enqueued');
    expect(jobQueueEnqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = jobQueueEnqueue.mock.calls[0][0] as {
      payload: { sessionId: string; messageUuid: string; origin: string };
    };
    expect(enqueueArgs.payload).toMatchObject({
      sessionId: SESSION_ID,
      messageUuid: MESSAGE_ID,
      origin: 'space_inject',
    });
    expect(target.setQueuedIfIdle).toHaveBeenCalledWith(MESSAGE_ID);
    expect(target.enqueueWithId).not.toHaveBeenCalled();
  });

  it('v2 existing row reuses the message id and still drives the job queue', async () => {
    const rows = makeRowDeps();
    const { jobQueue, jobQueueEnqueue } = makeJobQueue();
    const target = makeTargetSession();

    const dbId = await deliverInjectedMessage(
      { ...rows.deps, jobQueue: jobQueue as never },
      {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        enqueuePayload: 'shell step',
        deliveryV2Enabled: true,
        rowExists: true,
      }
    );

    expect(dbId).toBe(MESSAGE_ID);
    expect(rows.saveUserMessage).not.toHaveBeenCalled();
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID, 'enqueued');
    expect(jobQueueEnqueue).toHaveBeenCalledTimes(1);
  });

  it('v2 enqueue failure marks the row failed and publishes failed', async () => {
    const rows = makeRowDeps({ failedDbId: 'failed-db' });
    const { jobQueue } = makeJobQueue(true);
    const target = makeTargetSession();

    await expect(
      deliverInjectedMessage(
        { ...rows.deps, jobQueue: jobQueue as never },
        {
          session: target.session,
          sessionId: SESSION_ID,
          messageId: MESSAGE_ID,
          sdkUserMessage: makeSdkUserMessage(),
          enqueuePayload: 'shell step',
          deliveryV2Enabled: true,
          rowExists: false,
        }
      )
    ).rejects.toThrow('job queue unavailable');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rows.markDeliveryFailedByUuid).toHaveBeenCalledWith(SESSION_ID, MESSAGE_ID);
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, 'failed-db', 'failed');
  });

  it('v1 starts the query, persists enqueued, and enqueues the payload on the session queue', async () => {
    const rows = makeRowDeps({ savedDbId: 'saved-db' });
    const { jobQueue, jobQueueEnqueue } = makeJobQueue();
    const target = makeTargetSession();
    const order: string[] = [];
    target.ensureQueryStarted.mockImplementation(async () => {
      order.push('ensureQueryStarted');
    });
    rows.saveUserMessage.mockImplementation(() => {
      order.push('saveUserMessage');
      return 'saved-db';
    });
    target.enqueueWithId.mockImplementation(async () => {
      order.push('enqueueWithId');
    });

    const dbId = await deliverInjectedMessage(
      { ...rows.deps, jobQueue: jobQueue as never },
      {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        enqueuePayload: [{ type: 'text', text: 'shell step' }],
        deliveryV2Enabled: false,
        rowExists: false,
      }
    );

    expect(dbId).toBe('saved-db');
    expect(order).toEqual(['ensureQueryStarted', 'saveUserMessage', 'enqueueWithId']);
    expect(rows.saveUserMessage.mock.calls[0][2]).toBe('enqueued');
    expect(rows.publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, 'saved-db', 'enqueued');
    expect(target.enqueueWithId).toHaveBeenCalledWith(MESSAGE_ID, [
      { type: 'text', text: 'shell step' },
    ]);
    expect(jobQueueEnqueue).not.toHaveBeenCalled();
  });

  describe('consumption completing before waiter registration', () => {
    const GAP_DEADLINE_MS = 5_000;

    function armGapConsumption(rows: ReturnType<typeof makeRowDeps>): void {
      let rowStatus: string | null = 'enqueued';
      rows.publishStatusChanged.mockImplementation(async () => {
        rowStatus = 'consumed';
        signalDeliveryConsumed(SESSION_ID, MESSAGE_ID);
      });
      rows.getDeliverySendStatus.mockImplementation(() => rowStatus);
    }

    function withDeadline<T>(promise: Promise<T>): Promise<T> {
      return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('inject did not resolve')), GAP_DEADLINE_MS)
        ),
      ]);
    }

    it('default hold path resolves from persisted status instead of timing out', async () => {
      const rows = makeRowDeps({ savedDbId: 'saved-db' });
      armGapConsumption(rows);
      const { jobQueue, jobQueueEnqueue } = makeJobQueue(false, false);
      const target = makeTargetSession();

      const dbId = await withDeadline(
        deliverInjectedMessage(
          { ...rows.deps, jobQueue: jobQueue as never },
          {
            session: target.session,
            sessionId: SESSION_ID,
            messageId: MESSAGE_ID,
            sdkUserMessage: makeSdkUserMessage(),
            enqueuePayload: 'shell step',
            deliveryV2Enabled: true,
            rowExists: false,
          }
        )
      );

      expect(dbId).toBe('saved-db');
      expect(rows.getDeliverySendStatus).toHaveBeenCalled();
      expect(rows.markDeliveryFailedByUuid).not.toHaveBeenCalled();
      expect(jobQueueEnqueue).toHaveBeenCalledTimes(1);
    });

    it('acp hold path resolves from persisted status instead of holding for 12 minutes', async () => {
      const rows = makeRowDeps();
      armGapConsumption(rows);
      const { jobQueue, jobQueueEnqueue } = makeJobQueue(false, false);
      const target = makeTargetSession('acp');

      const dbId = await withDeadline(
        deliverInjectedMessage(
          { ...rows.deps, jobQueue: jobQueue as never },
          {
            session: target.session,
            sessionId: SESSION_ID,
            messageId: MESSAGE_ID,
            sdkUserMessage: makeSdkUserMessage(),
            enqueuePayload: 'shell step',
            deliveryV2Enabled: true,
            rowExists: true,
          }
        )
      );

      expect(dbId).toBe(MESSAGE_ID);
      expect(rows.getDeliverySendStatus).toHaveBeenCalled();
      expect(jobQueueEnqueue).toHaveBeenCalledTimes(1);
    });

    it('acp hold path still resolves from the waiter when consumption lands after registration', async () => {
      const rows = makeRowDeps();
      rows.getDeliverySendStatus.mockImplementation(() => 'enqueued');
      const { jobQueue, jobQueueEnqueue } = makeJobQueue();
      const target = makeTargetSession('acp');

      const dbId = await deliverInjectedMessage(
        { ...rows.deps, jobQueue: jobQueue as never },
        {
          session: target.session,
          sessionId: SESSION_ID,
          messageId: MESSAGE_ID,
          sdkUserMessage: makeSdkUserMessage(),
          enqueuePayload: 'shell step',
          deliveryV2Enabled: true,
          rowExists: true,
        }
      );

      expect(dbId).toBe(MESSAGE_ID);
      expect(jobQueueEnqueue).toHaveBeenCalledTimes(1);
    });
  });
});
