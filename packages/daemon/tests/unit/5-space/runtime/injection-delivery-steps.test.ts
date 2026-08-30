import { describe, expect, it, mock } from 'bun:test';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../../../src/storage/database';
import { createTestDb, createTestSession } from '../../../helpers/database';
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
  async function makeDb(): Promise<Database> {
    const db = await createTestDb();
    db.createSession(createTestSession(SESSION_ID));
    return db;
  }

  function makeTargetSession(provider = 'anthropic') {
    const setQueuedIfIdle = mock(async () => true);
    const session = {
      stateManager: { setQueuedIfIdle, getState: () => ({ status: 'idle' }) },
      getSessionData: () => ({ config: { provider } }),
    };
    return { session, setQueuedIfIdle };
  }

  function makeBranchDeps(db: Database) {
    const publishStatusChanged = mock(async () => {});
    return {
      deps: {
        db: db.getDatabase(),
        sdkMessageRepo: db.getSDKMessageRepo(),
        jobQueue: db.getJobQueueRepo(),
        publishStatusChanged,
        saveUserMessage: mock(() => 'unused'),
        reopenDeliveryByUuid: mock(() => null),
        markDeliveryDeferredByUuid: mock(() => null),
        markDeliveryFailedByUuid: mock(() => null),
      },
      publishStatusChanged,
    };
  }

  it('persists an enqueued row, enqueues a space_inject job, and returns the db id', async () => {
    const db = await makeDb();
    try {
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
      });

      expect(dbId).toBeTypeOf('string');
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'enqueued'
      );
      expect(publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, dbId, 'enqueued');
      expect(target.setQueuedIfIdle).toHaveBeenCalledWith(MESSAGE_ID);
      const job = db
        .getDatabase()
        .prepare(
          `SELECT id FROM job_queue WHERE queue = 'message_delivery'
             AND json_extract(payload, '$.messageUuid') = ?`
        )
        .get(MESSAGE_ID);
      expect(job).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('persists the SDK message origin on the fresh row', async () => {
    const db = await makeDb();
    try {
      const { deps } = makeBranchDeps(db);
      const target = makeTargetSession();

      await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        origin: 'system',
      });

      const row = db
        .getDatabase()
        .prepare(`SELECT origin FROM sdk_messages WHERE sdk_uuid = ?`)
        .get(MESSAGE_ID) as { origin: string | null };
      expect(row.origin).toBe('system');
    } finally {
      db.close();
    }
  });

  it('treats a stale failed snapshot as an accepted handoff when the row is already active', async () => {
    const db = await makeDb();
    try {
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();
      await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
      });
      publishStatusChanged.mockClear();

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        existing: { sendStatus: 'failed' },
      });

      expect(dbId).toBeTypeOf('string');
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'enqueued'
      );
      expect(publishStatusChanged).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('advances a stale failed snapshot when the row was concurrently deferred', async () => {
    const db = await makeDb();
    try {
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();
      db.saveUserMessage(SESSION_ID, makeSdkUserMessage(), 'enqueued');
      db.getSDKMessageRepo().markDeliveryDeferredByUuid(SESSION_ID, MESSAGE_ID);
      publishStatusChanged.mockClear();

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        existing: { sendStatus: 'failed' },
      });

      expect(dbId).toBeTypeOf('string');
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'enqueued'
      );
      expect(publishStatusChanged).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('retries a stale deferred snapshot when the row was concurrently failed', async () => {
    const db = await makeDb();
    try {
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();
      db.saveUserMessage(SESSION_ID, makeSdkUserMessage(), 'enqueued');
      db.getSDKMessageRepo().markDeliveryFailedByUuid(SESSION_ID, MESSAGE_ID);
      publishStatusChanged.mockClear();

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        existing: { sendStatus: 'deferred' },
      });

      expect(dbId).toBeTypeOf('string');
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'enqueued'
      );
      expect(publishStatusChanged).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('retries a row that became failed before the ensure path ran', async () => {
    const db = await makeDb();
    try {
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();
      db.saveUserMessage(SESSION_ID, makeSdkUserMessage(), 'enqueued');
      db.getSDKMessageRepo().markDeliveryFailedByUuid(SESSION_ID, MESSAGE_ID);
      publishStatusChanged.mockClear();

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        existing: null,
      });

      expect(dbId).toBeTypeOf('string');
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'enqueued'
      );
      expect(publishStatusChanged).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('recreates the delivery job for a transient enqueued row with no active job', async () => {
    const db = await makeDb();
    try {
      const { deps } = makeBranchDeps(db);
      const target = makeTargetSession();
      db.saveUserMessage(SESSION_ID, makeSdkUserMessage(), 'enqueued');

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        existing: { sendStatus: 'failed' },
      });

      expect(dbId).toBeTypeOf('string');
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'enqueued'
      );
      const job = db
        .getDatabase()
        .prepare(
          `SELECT id FROM job_queue WHERE queue = 'message_delivery'
             AND json_extract(payload, '$.messageUuid') = ?`
        )
        .get(MESSAGE_ID);
      expect(job).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('activates a row that became deferred before the ensure path ran', async () => {
    const db = await makeDb();
    try {
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();
      db.saveUserMessage(SESSION_ID, makeSdkUserMessage(), 'enqueued');
      db.getSDKMessageRepo().markDeliveryDeferredByUuid(SESSION_ID, MESSAGE_ID);
      publishStatusChanged.mockClear();

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        existing: null,
      });

      expect(dbId).toBeTypeOf('string');
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'enqueued'
      );
      expect(publishStatusChanged).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('accepts a consumed row idempotently when the ensure path sees it late', async () => {
    const db = await makeDb();
    try {
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();
      db.saveUserMessage(SESSION_ID, makeSdkUserMessage(), 'enqueued');
      db.getSDKMessageRepo().markDeliveryConsumedByUuid(SESSION_ID, MESSAGE_ID);
      publishStatusChanged.mockClear();

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        existing: null,
      });

      expect(dbId).toBeTypeOf('string');
      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'consumed'
      );
      expect(publishStatusChanged).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('reuses an existing enqueued row without re-publishing enqueued', async () => {
    const db = await makeDb();
    try {
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();
      const firstId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
      });
      publishStatusChanged.mockClear();

      const secondId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        existing: db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID),
      });

      expect(secondId).toBe(firstId);
      expect(publishStatusChanged).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('reactivates a deferred row into an enqueued delivery', async () => {
    const db = await makeDb();
    try {
      db.saveUserMessage(SESSION_ID, makeSdkUserMessage(), 'enqueued');
      db.getSDKMessageRepo().markDeliveryDeferredByUuid(SESSION_ID, MESSAGE_ID);
      const { deps, publishStatusChanged } = makeBranchDeps(db);
      const target = makeTargetSession();

      const dbId = await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
      });

      expect(db.getSDKMessageRepo().getDeliveryContent(SESSION_ID, MESSAGE_ID)?.sendStatus).toBe(
        'enqueued'
      );
      expect(publishStatusChanged).toHaveBeenCalledWith(SESSION_ID, dbId, 'enqueued');
    } finally {
      db.close();
    }
  });

  it('releases the context-clear boundary owner after the handoff', async () => {
    const db = await makeDb();
    try {
      const { deps } = makeBranchDeps(db);
      const target = makeTargetSession();
      const released = mock(() => {});
      const boundaryOwner = { release: released };

      await deliverInjectedMessage(deps, {
        session: target.session,
        sessionId: SESSION_ID,
        messageId: MESSAGE_ID,
        sdkUserMessage: makeSdkUserMessage(),
        boundaryOwner,
      });

      expect(released).toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
