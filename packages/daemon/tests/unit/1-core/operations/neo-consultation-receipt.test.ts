import { describe, expect, test } from 'bun:test';
import type { NeoConsultation, NeoConsultationWaiter } from '@hyperneo/shared/types/neo-context';
import { requireNeoConsultationReceipt } from '../../../../src/lib/neo/operations.ts';

const input = Object.freeze({ concernId: 'research', requestKey: 'B', question: 'Correction B' });
const origin = Object.freeze({ originSessionId: 'root', originMessageId: 'ask-B' });
const waiter: NeoConsultationWaiter = Object.freeze({
  ...input,
  ...origin,
  id: 'receipt-B',
  sessionId: 'holder',
  status: 'queued',
  createdAt: 1,
});

describe('requireNeoConsultationReceipt', () => {
  test.each(['pending', 'reported', 'failed'] as const)('admits immutable %s retries', (status) => {
    const receipt: NeoConsultation = Object.freeze({ ...waiter, status, answer: 'Recorded' });
    expect(requireNeoConsultationReceipt(input, receipt, origin, 'holder')).toEqual({
      value: receipt,
    });
    expect(receipt).toEqual({ ...waiter, status, answer: 'Recorded' });
  });
  test('admits a queued receipt with its own exact source and recipient', () => {
    expect(requireNeoConsultationReceipt(input, waiter, origin, 'holder')).toEqual({
      value: waiter,
    });
  });
  test.each([
    null,
    { ...waiter, requestKey: 'A' },
    { ...waiter, question: 'Other question' },
    { ...waiter, concernId: 'family' },
    { ...waiter, originSessionId: 'another-root' },
    { ...waiter, originMessageId: 'ask-A' },
    { ...waiter, sessionId: 'another-holder' },
  ])('rejects conflicting identity %j', (receipt) => {
    expect(requireNeoConsultationReceipt(input, receipt, origin, 'holder')).toEqual({
      reason: {
        ok: false,
        reason: 'Request key already belongs to another consultation or input.',
      },
    });
  });
  test.each(['cancelled', 'admitted'] as const)('does not resurrect a %s waiter', (status) => {
    expect(requireNeoConsultationReceipt(input, { ...waiter, status }, origin, 'holder')).toEqual({
      reason: { ok: false, reason: 'This queued consultation is no longer available.' },
    });
  });
  test('identity rejection takes precedence over cancelled state', () => {
    expect(
      requireNeoConsultationReceipt(input, { ...waiter, status: 'cancelled' }, origin, 'foreign')
    ).toHaveProperty(
      'reason.reason',
      'Request key already belongs to another consultation or input.'
    );
  });
});
