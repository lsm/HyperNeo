import { describe, expect, it } from 'bun:test';
import {
  isTurnEndAckEligible,
  selectPersistedAckRow,
  selectYieldedAckRow,
} from '../../../../src/lib/agent/ack-selection';

const UUID = 'queued-user-uuid';
const OTHER_UUID = 'current-turn-uuid';

describe('selectPersistedAckRow', () => {
  it.each([
    [
      'enqueued wins over every later status',
      { enqueued: true, deferred: true, submitted: true, consumed: true },
      { action: 'consume', status: 'enqueued' },
    ],
    [
      'deferred outranks submitted',
      { enqueued: false, deferred: true, submitted: true, consumed: false },
      { action: 'consume', status: 'deferred' },
    ],
    [
      'submitted is consumed when it is the only match',
      { enqueued: false, deferred: false, submitted: true, consumed: false },
      { action: 'consume', status: 'submitted' },
    ],
    [
      'an already-consumed row suppresses the replay instead of re-consuming',
      { enqueued: false, deferred: false, submitted: false, consumed: true },
      { action: 'already_consumed' },
    ],
    [
      'no row in any status is a miss',
      { enqueued: false, deferred: false, submitted: false, consumed: false },
      { action: 'none' },
    ],
  ])('%s', (_label, statuses, expected) => {
    expect(selectPersistedAckRow(statuses)).toEqual(expected);
  });
});

describe('selectYieldedAckRow', () => {
  it.each([
    [
      'enqueued wins first',
      { enqueued: true, submitted: true, deferred: true },
      { action: 'consume', status: 'enqueued' },
    ],
    [
      'submitted outranks deferred',
      { enqueued: false, submitted: true, deferred: true },
      { action: 'consume', status: 'submitted' },
    ],
    [
      'deferred is consumed only when enqueued and submitted miss',
      { enqueued: false, submitted: false, deferred: true },
      { action: 'consume', status: 'deferred' },
    ],
    [
      'no row in any status is a miss',
      { enqueued: false, submitted: false, deferred: false },
      { action: 'none' },
    ],
  ])('%s', (_label, statuses, expected) => {
    expect(selectYieldedAckRow(statuses)).toEqual(expected);
  });

  it('the yielded ladder defers behind submitted, unlike the persisted replay ladder', () => {
    expect(selectYieldedAckRow({ enqueued: false, submitted: true, deferred: true })).toEqual({
      action: 'consume',
      status: 'submitted',
    });
    expect(
      selectPersistedAckRow({ enqueued: false, deferred: true, submitted: true, consumed: false })
    ).toEqual({ action: 'consume', status: 'deferred' });
  });
});

describe('isTurnEndAckEligible', () => {
  it.each([
    [
      'unowned and not pending in memory is acked',
      { durableOwned: false, yielded: false, pendingOrClaimed: false, activeMessageId: null },
      true,
    ],
    [
      'pending or claimed in memory is left enqueued even when unowned',
      { durableOwned: false, yielded: false, pendingOrClaimed: true, activeMessageId: null },
      false,
    ],
    [
      'durable ownership leaves the row claimable when no message owns the turn',
      { durableOwned: true, yielded: false, pendingOrClaimed: false, activeMessageId: null },
      false,
    ],
    [
      'durable ownership leaves a yielded row behind when another message owns the turn',
      { durableOwned: true, yielded: true, pendingOrClaimed: false, activeMessageId: OTHER_UUID },
      false,
    ],
    [
      'the active message with a durable owner is acked once yielded',
      { durableOwned: true, yielded: true, pendingOrClaimed: false, activeMessageId: UUID },
      true,
    ],
    [
      'the active message with a durable owner is held before it yields',
      { durableOwned: true, yielded: false, pendingOrClaimed: false, activeMessageId: UUID },
      false,
    ],
    [
      'an active yielded row is still held while pending or claimed in memory',
      { durableOwned: true, yielded: true, pendingOrClaimed: true, activeMessageId: UUID },
      false,
    ],
  ])('%s', (_label, dims, expected) => {
    expect(isTurnEndAckEligible({ uuid: UUID, ...dims })).toBe(expected);
  });
});
