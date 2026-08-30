import { describe, expect, mock, test } from 'bun:test';
import {
  captureEpisodeStage,
  clearCooldownStage,
  type RateLimitManualCancelCtx,
  type RateLimitManualCancelDb,
  runRateLimitManualCancel,
  settleOwningDeliveryStage,
} from '../../../../src/lib/agent/rate-limit-manual-cancel';

function ctx(overrides: Partial<RateLimitManualCancelCtx> = {}): RateLimitManualCancelCtx {
  return {
    db: { getSession: () => null, getJobQueueRepo: () => null },
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
  };
}

function persistedCooldownDb(messageId: string): RateLimitManualCancelDb {
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
  test('an episode cancels and settles the episode delivery', () => {
    const cancelDelivery = mock(() => true);
    const markDeliveryFailedByUuid = mock((_sessionId: string, uuid: string) => `db-${uuid}`);
    const publishStatusesFailed = mock((_messageIds: string[]) => {});
    settleOwningDeliveryStage(
      ctx({
        db: {
          getSession: () => null,
          getJobQueueRepo: () => ({
            cancelDelivery,
          }),
          getSDKMessageRepo: () => ({ markDeliveryFailedByUuid }),
        },
        episodeMessageUuid: 'msg-episode',
        publishStatusesFailed,
      })
    );
    expect(cancelDelivery).toHaveBeenCalledWith('test-session-id', 'msg-episode');
    expect(markDeliveryFailedByUuid).toHaveBeenCalledWith('test-session-id', 'msg-episode');
    expect(publishStatusesFailed).toHaveBeenCalledWith(['db-msg-episode']);
  });

  test('reschedules the remaining session deliveries after settling', () => {
    const markDeliveryFailedByUuid = mock((_sessionId: string, uuid: string) => `db-${uuid}`);
    const publishStatusesFailed = mock((_messageIds: string[]) => {});
    const rescheduleSessionDeliveries = mock(() => true);
    settleOwningDeliveryStage(
      ctx({
        db: {
          getSession: () => null,
          getJobQueueRepo: () => ({
            cancelDelivery: () => true,
            rescheduleSessionDeliveries,
          }),
          getSDKMessageRepo: () => ({ markDeliveryFailedByUuid }),
        },
        episodeMessageUuid: 'msg-episode',
        publishStatusesFailed,
      })
    );
    expect(markDeliveryFailedByUuid).toHaveBeenCalledTimes(1);
    expect(publishStatusesFailed).toHaveBeenCalledTimes(1);
    expect(publishStatusesFailed).toHaveBeenCalledWith(['db-msg-episode']);
    expect(rescheduleSessionDeliveries).toHaveBeenCalledWith('test-session-id', expect.any(Number));
  });

  test('skips the publish when no bundled message settles', () => {
    const publishStatusesFailed = mock((_messageIds: string[]) => {});
    settleOwningDeliveryStage(
      ctx({
        db: {
          getSession: () => null,
          getJobQueueRepo: () => ({ cancelDelivery: () => true }),
          getSDKMessageRepo: () => ({ markDeliveryFailedByUuid: () => null }),
        },
        episodeMessageUuid: 'msg-episode',
        publishStatusesFailed,
      })
    );
    expect(publishStatusesFailed).not.toHaveBeenCalled();
  });

  test('does nothing when no owning delivery resolves', () => {
    const cancelDelivery = mock(() => true);
    const clearCooldown = mock(() => {});
    const out = settleOwningDeliveryStage(
      ctx({
        db: {
          getSession: () => null,
          getJobQueueRepo: () => ({
            cancelDelivery,
            getActiveDeliveryMessageUuid: () => null,
          }),
        },
        episodeMessageUuid: undefined,
        cooldownClearPending: true,
        clearCooldown,
      })
    );
    expect(cancelDelivery).not.toHaveBeenCalled();
    expect(out.cooldownClearPending).toBe(true);
  });

  test('a delivery cancellation failure reports the error and skips the reschedule', () => {
    const onDeliveryCancelError = mock((_error: unknown) => {});
    const rescheduleSessionDeliveries = mock(() => true);
    settleOwningDeliveryStage(
      ctx({
        db: {
          getSession: () => null,
          getJobQueueRepo: () => ({
            cancelDelivery: () => {
              throw new Error('job queue locked');
            },
            rescheduleSessionDeliveries,
          }),
        },
        episodeMessageUuid: 'msg-episode',
        onDeliveryCancelError,
      })
    );
    expect(onDeliveryCancelError).toHaveBeenCalledTimes(1);
    expect(onDeliveryCancelError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(rescheduleSessionDeliveries).not.toHaveBeenCalled();
  });
});

describe('clearCooldownStage', () => {
  test('clears the cooldown only when a clear is pending', () => {
    const clearCooldown = mock(() => {});
    clearCooldownStage(ctx({ cooldownClearPending: true, clearCooldown }));
    expect(clearCooldown).toHaveBeenCalledTimes(1);

    const idle = mock(() => {});
    clearCooldownStage(ctx({ cooldownClearPending: false, clearCooldown: idle }));
    expect(idle).not.toHaveBeenCalled();
  });
});

describe('runRateLimitManualCancel', () => {
  test('runs capture, settle, and clear synchronously for a persisted cooldown', () => {
    const effects: string[] = [];
    runRateLimitManualCancel({
      db: {
        getSession: () => ({
          processingState: JSON.stringify({
            status: 'rate_limit_cooldown',
            messageId: 'msg-episode',
          }),
        }),
        getJobQueueRepo: () => ({
          cancelDelivery: () => true,
          rescheduleSessionDeliveries: () => true,
        }),
        getSDKMessageRepo: () => ({
          markDeliveryFailedByUuid: (_sessionId: string, uuid: string) => `db-${uuid}`,
        }),
      },
      sessionId: 'test-session-id',
      getLiveEpisodeMessageUuid: () => undefined,
      getPersistedArmMessageUuid: () => undefined,
      cancelWatchdog: () => {
        effects.push('cancelWatchdog');
      },
      isInMemoryCooldown: () => true,
      clearCooldown: () => {
        effects.push('clearCooldown');
      },
      publishStatusesFailed: (messageIds) => {
        effects.push(`publish:${messageIds.join(',')}`);
      },
      onPersistedCooldownReadError: () => {
        effects.push('readError');
      },
      onDeliveryCancelError: () => {
        effects.push('settleError');
      },
    });
    expect(effects).toEqual(['cancelWatchdog', 'publish:db-msg-episode', 'clearCooldown']);
  });
});
