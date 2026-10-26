import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMailboxTestDb } from '../../../helpers/mailbox-test-db';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import {
  captureEpisodeStage,
  clearCooldownStage,
  type RateLimitManualCancelCtx,
  type RateLimitManualCancelDb,
  runRateLimitManualCancel,
  settleOwningDeliveryStage,
} from '../../../../src/lib/agent/rate-limit-manual-cancel';

type TestDb = Omit<RateLimitManualCancelDb, 'getDatabase'> &
  Partial<Pick<RateLimitManualCancelDb, 'getDatabase'>>;

function ctx(
  overrides: Omit<Partial<RateLimitManualCancelCtx>, 'db'> & { db?: TestDb } = {}
): RateLimitManualCancelCtx {
  return {
    sessionId: 'test-session-id',
    getLiveEpisodeMessageUuid: () => undefined,
    getPersistedArmMessageUuid: () => undefined,
    cancelWatchdog: () => {},
    isInMemoryCooldown: () => false,
    clearCooldown: () => {},
    publishStatusesFailed: () => {},
    onPersistedCooldownReadError: () => {},
    onDeliveryCancelError: () => {},
    episodeMessageUuid: undefined,
    cooldownClearPending: false,
    ...overrides,
    db: {
      getSession: () => null,
      getDatabase: () => {
        throw new Error('This test must not write');
      },
      ...overrides.db,
    },
  };
}

function persistedCooldownDb(messageId: string): TestDb {
  return {
    getSession: () => ({
      processingState: JSON.stringify({ status: 'rate_limit_cooldown', messageId }),
    }),
    getJobQueueRepo: () => null,
  };
}

describe('captureEpisodeStage', () => {
  test('the live episode uuid outranks the persisted arm and the persisted row messageId', () => {
    const out = captureEpisodeStage(
      ctx({
        getLiveEpisodeMessageUuid: () => 'msg-live',
        getPersistedArmMessageUuid: () => 'msg-arm',
        db: persistedCooldownDb('msg-row'),
      })
    );
    expect(out.episodeMessageUuid).toBe('msg-live');
    expect(out.cooldownClearPending).toBe(true);
  });

  test('the persisted arm outranks the persisted row messageId when the live episode is gone', () => {
    const out = captureEpisodeStage(
      ctx({
        getPersistedArmMessageUuid: () => 'msg-arm',
        db: persistedCooldownDb('msg-row'),
      })
    );
    expect(out.episodeMessageUuid).toBe('msg-arm');
  });

  test('the persisted row messageId backs the episode only for an active persisted cooldown', () => {
    const out = captureEpisodeStage(ctx({ db: persistedCooldownDb('msg-row') }));
    expect(out.episodeMessageUuid).toBe('msg-row');

    const inactive = captureEpisodeStage(
      ctx({
        db: {
          getSession: () => ({ processingState: JSON.stringify({ status: 'idle' }) }),
          getJobQueueRepo: () => null,
        },
      })
    );
    expect(inactive.episodeMessageUuid).toBeUndefined();
    expect(inactive.cooldownClearPending).toBe(false);
  });

  test('an unreadable persisted state warns and leaves the in-memory cooldown as the only trigger', () => {
    const onPersistedCooldownReadError = mock(() => {});
    const out = captureEpisodeStage(
      ctx({
        db: {
          getSession: () => ({ processingState: '{not json' }),
          getJobQueueRepo: () => null,
        },
        onPersistedCooldownReadError,
      })
    );
    expect(onPersistedCooldownReadError).toHaveBeenCalledTimes(1);
    expect(out.episodeMessageUuid).toBeUndefined();
    expect(out.cooldownClearPending).toBe(false);

    const inMemory = captureEpisodeStage(
      ctx({
        db: {
          getSession: () => ({ processingState: '{not json' }),
          getJobQueueRepo: () => null,
        },
        isInMemoryCooldown: () => true,
      })
    );
    expect(inMemory.cooldownClearPending).toBe(true);
  });

  test('captures both episode sources before cancelling the watchdog and reading the cooldown state', () => {
    const calls: string[] = [];
    captureEpisodeStage(
      ctx({
        getLiveEpisodeMessageUuid: () => {
          calls.push('live');
          return 'msg-live';
        },
        getPersistedArmMessageUuid: () => {
          calls.push('arm');
          return 'msg-arm';
        },
        cancelWatchdog: () => {
          calls.push('cancel');
        },
        isInMemoryCooldown: () => {
          calls.push('in-memory');
          return true;
        },
        db: {
          getSession: () => {
            calls.push('persisted');
            return null;
          },
          getJobQueueRepo: () => null,
        },
      })
    );
    expect(calls).toEqual(['live', 'arm', 'cancel', 'in-memory', 'persisted']);
  });
});

describe('settleOwningDeliveryStage', () => {
  let fixture: ReturnType<typeof createMailboxTestDb>;
  const sessionId = 'test-session-id';
  const future = () => Date.now() + 60_000;
  function seed(uuid: string, sid = sessionId, status = 'enqueued' as 'enqueued' | 'consumed') {
    fixture.sdkMessageRepo.saveUserMessage(
      sid,
      {
        type: 'user',
        uuid,
        message: { role: 'user', content: uuid },
      },
      status
    );
    return fixture.jobQueue.enqueue({
      queue: 'message_delivery',
      payload: { sessionId: sid, messageUuid: uuid },
      runAt: future(),
    });
  }
  function deliveryCtx(overrides: Partial<RateLimitManualCancelCtx> = {}) {
    return ctx({ db: { getSession: () => null, getDatabase: () => fixture.db }, ...overrides });
  }
  beforeEach(() => {
    fixture = createMailboxTestDb();
  });
  afterEach(() => {
    fixture.close();
  });

  test('commits all settlement writes before notifying and leaves other sessions untouched', async () => {
    const owning = seed('episode');
    const next = seed('next');
    fixture.db.prepare('UPDATE job_queue SET run_at = 0 WHERE id = ?').run(next.id);
    const [nextClaim] = fixture.jobQueue.dequeue('message_delivery');
    expect(nextClaim.id).toBe(next.id);
    const other = seed('other', 'another-session');
    const notifications: string[][] = [];
    const command = deliveryCtx({
      episodeMessageUuid: 'episode',
      onDeliveryCancelError: (error) => {
        throw error;
      },
      publishStatusesFailed: (ids) => {
        fixture.db.exec('BEGIN IMMEDIATE');
        fixture.db.exec('ROLLBACK');
        expect(fixture.jobQueue.getJob(owning.id)).toBeNull();
        expect(fixture.sdkMessageRepo.getUserSendStatus(sessionId, 'episode')).toBe('failed');
        expect(fixture.jobQueue.getJob(next.id)?.runAt).toBeLessThan(next.runAt);
        notifications.push(ids);
      },
    });
    await settleOwningDeliveryStage(command);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual([
      fixture.sdkMessageRepo.findMessageIdByUuid(sessionId, 'episode'),
    ]);
    expect(fixture.jobQueue.getJob(other.id)).toEqual(other);
    expect(fixture.jobQueue.getJob(next.id)).toMatchObject({
      status: 'pending',
      claimToken: null,
      startedAt: null,
      heartbeatAt: null,
      retryCount: 0,
    });
    expect(fixture.jobQueue.heartbeat(next.id, nextClaim.claimToken)).toBe(false);
    await settleOwningDeliveryStage(command);
    expect(notifications).toHaveLength(1);
  });

  test('resolves a fallback owning delivery inside the queued transaction', async () => {
    const original = seed('original');
    const gateway = new DbGateway(':memory:', fixture.db);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = gateway.run.bind(gateway);
    gateway.run = async (op, args) => {
      await hold;
      return run(op, args);
    };
    bindGateway(fixture.db, gateway);
    const pending = settleOwningDeliveryStage(deliveryCtx());
    const inserted = seed('new-owner');
    fixture.db
      .prepare('UPDATE job_queue SET created_at = ? WHERE id = ?')
      .run(original.createdAt - 1000, inserted.id);
    release();
    await pending;
    expect(fixture.jobQueue.getJob(inserted.id)).toBeNull();
    expect(fixture.jobQueue.getJob(original.id)?.status).toBe('pending');
    expect(fixture.sdkMessageRepo.getUserSendStatus(sessionId, 'original')).toBe('enqueued');
    expect(fixture.sdkMessageRepo.getUserSendStatus(sessionId, 'new-owner')).toBe('failed');
  });

  test('rolls back job deletion when message settlement fails', async () => {
    const owning = seed('episode');
    const next = seed('next');
    fixture.db.exec(`CREATE TRIGGER refuse_failure BEFORE UPDATE OF send_status ON sdk_messages
      BEGIN SELECT RAISE(ABORT, 'synthetic settlement failure'); END`);
    const onDeliveryCancelError = mock(() => {});
    const publishStatusesFailed = mock(() => {});
    await settleOwningDeliveryStage(
      deliveryCtx({ episodeMessageUuid: 'episode', onDeliveryCancelError, publishStatusesFailed })
    );
    expect(onDeliveryCancelError).toHaveBeenCalledTimes(1);
    expect(publishStatusesFailed).not.toHaveBeenCalled();
    expect(fixture.jobQueue.getJob(owning.id)).toEqual(owning);
    expect(fixture.jobQueue.getJob(next.id)).toEqual(next);
    expect(fixture.sdkMessageRepo.getUserSendStatus(sessionId, 'episode')).toBe('enqueued');
  });

  test('rejects a writer fault without any main-connection fallback', async () => {
    const owning = seed('episode');
    bindGateway(
      fixture.db,
      new DbGateway('synthetic-writer', null, undefined, () => {
        throw new Error('writer unavailable');
      })
    );
    const onDeliveryCancelError = mock(() => {});
    const publishStatusesFailed = mock(() => {});
    await settleOwningDeliveryStage(
      deliveryCtx({ episodeMessageUuid: 'episode', onDeliveryCancelError, publishStatusesFailed })
    );
    expect(onDeliveryCancelError).toHaveBeenCalledTimes(1);
    expect(publishStatusesFailed).not.toHaveBeenCalled();
    expect(fixture.jobQueue.getJob(owning.id)).toEqual(owning);
    expect(fixture.sdkMessageRepo.getUserSendStatus(sessionId, 'episode')).toBe('enqueued');
  });

  test('does not fail an already consumed message or notify without a settlement', async () => {
    const owning = seed('episode', sessionId, 'consumed');
    const publishStatusesFailed = mock(() => {});
    await settleOwningDeliveryStage(
      deliveryCtx({ episodeMessageUuid: 'episode', publishStatusesFailed })
    );
    expect(fixture.jobQueue.getJob(owning.id)).toBeNull();
    expect(fixture.sdkMessageRepo.getUserSendStatus(sessionId, 'episode')).toBe('consumed');
    expect(publishStatusesFailed).not.toHaveBeenCalled();
  });

  test('does nothing when no owning delivery exists', async () => {
    const publishStatusesFailed = mock(() => {});
    const out = await settleOwningDeliveryStage(
      deliveryCtx({ cooldownClearPending: true, publishStatusesFailed })
    );
    expect(publishStatusesFailed).not.toHaveBeenCalled();
    expect(out.cooldownClearPending).toBe(true);
    expect(fixture.rows()).toEqual([]);
  });
});

describe('clearCooldownStage', () => {
  test('awaits a pending cooldown clear and skips an inactive cooldown', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const pending = clearCooldownStage(
      ctx({ cooldownClearPending: true, clearCooldown: () => hold })
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(settled).toBe(true);
    const idle = mock(() => {});
    await clearCooldownStage(ctx({ cooldownClearPending: false, clearCooldown: idle }));
    expect(idle).not.toHaveBeenCalled();
  });
});

describe('runRateLimitManualCancel', () => {
  test('awaits commit and publication before clearing the cooldown', async () => {
    const fixture = createMailboxTestDb();
    try {
      fixture.sdkMessageRepo.saveUserMessage(
        'test-session-id',
        { type: 'user', uuid: 'episode', message: { role: 'user', content: 'cancel me' } },
        'enqueued'
      );
      fixture.jobQueue.enqueue({
        queue: 'message_delivery',
        payload: { sessionId: 'test-session-id', messageUuid: 'episode' },
        runAt: Date.now() + 60000,
      });
      const effects: string[] = [];
      let publishStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        publishStarted = resolve;
      });
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = runRateLimitManualCancel(
        ctx({
          db: { ...persistedCooldownDb('episode'), getDatabase: () => fixture.db },
          cancelWatchdog: () => {
            effects.push('watchdog');
          },
          onDeliveryCancelError: (error) => {
            throw error;
          },
          publishStatusesFailed: async () => {
            fixture.db.exec('BEGIN IMMEDIATE');
            fixture.db.exec('ROLLBACK');
            expect(fixture.sdkMessageRepo.getUserSendStatus('test-session-id', 'episode')).toBe(
              'failed'
            );
            effects.push('publish');
            publishStarted();
            await hold;
          },
          clearCooldown: () => {
            effects.push('clear');
          },
        })
      );
      await Promise.race([started, pending]);
      expect(effects).toEqual(['watchdog', 'publish']);
      release();
      await pending;
      expect(effects).toEqual(['watchdog', 'publish', 'clear']);
    } finally {
      fixture.close();
    }
  });
});
