import { describe, expect, it } from 'bun:test';
import {
  buildQueueTimeoutError,
  QUEUE_TIMEOUT_ERROR_NAME,
  resolveQueueTimeout,
} from '../../../../src/lib/agent/message-queue-timeout-policy';

describe('resolveQueueTimeout', () => {
  it.each([
    [
      'a never-yielded message rejects out of the pending queue',
      { pending: true, claimed: false, yielded: false, durable: false },
      { action: 'reject', removeFrom: 'pending' },
    ],
    [
      'a durable flag never rescues a pending message',
      { pending: true, claimed: false, yielded: false, durable: true },
      { action: 'reject', removeFrom: 'pending' },
    ],
    [
      'a claimed message rejects out of the claimed set',
      { pending: false, claimed: true, yielded: false, durable: false },
      { action: 'reject', removeFrom: 'claimed' },
    ],
    [
      'a claimed durable message still rejects (durable only matters once yielded)',
      { pending: false, claimed: true, yielded: false, durable: true },
      { action: 'reject', removeFrom: 'claimed' },
    ],
    [
      'a yielded non-durable message rejects (legacy bound)',
      { pending: false, claimed: false, yielded: true, durable: false },
      { action: 'reject', removeFrom: 'yielded' },
    ],
    [
      'a yielded-but-unacknowledged durable message resolves (no duplicate re-feed)',
      { pending: false, claimed: false, yielded: true, durable: true },
      { action: 'resolve', removeFrom: 'yielded' },
    ],
    [
      'a message already settled elsewhere is left alone',
      { pending: false, claimed: false, yielded: false, durable: true },
      { action: 'none' },
    ],
  ])('%s', (_label, dims, expected) => {
    expect(resolveQueueTimeout(dims)).toEqual(expected);
  });

  it('pending outranks claimed and yielded when containers disagree', () => {
    expect(
      resolveQueueTimeout({ pending: true, claimed: true, yielded: true, durable: true })
    ).toEqual({ action: 'reject', removeFrom: 'pending' });
  });
});

describe('buildQueueTimeoutError', () => {
  it('carries the error name downstream handlers match on', () => {
    expect(buildQueueTimeoutError({ messageId: 'abc-123', timeoutMs: 30_000 }).name).toBe(
      QUEUE_TIMEOUT_ERROR_NAME
    );
  });

  it('names the message and the budget in the message text', () => {
    const error = buildQueueTimeoutError({ messageId: 'abc-123', timeoutMs: 30_000 });
    expect(error.message).toContain('message abc-123');
    expect(error.message).toContain('within 30s');
  });
});
